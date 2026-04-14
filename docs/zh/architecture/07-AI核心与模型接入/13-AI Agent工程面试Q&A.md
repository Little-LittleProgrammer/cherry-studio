# AI Agent 工程实现 - 面试 Q&A 大全

面向资深前端工程师，基于 Cherry Studio 的工程实践整理。

---

## 一、架构设计类

### Q1. 在一个 AI 桌面应用中，为什么要把 AI 能力分成「执行内核 + 产品编排 + 主进程扩展能力」三层？每层解决什么问题？

**参考答案：**

三层架构的核心是职责分离：

- **执行内核层**（`@cherrystudio/ai-core`）：只关心"如何调用模型"，负责 Provider 注册、模型解析、插件生命周期管理、参数工厂、统一流事件协议。不关心 UI、消息、数据库等任何产品业务实体。
- **产品编排层**（渲染侧 `aiCore/` + `ApiService.ts`）：负责把产品语义（助手配置、MCP 模式、工具可见性、搜索策略、模型兼容策略）转换为可执行的 AI SDK 参数，并装配插件。
- **扩展能力层**（主进程 `MCPService`、`KnowledgeService`、`MemoryService` 等）：提供跨会话、跨窗口、持有敏感凭据的系统级能力，通过 IPC 暴露给渲染层。

这样做的原因：
1. Provider 与模型差异不会污染业务代码
2. 工具调用、搜索、知识记忆可以复用
3. Trace/日志/异常处理可以统一沉淀
4. Agent 与普通对话的链路可以并存

**追问：如果不这样分层，会遇到什么典型问题？**

答：
- Provider 差异散落在业务代码中，每新增一个 provider 就要改一堆业务逻辑
- 工具调用、搜索、知识记忆无法跨场景复用
- Agent 对话和普通聊天共用一套代码会互相耦合
- 错误处理、Trace 追踪无法统一，调试成本极高

---

### Q2. 渲染侧 `AiProvider` 为什么不直接创建 AI SDK 实例，而是采用延迟初始化？

**参考答案：**

`AiProvider` 构造时只做配置转换和缓存，不立即创建 AI SDK Provider 实例。实例创建延迟到 `createExecutor()` 阶段才发生。

这样做的好处：
1. **避免不必要的资源浪费**：构造 `AiProvider` 可能只是为了获取模型列表或检查连通性，不一定真正发起对话
2. **支持延迟获取完整配置**：API Key 轮转等逻辑可能在构造后才确定最终值
3. **保持对象的轻量性**：构造阶段只做数据转换，真正的 Provider 实例化在 aiCore 的 `resolveModel` 阶段完成，且被 LRU 缓存复用

---

### Q3. Cherry Studio 的 Provider 系统如何处理「用户自定义 OpenAI 兼容 Provider」？请描述从用户输入配置到实际发起请求的完整路径。

**参考答案：**

完整路径（以 DashScope 为例）：

1. **用户填写配置** → Redux store 中保存 `Provider` 对象（`id: 'dashscope'`, `type: 'openai'`, `apiHost`, `apiKey`）
2. **ID 映射** → `getAiSdkProviderId()` 返回 `'openai-compatible'`（因为不在预注册列表中，但 type 为 openai）
3. **配置转换** → `providerToAiSdkConfig()` 将 `apiHost` → `baseURL`，构建 `ProviderConfig`
4. **AiProvider 构造** → 持有配置，延迟初始化
5. **参数构建** → `buildStreamTextParams()` 整合消息、工具、参数
6. **插件装配** → `buildPlugins()` 根据 provider/model/config 条件组装插件
7. **进入 aiCore** → `createExecutor('openai-compatible', settings, plugins)`
8. **resolveModel** → `OpenAICompatibleExtension` 创建 Provider 实例（LRU 缓存）
9. **执行请求** → `executor.streamText()` → POST 到 DashScope API
10. **流适配** → `AiSdkToChunkAdapter` 将 AI SDK 事件转为 UI Chunk

**关键点：** 数据形态在每一层都有明确转换，不是透传原始配置。

---

## 二、插件系统类

### Q4. 插件系统的 8 个钩子分为哪四类？各自解决什么问题？

**参考答案：**

| 分类 | 钩子 | 执行策略 | 解决的问题 |
|------|------|---------|-----------|
| **First** | `resolveModel` | 首个返回非 null 的胜出 | 模型解析的 provider 级差异 |
| **First** | `loadTemplate` | 首个返回非 null 的胜出 | 提示词模板加载 |
| **Sequential** | `configureContext` | 每个依次执行 | 向 RequestContext 注入元数据 |
| **Sequential** | `transformParams` | 链式合并 | 参数层层加工 |
| **Sequential** | `transformResult` | 链式传递 | 结果后处理 |
| **Parallel** | `onRequestStart` | Promise.all 并行 | 日志记录、span 创建等副作用 |
| **Parallel** | `onRequestEnd` | Promise.all 并行 | 记忆写回、token 统计等 |
| **Parallel** | `onError` | Promise.all 并行 | 错误日志、span 标记 |
| **Stream** | `transformStream` | 收集所有 TransformStream | 直接接入 AI SDK 的 transform 选项 |

