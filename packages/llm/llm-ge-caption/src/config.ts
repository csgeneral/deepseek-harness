/**
 * Configuration for the vision-to-text gateway middleware.
 *
 * The gateway short-circuits agent-loop requests whose messages carry image
 * blocks: it routes the images to a configured vision model, collects the
 * caption text, then rebuilds the request with the images replaced by that
 * caption and dispatches it to the configured text model. The image blocks
 * never reach the text route's adapter, so a text-only route keeps working on
 * sessions that contain images.
 *
 * @module dsh-llm-ge-caption/config
 */

import z from '@deepseek-ai/schemastery'

/** One provider/model route pair. */
export interface ModelRoute {
  /** Registered provider route (e.g. a `llm-pi-ai` route). */
  provider: string
  /** Model id the route accepts. */
  model: string
}

/** Vision leg of the gateway: where image blocks go to become text. */
export interface VisionLeg extends ModelRoute {
  /** Instruction sent beside the images; defaults to {@link DEFAULT_CAPTION_PROMPT}. */
  captionPrompt?: string
  /** Maximum output tokens for the caption call; defaults to 1024. */
  maxTokens?: number
}

/** Text leg of the gateway: where the caption-augmented request goes to reason. */
export interface TextLeg extends ModelRoute { }

/** Plugin configuration as written to the `ge-caption` settings namespace. */
export interface Config {
  /** Master switch; when false every request passes through untouched. */
  enabled: boolean
  /** Vision model that converts image blocks to text. */
  vision?: VisionLeg
  /**
   * Text model that reasons over the caption. When omitted, the gateway keeps
   * the request's own provider/model (the session's current model).
   */
  text?: TextLeg
}

/** Default caption instruction; asks for a complete, faithful description. */
export const DEFAULT_CAPTION_PROMPT = '请用中文详细描述这张图片的内容，包括其中的文字、物体、布局、颜色、人物动作等，尽量完整准确，只输出描述本身。'

/** Default output cap for the caption call. */
export const DEFAULT_CAPTION_MAX_TOKENS = 1024

const route = z.object({
  provider: z.string().required(),
  model: z.string().required(),
})

const visionLeg = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  captionPrompt: z.string(),
  maxTokens: z.number().step(1).min(1),
})

/** Runtime schema for {@link Config}. Every leg is optional at load; the settings layer supplies them. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  vision: visionLeg,
  text: route,
})

/** Empty route used when the plugin is composed without config. */
export function emptyConfig(): Config {
  return {
    enabled: true,
  }
}

/**
 * Whether a resolved configuration makes the gateway able to carry images for
 * a text-only route: enabled with a fully specified vision leg. Image-admission
 * gates (host upload preflight, `read_image`) consult this when the session's
 * current model declares no image input: if the gateway is image-capable, the
 * gate may admit the image because the gateway will turn it into caption text
 * before it ever reaches the text route's adapter.
 * @param config - the resolved `ge-caption` section.
 * @returns whether the gateway can convert images to text.
 */
export function isGatewayImageCapable(config: Config | undefined): boolean {
  return config?.enabled === true
    && config.vision !== undefined
    && config.vision.provider.length > 0
    && config.vision.model.length > 0
}
