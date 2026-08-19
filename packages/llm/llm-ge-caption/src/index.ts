/**
 * Vision-to-text gateway middleware (`ge-caption`).
 *
 * This plugin gives a text-only conversation route (DeepSeek official) the
 * ability to reason over images: whenever a request that can carry durable
 * session images reaches the `llm/stream` waterfall, the gateway
 *
 * 1. collects the image blocks — top-level ones and those nested inside
 *    tool-result content (`read_image` and image-returning MCP tools embed
 *    the image in the tool result's rendered content),
 * 2. routes them to the configured vision model through a hand-built call
 *    (which does NOT carry the agent-loop mark, so it passes through this
 *    same waterfall untouched — no recursion),
 * 3. rebuilds the request with every image block replaced by the caption
 *    text, at the same nesting depth it was found, and
 * 4. dispatches that rebuilt request to the configured text route (defaulting
 *    to the session's current model or the deployment default) and forwards
 *    its chunk stream to the caller.
 *
 * Intercepted requests are the agent-loop conversation requests (marked with
 * the process-local loop identity) and compaction summarization (which replays
 * the conversation prefix, images included, into the text route). Image blocks
 * never reach the text route's adapter, so a text-only route keeps working on
 * sessions that contain images, and the image-admission gates (host upload
 * preflight, `read_image`) may admit images whenever this gateway is
 * image-capable (see {@link isGatewayImageCapable}).
 *
 * @module @deepseek-ai/dsh-llm-ge-caption
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  contentHasImage,
  createUserMessage,
  isAgentLoopRequest,
  type ContentBlock,
  type GenerateOptions,
  type ImageBlock,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { settingsNamespace, installSettingsSection } from '@deepseek-ai/dsh-settings'
import {
  Config,
  DEFAULT_CAPTION_PROMPT,
  emptyConfig,
  type Config as GeCaptionConfig,
} from './config.ts'

/** Settings namespace owning the gateway configuration. */
export const GE_CAPTION_SETTINGS_NAMESPACE = settingsNamespace('ge-caption')

export { Config, DEFAULT_CAPTION_PROMPT, DEFAULT_CAPTION_MAX_TOKENS } from './config.ts'
export type { Config as GeCaptionConfig, ModelRoute, TextLeg, VisionLeg } from './config.ts'

export const name = 'ge-caption'
export const inject = ['llm']

/**
 * Collect every image block across the request's messages, descending into
 * tool-result content. `read_image` and image-returning MCP tools embed the
 * image inside the tool result's rendered content, so a top-level scan would
 * miss the very images the intercept predicate (recursive `contentHasImage`)
 * detected — leaving them to be rejected by the text route's adapter.
 */
function collectImages(messages: readonly Message[]): ImageBlock[] {
  const images: ImageBlock[] = []
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'image') images.push(block)
      else if (block.type === 'tool-result') walk(block.content)
    }
  }
  for (const message of messages) walk(message.content)
  return images
}

/**
 * Replace every image block — top-level or nested inside tool-result content —
 * with a text block carrying the caption. The same caption replaces every
 * image in the request, mirroring the top-level behavior; sibling blocks
 * (e.g. `read_image`'s envelope text) are preserved.
 */
function replaceImagesWithCaption(messages: readonly Message[], caption: string): Message[] {
  const textBlock: ContentBlock = { type: 'text', text: caption }
  const replace = (blocks: readonly ContentBlock[]): ContentBlock[] =>
    blocks.map((block) => {
      if (block.type === 'image') return textBlock
      if (block.type === 'tool-result') {
        return { ...block, content: replace(block.content) }
      }
      return block
    })
  return messages.map((message) => {
    if (!contentHasImage(message.content)) return message
    return { ...message, content: replace(message.content) }
  })
}

/** Outcome of one caption call: the text, or the reason it could not caption. */
type CaptionOutcome =
  | { readonly ok: true; readonly caption: string }
  | { readonly ok: false; readonly reason: string }