**追问：为什么 transformParams 用链式合并，而 onRequestStart 用并行？**

答：`transformParams` 的返回值需要依次合并到参数对象中，后一个插件的结果依赖前一个的累积输出，必须顺序执行。而 `onRequestStart` 的副作用（如创建 span、记录日志）之间无依赖关系，可以并行，减少延迟。

---

### Q5. PluginManager 的执行顺序中，为什么 `wrapLanguageModel` 会对 middleware 数组执行 `.reverse()`？这带来了什么实际影响？

**参考答案：**

`wrapLanguageModel` 对 middleware 数组执行 `.reverse()`，因此数组中靠前的插件在运行时变成最外层包装。

实际影响：`ReasoningExtractionPlugin` 必须在 `SimulateStreamingPlugin` 之前推入数组，因为反转后 `extractReasoning` 在外层，其状态机才能正确处理 `simulateStreaming` 生成的模拟流中未闭合的 `<thinking>` 标签。如果顺序反了，推理内容提取就会失败。

**这本质上是一个洋葱模型（onion model）问题** —— 请求进入时先经过外层中间件，响应返回时最后经过外层中间件。

---

### Q6. PromptToolUsePlugin 和原生 Function Calling 的递归调用有什么区别？各自的深度控制在哪？

**参考答案：**

| | 原生 Function Calling | Prompt Tool Use 模拟 |
|---|---|---|
| **递归在哪** | AI SDK 内部（`_streamText()` 内） | Cherry Studio `PromptToolUsePlugin` |
| **触发方式** | AI SDK 自动检测模型返回的 tool-call | XML 标签解析后手动调 `recursiveCall()` |
| **谁执行工具** | AI SDK 调 `tools[name].execute()` | `ToolExecutor.executeTools()` |
| **谁回填结果** | AI SDK 自动构造下一轮消息 | 拼 `<tool_use_result>` XML 注入流 |
| **深度控制** | AI SDK `maxSteps` + Cherry Studio `stepCountIs(N)` | `context.maxRecursiveDepth`（默认 10） |
| **是否重新走插件生命周期** | 否 | 是（每轮都重新执行 configureContext/transformParams 等） |

原生模式下递归是 AI SDK 内部闭环，不走 PluginEngine。Prompt 模拟模式每轮递归都重新走完整的插件生命周期。

---

### Q7. SearchOrchestrationPlugin 做了哪三件事？它的意图分析为什么用 XML 结构返回而不是 JSON Schema？

**参考答案：**

SearchOrchestrationPlugin 在三个生命周期钩子中工作：

1. **`onRequestStart`**：发起轻量 `generateText()` 进行意图分析，判断是否需要网页搜索/知识搜索/记忆搜索
2. **`transformParams`**：动态注入对应工具（`KnowledgeSearchTool`、`MemorySearchTool`、`WebSearchTool`）
3. **`onRequestEnd`**：对话结束后异步触发记忆写回流程（不阻塞主回答）

用 XML 结构返回意图分析结果而不是 JSON Schema 的原因：
- **更可靠**：某些模型对 JSON schema 输出的遵循度不稳定，XML 结构更容易通过正则或 DOM 解析做容错
- **失败有回退**：识别失败时回退到用户原始输入作为保底 query
- **降低 token 开销**：XML 比 JSON Schema 更紧凑

---

### Q8. 如何在 PluginBuilder 中新增一个插件？需要考虑哪些因素？

**参考答案：**

步骤：
1. 在 `PluginBuilder.ts` 的 `buildPlugins()` 中添加条件判断，决定何时装配新插件
2. 实现插件逻辑，定义 8 个钩子中需要用到的那些
3. 设置正确的 `enforce` 值（`pre`/`normal`/`post`），确定执行顺序
4. 注意与已有插件的依赖关系（比如必须在某插件之前或之后执行）
5. 考虑是否需要处理递归场景
6. 如果是 transformStream 插件，要考虑和 `reverse()` 带来的外层/内层关系

需要考虑的因素：
- 触发条件是否准确（provider、model、config 维度）
- 是否会影响其他插件的执行（比如参数修改的顺序）
- 流式和非流式是否都需要处理
- 错误处理路径
- 是否需要在 `onRequestEnd` 做清理或异步操作

---

## 三、工具调用与 MCP 类

### Q9. Cherry Studio 中「工具调用」包含哪些类型？各自的注入方式是什么？

**参考答案：**

| 工具类型 | 来源 | 注入方式 |
|---------|------|---------|
| MCP 工具 | 主进程 MCPService | `setupToolsConfig()` → `tools` 参数 |
| 知识库搜索 | 渲染侧 `KnowledgeSearchTool` | 搜索编排插件动态注入 |
| 记忆搜索 | 渲染侧 `MemorySearchTool` | 搜索编排插件动态注入 |
| 网页搜索 | 渲染侧 `WebSearchTool` | 搜索编排插件 / providerToolPlugin |
| Provider 原生工具 | 各 provider 的 toolFactory | providerToolPlugin('webSearch' / 'urlContext') |

