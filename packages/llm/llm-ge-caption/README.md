# `@deepseek-ai/dsh-llm-ge-caption`

English | [中文](README.zh.md)

Vision-to-text gateway middleware for the DeepSeek Harness. When an agent-loop
request carries image blocks (uploaded attachments or `read_image` tool
results), the gateway routes the images to a configured vision model, collects
the caption text, then rebuilds the request with the images replaced by that
caption and dispatches it to the configured text route. Image blocks never
reach the text route's adapter, so a text-only route (DeepSeek official) keeps
working on sessions that already contain images.

## How it works

The plugin listens on the `llm/stream` waterfall — the single extension point
every streaming model call passes through. It intercepts only agent-loop
requests (detected through the loop's process-local request mark), so:

1. A request whose messages contain no image block passes through untouched.
2. A request with image blocks is short-circuited:
   - the gateway collects the image blocks — both top-level ones and those
     nested inside tool-result content (`read_image` and image-returning MCP
     tools embed the image in the tool result's rendered content),
   - issues a **hand-built** vision call (no loop mark, so it passes through
     this same waterfall without recursion) and collects the caption text,
   - rebuilds the request replacing every image block with that caption text
     at the same nesting depth it was found (a tool result keeps its envelope
     text, with the image replaced by the caption),
   - dispatches the rebuilt request to the configured text route and forwards
     its chunk stream to the loop.
3. The caption call and the rebuilt text call are hand-built, so they never
   re-enter the interception path.

Failures fail closed: if the vision leg is unconfigured, aborts, errors, or
returns an empty caption, the gateway yields a terminal `error` finish chunk
instead of handing image blocks to a route that might reject them mid-turn.

## Configuration

Configuration lives in the `ge-caption` settings namespace (the same
`settings.yaml`/web Models surface as other plugins) and is read live on every
request — no restart needed. The composition entry is the settings `base`.

```yaml
- id: ge-caption
  name: '@deepseek-ai/dsh-llm-ge-caption'
  config:
    enabled: true
    vision:
      provider: my-vision-route   # any registered provider, e.g. a llm-pi-ai route
      model: qwen3-vl-flash
      # optional: captionPrompt overrides the default instruction
      # optional: maxTokens caps the caption call output
    text:
      provider: deepseek-official
      model: deepseek-v4-flash
```

- `enabled` (default `true`): master switch.
- `vision.provider` / `vision.model`: the vision route that converts images to
  text. It must be a registered provider route whose model declares `image`
  input (see the providers guide: a custom pi-ai route declares
  `input: [text, image]` once). The caption call requires the durable
  attachment service, which resolves the image bytes per request.
- `vision.captionPrompt`: the instruction sent beside the images. Defaults to a
  Chinese description instruction.
- `vision.maxTokens`: output cap for the caption call. Defaults to 1024.
- `text.provider` / `text.model`: the text route that reasons over the caption.
  When omitted, the gateway keeps the request's own provider/model — the
  session's current model.

### Example: DeepSeek text route + Alibaba Cloud Bailian vision route

Configure a pi-ai vision route (dormant until a `llm-pi-ai:` settings section
supplies it) and point the gateway at it:

```yaml
llm-pi-ai:
  providers:
    bailian:
      displayName: Bailian Vision
      apiKeyEnv: BAILIAN_API_KEY
      api: openai-completions
      baseURL: https://<workspace>.maas.aliyuncs.com/compatible-mode/v1
      models:
        - id: qwen3-vl-flash
          name: Qwen3-VL-Flash
          input: [text, image]
ge-caption:
  enabled: true
  vision:
    provider: bailian
    model: qwen3-vl-flash
  text:
    provider: deepseek-official
    model: deepseek-v4-flash
```

Store `BAILIAN_API_KEY` in the managed credentials (`$DSH_HOME/.credentials.yaml`
or the web Models page). The DeepSeek official adapter stays text-only; images
enter the session through the vision route's `image` declaration, and the
gateway keeps them out of the DeepSeek request.

## Model Experience

### What the model sees

The vision caption becomes a text block in place of each image block, so the
text model reads a faithful description of every image plus the original
conversation text. A caption failure surfaces as a terminal error on the
request, never as a partial or silent image drop.

### Token effect

Each image-bearing request costs one caption call on the vision route (input =
image tokens + prompt, output ≤ `vision.maxTokens`) plus the ordinary text
request. Caption output is not cached across turns: every request with images
re-describes them. Turn around a caption caching policy here if image-heavy
sessions matter.