/** Run one vision-model call over the image blocks and collect its text. */
async function captionViaVision(
  ctx: Context,
  images: readonly ImageBlock[],
  vision: NonNullable<GeCaptionConfig['vision']>,
  signal: AbortSignal | undefined,
): Promise<CaptionOutcome> {
  if (vision.provider.length === 0 || vision.model.length === 0) {
    return { ok: false, reason: 'ge-caption: vision provider/model is not configured' }
  }
  const message = createUserMessage({
    content: [
      ...images,
      { type: 'text', text: vision.captionPrompt ?? DEFAULT_CAPTION_PROMPT },
    ],
    source: { kind: 'plugin', plugin: 'ge-caption' },
  })
  const options: GenerateOptions = {
    provider: vision.provider,
    model: vision.model,
    messages: [message],
    ...vision.maxTokens === undefined ? {} : { maxTokens: vision.maxTokens },
    ...signal === undefined ? {} : { signal },
  }
  let caption = ''
  try {
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk.type === 'text-delta') caption += chunk.text
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'aborted') {
          return { ok: false, reason: 'ge-caption: vision caption aborted' }
        }
        if (chunk.reason.kind === 'error') {
          return { ok: false, reason: `ge-caption: vision caption failed: ${chunk.reason.failure.message}` }
        }
      }
    }
  } catch (error: unknown) {
    return { ok: false, reason: `ge-caption: vision caption raised: ${String(error)}` }
  }
  if (caption.trim().length === 0) {
    return { ok: false, reason: 'ge-caption: vision model returned an empty caption' }
  }
  return { ok: true, caption }
}

/**
 * Install the gateway. Reads configuration live from the `ge-caption`
 * settings namespace (falling back to the composition entry), so a settings
 * edit is effective on the next request without a restart.
 * @param ctx - plugin context owning the listener.
 * @param config - composition entry config, used as the settings base layer.
 */
export function apply(ctx: Context, config: Config = emptyConfig()): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, GE_CAPTION_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source: () => Config) => { current = source },
    onChange: () => { /* no registration-level facts depend on the config */ },
  })

  ctx.on('llm/stream', async function* (
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    // Intercept the requests that can carry durable session images:
    //   - agent-loop conversation requests (marked with the loop identity),
    //   - compaction summarization (it replays the conversation prefix,
    //     images included, into the text route — without this the text
    //     adapter would reject the image blocks mid-compaction).
    // Hand-built gateway calls (the caption call and the rebuilt text call)
    // carry neither the loop mark nor `purpose: 'compaction'` and pass
    // through untouched — no recursion. Disabled or image-free requests
    // delegate to the real route.
    if (!isAgentLoopRequest(options) && options.purpose !== 'compaction') {
      yield* next()
      return
    }
    const resolved = current()
    if (!resolved.enabled || !resolved.vision) {
      yield* next()
      return
    }
    if (!options.messages.some(message => contentHasImage(message.content))) {
      yield* next()
      return
    }
    const images = collectImages(options.messages)
    const outcome = await captionViaVision(ctx, images, resolved.vision, options.signal)
    if (!outcome.ok) {
      ctx.logger.warn(outcome.reason)
      // Fail closed: do not hand image blocks to a route that may reject them
      // mid-turn. Surface the caption failure as a terminal error chunk.
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: outcome.reason, code: 'GE_CAPTION_FAILED' },
        },
      }
      return
    }
    const text = resolved.text
    const textOptions: GenerateOptions = {
      ...options,
      provider: text?.provider ?? options.provider,
      model: text?.model ?? options.model,
      messages: replaceImagesWithCaption(options.messages, outcome.caption),
    }
    // Rebuilt request carries no agent-loop mark and keeps its original
    // purpose (compaction stays compaction); it no longer contains images, so
    // the waterfall delegates it straight to the configured text route.
    yield* ctx.llm.stream(textOptions)
  })
}