**关键区分：** 模型原生 web search 和外部 web search provider 是两套能力。模型原生方式由模型内部执行搜索；外部 provider 方式由 Cherry Studio 调用搜索 API 后把结果给模型。

---

### Q10. 什么是 Hub MCP Server？它解决什么问题？Auto Mode 和 Manual Mode 的对比是什么？

**参考答案：**

Hub MCP Server 是一个**内置的元服务器（meta-server）**，用于聚合所有已激活的 MCP Server，并通过一组通用元工具暴露给 LLM。

核心价值：支撑 **Auto Mode（自动模式）**，让 LLM 能够动态发现和调用所有 MCP 工具，而不需要在每次请求前手动配置工具列表。

对比：

| | Manual 模式 | Hub Auto 模式 |
|---|---|---|
| 工具注入方式 | 将所有 MCP 工具描述完整塞入 system prompt | 只注入 4 个元工具（list/inspect/invoke/exec） |
| 工具发现 | 静态的，请求前决定注入哪些 | 动态的，LLM 通过 list 按需探索 |
| 灵活性 | 新增 MCP Server 后需重新配置助手 | Hub 自动聚合，无需额外配置 |
| 系统 prompt 大小 | 工具多时 prompt 很长 | 固定 4 个工具描述，较轻量 |

四个元工具：
- `list`：分页列出所有可用 MCP 工具
- `inspect`：获取单个工具签名（JSDoc 格式）
- `invoke`：调用单个工具
- `exec`：执行 JS 代码编排多步工具调用（Worker 沙箱隔离）

---

### Q11. Hub MCP Server 的 `exec` 模式为什么使用独立 Worker？它的安全性和超时控制怎么做？

**参考答案：**

`exec` 模式使用独立 Node.js Worker 线程的原因：
1. **沙箱隔离**：用户编写的 JS 代码不应直接访问主进程的全部能力
2. **超时可控**：固定 60 秒超时（`EXECUTION_TIMEOUT`），超时后通过 `abortMcpTool(callId)` 取消所有活跃调用
3. **日志隔离**：Worker 通过 `mcp.log()` / `console.*` 回传，最多 1000 条，避免无限输出

安全控制：
- 代码在 Worker 中执行，不直接持有主进程的 `MCPService` 实例
- 通过 `postMessage` 通信，Worker 请求工具调用需经过主线程的 `callMcpTool` 桥接
- Worker 退出码非 0 或意外退出时，记录错误并标记 `isError: true`

---

### Q12. MCP 的调用链路中，`mcp-bridge` 的作用是什么？工具名称映射怎么做？

**参考答案：**

mcp-bridge 是 Hub Server 和 MCPService 之间的桥接层。Hub 不直接连接外部 MCP Server，而是通过 bridge 路由到具体 MCP Server 实例。

调用链路：
```
HubServer.handleInvoke() → callMcpTool(name, params)
  → resolveToolId(nameOrId)          // "githubSearchRepos" → "github__search_repos"
  → mcpService.callToolById(toolId)  // 通过 __ 分割找到 server 和 tool
  → toolId.split('__') → serverId + toolName
  → 找到对应 MCP Server 实例 → server.client.callTool()
```

工具名称映射支持两种格式：
- **JS 格式（camelCase）**：如 `githubSearchRepos`，方便 LLM 编写代码调用
- **原始命名（namespaced）**：如 `github__search_repos`（`serverId__toolName`）

两者均可用于 `inspect`、`invoke` 和 `mcp.callTool()`。映射关系由 `buildToolNameMapping` 构建，缓存 1 分钟，MCP Server 连接/断开时 `invalidateCache()`。

---

### Q13. MCPService 支持哪些传输方式？内置 Server 和外部 Server 有什么区别？

**参考答案：**

四种传输方式：
1. **StdioClientTransport** — 本地 CLI 工具
2. **SSEClientTransport** — 远程 SSE 服务
3. **StreamableHTTPClientTransport** — 远程 HTTP 服务
4. **InMemoryTransport** — 进程内服务

内置 Server 特例：
| Server | Transport | 用途 |
|--------|-----------|------|
| knowledge | StreamableHTTP | 知识库记忆服务 |
| flomo | StreamableHTTP | Flomo 笔记集成 |
| 其他 builtin | InMemory | 浏览器自动化、Claw、Assistant 等 |

内置 Server 在产品层直接创建并接入，不需要用户配置。外部 Server 需要用户通过 stdio/SSE/HTTP 等方式手动配置。

**追问：MCPService 如何监听 Server 的动态变化？**

答：监听 MCP SDK 的动态通知：`ToolListChanged`、`PromptListChanged`、`ResourceListChanged`、`ResourceUpdated`、`LoggingMessage`。这意味着 MCP server 的工具、资源、提示词不是静态快照，可以在运行中刷新。

