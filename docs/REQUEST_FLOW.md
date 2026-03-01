# Cherry Studio 请求流程完整指南

本文档详细描述了 Cherry Studio 项目从用户发起请求到界面展示的完整流程，涵盖所有功能模块。

## 目录

1. [项目架构概述](#1-项目架构概述)
2. [进程间通信 (IPC)](#2-进程间通信-ipc)
3. [请求发起流程](#3-请求发起流程)
4. [AI 核心处理流程](#4-ai-核心处理流程)
5. [中间件系统](#5-中间件系统)
6. [Chunk 类型与流式处理](#6-chunk-类型与流式处理)
7. [MCP 工具调用机制](#7-mcp-工具调用机制)
8. [RAG 知识库](#8-rag-知识库)
9. [全局记忆系统](#9-全局记忆系统)
10. [异常处理机制](#10-异常处理机制)
11. [状态管理](#11-状态管理)
12. [界面展示流程](#12-界面展示流程)

---

## 1. 项目架构概述

Cherry Studio 是一个基于 **Electron** 的跨平台 AI 桌面应用，采用 **Electron-Vite** 构建系统，使用 **pnpm workspaces** 管理依赖。

```
┌─────────────────────────────────────────────────────────────┐
│                        主进程 (Main Process)                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ MCPService   │  │KnowledgeService│  │ MemoryService │    │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ FileService  │  │ WindowService │  │  API Server   │    │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
└─────────────────────────────────────────────────────────────┘
                            │ IPC
┌─────────────────────────────────────────────────────────────┐
│                      预加载脚本 (Preload)                    │
│              contextBridge.exposeInMainWorld               │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│                    渲染进程 (Renderer Process)              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │  React UI    │  │ Redux Store   │  │  AI Core     │    │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### 1.1 核心目录结构

| 目录 | 说明 |
|------|------|
| `src/main/` | 主进程 (Node.js 后端) |
| `src/preload/` | 预加载脚本 (IPC 桥接) |
| `src/renderer/` | 渲染进程 (React 前端) |
| `packages/shared/` | 共享类型和常量 |
| `packages/aiCore/` | AI SDK 核心包 |

### 1.2 渲染进程核心模块

```
src/renderer/src/
├── aiCore/                    # AI 核心处理逻辑
│   ├── legacy/               # 旧的 AI Provider 实现
│   │   ├── clients/          # 各种 API 客户端 (OpenAI, Anthropic, Gemini 等)
│   │   ├── middleware/       # 中间件系统
│   │   └── index.ts          # 主入口
│   ├── index_new.ts          # 新的 AI Provider (aisdk v6)
│   ├── tools/                # 工具 (知识库搜索、记忆搜索、Web搜索)
│   ├── chunk/                # Chunk 适配器
│   └── plugins/              # AI SDK 插件
├── store/                    # Redux 状态管理
│   ├── thunk/               # Redux Thunk
│   └── *.ts                 # Store slices
├── services/                 # 渲染进程服务
│   ├── StreamProcessingService.ts   # 流处理服务
│   └── messageStreaming/    # 消息流回调
└── types/                    # 类型定义
    └── chunk.ts             # Chunk 类型定义
```

---

## 2. 进程间通信 (IPC)

### 2.1 IPC 通道定义

所有 IPC 通道定义在 `@shared/IpcChannel` 中:

**文件**: `src/shared/IpcChannel.ts`

主要通道类别:
- **App**: 应用控制 (quit, reload, theme, proxy 等)
- **File**: 文件操作 (read, write, select, save 等)
- **KnowledgeBase**: 知识库操作
- **Memory**: 记忆操作
- **MCP**: MCP 服务器操作

### 2.2 Preload 桥接

**文件**: `src/preload/index.ts`

```typescript
const api = {
  knowledgeBase: {
    create: (base, context) => tracedInvoke(IpcChannel.KnowledgeBase_Create, context, base),
    search: ({ search, base }, context) => tracedInvoke(IpcChannel.KnowledgeBase_Search, context, { search, base }),
  },
  memory: {
    add: (messages, options) => ipcRenderer.invoke(IpcChannel.Memory_Add, messages, options),
    search: (query, options) => ipcRenderer.invoke(IpcChannel.Memory_Search, query, options),
  },
  mcp: {
    callTool: ({ server, name, args, callId }, context) =>
      tracedInvoke(IpcChannel.Mcp_CallTool, context, { server, name, args, callId }),
  }
}
```

### 2.3 主进程 IPC 处理器

**文件**: `src/main/ipc.ts`

使用 `ipcMain.handle()` 注册处理器，处理来自渲染进程的请求。

---

## 3. 请求发起流程

### 3.1 入口: Redux Thunk

**文件**: `src/renderer/src/store/thunk/messageThunk.ts`

用户发送消息后，流程如下:

```
用户输入消息
    ↓
sendMessage() (Redux Thunk)
    ↓
1. 保存用户消息到数据库
2. 添加用户消息到 Redux Store
3. 创建助手消息占位符
4. 获取助手配置和模型
5. 加入话题队列执行
    ↓
fetchAndProcessAssistantResponseImpl()
    ↓
1. 创建 BlockManager 管理消息块状态
2. 创建流处理器回调
3. 设置中止控制器
4. 调用 AI Provider
```

### 3.2 核心函数调用链

#### 3.2.1 sendMessage 函数

```typescript
// 文件: messageThunk.ts
export const sendMessage = (userMessage, userMessageBlocks, assistant, topicId, agentSession?) =>
  async (dispatch, getState) => {
    // 1. 保存用户消息到数据库
    await saveMessageAndBlocksToDB(topicId, userMessage, userMessageBlocks)
    dispatch(newMessagesActions.addMessage({ topicId, message: userMessage }))

    // 2. 创建助手消息占位符
    const assistantMessage = createAssistantMessage(assistant.id, topicId, {
      askId: userMessage.id,
      model: assistant.model,
      traceId: userMessage.traceId
    })

    // 3. 加入话题队列处理
    queue.add(async () => {
      await fetchAndProcessAssistantResponseImpl(dispatch, getState, topicId, assistant, assistantMessage)
    })
  }
```

#### 3.2.2 fetchAndProcessAssistantResponseImpl 函数

```typescript
const fetchAndProcessAssistantResponseImpl = async (dispatch, getState, topicId, assistant, assistantMessage) => {
  // 1. 创建 BlockManager 管理消息块状态
  const blockManager = new BlockManager({ dispatch, getState, ... })

  // 2. 创建流处理器回调
  callbacks = createCallbacks({ blockManager, dispatch, getState, ... })
  const streamProcessorCallbacks = createStreamProcessor(callbacks)

  // 3. 设置中止控制器
  const abortController = new AbortController()
  addAbortController(userMessageId, () => abortController.abort())

  // 4. 调用核心 API 服务
  await transformMessagesAndFetch({
    messages: messagesForContext,
    assistant,
    topicId,
    blockManager,
    callbacks,
    options: { signal: abortController.signal, timeout: 30000 }
  }, streamProcessorCallbacks)
}
```

### 3.3 消息准备流程

**文件**: `src/renderer/src/services/ApiService.ts`

```typescript
export async function transformMessagesAndFetch({ messages, assistant, ... }) {
  // 1. 准备模型消息格式
  const messagesForModel = await ConversationService.prepareMessagesForModel(messages, assistant)

  // 2. 注入知识库搜索提示（如果启用）
  const enrichedMessages = await injectUserMessageWithKnowledgeSearchPrompt(messagesForModel, assistant)

  // 3. 调用聊天完成
  await fetchChatCompletion({
    messages: enrichedMessages,
    assistant,
    onChunkReceived: streamProcessorCallbacks
  })
}
```

### 3.4 请求构建和发送

```typescript
export async function fetchChatCompletion({ messages, assistant, requestOptions, onChunkReceived, topicId }) {
  // 1. 获取 Provider 并应用 API Key 轮换
  const baseProvider = getProviderByModel(assistant.model)
  const providerWithRotatedKey = { ...baseProvider, apiKey: getRotatedApiKey(baseProvider) }

  // 2. 创建 ModernAiProvider 实例
  const AI = new AiProviderNew(assistant.model, providerWithRotatedKey)

  // 3. 获取 MCP 工具
  const mcpTools = await fetchMcpTools(assistant)

  // 4. 构建流式参数
  const { params: aiSdkParams, modelId, capabilities } = await buildStreamTextParams(
    messages, assistant, provider, { mcpTools, requestOptions }
  )

  // 5. 配置中间件
  const middlewareConfig: AiSdkMiddlewareConfig = {
    streamOutput: assistant.settings?.streamOutput ?? true,
    onChunk: onChunkReceived,
    model: assistant.model,
    provider,
    mcpTools,
    // ...
  }

  // 6. 调用 AI 完成请求
  await AI.completions(modelId, aiSdkParams, middlewareConfig)
}
```

---

## 4. AI 核心处理流程

### 4.1 双层架构

Cherry Studio 的 AI 核心采用**双层架构**设计:

1. **Legacy AiProvider** (`aiCore/legacy/`) - 基于 Vercel AI SDK 的传统实现
2. **Modern AiProvider** (`aiCore/index_new.ts`) - 基于 AI SDK v6 的新实现

两者通过适配器模式无缝集成，新实现兼容旧中间件系统。

### 4.2 ModernAiProvider 入口

**文件**: `src/renderer/src/aiCore/index_new.ts`

```typescript
export default class ModernAiProvider {
  private legacyProvider: LegacyAiProvider
  private localProvider: Awaited<AiSdkProvider> | null = null

  async completions(modelId: string, params: StreamTextParams, providerConfig) {
    // 1. 创建 AI SDK Provider 实例
    if (!this.localProvider) {
      this.localProvider = await createAiSdkProvider(this.config)
    }

    // 2. 创建模型实例
    const model = this.localProvider.languageModel(modelId)

    // 3. 构建插件
    const plugins = buildPlugins(providerConfig)

    // 4. 创建执行器
    const executor = createExecutor(this.config.providerId, this.config.options, plugins)

    // 5. 执行流式请求
    const adapter = new AiSdkToChunkAdapter(providerConfig.onChunk, ...)
    const streamResult = await executor.streamText({ ...params, model })
    return adapter.processStream(streamResult)
  }
}
```

### 4.3 Legacy AiProvider 主入口

**文件**: `src/renderer/src/aiCore/legacy/index.ts`

```typescript
class AiProvider {
  async completions(params: CompletionsParams, options?: RequestOptions): Promise<CompletionsResult> {
    // 1. 根据模型选择合适的 API 客户端
    const client = this.selectClient(params.assistant.model)

    // 2. 构建中间件链
    const builder = CompletionsMiddlewareBuilder.withDefaults()
    // 根据参数配置中间件

    // 3. 应用中间件
    const middlewares = builder.build()
    const wrappedCompletionMethod = applyCompletionsMiddlewares(client, client.createCompletions, middlewares)

    // 4. 执行
    return wrappedCompletionMethod(params, options)
  }
}
```

### 4.4 API 客户端工厂

**文件**: `src/renderer/src/aiCore/legacy/clients/ApiClientFactory.ts`

支持的客户端:

| Provider Type | 客户端类 | 说明 |
|---------------|----------|------|
| `openai` | OpenAIAPIClient | OpenAI API |
| `azure-openai` | OpenAIAPIClient | Azure OpenAI |
| `openai-response` | OpenAIResponseAPIClient | OpenAI Response API |
| `anthropic` | AnthropicAPIClient | Anthropic API |
| `anthropic-vertex` | AnthropicVertexAPIClient | Anthropic Vertex AI |
| `gemini` | GeminiAPIClient | Google Gemini |
| `vertex` | VertexAPIClient | Google Vertex AI |
| `aws-bedrock` | AwsBedrockAPIClient | AWS Bedrock |
| 特殊 ID | CherryAiAPIClient, AihubmixAPIClient, NewAPIClient | 特殊提供商 |

```typescript
export class ApiClientFactory {
  static create(provider: Provider): BaseApiClient {
    // 特殊 Provider ID 优先
    if (provider.id === 'cherryai') return new CherryAiAPIClient(provider)
    if (provider.id === 'aihubmix') return new AihubmixAPIClient(provider)
    if (isNewApiProvider(provider)) return new NewAPIClient(provider)

    // 标准 Provider Type
    switch (provider.type) {
      case 'openai': return new OpenAIAPIClient(provider)
      case 'azure-openai':
      case 'openai-response': return new OpenAIResponseAPIClient(provider)
      case 'gemini': return new GeminiAPIClient(provider)
      case 'anthropic': return new AnthropicAPIClient(provider)
      case 'aws-bedrock': return new AwsBedrockAPIClient(provider)
      default: return new OpenAIAPIClient(provider)
    }
  }
}
```

### 4.5 参数准备

**文件**: `src/renderer/src/aiCore/prepareParams/index.ts`

负责:
- 消息格式转换 (`messageConverter.ts`)
- 模型参数处理 (`modelParameters.ts`)
- 文件处理 (`fileProcessor.ts`)

### 4.6 请求转换器

每个 API 客户端都有一个 `RequestTransformer`，负责将通用参数转换为提供商特定格式:

```typescript
// 示例: OpenAI 请求转换器
class OpenAIRequestTransformer {
  async transform(params: CompletionsParams): Promise<{ payload: OpenAIParams, metadata: any }> {
    // 转换消息格式
    const messages = await this.convertMessages(params.messages)
    // 转换工具定义
    const tools = mcpToolsToOpenAIChatTools(params.tools)
    // 构建最终参数
    return { payload: { messages, tools, ... }, metadata }
  }
}
```

---

## 5. 中间件系统

### 5.1 中间件架构

采用 **责任链模式**，按顺序处理流式响应。

**文件**: `src/renderer/src/aiCore/legacy/middleware/`

```
请求流入
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          中间件管道                                      │
│  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────┐        │
│  │ FinalChunkConsumer│──▶│ ErrorHandler     │──▶│ AbortHandler │        │
│  └──────────────────┘   └──────────────────┘   └──────────────┘        │
│          │                                                │              │
│          ▼                                                ▼              │
│  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────┐        │
│  │TransformCoreParams│──▶│ McpToolChunk     │──▶│ TextChunk    │        │
│  └──────────────────┘   └──────────────────┘   └──────────────┘        │
│          │                                                │              │
│          ▼                                                ▼              │
│  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────┐        │
│  │ WebSearch        │──▶│ ToolUseExtraction│──▶│ ThinkingTag  │        │
│  └──────────────────┘   └──────────────────┘   └──────────────┘        │
│          │                                                │              │
│          ▼                                                ▼              │
│  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────┐        │
│  │ ThinkChunk       │──▶│ResponseTransform │──▶│StreamAdapter │        │
│  └──────────────────┘   └──────────────────┘   └──────────────┘        │
│          │                                                │              │
│          ▼                                                │              │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │              RawStreamListener (最终监听器)                        │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
    │
    ▼
响应流出
```

### 5.2 中间件注册表

**文件**: `src/renderer/src/aiCore/legacy/middleware/register.ts`

| 顺序 | 中间件 | 职责 | 文件 |
|------|--------|------|------|
| 1 | FinalChunkConsumerMiddleware | 最终块消费 | `common/FinalChunkConsumerMiddleware.ts` |
| 2 | ErrorHandlerMiddleware | 捕获并处理错误 | `common/ErrorHandlerMiddleware.ts` |
| 3 | TransformCoreToSdkParamsMiddleware | 参数转换为 SDK 格式 | `core/TransformCoreToSdkParamsMiddleware.ts` |
| 4 | AbortHandlerMiddleware | 处理中断请求 | `common/AbortHandlerMiddleware.ts` |
| 5 | McpToolChunkMiddleware | 处理 MCP 工具调用 | `core/McpToolChunkMiddleware.ts` |
| 6 | TextChunkMiddleware | 处理文本块 | `core/TextChunkMiddleware.ts` |
| 7 | WebSearchMiddleware | 处理网页搜索 | `core/WebSearchMiddleware.ts` |
| 8 | ToolUseExtractionMiddleware | 提取工具调用 | `feat/ToolUseExtractionMiddleware.ts` |
| 9 | ThinkingTagExtractionMiddleware | 提取思考内容 | `feat/ThinkingTagExtractionMiddleware.ts` |
| 10 | ThinkChunkMiddleware | 思考块处理 | `core/ThinkChunkMiddleware.ts` |
| 11 | ResponseTransformMiddleware | 响应转换 | `core/ResponseTransformMiddleware.ts` |
| 12 | StreamAdapterMiddleware | 流适配器 | `core/StreamAdapterMiddleware.ts` |
| 13 | RawStreamListenerMiddleware | 原始流监听器 | `core/RawStreamListenerMiddleware.ts` |

### 5.3 中间件类型定义

```typescript
// 文件: aiCore/legacy/middleware/types.ts
export type CompletionsMiddleware = (
  api: MiddlewareAPI<CompletionsContext, [CompletionsParams]>
) => (
  next: (context: CompletionsContext, params: CompletionsParams) => Promise<CompletionsResult>
) => (context: CompletionsContext, params: CompletionsParams) => Promise<CompletionsResult>
```

### 5.4 核心中间件详解

#### 5.4.1 ErrorHandlerMiddleware

```typescript
export const ErrorHandlerMiddleware = () => (next) => async (ctx, params) => {
  try {
    return await next(ctx, params)
  } catch (error) {
    // 1. 错误日志记录
    logger.error(error)

    // 2. 特定提供商错误处理 (智谱等)
    processedError = handleError(error, params)

    // 3. 创建错误 Chunk
    const errorChunk = createErrorChunk(processedError)

    // 4. 调用外部错误回调
    if (params.onError) {
      params.onError(processedError)
    }

    // 5. 根据配置决定是否抛出
    if (shouldThrow) {
      throw processedError
    }

    // 6. 返回错误流
    return { stream: errorStream, getText: () => '' }
  }
}
```

#### 5.4.2 TransformCoreToSdkParamsMiddleware

```typescript
export const TransformCoreToSdkParamsMiddleware = () => (next) => async (ctx, params) => {
  // 获取请求转换器
  const requestTransformer = ctx.apiClientInstance.getRequestTransformer()

  // 将通用参数转换为 SDK 特定格式
  const { payload: sdkPayload, metadata } = await requestTransformer.transform(params, ...)

  // 存储转换后的参数
  ctx._internal.sdkPayload = sdkPayload

  return next(ctx, params)
}
```

#### 5.4.3 StreamAdapterMiddleware

```typescript
export const StreamAdapterMiddleware = () => (next) => async (ctx, params) => {
  const result = await next(ctx, params)

  // 将 AsyncIterable 转换为 ReadableStream
  if (isAsyncIterable(result.rawOutput)) {
    return { ...result, stream: asyncGeneratorToReadableStream(result.rawOutput) }
  }

  return result
}
```

#### 5.4.4 TextChunkMiddleware

```typescript
export const TextChunkMiddleware = () => (next) => async (ctx, params) => {
  const result = await next(ctx, params)

  // 使用 TransformStream 处理流中的文本块
  const enhancedTextStream = result.stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (chunk.type === ChunkType.TEXT_DELTA) {
        accumulatedTextContent += chunk.text
        controller.enqueue({ ...chunk, text: accumulatedTextContent })
      }
    }
  }))

  return { ...result, stream: enhancedTextStream }
}
```

### 5.5 中间件链构建

**文件**: `src/renderer/src/aiCore/legacy/middleware/builder.ts`

```typescript
const builder = CompletionsMiddlewareBuilder.withDefaults()
  .use(new ErrorHandlerMiddleware())
  .use(new AbortHandlerMiddleware())
  .use(new ToolUseExtractionMiddleware())
  .use(new McpToolChunkMiddleware())
  .use(new WebSearchMiddleware())
  // ... 更多中间件

const middlewares = builder.build()
```

---

## 6. Chunk 类型与流式处理

### 6.1 Chunk 类型定义

**文件**: `src/renderer/src/types/chunk.ts`

```typescript
export enum ChunkType {
  // 块状态
  BLOCK_CREATED = 'block_created',
  BLOCK_IN_PROGRESS = 'block_in_progress',
  BLOCK_COMPLETE = 'block_complete',

  // 文本
  TEXT_START = 'text.start',
  TEXT_DELTA = 'text.delta',
  TEXT_COMPLETE = 'text.complete',

  // 思考/推理
  THINKING_START = 'thinking.start',
  THINKING_DELTA = 'thinking.delta',
  THINKING_COMPLETE = 'thinking.complete',

  // MCP 工具
  MCP_TOOL_CREATED = 'mcp_tool_created',
  MCP_TOOL_PENDING = 'mcp_tool_pending',
  MCP_TOOL_IN_PROGRESS = 'mcp_tool_in_progress',
  MCP_TOOL_COMPLETE = 'mcp_tool_complete',
  MCP_TOOL_STREAMING = 'mcp_tool_streaming',

  // 外部工具
  WEB_SEARCH_IN_PROGRESS = 'web_search_in_progress',
  WEB_SEARCH_COMPLETE = 'web_search_complete',
  KNOWLEDGE_SEARCH_IN_PROGRESS = 'knowledge_search_in_progress',
  KNOWLEDGE_SEARCH_COMPLETE = 'knowledge_search_complete',

  // 图片/音频
  IMAGE_CREATED = 'image.created',
  IMAGE_DELTA = 'image.delta',
  IMAGE_COMPLETE = 'image.complete',

  // 完成状态
  LLM_RESPONSE_CREATED = 'llm_response_created',
  LLM_RESPONSE_COMPLETE = 'llm_response_complete',

  // 错误
  ERROR = 'error',
}
```

### 6.2 流处理器

**文件**: `src/renderer/src/services/StreamProcessingService.ts`

```typescript
export function createStreamProcessor(callbacks: StreamProcessorCallbacks = {}) {
  return (chunk: Chunk) => {
    switch (chunk.type) {
      case ChunkType.TEXT_DELTA:
        callbacks.onTextChunk?.(chunk.text)
        break
      case ChunkType.THINKING_DELTA:
        callbacks.onThinkingChunk?.(chunk.text, chunk.thinking_millsec)
        break
      case ChunkType.MCP_TOOL_PENDING:
        callbacks.onToolCallPending?.(chunk.responses)
        break
      case ChunkType.ERROR:
        callbacks.onError?.(chunk.error)
        break
      // ... 更多类型处理
    }
  }
}
```

---

## 7. MCP 工具调用机制

### 7.1 工具类型

Cherry Studio 支持三种类型的工具:

| 类型 | 说明 | 示例 |
|------|------|------|
| `mcp` | MCP 服务器提供的工具 | 文件操作、数据库查询等 |
| `builtin` | 内置工具 | `think` (思考工具) |
| `provider` | 提供商原生工具 | `web_search` (Web 搜索) |

### 7.2 MCP 服务架构

**文件**: `src/main/services/MCPService.ts`

MCP (Model Context Protocol) 服务负责:
- MCP 服务器生命周期管理
- 工具列表获取
- 工具调用执行
- 资源/Prompt 访问

支持多种传输方式:
- **StdioClientTransport**: 标准输入输出
- **SSEClientTransport**: Server-Sent Events
- **StreamableHTTPClientTransport**: HTTP 流

```typescript
class MCPService {
  // 初始化 MCP 客户端
  async initClient(server: MCPServer): Promise<Client>

  // 获取工具列表
  async listTools(): Promise<MCPTool[]>

  // 调用工具
  async callTool({ server, name, args, callId }): Promise<MCPCallToolResponse>

  // 获取资源
  async listResources(): Promise<Resource[]>
  async readResource({ server, uri }): Promise<ReadResourceResult>
}
```

### 7.3 工具调用完整流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        AI Response (工具调用)                            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              AiSdkToChunkAdapter / ToolUseExtractionMiddleware          │
│  • 检测工具调用                                                          │
│  • 解析工具名称和参数                                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     MCP_TOOL_CREATED Chunk                               │
│  • 创建 ToolCallInfo                                                    │
│  • 确定工具类型 (builtin/provider/mcp)                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     MCP_TOOL_PENDING Chunk                               │
│  • 显示工具等待确认 UI                                                  │
│  • 检查是否自动批准                                                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
           ┌───────────────┐               ┌───────────────┐
           │  自动批准      │               │  需要确认      │
           └───────────────┘               └───────────────┘
                    │                               │
                    │                               ▼
                    │                    ┌───────────────────┐
                    │                    │ 用户确认/拒绝弹窗  │
                    │                    └───────────────────┘
                    │                               │
                    └───────────────┬───────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   MCP_TOOL_IN_PROGRESS Chunk                             │
│  • 执行工具调用                                                          │
│  • 通过 IPC 调用主进程 MCPService                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       MCP Server 执行工具                                │
│  • 调用外部服务/工具                                                     │
│  • 返回结果                                                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   MCP_TOOL_COMPLETE Chunk                                │
│  • 处理工具结果                                                          │
│  • 特殊处理 (知识库引用等)                                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        递归调用 AI                                       │
│  • 工具结果作为上下文                                                    │
│  • 检查是否需要更多工具调用                                              │
│  • 最大递归深度: 20 层                                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.4 工具调用中间件

**文件**: `src/renderer/src/aiCore/legacy/middleware/core/McpToolChunkMiddleware.ts`

```typescript
export const McpToolChunkMiddleware: CompletionsMiddleware = () => (next) => async (ctx, params) => {
  const executeWithToolHandling = async (currentParams, depth = 0) => {
    if (depth >= MAX_TOOL_RECURSION_DEPTH) {
      throw new Error('Max tool recursion depth exceeded')
    }

    // 处理流并检测工具调用
    const toolHandlingStream = resultFromUpstream.pipeThrough(
      createToolHandlingTransform(ctx, currentParams, mcpTools, depth, executeWithToolHandling)
    )

    return { ...result, stream: toolHandlingStream }
  }

  return executeWithToolHandling(params, 0)
}
```

### 7.5 工具权限管理

**文件**: `src/renderer/src/store/toolPermissions.ts`

```typescript
export type ToolPermissionStatus = 'pending' | 'submitting-allow' | 'submitting-deny' | 'invoking'

// 检查自动批准
const isAutoApproveEnabled = isToolAutoApproved(toolResponse.tool, server)

if (!isAutoApproveEnabled) {
  // 请求用户确认
  confirmationPromise = requestToolConfirmation(toolResponse.id, abortSignal)
}
```

### 7.6 工具结果处理

**文件**: `src/renderer/src/utils/mcp-tools.ts`

```typescript
// 调用 MCP 工具
export async function callMCPTool(toolResponse: MCPToolResponse, topicId?: string, modelName?: string) {
  const server = getMcpServerByTool(toolResponse.tool)

  // 通过 IPC 调用主进程
  const resp = await window.api.mcp.callTool({
    server,
    name: toolResponse.tool.name,
    args: toolResponse.arguments,
    callId: toolResponse.id
  })

  return resp
}

// 调用内置工具
export async function callBuiltInTool(toolResponse: MCPToolResponse) {
  if (toolResponse.tool.name === 'think') {
    return { isError: false, content: [{ type: 'text', text: thought }] }
  }
}
```

### 7.7 工具状态流转

```
pending → invoking → done
                 ↓
              cancelled
```

### 7.8 Prompt-based 工具调用

对于不支持原生 Function Calling 的模型，使用 Prompt-based 方式:

**文件**: `packages/aiCore/src/core/plugins/built-in/toolUsePlugin/promptToolUsePlugin.ts`

```typescript
// 在系统提示中注入工具定义
<tool_use>
  <name>{tool_name}</name>
  <arguments>{json_arguments}</arguments>
</tool_use>

// 使用 TagExtractor 从文本输出中提取工具调用
const TOOL_USE_TAG_CONFIG: TagConfig = {
  openingTag: '<tool_use>',
  closingTag: '</tool_use>',
  separator: '\n'
}
```

---

## 8. RAG 知识库

### 8.1 知识库系统架构

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Renderer Process (UI Layer)                         │
├─────────────────────────────────────────────────────────────────────────────────┤
│  KnowledgePage.tsx          KnowledgeContent.tsx       KnowledgeBaseInput.tsx   │
│  KnowledgeQueue.ts          knowledgeThunk.ts          KnowledgeService.ts      │
│  KnowledgeSearchTool.ts     useKnowledge.ts            knowledge.ts (store)     │
└────────────────────────────────────────────┬────────────────────────────────────┘
                                             │ IPC
┌────────────────────────────────────────────▼────────────────────────────────────┐
│                              Main Process (Service Layer)                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│  KnowledgeService.ts ───────────────────────────────────────────────────────────│
│         │                                                                        │
│         ├── RAGApplication (@cherrystudio/embedjs)                              │
│         │         │                                                              │
│         │         ├── Embeddings (嵌入模型)                                       │
│         │         │      ├── OpenAiEmbeddings                                    │
│         │         │      ├── OllamaEmbeddings                                    │
│         │         │      └── VoyageEmbeddings                                    │
│         │         │                                                              │
│         │         └── LibSqlDb (向量数据库)                                       │
│         │                                                                        │
│         ├── Loaders (文档加载器)                                                  │
│         │      ├── LocalPathLoader (PDF, DOCX, XLSX, PPTX, CSV, MD)             │
│         │      ├── WebLoader (URL, HTML)                                         │
│         │      ├── SitemapLoader                                                 │
│         │      ├── NoteLoader                                                    │
│         │      ├── EpubLoader                                                    │
│         │      ├── OdLoader (ODT, ODS, ODP)                                      │
│         │      ├── DraftsExportLoader                                            │
│         │      └── JsonLoader                                                    │
│         │                                                                        │
│         ├── Reranker (重排序)                                                    │
│         │      └── GeneralReranker (支持多策略: Jina, Voyage, Tei, Bailian...)   │
│         │                                                                        │
│         └── PreprocessProvider (预处理)                                          │
│                ├── Doc2xPreprocessProvider                                       │
│                ├── MistralPreprocessProvider                                     │
│                ├── MineruPreprocessProvider                                      │
│                ├── OpenMineruPreprocessProvider                                  │
│                └── PaddleocrPreprocessProvider                                   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 8.2 知识库数据模型

**文件**: `src/renderer/src/types/knowledge.ts`

```typescript
// 知识库定义
interface KnowledgeBase {
  id: string
  name: string
  model: Model                    // 嵌入模型
  dimensions?: number             // 向量维度
  items: KnowledgeItem[]          // 知识项列表
  chunkSize?: number              // 分块大小 (默认 1000-2000)
  chunkOverlap?: number           // 分块重叠 (默认 200)
  threshold?: number              // 检索阈值
  rerankModel?: Model             // 重排序模型
  preprocessProvider?: {...}      // 预处理提供者
}

// 知识项类型
type KnowledgeItemType = 'file' | 'url' | 'note' | 'sitemap' | 'directory' | 'memory' | 'video'

interface KnowledgeItem {
  id: string
  type: KnowledgeItemType
  content: string | FileMetadata | FileMetadata[]
  processingStatus?: 'pending' | 'processing' | 'completed' | 'failed'
  uniqueId?: string               // 向量库中的唯一标识
  uniqueIds?: string[]            // 多个分块的ID列表
}
```

### 8.3 知识库服务

**文件**: `src/main/services/KnowledgeService.ts`

```typescript
class KnowledgeService {
  // 向量数据库存储目录
  private storageDir = path.join(getDataPath(), 'KnowledgeBase')

  // RAG应用实例缓存
  private ragApplications: Map<string, RAGApplication> = new Map()

  // 并发控制参数
  private static MAXIMUM_WORKLOAD = 80 * MB        // 最大工作负载
  private static MAXIMUM_PROCESSING_ITEM_COUNT = 30 // 最大并发处理数

  // 核心方法
  async create(base: KnowledgeBaseParams)          // 创建知识库
  async add({ base, item, forceReload })           // 添加内容
  async search({ search, base })                   // 搜索
  async rerank({ search, base, results })          // 重排序
  async delete(id: string)                         // 删除
  async reset(id: string)                          // 重置
}
```

### 8.4 嵌入模型支持

**文件**: `src/main/knowledge/embedjs/embeddings/EmbeddingsFactory.ts`

| 提供者 | 实现类 | 特点 |
|--------|--------|------|
| OpenAI/Azure | OpenAiEmbeddings | 支持自定义 dimensions |
| Ollama | OllamaEmbeddings | 本地模型支持 |
| Voyage AI | VoyageEmbeddings | 专用嵌入模型，batchSize=8 |

### 8.5 文档加载器

**文件**: `src/main/knowledge/embedjs/loader/index.ts`

```typescript
const FILE_LOADER_MAP = {
  '.pdf': 'common', '.doc': 'common', '.docx': 'common',
  '.pptx': 'common', '.xlsx': 'common', '.csv': 'common', '.md': 'common',
  '.odt': 'od', '.ods': 'od', '.odp': 'od',
  '.epub': 'epub', '.draftsexport': 'drafts',
  '.html': 'html', '.htm': 'html', '.json': 'json'
}
```

### 8.6 知识库检索流程

```
用户发送消息
    │
    ▼
injectUserMessageWithKnowledgeSearchPrompt()
    │
    ▼
getKnowledgeReferences()
    │
    ├── 提取知识库ID列表
    │
    └── processKnowledgeSearch()
            │
            ▼
       searchKnowledgeBase()
            │
            ├── 截断查询 (基于嵌入模型 max_context)
            │
            ▼
       KnowledgeService.search() → IPC
            │
            ▼
       RAGApplication.search()
            │
            ├── Embeddings.embedQuery() → 查询向量化
            │
            ▼
       LibSqlDb 向量相似度搜索
            │
            ▼
       过滤阈值不达标结果
            │
            ▼
       Reranker.rerank() (可选)
            │
            ▼
       返回 KnowledgeSearchResult[]
    │
    ▼
构建 REFERENCE_PROMPT
    │
    ▼
注入到用户消息中
```

### 8.7 知识库搜索工具

**文件**: `src/renderer/src/aiCore/tools/KnowledgeSearchTool.ts`

```typescript
export const knowledgeSearchTool = (assistant, extractedKeywords, topicId, userMessage) => {
  return tool({
    description: `Knowledge base search tool...`,
    inputSchema: z.object({
      additionalContext: z.string().optional()
    }),
    execute: async ({ additionalContext }) => {
      // 获取助手配置的知识库
      const knowledgeBaseIds = assistant.knowledge_bases?.map(base => base.id)

      // 执行搜索
      const knowledgeReferences = await processKnowledgeSearch(extractResults, knowledgeBaseIds, topicId)

      return knowledgeReferencesData
    }
  })
}
```

### 8.8 两种检索模式

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `on` (自动) | 使用意图识别提取关键词搜索 | 复杂查询，需要 AI 理解意图 |
| `off` (直接) | 直接使用用户消息内容搜索 | 简单查询，精确匹配 |

### 8.9 引用提示词

**文件**: `src/renderer/src/config/prompts.ts`

```
REFERENCE_PROMPT = `Please answer the question based on the reference materials

## Citation Rules:
- Please cite the context at the end of sentences when appropriate.
- Please use the format of citation number [number] to reference...
`
```

### 8.10 预处理系统

支持的预处理服务:
- **Doc2x** - 专业文档解析
- **Mistral** - OCR 识别
- **Mineru** - 开源文档解析
- **Open-Mineru** - 自托管 Mineru
- **PaddleOCR** - 百度 OCR 引擎

### 8.11 IPC 通道

| 通道 | 功能 |
|------|------|
| `KnowledgeBase_Create` | 创建知识库 |
| `KnowledgeBase_Delete` | 删除知识库 |
| `KnowledgeBase_Add` | 添加文档 |
| `KnowledgeBase_Remove` | 移除文档 |
| `KnowledgeBase_Search` | 搜索 |
| `KnowledgeBase_Rerank` | 重排序 |
| `KnowledgeBase_Reset` | 重置 |
```

---

## 9. 全局记忆系统

### 9.1 记忆系统架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Renderer Process                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌──────────────────┐    ┌───────────────────────┐   │
│  │  Redux Store    │    │ MemoryProcessor  │    │  MemorySearchTool     │   │
│  │  (memory.ts)    │───>│                  │<───│  (AI Tool)            │   │
│  │  - memoryConfig │    │ - extractFacts() │    │  - AI can call to    │   │
│  │  - currentUserId│    │ - updateMemories │    │    search memories    │   │
│  │  - globalEnabled│    │ - searchMemories │    └───────────────────────┘   │
│  └─────────────────┘    └──────────────────┘                                │
│           │                      │                                           │
│           v                      v                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    MemoryService (Renderer)                           │   │
│  │  - Singleton instance                                                 │   │
│  │  - Delegates all operations to main process via IPC                   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              │ IPC Calls                                    │
└──────────────────────────────┼──────────────────────────────────────────────┘
                               v
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Main Process                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    MemoryService (Main)                               │   │
│  │  - SQLite database (libsql)                                          │   │
│  │  - Vector embeddings (1536 dimensions)                               │   │
│  │  - CRUD operations with soft delete                                  │   │
│  │  - Hybrid search (vector similarity)                                 │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              │                                               │
│                              v                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    Database: memories.db                              │   │
│  │  ┌───────────────────────┐  ┌───────────────────────────────────┐    │   │
│  │  │    memories table      │  │    memory_history table           │    │   │
│  │  │  - id (PK)             │  │  - id (PK)                        │    │   │
│  │  │  - memory (content)    │  │  - memory_id (FK)                 │    │   │
│  │  │  - hash (dedup)        │  │  - previous_value                 │    │   │
│  │  │  - embedding (vector)  │  │  - new_value                      │    │   │
│  │  │  - user_id             │  │  - action (ADD/UPDATE/DELETE)     │    │   │
│  │  │  - agent_id            │  └───────────────────────────────────┘    │   │
│  │  │  - is_deleted          │                                           │   │
│  │  └───────────────────────┘                                           │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 9.2 记忆服务

**文件**: `src/main/services/memory/MemoryService.ts`

```typescript
class MemoryService {
  // 数据库位置
  private dbPath = path.join(getDataPath(), 'Memory', 'memories.db')

  // 向量维度
  private static VECTOR_DIMENSIONS = 1536

  // 相似度阈值 (>= 85% 视为重复)
  private static SIMILARITY_THRESHOLD = 0.85

  // 核心方法
  async add(messages, options)       // 添加记忆
  async search(query, options)       // 搜索记忆
  async list(options)                // 列出记忆
  async update(id, memory, metadata) // 更新记忆
  async delete(id)                   // 删除记忆
}
```

### 9.3 技术实现

| 特性 | 实现 |
|------|------|
| 数据库 | LibSQL (SQLite) |
| 向量存储 | 支持原生向量 |
| 向量维度 | 统一 1536 维 (填充/截断) |
| 去重机制 | SHA256 哈希 |
| 相似度阈值 | 0.85 (85%) |
| 软删除 | `is_deleted` 标志 |

### 9.4 记忆 Redux 配置

**文件**: `src/renderer/src/store/memory.ts`

```typescript
interface MemoryState {
  memoryConfig: MemoryConfig         // 记忆配置 (LLM + 嵌入模型)
  currentUserId: string              // 当前用户 ID (default: 'default-user')
  globalMemoryEnabled: boolean       // 全局开关
}
```

### 9.5 记忆处理器

**文件**: `src/renderer/src/services/MemoryProcessor.ts`

```typescript
class MemoryProcessor {
  // 使用 LLM 从对话中提取个人事实
  async extractFacts(messages, config)

  // 执行 ADD/UPDATE/DELETE 操作
  async updateMemories(facts, config)

  // 搜索相关记忆
  async searchRelevantMemories(query, config, limit)

  // 端到端对话处理
  async processConversation(messages, config)
}
```

### 9.6 记忆搜索工具

**文件**: `src/renderer/src/aiCore/tools/MemorySearchTool.ts`

```typescript
export const memorySearchTool = (config) => {
  return tool({
    description: `Memory search tool for retrieving personal information...`,
    inputSchema: z.object({
      query: z.string(),
      limit: z.number().default(5).max(20)
    }),
    execute: async ({ query, limit }) => {
      const memories = await MemoryProcessor.searchRelevantMemories(query, config, limit)
      return memories
    }
  })
}
```

### 9.7 记忆存储流程

```
Conversation End
       │
       v
searchOrchestrationPlugin.onRequestEnd()
       │
       v
storeConversationMemory()
       │
       v
MemoryProcessor.processConversation()
       │
       ├─> extractFacts() ──> LLM extracts personal facts
       │
       └─> updateMemories() ──> LLM decides ADD/UPDATE/DELETE
              │
              v
       MemoryService.add/update/delete() ──> IPC to Main Process
              │
              v
       Database operations with embeddings
```

### 9.8 记忆检索流程

```
User Message
       │
       v
searchOrchestrationPlugin.onRequestStart()
       │
       v
AI decides to call memorySearchTool
       │
       v
MemoryProcessor.searchRelevantMemories()
       │
       v
MemoryService.search() ──> IPC to Main Process
       │
       v
Vector similarity search in database
       │
       v
Relevant memories returned to AI context
```

### 9.9 用户和助手关联

记忆支持多租户:
- **User ID (`user_id`)**: 隔离不同用户的记忆 (default: `default-user`)
- **Agent ID (`agent_id`)**: 关联特定助手的记忆

每个助手有 `enableMemory` 标志控制记忆功能。

### 9.10 LLM 提示词

**文件**: `src/renderer/src/utils/memory-prompts.ts`

- **事实提取提示词**: 指导 LLM 只提取个人信息 (偏好、活动、背景)，排除通用知识和问题
- **记忆更新提示词**: 指导 LLM 执行 ADD/UPDATE/DELETE/NONE 操作

---

## 10. 异常处理机制

### 10.1 异常处理架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           用户请求                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 AbortHandlerMiddleware (创建 AbortController)            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 ErrorHandlerMiddleware (捕获异常)                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  try --> 正常处理流 --> 返回结果                                  │   │
│  │                                                                   │   │
│  │  catch -->                                                       │   │
│  │      ├── handleError() (特定 Provider 错误映射)                   │   │
│  │      ├── createErrorChunk() (转换为 ErrorChunk)                  │   │
│  │      ├── onError 回调                                            │   │
│  │      └── shouldThrow?                                            │   │
│  │              |-- Yes --> 抛出错误                                 │   │
│  │              |-- No --> 返回包含 ErrorChunk 的流                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     StreamProcessingService                              │
│  • 解析 ErrorChunk                                                      │
│  • 调用 callbacks.onError()                                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     baseCallbacks.onError()                              │
│  • 更新 Block 状态 (ERROR/PAUSED)                                       │
│  • 创建 ErrorBlock                                                      │
│  • 发送通知                                                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     ErrorBlock UI 展示                                   │
│  • 显示错误消息                                                          │
│  • ErrorDetailModal (详情弹窗)                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 10.2 中间件级错误处理

**文件**: `src/renderer/src/aiCore/legacy/middleware/common/ErrorHandlerMiddleware.ts`

```typescript
export const ErrorHandlerMiddleware = () => (next) => async (ctx, params) => {
  const { shouldThrow } = params
  try {
    return await next(ctx, params)
  } catch (error: any) {
    // 1. 错误日志记录
    logger.error(error)

    // 2. 特定提供商错误处理
    let processedError = error
    processedError = handleError(error, params)

    // 3. 将错误转换为标准 ErrorChunk
    const errorChunk = createErrorChunk(processedError)

    // 4. 调用 onError 回调
    if (params.onError) {
      params.onError(processedError)
    }

    // 5. 根据 shouldThrow 决定是抛出错误还是作为流的一部分
    if (shouldThrow) {
      throw processedError
    }

    // 6. 返回包含错误的流
    const errorStream = new ReadableStream<Chunk>({
      start(controller) {
        controller.enqueue(errorChunk)
        controller.close()
      }
    })
    return { rawOutput: undefined, stream: errorStream, controller: undefined, getText: () => '' }
  }
}
```

### 10.3 特定提供商错误映射

**智谱 AI 特定错误码**:

| 错误码 | i18n Key | 说明 |
|--------|----------|------|
| 401 | `chat.no_api_key` | API Key 无效或令牌过期 |
| 1304 | `chat.quota_exceeded` | 配额用尽 |
| 1113 | `chat.insufficient_balance` | 余额不足 |

### 10.4 错误类型系统

**文件**: `src/renderer/src/types/error.ts`

支持的 AI SDK 错误类型:
- `SerializedAiSdkAPICallError` - API 调用错误
- `SerializedAiSdkDownloadError` - 下载错误
- `SerializedAiSdkRetryError` - 重试错误
- `SerializedAiSdkNoSuchModelError` - 模型不存在错误
- `SerializedAiSdkNoSuchToolError` - 工具不存在错误
- `ProviderSpecificError` - 提供商特定错误

### 10.5 错误 Chunk 结构

**文件**: `src/renderer/src/types/chunk.ts`

```typescript
interface ErrorChunk {
  error: ResponseError
  type: ChunkType.ERROR
}

interface ResponseError {
  message: string
  status?: number
  statusText?: string
  url?: string
  responseBody?: string
  // ... 更多字段
}
```

### 10.6 错误序列化与格式化

**文件**: `src/renderer/src/utils/error.ts`

```typescript
// 将 AI SDK 错误序列化为可传输格式
export function serializeError(error: unknown): SerializedError

// 格式化错误消息供用户查看
export function formatErrorMessage(error: unknown): string

// 判断是否为中断错误
export function isAbortError(error: unknown): boolean

// 格式化 AI SDK 错误详情
export function formatAiSdkError(error: AISDKError): string
```

### 10.7 AbortController 管理

**文件**: `src/renderer/src/utils/abortController.ts`

```typescript
// 全局中断控制器映射
export const abortMap = new Map<string, (() => void)[]>()

// 添加中断控制器
export const addAbortController = (id: string, abortFn: () => void) => {
  abortMap.set(id, [...(abortMap.get(id) || []), abortFn])
}

// 中止指定 ID 的所有请求
export const abortCompletion = (id: string) => {
  const abortFns = abortMap.get(id)
  if (abortFns?.length) {
    for (const fn of [...abortFns]) {
      fn()
      removeAbortController(id, fn)
    }
  }
}
```

### 10.8 流式响应中断处理

**文件**: `src/renderer/src/services/messageStreaming/callbacks/baseCallbacks.ts`

```typescript
onError: async (error: AISDKError) => {
  // 忽略无输出错误
  if (NoOutputGeneratedError.isInstance(error)) return

  const isErrorTypeAbort = isAbortError(error)
  const serializableError = serializeError(error)

  // 中断错误使用特殊占位消息
  if (isErrorTypeAbort) {
    serializableError.message = 'pause_placeholder'
  }

  // 更新 block 状态为 ERROR/PAUSED
  const changes: Partial<ThinkingMessageBlock> = {
    status: isErrorTypeAbort ? MessageBlockStatus.PAUSED : MessageBlockStatus.ERROR
  }

  // 创建错误 block
  const errorBlock = createErrorBlock(assistantMsgId, serializableError, { status: MessageBlockStatus.SUCCESS })
  await blockManager.handleBlockTransition(errorBlock, MessageBlockType.ERROR)
}
```

### 10.9 用户界面错误展示

#### ErrorBlock 组件

**文件**: `src/renderer/src/pages/home/Messages/Blocks/ErrorBlock.tsx`

- 显示错误消息和 HTTP 状态码
- 支持国际化错误消息
- 提供"详情"按钮查看完整错误
- 可关闭删除错误块

#### ErrorDetailModal 组件

**文件**: `src/renderer/src/components/ErrorDetailModal/index.tsx`

- 详细展示所有错误字段
- 支持复制错误详情
- 大数据自动截断处理

#### 错误边界组件

| 组件 | 文件 | 用途 |
|------|------|------|
| ErrorBoundary | `components/ErrorBoundary.tsx` | 全局错误边界 |
| MessageErrorBoundary | `pages/home/Messages/MessageErrorBoundary.tsx` | 消息渲染错误 |
| BlockErrorFallback | `pages/home/Messages/Blocks/BlockErrorFallback.tsx` | Block 错误回退 |

### 10.10 超时配置

| 场景 | 超时时间 |
|------|----------|
| 默认请求 | 30 秒 |
| Flex 服务层级 | 15 分钟 |
| 网络请求 (fetch) | 30 秒 |
| MCP 工具调用 | 默认 60 秒 (可配置) |

---

## 11. 状态管理

### 11.1 Redux Store 配置

**文件**: `src/renderer/src/store/index.ts`

```typescript
const rootReducer = combineReducers({
  assistants,      // 助手配置
  llm,           // LLM/Provider 配置
  settings,       // 应用设置
  knowledge,     // 知识库配置
  memory,        // 记忆配置
  mcp,           // MCP 配置
  messages,      // 消息
  messageBlocks, // 消息块 (文本、工具、图片等)
  tabs,          // 标签页
  runtime,       // 运行时状态
})

// 使用 redux-persist 持久化
const persistedReducer = persistReducer({
  key: 'cherry-studio',
  version: 199,
  blacklist: ['runtime', 'messages', 'messageBlocks', 'tabs', 'toolPermissions']
}, rootReducer)
```

### 11.2 主要 Store Slice

| Slice | 用途 |
|-------|------|
| `llm` | LLM 提供商和模型配置 |
| `assistants` | 助手配置 |
| `knowledge` | 知识库列表和配置 |
| `memory` | 全局记忆配置 |
| `mcp` | MCP 服务器列表 |
| `messages` | 当前话题的消息 |
| `messageBlocks` | 消息块 |
| `settings` | 应用设置 |
| `runtime` | 运行时状态（临时） |

---

## 12. 界面展示流程

### 12.1 数据存储层 (Redux Store)

#### 消息状态

**文件**: `src/renderer/src/store/newMessage.ts`

```typescript
interface MessagesState extends EntityState<Message, string> {
  messageIdsByTopic: Record<string, string[]>  // topicId -> ordered message IDs
  currentTopicId: string | null
  loadingByTopic: Record<string, boolean>
  fulfilledByTopic: Record<string, boolean>
  displayCount: number
}
```

#### 消息块状态

**文件**: `src/renderer/src/store/messageBlock.ts`

```typescript
// 规范化实体存储
EntityState<MessageBlock>

// Block 类型
enum MessageBlockType {
  UNKNOWN = 'unknown',      // 加载中占位符
  MAIN_TEXT = 'main_text',  // 主要文本内容
  THINKING = 'thinking',    // 推理过程 (Claude 等)
  TRANSLATION = 'translation',
  IMAGE = 'image',
  CODE = 'code',
  TOOL = 'tool',            // MCP 工具调用
  FILE = 'file',
  ERROR = 'error',
  CITATION = 'citation',    // Web 搜索, 知识库引用
  VIDEO = 'video',
  COMPACT = 'compact'
}

// Block 状态
enum MessageBlockStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  STREAMING = 'streaming',
  SUCCESS = 'success',
  ERROR = 'error',
  PAUSED = 'paused'
}
```

### 12.2 流式数据流

#### 流处理器

**文件**: `src/renderer/src/services/StreamProcessingService.ts`

```typescript
interface StreamProcessorCallbacks {
  onLLMResponseCreated?: () => void
  onTextStart?: () => void
  onTextChunk?: (text: string) => void
  onTextComplete?: (text: string) => void
  onThinkingStart?: () => void
  onThinkingChunk?: (text: string, thinking_millsec?: number) => void
  onThinkingComplete?: (text: string, thinking_millsec?: number) => void
  onToolCallPending?: (toolResponse: MCPToolResponse) => void
  onToolCallComplete?: (toolResponse: MCPToolResponse) => void
  onImageGenerated?: (imageData: GenerateImageResponse) => void
  onError?: (error: any) => void
  onComplete?: (status: AssistantMessageStatus, response?: Response) => void
  // ... 更多回调
}
```

#### Block 管理器

**文件**: `src/renderer/src/services/messageStreaming/BlockManager.ts`

```typescript
class BlockManager {
  // 智能更新策略 - 流式期间节流，完成时立即更新
  smartBlockUpdate(blockId, changes, blockType, isComplete) {
    if (isBlockTypeChanged || isComplete) {
      // 立即更新 + DB 保存
      dispatch(updateOneBlock({ id: blockId, changes }))
    } else {
      // 节流更新以实现平滑流式效果
      throttledBlockUpdate(blockId, changes)
    }
  }

  // 处理新块创建
  async handleBlockTransition(newBlock, newBlockType) {
    dispatch(newMessagesActions.updateMessage({ blockInstruction: { id: newBlock.id } }))
    dispatch(upsertOneBlock(newBlock))
    dispatch(newMessagesActions.upsertBlockReference({ messageId, blockId }))
  }
}
```

### 12.3 组件层级结构

```
Chat.tsx (/pages/home/Chat.tsx)
├── ChatNavbar
├── Messages (/pages/home/Messages/Messages.tsx)
│   ├── InfiniteScroll (分页加载)
│   │   └── MessageGroup (/pages/home/Messages/MessageGroup.tsx)
│   │       └── MessageItem (/pages/home/Messages/Message.tsx)
│   │           ├── MessageHeader
│   │           ├── MessageContent (/pages/home/Messages/MessageContent.tsx)
│   │           │   └── MessageBlockRenderer (/pages/home/Messages/Blocks/index.tsx)
│   │           │       ├── MainTextBlock -> Markdown
│   │           │       ├── ThinkingBlock
│   │           │       ├── ToolBlock / ToolBlockGroup
│   │           │       ├── ImageBlock
│   │           │       ├── ErrorBlock
│   │           │       ├── CitationBlock
│   │           │       └── PlaceholderBlock
│   │           └── MessageMenubar
│   └── MessageAnchorLine (消息导航)
└── Inputbar
```

### 12.4 消息块渲染器

**文件**: `src/renderer/src/pages/home/Messages/Blocks/index.tsx`

```typescript
const MessageBlockRenderer: React.FC<Props> = ({ blocks, message }) => {
  const blockEntities = useSelector(selectMessageEntities)
  const renderedBlocks = blocks.map(blockId => blockEntities[blockId]).filter(Boolean)

  // 分组相似块 (图片, 视频, 工具)
  const groupedBlocks = groupSimilarBlocks(renderedBlocks)

  return (
    <AnimatePresence mode="sync">
      {groupedBlocks.map(block => {
        switch (block.type) {
          case MessageBlockType.MAIN_TEXT:
            return <MainTextBlock block={block} citationBlockId={...} />
          case MessageBlockType.THINKING:
            return <ThinkingBlock block={block} />
          case MessageBlockType.TOOL:
            return <ToolBlock block={block} />
          case MessageBlockType.ERROR:
            return <ErrorBlock block={block} message={message} />
          // ... 其他类型
        }
      })}
      {/* 处理中显示占位符 */}
      {isProcessing && <PlaceholderBlock />}
    </AnimatePresence>
  )
}
```

### 12.5 Markdown 渲染

**文件**: `src/renderer/src/pages/home/Markdown/Markdown.tsx`

```typescript
const Markdown: FC<Props> = ({ block, postProcess }) => {
  // 使用 useSmoothStream hook 实现平滑流式效果
  const { addChunk, reset } = useSmoothStream({
    onUpdate: (rawText) => setDisplayedContent(postProcess(rawText)),
    streamDone: isStreamDone,
    initialText: block.content
  })

  // ReactMarkdown 配置
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, remarkAlert]}
      rehypePlugins={[rehypeKatex, rehypeRaw]}
      components={{
        code: (props) => <CodeBlock {...props} blockId={block.id} />,
        table: (props) => <Table {...props} />,
        // ... 其他组件
      }}>
      {messageContent}
    </ReactMarkdown>
  )
}
```

### 12.6 代码块渲染

**文件**: `src/renderer/src/pages/home/Markdown/CodeBlock.tsx`

```typescript
const CodeBlock: React.FC<Props> = ({ children, className, blockId }) => {
  const language = /language-([\w-+]+)/.exec(className)?.[1]
  const msgBlock = messageBlocksSelectors.selectById(store.getState(), blockId)
  const isStreaming = msgBlock?.status === MessageBlockStatus.STREAMING

  // HTML artifacts 特殊渲染
  if (codeFancyBlock && language === 'html') {
    return <HtmlArtifactsCard html={children} isStreaming={isStreaming} />
  }

  return <CodeBlockView language={language}>{children}</CodeBlockView>
}
```

### 12.7 消息状态展示

#### 思考块 (ThinkingBlock)

**文件**: `src/renderer/src/pages/home/Messages/Blocks/ThinkingBlock.tsx`

```typescript
const ThinkingBlock: React.FC<Props> = ({ block }) => {
  const isThinking = block.status === MessageBlockStatus.STREAMING

  // 完成时自动折叠
  useEffect(() => {
    setActiveKey(thoughtAutoCollapse ? '' : 'thought')
  }, [isThinking])

  return (
    <Collapse
      label={<ThinkingEffect isThinking={isThinking} thinkingTimeText={...} />}
      // 可折叠的思考内容
    />
  )
}
```

#### 占位块 (PlaceholderBlock)

**文件**: `src/renderer/src/pages/home/Messages/Blocks/PlaceholderBlock.tsx`

```typescript
const PlaceholderBlock: React.FC<Props> = ({ block }) => {
  if (block.status === MessageBlockStatus.PROCESSING && block.type === MessageBlockType.UNKNOWN) {
    return (
      <MessageContentLoading>
        <BeatLoader color="var(--color-text-1)" size={8} />
      </MessageContentLoading>
    )
  }
  return null
}
```

### 12.8 完整数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AI Provider Response                          │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ Stream chunks
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 AiSdkToChunkAdapter                                  │
│   将 AI SDK 流转换为统一 Chunk 格式                                   │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ Chunk[]
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 createStreamProcessor()                              │
│   将 Chunk 分发到对应回调                                             │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ Callbacks
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 BlockManager                                         │
│   管理块生命周期和节流更新                                             │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ Redux Actions
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 Redux Store                                          │
│   newMessages.slice: Message entities                                │
│   messageBlocks.slice: MessageBlock entities                         │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ useSelector
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 React Components                                     │
│   Messages -> MessageGroup -> MessageItem -> MessageContent          │
│                            -> MessageBlockRenderer -> Block          │
└─────────────────────────────────────────────────────────────────────┘
```

### 12.9 性能优化

| 优化策略 | 实现方式 |
|----------|----------|
| 节流更新 | Block 内容更新节流 (150ms) |
| RAF 调度 | 使用 `requestAnimationFrame` 进行 Redux 更新 |
| 规范化状态 | Messages 和 Blocks 分开存储，通过 ID 关联 |
| 记忆化选择器 | `selectMessagesForTopic`, `selectFormattedCitationsByBlockId` |
| 动画优化 | 使用 `framer-motion` (`motion/react`) 实现平滑动画 |

### 12.10 流式更新策略

| 阶段 | 行为 |
|------|------|
| 流式期间 | 节流更新到 Redux 和 DB |
| 完成时 | 立即更新，取消节流，刷入 DB |
| Block 类型变化 | 取消前一个块的节流，立即更新 |

---

## 完整流程图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           用户输入消息                                   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      sendMessage (Redux Thunk)                          │
│  • 保存用户消息到数据库                                                  │
│  • 添加用户消息到 Redux Store                                            │
│  • 创建助手消息占位符                                                    │
│  • 加入话题队列执行                                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│               fetchAndProcessAssistantResponseImpl                      │
│  • 创建 BlockManager                                                    │
│  • 创建流处理器回调                                                      │
│  • 设置 AbortController                                                 │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    transformMessagesAndFetch                             │
│  • 准备模型消息格式                                                      │
│  • 注入知识库搜索提示 (如果启用)                                         │
│  • 注入记忆上下文 (如果启用)                                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    fetchChatCompletion                                   │
│  • 获取 Provider 并应用 API Key 轮换                                     │
│  • 获取 MCP 工具列表                                                    │
│  • 构建流式参数                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         ModernAiProvider.completions()                  │
│  • 创建 AI SDK Provider 实例                                            │
│  • 创建模型实例                                                         │
│  • 构建插件                                                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         中间件链处理 (责任链)                             │
│  1. FinalChunkConsumerMiddleware - 最终块消费                           │
│  2. ErrorHandlerMiddleware - 错误处理                                   │
│  3. TransformCoreToSdkParamsMiddleware - 参数转换                       │
│  4. AbortHandlerMiddleware - 中断处理                                   │
│  5. McpToolChunkMiddleware - MCP 工具处理                               │
│  6. TextChunkMiddleware - 文本处理                                      │
│  7. WebSearchMiddleware - 网页搜索                                      │
│  8. ToolUseExtractionMiddleware - 工具使用提取                          │
│  9. ThinkingTagExtractionMiddleware - 思考标签提取                      │
│  10. ThinkChunkMiddleware - 思考块处理                                  │
│  11. ResponseTransformMiddleware - 响应转换                             │
│  12. StreamAdapterMiddleware - 流适配器                                 │
│  13. RawStreamListenerMiddleware - 原始流监听器                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         API 客户端 (流式响应)                             │
│  • OpenAI / Anthropic / Gemini / Azure / AWS Bedrock / 等               │
│  • 返回 AsyncIterable 或 ReadableStream                                 │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      AiSdkToChunkAdapter                                 │
│  • 将 AI SDK 流事件转换为 Chunk                                          │
│  • 处理 tool-input-start/delta/end                                      │
│  • 处理 text-delta, reasoning 等                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      StreamProcessor (Chunk 处理)                        │
│  • 解析 Chunk 类型                                                      │
│  • 分发到对应回调                                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┬───────────────┐
                    ▼               ▼               ▼               ▼
            ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐
            │ TEXT_DELTA │   │THINKING_DL│   │TOOL_PENDING│   │   ERROR   │
            └───────────┘   └───────────┘   └───────────┘   └───────────┘
                    │               │               │               │
                    ▼               ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         BlockManager                                    │
│  • 创建消息块 (MAIN_TEXT, THINKING, TOOL, ERROR 等)                     │
│  • 智能更新块内容 (节流/立即)                                            │
│  • 管理块状态 (PENDING → STREAMING → SUCCESS/ERROR)                     │
│  • 更新 Redux Store 和数据库                                            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Redux Store 更新                                 │
│  • newMessagesActions.upsertOneBlock()                                  │
│  • newMessagesActions.updateMessage()                                   │
│  • 触发 React 重新渲染                                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         React UI 更新                                    │
│  Messages → MessageGroup → MessageItem → MessageContent                 │
│          → MessageBlockRenderer → Block Component                       │
│  • MainTextBlock (Markdown 渲染)                                        │
│  • ThinkingBlock (可折叠思考)                                           │
│  • ToolBlock (工具调用结果)                                             │
│  • ErrorBlock (错误展示)                                                │
│  • CitationBlock (引用来源)                                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      工具调用? (如果有)                                   │
│  • 检查权限 (自动批准/用户确认)                                          │
│  • 执行工具 (IPC → Main Process → MCP Server)                           │
│  • 返回结果                                                             │
│  • 递归调用 AI (最大深度 20)                                            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      对话结束?                                           │
│  • 存储记忆 (如果启用全局记忆)                                           │
│  • 提取个人事实                                                         │
│  • 更新记忆数据库                                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 关键文件索引

### 请求发起

| 文件 | 说明 |
|------|------|
| `src/renderer/src/store/thunk/messageThunk.ts` | 消息发送 Redux Thunk |
| `src/renderer/src/services/ApiService.ts` | API 调用服务 |
| `src/renderer/src/services/ConversationService.ts` | 对话消息准备 |

### AI 核心

| 文件 | 说明 |
|------|------|
| `src/renderer/src/aiCore/legacy/index.ts` | Legacy AiProvider 主入口 |
| `src/renderer/src/aiCore/index_new.ts` | Modern AiProvider (aisdk v6) |
| `src/renderer/src/aiCore/legacy/clients/ApiClientFactory.ts` | API 客户端工厂 |
| `src/renderer/src/aiCore/prepareParams/parameterBuilder.ts` | 参数构建器 |

### 中间件

| 文件 | 说明 |
|------|------|
| `src/renderer/src/aiCore/legacy/middleware/register.ts` | 中间件注册表 |
| `src/renderer/src/aiCore/legacy/middleware/builder.ts` | 中间件构建器 |
| `src/renderer/src/aiCore/legacy/middleware/composer.ts` | 中间件组合器 |
| `src/renderer/src/aiCore/legacy/middleware/common/ErrorHandlerMiddleware.ts` | 错误处理 |
| `src/renderer/src/aiCore/legacy/middleware/common/AbortHandlerMiddleware.ts` | 中断处理 |
| `src/renderer/src/aiCore/legacy/middleware/core/McpToolChunkMiddleware.ts` | MCP 工具处理 |
| `src/renderer/src/aiCore/legacy/middleware/feat/ToolUseExtractionMiddleware.ts` | 工具调用提取 |
| `src/renderer/src/aiCore/legacy/middleware/feat/ThinkingTagExtractionMiddleware.ts` | 思考标签提取 |

### 流处理

| 文件 | 说明 |
|------|------|
| `src/renderer/src/services/StreamProcessingService.ts` | 流处理器 |
| `src/renderer/src/aiCore/chunk/AiSdkToChunkAdapter.ts` | AI SDK 到 Chunk 适配器 |
| `src/renderer/src/types/chunk.ts` | Chunk 类型定义 |
| `src/renderer/src/services/messageStreaming/BlockManager.ts` | Block 管理器 |
| `src/renderer/src/services/messageStreaming/callbacks/` | 流回调处理 |

### 工具调用

| 文件 | 说明 |
|------|------|
| `src/main/services/MCPService.ts` | MCP 服务 (主进程) |
| `src/renderer/src/utils/mcp-tools.ts` | 工具调用工具函数 |
| `src/renderer/src/store/toolPermissions.ts` | 工具权限状态 |
| `src/renderer/src/types/tool.ts` | 工具类型定义 |

### 知识库

| 文件 | 说明 |
|------|------|
| `src/main/services/KnowledgeService.ts` | 知识库服务 (主进程) |
| `src/renderer/src/services/KnowledgeService.ts` | 知识库服务 (渲染进程) |
| `src/renderer/src/aiCore/tools/KnowledgeSearchTool.ts` | 知识库搜索工具 |
| `src/renderer/src/store/knowledge.ts` | 知识库状态管理 |
| `src/renderer/src/queue/KnowledgeQueue.ts` | 知识库处理队列 |
| `src/main/knowledge/embedjs/embeddings/EmbeddingsFactory.ts` | 嵌入模型工厂 |
| `src/main/knowledge/reranker/Reranker.ts` | 重排序器 |

### 记忆

| 文件 | 说明 |
|------|------|
| `src/main/services/memory/MemoryService.ts` | 记忆服务 (主进程) |
| `src/renderer/src/services/MemoryService.ts` | 记忆服务 (渲染进程) |
| `src/renderer/src/services/MemoryProcessor.ts` | 记忆处理器 |
| `src/renderer/src/aiCore/tools/MemorySearchTool.ts` | 记忆搜索工具 |
| `src/renderer/src/store/memory.ts` | 记忆状态管理 |
| `src/renderer/src/utils/memory-prompts.ts` | 记忆 LLM 提示词 |

### 错误处理

| 文件 | 说明 |
|------|------|
| `src/renderer/src/aiCore/legacy/middleware/common/ErrorHandlerMiddleware.ts` | 错误处理中间件 |
| `src/renderer/src/utils/error.ts` | 错误工具函数 |
| `src/renderer/src/types/error.ts` | 错误类型定义 |
| `src/renderer/src/utils/abortController.ts` | AbortController 管理 |
| `src/renderer/src/pages/home/Messages/Blocks/ErrorBlock.tsx` | 错误块 UI 组件 |
| `src/renderer/src/components/ErrorDetailModal/index.tsx` | 错误详情弹窗 |

### 状态管理

| 文件 | 说明 |
|------|------|
| `src/renderer/src/store/index.ts` | Redux Store 配置 |
| `src/renderer/src/store/newMessage.ts` | 消息状态 |
| `src/renderer/src/store/messageBlock.ts` | 消息块状态 |
| `src/renderer/src/store/assistants.ts` | 助手配置 |
| `src/renderer/src/store/llm.ts` | LLM/Provider 配置 |
| `src/renderer/src/store/settings.ts` | 应用设置 |

### UI 组件

| 文件 | 说明 |
|------|------|
| `src/renderer/src/pages/home/Chat.tsx` | 聊天主页面 |
| `src/renderer/src/pages/home/Messages/Messages.tsx` | 消息列表 |
| `src/renderer/src/pages/home/Messages/Message.tsx` | 消息项 |
| `src/renderer/src/pages/home/Messages/MessageContent.tsx` | 消息内容 |
| `src/renderer/src/pages/home/Messages/Blocks/index.tsx` | 消息块渲染器 |
| `src/renderer/src/pages/home/Messages/Blocks/MainTextBlock.tsx` | 文本块 |
| `src/renderer/src/pages/home/Messages/Blocks/ThinkingBlock.tsx` | 思考块 |
| `src/renderer/src/pages/home/Messages/Blocks/ToolBlock.tsx` | 工具块 |
| `src/renderer/src/pages/home/Markdown/Markdown.tsx` | Markdown 渲染 |
| `src/renderer/src/pages/home/Markdown/CodeBlock.tsx` | 代码块渲染 |

### IPC 通信

| 文件 | 说明 |
|------|------|
| `packages/shared/IpcChannel.ts` | IPC 通道定义 |
| `src/preload/index.ts` | Preload 脚本 |
| `src/main/ipc.ts` | 主进程 IPC 处理器 |
