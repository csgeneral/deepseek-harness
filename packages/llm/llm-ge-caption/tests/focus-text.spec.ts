import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'

// Focused text-recognition probe: re-examine the source image with a prompt
// that asks the vision model to transcribe the red printed characters on the
// plastic bag character by character. Live network + BAILIAN_API_KEY needed.
describe('focused bag-label text recognition (live)', () => {
  it('transcribes the red characters on the bag', async () => {
    const ctx = new Context()
    await ctx.plugin(SettingsFile, { path: 'C:/Users/49174/.dsh/settings.yaml' })
    await ctx.plugin(CredentialsLocal, { path: 'C:/Users/49174/.dsh/.credentials.yaml' })
    await ctx.plugin(AttachmentLocal, { path: 'C:/Users/49174/.dsh/attachments' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Object.assign((inner: Context) => {
      piAi.apply(inner, piAi.Config({ providers: {} }))
    }, { inject: piAi.inject }))

    const data = await readFile('D:/study/aigate/probe-image-1.jpg')
    const ref = await ctx.attachments.saveImage({
      data,
      mediaType: 'image/jpeg',
      name: 'probe-image-1.jpg',
    })
    let text = ''
    let failure: string | undefined
    for await (const chunk of ctx.llm.stream({
      provider: 'bailian',
      model: 'qwen3-vl-flash',
      messages: [createUserMessage({
        content: [
          { type: 'image', attachment: ref },
          { type: 'text', text: '请仔细辨认图片中塑料袋上印的红色汉字。逐个字符辨认，尽量读出完整内容（可能是店名或品牌名）。如果看不清或不确定，请说明你能确定哪些字、哪些是推测。只输出文字辨认结果，不要描述其他内容。' },
        ],
        source: { kind: 'plugin', plugin: 'ge-caption-focus' },
      })],
      maxTokens: 256,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') failure = chunk.reason.failure.message
    }
    await ctx.fiber.dispose()
    if (failure !== undefined) {
      console.warn(`focused recognition failed: ${failure}`)
      return
    }
    console.log('=== FOCUSED TEXT RECOGNITION ===')
    console.log(text.trim())
    expect(text.trim().length).toBeGreaterThan(0)
  })
})