---

## 四、流式处理与事件适配类

### Q14. AI SDK 流事件到 UI Chunk 的转换为什么需要 adapter？直接透传会有什么问题？

**参考答案：**

需要 `AiSdkToChunkAdapter` 的原因：

1. **事件格式不统一**：不同 Provider 的流事件格式、字段名、发送顺序不同
2. **UI 不需要感知厂商差异**：UI 只需要消费 `ChunkType` 协议（TEXT_DELTA、THINKING_COMPLETE 等）
3. **兼容逻辑集中处理**：乱序事件、缺失字段、补发 usage 等兼容逻辑在适配层处理
4. **统一消息块生命周期**：文本、thinking、工具调用、Web Search 都进入统一消息块渲染

直接透传的问题：
- UI 组件需要写大量 `switch-case` 处理各厂商差异
- 新增 Provider 时 UI 层需要改
- 工具调用的状态机逻辑散落在 UI 中
- 首 token 计时、idle timeout 等通用逻辑无法复用

---

### Q15. 工具调用在流式场景下有哪些状态？状态机怎么设计？

**参考答案：**

流式工具调用的状态（通过 `ToolCallChunkHandler`）：

```
tool-call (一次性) / tool-input-start → tool-input-delta* → tool-input-end
```

状态机：
- **全局静态 Map** 跟踪活跃工具调用（通过 `toolCallId` 索引）
- **流式参数模式**：`tool-input-start` → 多个 `tool-input-delta` → `tool-input-end`
- **非流式模式**：直接收到 `tool-call`（一次性完整参数）

区分工具类型后发送不同 UI 事件：
- builtin 工具：直接处理
- MCP 工具：`MCP_TOOL_STREAMING` → `MCP_TOOL_PENDING` → `MCP_TOOL_COMPLETE`
- provider 工具：对应事件

**追问：如何从工具输出中提取图片？**

答：`ToolCallChunkHandler` 在处理 `tool-result` 时，会从工具输出中检测图片数据（base64 或 URL），并将其转换为 UI 可渲染的图片块。

---

### Q16. TagExtractor 解决了什么问题？为什么不能直接用正则匹配？

**参考答案：**

TagExtractor 是流式 XML 标签提取器，解决**标签跨多个 stream chunk** 的问题。

流式场景下，一个 `<tool_use>` 标签可能被拆分成多个 chunk：
```
chunk1: "好的，我来调用工具<tool"
chunk2: "_use><name>search</name>"
chunk3: "<result>...</result></tool_use>"
```

不能直接用正则匹配的原因：
- 正则假设标签在完整字符串中，流式场景中标签会被拆分
- 需要缓冲部分数据，检测 `<tag>` 和 `</tag>` 边界
- 需要处理嵌套标签和标签不完整的情况
- 需要实时输出有效内容（非标签部分）给用户

TagExtractor 的处理方式：
- 缓冲部分数据，跟踪标签开闭状态
- 当检测到完整标签时，提取内容并发送事件
- 未闭合时继续等待后续 chunk
- 非标签内容直接输出

---

## 五、模型参数与能力适配类

### Q17. 不同模型的推理能力（reasoning/thinking）参数不同，Cherry Studio 怎么统一处理？

**参考答案：**

通过 `getReasoningEffort()` 函数将 `assistant.settings.reasoning_effort` 映射到 20+ 模型家族的正确参数形状：

- **OpenAI 系列** → `reasoning_effort: 'low' | 'medium' | 'high'`
- **Anthropic** → `thinking: { type: 'enabled' }, budget_tokens: N`
- **Gemini** → `thinking_config: { thinking_budget: N }`
- **Qwen3** → 在模型 ID 后追加 `/think` 或 `/no_think` 后缀（通过 `QwenThinkingPlugin`）
- **OpenRouter** → 清洗 `[REDACTED]` 推理内容块（通过 `OpenrouterReasoningPlugin`）

关键设计：产品层只表达「需要推理能力」和「推理强度」，具体的参数形状由各 provider 的 options factory 处理。

---

### Q18. `buildStreamTextParams()` 这个函数决定哪些关键东西？为什么说它是参数准备的"总装配"？

**参考答案：**

`buildStreamTextParams()` 决定的关键事项：

1. **工具调用可用性**：通过 `setupToolsConfig()` 配置 MCP 工具
2. **文件输入可用性**：通过 `fileProcessor` 处理文件/图片
3. **模型专属参数**：温度、topP、maxTokens、timeout（IdleTimeoutController）
4. **推理能力**：`enableReasoning` → 映射到 20+ 模型家族的正确参数
5. **Web 搜索**：模型原生搜索 vs 外部 web search provider
6. **URL 上下文**：Anthropic urlContext / Google urlContext
7. **最大工具调用次数**：`stepCountIs` 设置
8. **MCP auto-mode system prompt 注入**
9. **Anthropic beta headers**

