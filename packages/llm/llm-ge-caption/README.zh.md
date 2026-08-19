# `@deepseek-ai/dsh-llm-ge-caption`

[English](README.md) | 中文

DeepSeek Harness 的视觉转文本网关中间件。当 agent-loop 请求携带图片块（上传的附件或
`read_image` 工具结果）时，网关把图片交给配置好的视觉模型，收集描述文本，然后用该描述
替换请求中的图片块，再把重建后的请求交给配置的文本路由。图片块永远不会到达文本路由的
适配器，因此纯文本路由（DeepSeek 官方）在已经含图的会话上也能继续工作。

## 工作原理

插件监听 `llm/stream` waterfall —— 所有流式模型调用都要经过的唯一扩展点。它只拦截
agent-loop 请求（通过 loop 的进程本地请求标记识别），因此：

1. 不含图片块的请求原样放行。
2. 含图片块的请求被短路：
   - 网关收集图片块——包括顶层图片块，以及嵌套在 tool-result 内容里的图片块
     （`read_image` 和返回图片的 MCP 工具会把图片嵌在工具结果渲染内容里），
   - 发起一次**手写**视觉调用（无 loop 标记，因此不会递归进入同一 waterfall），收集描述文本，
   - 重建请求，把每个图片块替换为描述文本（保持原有嵌套深度：工具结果的
     信封文本保留，图片原位替换为描述），
   - 把重建后的请求交给配置的文本路由，并把它的 chunk 流转发给 loop。
3. 视觉调用和重建后的文本调用都是手写调用，永远不会再次进入拦截路径。

失败时 fail-closed：如果视觉端未配置、被中止、出错或返回空描述，网关会产出终止
`error` finish chunk，而不是把图片块交给可能在轮次中途拒绝它们的路由。

## 配置

配置位于 `ge-caption` settings 命名空间（与其他插件共用同一个
`settings.yaml`/Web Models 页面），每个请求实时读取，无需重启。组合条目即 settings 的
`base` 层。

```yaml
- id: ge-caption
  name: '@deepseek-ai/dsh-llm-ge-caption'
  config:
    enabled: true
    vision:
      provider: my-vision-route   # 任意已注册 provider，例如 llm-pi-ai 路由
      model: qwen3-vl-flash
      # 可选：captionPrompt 覆盖默认指令
      # 可选：maxTokens 限制描述调用的输出
    text:
      provider: deepseek-official
      model: deepseek-v4-flash
```

- `enabled`（默认 `true`）：总开关。
- `vision.provider` / `vision.model`：把图片转成文本的视觉路由。必须是已注册的 provider
  路由，且其模型声明 `image` 输入（参见 providers 指南：自定义 pi-ai 路由声明一次
  `input: [text, image]`）。描述调用依赖持久 attachment 服务，按请求解析图片字节。
- `vision.captionPrompt`：图片旁的指令。默认是一段中文描述指令。
- `vision.maxTokens`：描述调用的输出上限。默认 1024。
- `text.provider` / `text.model`：基于描述进行推理的文本路由。省略时沿用请求自身的
  provider/model —— 即会话当前模型。

### 示例：DeepSeek 文本路由 + 阿里云百炼视觉路由

配置一个 pi-ai 视觉路由（在 `llm-pi-ai:` settings 段提供 profile 之前保持休眠），并让
网关指向它：

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

把 `BAILIAN_API_KEY` 存入受管凭据（`$DSH_HOME/.credentials.yaml` 或 Web Models 页面）。
DeepSeek 官方适配器保持纯文本；图片通过视觉路由的 `image` 声明进入会话，而网关让它们
始终不进入 DeepSeek 请求。

## 模型体验

### 模型看到什么

视觉描述会作为文本块替代每个图片块，因此文本模型读到的是每张图片的忠实描述加原始对话
文本。描述失败会在请求上表现为终止错误，绝不会是部分或静默丢图。

### Token 影响

每个含图请求都会在视觉路由上产生一次描述调用（输入 = 图片 token + 指令，输出 ≤
`vision.maxTokens`），外加普通文本请求。描述输出跨轮次不缓存：每个含图请求都会重新描述
图片。如果图片密集的会话很重要，可在此基础上增加描述缓存策略。
