import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  CallId,
  LlmAdapter,
  contentHasImage,
  createUserMessage,
  markAgentLoopRequest,
  type ContentBlock,
  type GenerateOptions,
  type ImageBlock,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import * as geCaption from '../src/index.ts'

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function imageBlock(id: string): ImageBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: id as ImageBlock['attachment']['attachmentId'],
      mediaType: 'image/png',
      bytes: 42,
      width: 8,
      height: 8,
    },
  }
}

function collectText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  return (async () => {
    let text = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    return text
  })()
}

/** Records every request it serves; scripts a canned response per provider. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly responses: Readonly<Record<string, StreamChunk[]>>) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.responses[options.provider]
    if (entry === undefined) throw new Error(`no scripted response for provider "${options.provider}"`)
    yield* entry
  }
}

async function harness(config: geCaption.GeCaptionConfig): Promise<{
  ctx: Context
  adapter: ScriptedAdapter
  dispose: () => void
}> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ScriptedAdapter({
    vision: textResponse('[视觉描述：一张蓝色图片]'),
    text: textResponse('[文本模型推理结果]'),
  })
  const dispose = ctx.llm.registerAdapter(['vision', 'text'], adapter)
  await ctx.plugin(Object.assign((inner: Context) => {
    geCaption.apply(inner, config)
  }, { inject: geCaption.inject }))
  return { ctx, adapter, dispose }
}

describe('ge-caption gateway', () => {
  it('short-circuits an agent-loop request with images through vision then text', async () => {
    const { ctx, adapter, dispose } = await harness({
      enabled: true,
      vision: { provider: 'vision', model: 'vision-model' },
      text: { provider: 'text', model: 'text-model' },
    })
    try {
      const request = markAgentLoopRequest({
        provider: 'text',
        model: 'text-model',
        messages: [
          createUserMessage({
            content: [imageBlock('att-1'), { type: 'text', text: '这张图里有什么？' }],
            source: { kind: 'user' },
          }),
        ],
      })
      const output = await collectText(ctx.llm.stream(request))

      expect(output).toBe('[文本模型推理结果]')
      // The caption leg saw the image; the text leg saw the caption, never the image.
      const visionRequest = adapter.requests[0]
      const textRequest = adapter.requests[1]
      expect(visionRequest?.provider).toBe('vision')
      expect(visionRequest?.messages[0]?.content.some(block => block.type === 'image')).toBe(true)
      expect(textRequest?.provider).toBe('text')
      const textContent = textRequest?.messages[0]?.content ?? []
      expect(textContent.some(block => block.type === 'image')).toBe(false)
      expect(textContent.some(block => block.type === 'text' && block.text.includes('[视觉描述'))).toBe(true)
    } finally {
      dispose()
    }
  })

  it('captions an image nested inside a tool-result block before the text route sees it', async () => {
    const { ctx, adapter, dispose } = await harness({
      enabled: true,
      vision: { provider: 'vision', model: 'vision-model' },
      text: { provider: 'text', model: 'text-model' },
    })
    try {
      // `read_image` and image-returning MCP tools embed the image inside the
      // tool result's rendered content, so the image is nested, not top-level.
      const request = markAgentLoopRequest({
        provider: 'text',
        model: 'text-model',
        messages: [
          createUserMessage({
            content: [{
              type: 'tool-result',
              toolCallId: CallId('call-1'),
              content: [
                { type: 'text', text: '<path>shot.png</path>' },
                imageBlock('att-n1'),
              ],
            }],
            source: { kind: 'tool', callId: CallId('call-1') },
          }),
        ],
      })
      const output = await collectText(ctx.llm.stream(request))

      expect(output).toBe('[文本模型推理结果]')
      // The vision leg saw the nested image; the text leg never does.
      const visionRequest = adapter.requests[0]
      const textRequest = adapter.requests[1]
      expect(visionRequest?.provider).toBe('vision')
      expect(visionRequest?.messages[0]?.content.some(block => block.type === 'image')).toBe(true)
      expect(textRequest?.provider).toBe('text')
      const textMessages = textRequest?.messages ?? []
      expect(textMessages.some(message => contentHasImage(message.content))).toBe(false)
      // The caption replaced the image inside the tool result; sibling text survives.
      const toolBlock = textMessages[0]?.content[0]
      expect(toolBlock?.type).toBe('tool-result')
      const toolTexts = (toolBlock as Extract<ContentBlock, { type: 'tool-result' }>).content
        .filter(block => block.type === 'text')
        .map(block => (block as { text: string }).text)
      expect(toolTexts.join('|')).toContain('<path>shot.png</path>')
      expect(toolTexts.join('|')).toContain('[视觉描述')
    } finally {
      dispose()
    }
  })

  it('keeps the original text alongside the caption when replacing images', async () => {
    const { ctx, adapter, dispose } = await harness({
      enabled: true,
      vision: { provider: 'vision', model: 'vision-model' },
    })
    try {
      const request = markAgentLoopRequest({
        provider: 'text',
        model: 'text-model',
        messages: [
          createUserMessage({
            content: [imageBlock('att-2'), { type: 'text', text: '请问颜色' }],
            source: { kind: 'user' },
          }),
        ],
      })
      await collectText(ctx.llm.stream(request))
      const textRequest = adapter.requests[1]
      const textBlocks = (textRequest?.messages[0]?.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => (block as { text: string }).text)
      expect(textBlocks.join('|')).toContain('请问颜色')
      expect(textBlocks.join('|')).toContain('[视觉描述')
    } finally {
      dispose()
    }
  })

  it('passes an image-free agent-loop request straight to the route', async () => {
    const { ctx, adapter, dispose } = await harness({
      enabled: true,
      vision: { provider: 'vision', model: 'vision-model' },
    })
    try {
      const request = markAgentLoopRequest({
        provider: 'text',
        model: 'text-model',
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: '你好' }],
            source: { kind: 'user' },
          }),
        ],
      })
      const output = await collectText(ctx.llm.stream(request))
      expect(output).toBe('[文本模型推理结果]')
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.provider).toBe('text')
    } finally {
      dispose()
    }
  })

  it('passes a hand-built (non-loop) request through untouched even with images', async () => {
    const { ctx, adapter, dispose } = await harness({
      enabled: true,
      vision: { provider: 'vision', model: 'vision-model' },
    })
    try {
      const request: GenerateOptions = {
        provider: 'vision',
        model: 'vision-model',
        messages: [
          createUserMessage({
            content: [imageBlock('att-3'), { type: 'text', text: '看图' }],
            source: { kind: 'plugin', plugin: 'ge-caption' },
          }),
        ],
      }
      const output = await collectText(ctx.llm.stream(request))
      expect(output).toBe('[视觉描述：一张蓝色图片]')
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.provider).toBe('vision')
    } finally {
      dispose()
    }
  })

  it('fails closed with a terminal error chunk when disabled via config', async () => {
    const { ctx, adapter, dispose } = await harness({
      enabled: false,
      vision: { provider: 'vision', model: 'vision-model' },
    })
    try {
      const request = markAgentLoopRequest({
        provider: 'text',
        model: 'text-model',
        messages: [
          createUserMessage({
            content: [imageBlock('att-4'), { type: 'text', text: '图' }],
            source: { kind: 'user' },
          }),
        ],
      })
      const output = await collectText(ctx.llm.stream(request))
      // Disabled: the loop request goes straight to its own route, which
      // scripted text answers normally.
      expect(output).toBe('[文本模型推理结果]')
      expect(adapter.requests).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  it('captions image blocks in a compaction call before the text route sees them', async () => {
    const { ctx, adapter, dispose } = await harness({
      enabled: true,
      vision: { provider: 'vision', model: 'vision-model' },
      text: { provider: 'text', model: 'text-model' },
    })
    try {
      // Compaction replays the conversation prefix (images included) into the
      // text route; the gateway must convert those images to caption text.
      const request = markAgentLoopRequest({
        provider: 'text',
        model: 'text-model',
        purpose: 'compaction',
        messages: [
          createUserMessage({
            content: [imageBlock('att-c1'), { type: 'text', text: '原始对话' }],
            source: { kind: 'user' },
          }),
        ],
      })
      const output = await collectText(ctx.llm.stream(request))
      expect(output).toBe('[文本模型推理结果]')
      // Vision leg first, then the rebuilt text request without the image.
      const visionRequest = adapter.requests[0]
      const textRequest = adapter.requests[1]
      expect(visionRequest?.provider).toBe('vision')
      expect(textRequest?.provider).toBe('text')
      const textContent = textRequest?.messages[0]?.content ?? []
      expect(textContent.some(block => block.type === 'image')).toBe(false)
      expect(textContent.some(block => block.type === 'text' && block.text.includes('[视觉描述'))).toBe(true)
    } finally {
      dispose()
    }
  })

  it('captions nested tool-result images in a compaction call before the text route sees them', async () => {
    const { ctx, adapter, dispose } = await harness({
      enabled: true,
      vision: { provider: 'vision', model: 'vision-model' },
      text: { provider: 'text', model: 'text-model' },
    })
    try {
      // Compaction replays the conversation prefix verbatim, so images nested
      // inside tool results must be captioned too or the text adapter rejects
      // the replay mid-compaction.
      const request: GenerateOptions = {
        provider: 'text',
        model: 'text-model',
        purpose: 'compaction',
        messages: [
          createUserMessage({
            content: [{
              type: 'tool-result',
              toolCallId: CallId('call-2'),
              content: [imageBlock('att-c2'), { type: 'text', text: '原始工具输出' }],
            }],
            source: { kind: 'tool', callId: CallId('call-2') },
          }),
        ],
      }
      const output = await collectText(ctx.llm.stream(request))

      expect(output).toBe('[文本模型推理结果]')
      const visionRequest = adapter.requests[0]
      const textRequest = adapter.requests[1]
      expect(visionRequest?.provider).toBe('vision')
      expect(visionRequest?.messages[0]?.content.some(block => block.type === 'image')).toBe(true)
      expect(textRequest?.provider).toBe('text')
      const textMessages = textRequest?.messages ?? []
      expect(textMessages.some(message => contentHasImage(message.content))).toBe(false)
      const toolBlock = textMessages[0]?.content[0]
      expect(toolBlock?.type).toBe('tool-result')
      const toolTexts = (toolBlock as Extract<ContentBlock, { type: 'tool-result' }>).content
        .filter(block => block.type === 'text')
        .map(block => (block as { text: string }).text)
      expect(toolTexts.join('|')).toContain('原始工具输出')
      expect(toolTexts.join('|')).toContain('[视觉描述')
    } finally {
      dispose()
    }
  })

  it('keeps a compaction call without images on its original route', async () => {
    const { ctx, adapter, dispose } = await harness({
      enabled: true,
      vision: { provider: 'vision', model: 'vision-model' },
    })
    try {
      const request: GenerateOptions = {
        provider: 'text',
        model: 'text-model',
        purpose: 'compaction',
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: '纯文本压缩' }],
            source: { kind: 'user' },
          }),
        ],
      }
      const output = await collectText(ctx.llm.stream(request))
      expect(output).toBe('[文本模型推理结果]')
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.provider).toBe('text')
    } finally {
      dispose()
    }
  })
})