说是"总装配"因为它整合了所有子模块的输出，生成最终的 AI SDK 参数对象。它是产品语义到执行协议的唯一转换点。

---

### Q19. 为什么 Cherry Studio 始终使用 `streamText` 而不是 `generateText`？无回调时怎么处理？

**参考答案：**

始终使用 `streamText` 的原因：
1. **统一的流协议**：所有路径都走流式，保证 Chunk 适配层的一致性
2. **真实的错误诊断**：流式消费可以保留更精确的错误上下文
3. **避免两套代码维护**：不需要同时维护流式和非流式的处理逻辑

无 `onChunk` 回调时（如获取文本摘要等场景），通过 `consumeStream()` 强制消费流，返回 `getText()` + `usage`，而不是调用 `generateText`。

---

## 六、AI SDK 协议标准化类

### Q20. Cherry Studio 的「AI SDK 协议标准化」具体指什么？它不是定义行业标准，那到底是什么？

**参考答案：**

"AI SDK 协议标准化"是为 Cherry Studio 建立统一执行面，使上层编排和 UI 不需要直接面向 OpenAI、Anthropic、Google 等供应商的原生协议。

两层转换：
1. **ai-core 层**：把"多厂商协议"收敛成"统一执行协议"
   - 统一输入：`model`、`messages`、`system`、`tools`、`toolChoice` 等
   - 统一输出：`text`、`reasoning`、`tool-call`、`finishReason`、`usage`
   - 统一流事件：`text-start/delta/end`、`reasoning-*`、`tool-*`
2. **渲染层**：把"统一执行协议"转换成"产品交互协议"
   - AI SDK 事件 → `ChunkType`（TEXT_DELTA、THINKING_COMPLETE 等）

关键原则：
- ai-core 负责模型协议归一，**不**负责页面状态与交互细节
- 渲染层负责编排产品参数，**不**直接拼厂商 HTTP Body
- 主进程负责系统资源和持久化，**不**参与 UI Chunk 协议
- UI 层只消费统一 Chunk，**不**耦合厂商原生返回格式

---

### Q21. 不同模型类型（Language/Image/Embedding/Speech）的协议差异在哪？统一执行框架怎么处理？

**参考答案：**

它们共享「统一注册、统一解析、统一执行入口」的框架，但协议重点不同：

| 模型类型 | 协议重点 |
|---------|---------|
| Language | `messages`、`tools`、流式文本、reasoning、finish reason、usage |
| Image | 提示词、尺寸/质量等生成参数、URL/Base64 图像结果 |
| Embedding | 输入文本到向量结果的稳定映射，不涉及 messages |
| Reranking | query、候选文档列表和排序分数 |
| Speech/Transcription | 音频输入、分片传输、文本输出、时间戳元数据 |

不是把所有模型压成同一个字段集合，而是为每类模型定义统一的执行抽象和错误边界。

---

## 七、错误处理与可观测性类

### Q22. aiCore 的错误模型怎么设计？为什么需要自定义错误类？

**参考答案：**

错误类体系：
| 错误类 | 触发场景 |
|--------|---------|
| `AiCoreError` | 所有 aiCore 错误的基类，提供 `toJSON()` 序列化 |
| `RecursiveDepthError` | 插件递归调用超过最大深度（默认 10） |
| `ModelResolutionError` | 模型 ID 无法解析为有效模型对象 |
| `ParameterValidationError` | 参数校验失败 |
| `PluginExecutionError` | 插件执行过程中抛出异常 |
| `ProviderConfigError` | Provider 配置缺失或格式错误 |
| `ImageGenerationError` | 图像生成失败 |
| `TemplateLoadError` | 提示词模板加载失败 |

为什么需要自定义错误类：
1. **可诊断**：每种错误有明确的类型和上下文信息
2. **可归因**：调用方可以根据错误类型决定重试策略（如 ModelResolutionError 不应重试，ParameterValidationError 需要修正参数）
3. **可观测**：通过 `toJSON()` 序列化用于 Trace 和日志
4. **分层隔离**：aiCore 的错误不应直接暴露给 UI，中间层可以做转换和降级

---

### Q23. TelemetryPlugin 如何工作？Developer Mode 下的 Trace 是怎么关联到具体请求的？

**参考答案：**

TelemetryPlugin 在三个钩子中工作：

1. **`configureContext`**：注入 tracer 到 RequestContext
2. **`onRequestStart`**：创建 OpenTelemetry span
3. **`onRequestEnd` / `onError`**：结束 span，标记状态

触发条件：developer mode 开启 + 存在 `topicId`。

通过 `AiSdkSpanAdapter` 将 AI SDK 的 span 转换为 Cherry Studio 格式（`SpanEntity`），供 `SpanCacheService` 持久化。IPC 调用通过 `tracedInvoke()` 携带 span 上下文。

---

## 八、实战设计类

### Q24. 如果让你设计一个「支持模型原生 Web Search + 外部 Web Search Provider 共存」的系统，你会怎么做？

**参考答案：**

