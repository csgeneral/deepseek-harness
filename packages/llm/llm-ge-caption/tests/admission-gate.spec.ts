/**
 * End-to-end admission gate behavior: with the ge-caption gateway enabled, a
 * session on a text-only route (DeepSeek official) may still admit images,
 * because the gateway converts them to caption text before the text adapter
 * ever sees them.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api-proxy'
import * as geCaption from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`gateway-${String(nextRpc++)}`), payload }
}

/** A route that explicitly declares text-only input (like DeepSeek official). */
class TextOnlyAdapter extends LlmAdapter {
  override providerInfo() { return { id: 'deepseek-official', name: 'DeepSeek' } }
  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' }])
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { /* never reached */ }
}

async function harness(): Promise<{ ctx: Context; agent: Agent; sessionId: SessionId }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ge-caption-gate-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, [
    'ge-caption:',
    '  enabled: true',
    '  vision:',
    '    provider: bailian',
    '    model: qwen3-vl-flash',
    '  text:',
    '    provider: deepseek-official',
    '    model: deepseek-chat',
    '',
  ].join('\n'))

  const ctx = new Context()
  await ctx.plugin(SettingsFile, { path: settingsPath })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Object.assign((inner: Context) => {
    geCaption.apply(inner, { enabled: true, vision: { provider: 'bailian', model: 'qwen3-vl-flash' } })
  }, { inject: geCaption.inject }))
  ctx.llm.registerAdapter(['deepseek-official'], new TextOnlyAdapter())
  const session = ctx.sessions.create()
  session.append('request/header', {
    header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } },
    reason: 'initial',
  })
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  ctx.agents.register(agent)
  context = ctx
  return { ctx, agent, sessionId: session.id }
}

describe('ge-caption gateway image admission (text-only route + enabled gateway)', () => {
  it('admits an image upload on a text-only route when the gateway is enabled', async () => {
    const { ctx, agent, sessionId } = await harness()
    const saveImage = vi.fn((input: { data: Uint8Array; mediaType: 'image/png' }) => Promise.resolve({
      attachmentId: 'att-gw-1',
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }))
    ctx.provide('attachments', {
      imageLimits: {
        maxImageBytes: 4, maxImagesPerMessage: 2, maxMessageImageBytes: 4, maxImagePixels: 4,
        mediaTypes: ['image/png'],
      },
      validateImage: (_input: { data: Uint8Array }) => Promise.resolve(),
      saveImage,
    } as never)
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const result = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==' },
        { type: 'text' as const, text: '这张图是什么？' },
      ],
    }))
    expect(result.result.ok).toBe(true)
    expect(saveImage).toHaveBeenCalledTimes(1)
  })

  it('still refuses an image upload when the gateway is disabled', async () => {
    const { ctx, sessionId } = await harness()
    // Turn the gateway off in the settings document.
    await ctx.settings.update(geCaption.GE_CAPTION_SETTINGS_NAMESPACE, { enabled: false })
    ctx.provide('attachments', {
      imageLimits: {
        maxImageBytes: 4, maxImagesPerMessage: 2, maxMessageImageBytes: 4, maxImagePixels: 4,
        mediaTypes: ['image/png'],
      },
      validateImage: (_input: { data: Uint8Array }) => Promise.resolve(),
      saveImage: () => Promise.resolve({
        attachmentId: 'att-x', mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1,
      }),
    } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const result = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==' },
      ],
    }))
    expect(result.result.ok).toBe(false)
    expect(result.result).toMatchObject({
      error: { code: 'attachment-error', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } },
    })
  })
})