核心是区分两套能力并让用户可以选择：

**架构设计：**
1. 模型原生 web search：通过 `providerToolPlugin('webSearch', config)` 注入，由模型内部执行搜索，结果直接在模型响应中
2. 外部 web search provider：通过 `searchOrchestrationPlugin` 注入 `WebSearchTool`，由 Cherry Studio 调用搜索 API 后把结果作为上下文给模型

**决策逻辑：**
- 优先使用模型原生搜索（如果 provider 支持且用户开启）
- 如果模型不支持或用户关闭，回退到外部 provider
- 两者可以同时开启时，原生搜索优先，外部 provider 作为补充

**注入时机：**
- 原生搜索：在 `transformParams` 阶段注入到 `tools` 或 `providerOptions`
- 外部 provider：在 `searchOrchestrationPlugin.onRequestStart` 中做意图分析，`transformParams` 中动态注入 `WebSearchTool`

**UI 层统一：** 两种搜索结果都转换为相同的 Chunk 类型和消息块结构，UI 不感知差异。

---

### Q25. 如果一个新 Provider 需要接入，且它不支持原生 Function Calling，你需要改动哪些地方？

**参考答案：**

需要改动的地方（从少到多）：

1. **Provider Extension 注册**（如果不在已有的 17+ 扩展中）：
   - 在 `initialization.ts` 定义新的 ProviderExtension
   - 声明 baseId、aliases、variants、toolFactories

2. **Provider 配置转换**（渲染侧）：
   - 在 `providerConfig.ts` 添加对应的 config builder
   - 处理 API Host 格式化

3. **Provider ID 映射**：
   - 在 `factory.ts` 添加 ID 映射逻辑（如果需要特殊处理）

4. **插件兼容**（如果需要特殊处理）：
   - 在 `PluginBuilder.ts` 添加条件判断，决定是否启用 PromptToolUsePlugin
   - 如果该 provider 有特殊的思考模式或参数格式，可能需要新增兼容插件

5. **Provider Options**：
   - 在 `options.ts` 添加 `buildXXXProviderOptions` 函数

6. **模型列表获取**：
   - 在 `listModels.ts` 添加该 provider 的响应格式解析

**不需要的改动：** aiCore 执行内核本身不需要改，因为 PromptToolUsePlugin 已经处理了不支持原生 Function Calling 的情况。

---

### Q26. 如何排查「工具调用后模型没有继续生成文本」的问题？你会看哪些日志和 Trace？

**参考答案：**

排查步骤：

1. **确认工具调用是否成功**：
   - 看 MCP 日志（`ServerLogBuffer`）确认工具是否被正确调用
   - 检查 IPC 事件流中是否有 `MCP_TOOL_COMPLETE` 或 `MCP_TOOL_ERROR`

2. **确认工具结果是否回填**：
   - 原生模式：检查 AI SDK 是否正确将 tool-result 回填给模型
   - Prompt 模式：检查 `<tool_use_result>` XML 是否正确注入流

3. **检查递归调用是否触发**：
   - 原生模式：检查 `maxSteps` 和 `stepCountIs(N)` 配置
   - Prompt 模式：检查 `recursiveDepth` 是否达到 `maxRecursiveDepth`

4. **检查流事件是否正常消费**：
   - 看 `AiSdkToChunkAdapter` 的日志，确认 chunk 是否正确转换
   - 检查 `StreamProcessingService` 是否正确分发事件

5. **Trace 侧**：
   - 查看 OpenTelemetry span，确认请求是否完整走完
   - 看每个阶段的耗时，定位卡在哪一步

6. **模型侧**：
   - 某些模型在收到工具结果后可能直接结束而不生成文本，这是模型行为而非 bug

---

### Q27. 如果要在渲染侧新增一个「代码执行工具」，从产品需求到上线需要走哪些步骤？

**参考答案：**

步骤：

1. **定义工具接口**：
   - 在 `aiCore/tools/` 下创建 `CodeExecutionTool.ts`
   - 定义 JSON Schema（输入参数描述）
   - 实现 `execute()` 方法

2. **注册到工具配置**：
   - 在 `setupToolsConfig()` 中将新工具添加到 MCP 工具列表
   - 定义可见性规则（哪些助手/模型可用）

3. **决定注入方式**：
   - 如果模型支持原生 Function Calling → 通过 `tools` 参数注入
   - 如果不支持 → 通过 `PromptToolUsePlugin` 的 XML 协议注入

4. **主进程支持（如果需要）**：
   - 如果代码执行需要系统级能力（如文件读写、网络访问），需要在主进程实现并通过 IPC 暴露
   - 或使用 Worker 沙箱隔离执行

5. **UI 支持**：
   - 添加工具调用状态的渲染组件（执行中/成功/失败）
   - 处理代码执行结果的展示（代码块、输出、错误）

6. **测试与可观测性**：
   - 编写测试用例覆盖正常路径和异常路径
   - 确保 TelemetryPlugin 能追踪代码执行 span
   - 添加日志埋点

7. **上线**：
   - 通过 feature flag 灰度发布
   - 监控工具调用成功率和性能指标

---

## 九、性能与优化类

### Q28. Provider 实例化的 LRU 缓存机制是怎么工作的？为什么要用 stableStringify 做 key？

**参考答案：**

ProviderExtension 使用 LRU 缓存（max 10）+ pending promise map 防止并发重复创建：

1. 合并 settings（defaultOptions ∪ 传入的 settings）
2. 计算 stable hash（`stableStringify(mergedSettings)`）
3. 查 LRU cache → 命中则直接返回，未命中则创建
4. 调 `create` 函数创建 Provider 实例
5. 写入 LRU cache

用 `stableStringify` 的原因：
- 对象属性顺序不固定时，普通 JSON.stringify 会产生不同字符串
- `stableStringify` 保证相同内容产生相同 hash，避免重复创建
- 支持深合并后的稳定比较

**追问：为什么还要用 pending promise map？**

答：防止并发场景下多个请求同时创建相同配置的 Provider。当第一个请求正在创建 Provider 时，后续请求会等待同一个 promise 而不是重复创建。

---

### Q29. 文件/图片上传到 AI 模型时，Cherry Studio 怎么处理大文件问题？

**参考答案：**

通过 `fileProcessor.ts` 处理：

1. **PDF 原生 FilePart 支持**：OpenAI/Anthropic/Gemini 支持原生 PDF，直接传 FilePart
2. **大文件处理**：通过 Gemini File API / OpenAI file upload 上传大文件，获取文件 ID 后在消息中引用
3. **base64 图片剥离**：防 HTTP 413，通过 `messageConverter` 检测过大的 base64 图片并降级处理
4. **文本提取降级**：如果无法提取内容，降级为纯文本提示

在 `buildStreamTextParams()` 中通过 `fileProcessor` 和 `modelCapabilities.ts` 检测模型能力（`supportsLargeFileUpload()`、`getFileSizeLimit()`），采用白名单+黑名单模式。

---

### Q30. IdleTimeoutController 在 AI 请求中起什么作用？为什么每次收到 chunk 都要 reset？

**参考答案：**

IdleTimeoutController 控制 AI 请求的空闲超时。每次收到 chunk 时 reset 超时计数器，因为：

1. **流式场景下，chunk 之间可能间隔很长**：模型生成内容时，两个 chunk 可能间隔几秒
2. **真正的超时是"长时间没有收到任何数据"**：如果只是生成慢不应该超时
3. **reset 保证只在连接断开或服务端卡死时才触发超时**

配合 `streamText` 始终使用的策略，保证了即使在没有 `onChunk` 回调的场景下也能正确消费流和诊断错误。

---

## 十、综合与进阶类

### Q31. 请描述一个用户发送消息到收到 AI 回复的完整链路（包含工具调用场景）。

**参考答案：**

```
1. 用户点击发送 → Redux Thunk dispatch(sendNewMessage())
2. messageThunk → 调用 ApiService.transformMessagesAndFetch()
3. transformMessagesAndFetch():
   a. ConversationService.prepareMessagesForModel() → modelMessages + uiMessages
   b. 替换 prompt 变量
   c. 检测专用图像生成模型 → 路由到 fetchImageGeneration()
   d. 注入知识搜索 prompt
   e. 调用 fetchChatCompletion()
4. fetchChatCompletion():
   a. 获取 provider（含 API key 轮转）
   b. 创建 AiProvider 实例
   c. 获取 MCP 工具列表（若启用工具调用）
   d. buildStreamTextParams() → AI SDK 参数
   e. buildAiSdkMiddlewareConfig() → 能力标志
   f. 包装 onChunkReceived 回调
   g. AI.completions() → AiProvider.completions()
5. AiProvider.completions():
   a. buildPlugins() → 插件数组
   b. createExecutor(providerId, settings, plugins)
   c. executor.streamText()
6. aiCore PluginEngine:
   a. configureContext → onRequestStart → resolveModel → transformParams
   b. [AI SDK streamText() → HTTP 请求 → 模型 API]
7. 模型返回流式响应 → AI SDK TextStreamPart 流
8. AiSdkToChunkAdapter:
   a. text-delta → TEXT_DELTA
   b. tool-call → 委托 ToolCallChunkHandler
   c. ToolCallChunkHandler → MCP_TOOL_STREAMING → IPC → UI
   d. 工具执行 → 结果注入流
9. StreamProcessingService 分发 Chunk → UI 增量渲染
10. 流结束 → BLOCK_COMPLETE + LLM_RESPONSE_COMPLETE（含 usage）
11. SearchOrchestrationPlugin.onRequestEnd → 异步触发记忆写回
```

---

### Q32. Cherry Studio 的 AI 架构中，哪些地方用了策略模式/工厂模式？为什么要用？

**参考答案：**

| 设计模式 | 位置 | 为什么用 |
|---------|------|---------|
| **策略模式** | `providerToAiSdkConfig()` | 每种 provider 类型有独立的 config builder |
| **策略模式** | `listModels.ts` | 各 Provider API 的模型列表响应格式不同 |
| **工厂模式** | `options/factory.ts` | 创建 provider 专属 options，按类型分发 |
| **工厂模式** | `tools/` 目录 | WebSearchTool、KnowledgeSearchTool、MemorySearchTool 工厂 |
| **工厂模式** | `provider/extensions/` | ProviderExtension 的 create 函数 |
| **工厂模式** | `provider/factory.ts` | getAiSdkProviderId() 映射 |
| **扩展注册** | `ExtensionRegistry` | 声明式注册，自动发现 |
| **变体模式** | Provider variant 机制 | 同一 Provider 多个 variant（如 openai-chat、openai-responses） |

共同目标：避免 if-else 链膨胀，新增 provider/工具时只需注册新策略而不改已有代码。

---

### Q33. 如果你是团队 Tech Lead，你会怎么评估一个前端工程师是否具备参与 Cherry Studio AI Agent 开发的能力？

**参考答案：**

我会关注以下几个维度：

1. **分层思维**：能否清晰区分「执行层」「编排层」「扩展层」的职责，不会把业务逻辑塞到执行内核
2. **异步流处理能力**：对 ReadableStream、TransformStream、async iterator 有深入理解，能处理复杂的流式事件
3. **插件/中间件设计经验**：理解洋葱模型、中间件执行顺序、副作用管理
4. **协议抽象能力**：能把多厂商差异收敛为统一协议，而不是到处写 switch-case
5. **状态机设计能力**：工具调用的流式状态管理需要精确的状态机
6. **错误处理策略**：知道不同类型的错误需要不同的重试/降级策略
7. **IPC 与跨进程通信经验**：理解渲染层和主进程的边界
8. **类型安全实践**：在 TypeScript 中正确使用泛型、类型守卫、条件类型

**具体测试方式：**
- 让他设计一个插件系统的钩子调度器
- 让他处理一个流式场景下标签跨 chunk 的问题
- 让他描述从用户输入到 AI 回复的完整数据流

---

### Q34. AI Agent 开发中，「递归工具调用」容易踩哪些坑？

**参考答案：**

常见坑：

1. **无限递归**：模型反复调用同一工具，没有终止条件。需要 `maxSteps` 或 `maxRecursiveDepth` 限制
2. **参数累积丢失**：递归调用时上下文（如消息历史）没有正确传递，导致模型"遗忘"之前的工具结果
3. **Usage 统计错误**：多轮递归调用的 token 消耗需要跨轮次累积，否则计费不准确
4. **插件生命周期重复执行**：Prompt 模式下每轮递归都重新走完整的插件生命周期，可能产生重复副作用（如重复创建 span）
5. **流事件乱序**：多轮递归的流事件如果没有正确的顺序控制，UI 会渲染出错误的输出
6. **中止控制遗漏**：用户取消请求时，需要正确中断所有活跃的递归调用和工具执行
7. **ProviderMetadata 合并**：每轮递归可能返回不同的 metadata，需要正确合并

---

### Q35. 如何理解「AI SDK 协议标准化」不是追求抽象层数本身？

**参考答案：**

这句话的意思是：协议标准化的目标是**把供应商差异隔离在可维护、可测试、可扩展的边界内**，而不是为了抽象而抽象。

反例（过度抽象）：
- 把所有可能的字段都塞进一个统一接口，导致大量可选字段
- 抽象层级太多，新增功能需要改 N 个文件
- 抽象层引入了不必要的性能损耗

正确做法：
- 只抽象**真正会变化的部分**（Provider 差异、模型类型差异）
- **保持接口稳定**（输入协议、输出协议、流事件协议）
- **边界清晰**（ai-core 做什么、不做什么，渲染层做什么、不做什么）
- **可测试**（每个层的输入输出可 mock）

在 Cherry Studio 中，标准化的意义是：
- 新增 Provider 不改 UI 代码
- 新增工具不改 aiCore 代码
- UI 渲染不直接感知厂商差异

---

## 附录：面试评估维度参考

| 维度 | 初级 | 中级 | 高级 |
|------|------|------|------|
| **架构理解** | 知道分层，说不清边界 | 能画出完整架构图 | 能分析分层的原因和权衡 |
| **插件设计** | 了解概念 | 能实现简单插件 | 能设计完整的插件生命周期 |
| **流式处理** | 知道 SSE | 能处理基本流 | 能处理跨 chunk、标签提取、状态机 |
| **工具调用** | 知道 Function Calling | 理解两条路径 | 能对比两种递归控制的优劣 |
| **协议抽象** | 直接透传原始数据 | 做过简单的格式转换 | 能设计统一协议并处理边界情况 |
| **错误处理** | try-catch | 区分错误类型 | 能设计错误模型和重试策略 |
| **性能意识** | 无明显性能意识 | 知道缓存、LRU | 能分析流式场景的性能瓶颈 |
