# Claude Agent SDK 设计文档

## 1. 概述

Cherry Studio 使用 `@anthropic-ai/claude-agent-sdk` 作为 Claude Code Agent 的核心 SDK。该模块负责：

- 与 Claude Code CLI 交互执行自主代理任务
- 管理工具调用权限
- 处理流式响应和状态管理
- 集成 MCP (Model Context Protocol) 服务器

## 2. 核心目录结构

```
src/main/services/agents/
├── services/
│   ├── AgentService.ts          # Agent 生命周期管理
│   ├── SessionService.ts        # Session 会话管理
│   ├── SessionMessageService.ts  # 消息历史管理
│   └── claudecode/
│       ├── index.ts             # ClaudeCodeService 主入口
│       ├── transform.ts         # SDK 消息转换为 AI SDK 格式
│       ├── tool-permissions.ts   # 工具权限管理
│       ├── tools.ts             # 内置工具定义
│       ├── commands.ts          # 内置斜杠命令
│       ├── claude-stream-state.ts # 流式状态管理
│       └── utils.ts             # 工具函数
├── interfaces/
│   └── AgentStreamInterface.ts  # 通用 Agent 流接口定义
└── BaseService.ts               # 服务基类
```

## 3. 核心接口设计

### 3.1 AgentStreamInterface (AgentStreamInterface.ts)

```typescript
// 通用 Agent 流事件
export interface AgentStreamEvent {
  type: 'chunk' | 'error' | 'complete' | 'cancelled'
  chunk?: TextStreamPart<any>  // 标准 AI SDK chunk
  error?: Error
}

// Agent 流接口 (所有 Agent 服务需实现)
export interface AgentStream extends EventEmitter {
  emit(event: 'data', data: AgentStreamEvent): boolean
  on(event: 'data', listener: (data: AgentStreamEvent) => void): this
  once(event: 'data', listener: (data: AgentStreamEvent) => void): this
}

// Agent 服务基接口
export interface AgentServiceInterface {
  invoke(
    prompt: string,
    session: GetAgentSessionResponse,
    abortController: AbortController,
    lastAgentSessionId?: string,
    thinkingOptions?: AgentThinkingOptions
  ): Promise<AgentStream>
}
```

### 3.2 ClaudeCodeService 主类

```typescript
class ClaudeCodeService implements AgentServiceInterface {
  // SDK 可执行文件路径
  private claudeExecutablePath: string

  // 核心调用方法
  async invoke(
    prompt: string,
    session: GetAgentSessionResponse,
    abortController: AbortController,
    lastAgentSessionId?: string,
    thinkingOptions?: AgentThinkingOptions
  ): Promise<AgentStream>
}
```

## 4. 调用链路

### 4.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        Renderer Process                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │   UI Layer  │  │ Store(Redux) │  │ useAgentToolApproval   │  │
│  └──────┬──────┘  └──────┬───────┘  └───────────┬────────────┘  │
│         │                 │                      │               │
│         └─────────────────┼──────────────────────┘               │
│                           │ IPC                                    │
└───────────────────────────┼───────────────────────────────────────┘
                            │
┌───────────────────────────┼───────────────────────────────────────┐
│                     Main Process                                  │
│  ┌────────────────────────┴────────────────────────────────────┐  │
│  │                    API Server Routes                         │  │
│  │              /v1/agents/:agentId/invoke                     │  │
│  └────────────────────────┬────────────────────────────────────┘  │
│                           │                                       │
│  ┌────────────────────────┴────────────────────────────────────┐  │
│  │              ClaudeCodeService.invoke()                      │  │
│  │  ┌─────────────────────────────────────────────────────────┐ │  │
│  │  │ 1. 验证 session 和模型配置                              │ │  │
│  │  │ 2. 构建环境变量 (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL) │ │  │
│  │  │ 3. 配置工具权限回调 (canUseTool, hooks)                 │ │  │
│  │  │ 4. 调用 SDK query() 方法                               │ │  │
│  │  └─────────────────────────────────────────────────────────┘ │  │
│  └────────────────────────┬────────────────────────────────────┘  │
│                           │                                       │
│  ┌────────────────────────┴────────────────────────────────────┐  │
│  │              transformSDKMessageToStreamParts()              │  │
│  │  - 将 SDKMessage 转换为 AgentStreamPart (AI SDK 格式)       │  │
│  │  - 管理 ClaudeStreamState 状态                              │  │
│  └────────────────────────┬────────────────────────────────────┘  │
│                           │                                       │
│  ┌────────────────────────┴────────────────────────────────────┐  │
│  │              @anthropic-ai/claude-agent-sdk                  │  │
│  │                    query() / CLI                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

### 4.2 详细调用流程

#### Step 1: API 入口 (Renderer → Main)

```typescript
// renderer/src/api/agent.ts
window.api.agent.invokeAgent({
  agentId: string,
  sessionId: string,
  prompt: string,
  lastAgentSessionId?: string,
  thinkingOptions?: { effort?: string; thinking?: string }
})
```

#### Step 2: Main Process Handler

```typescript
// 通过 IPC 路由到 AgentService
ClaudeCodeService.invoke(prompt, session, abortController, lastAgentSessionId, thinkingOptions)
```

#### Step 3: SDK 调用准备

```typescript
// index.ts - ClaudeCodeService.invoke()

// 1. 验证工作目录
const cwd = session.accessible_paths[0]

// 2. 验证模型配置
const modelInfo = await validateModelId(session.model)

// 3. 构建环境变量
const env = {
  ANTHROPIC_API_KEY: modelInfo.provider.apiKey,
  ANTHROPIC_BASE_URL: anthropicBaseUrl,
  ANTHROPIC_MODEL: modelInfo.modelId,
  CLAUDE_CODE_USE_BEDROCK: '0',
  // ...
}

// 4. 配置工具权限
const canUseTool: CanUseTool = async (toolName, input, options) => {
  // 自动允许的工具 (Read, Glob, Grep)
  if (autoAllowTools.has(toolName)) {
    return { behavior: 'allow', updatedInput: input }
  }
  // 需要用户确认的工具
  return promptForToolApproval(toolName, input, { toolCallId, ...options })
}

// 5. 配置 PreToolUse Hook
const preToolUseHook: HookCallback = async (input, toolUseID, options) => {
  if (input.hook_event_name !== 'PreToolUse') return {}
  // 处理自动批准的工...
```

#### Step 4: SDK 执行

```typescript
// 调用 SDK query 方法
const { stream: userInputStream, close: closeUserStream } = this.createUserMessageStream(prompt, abortSignal)

for await (const message of query({ prompt: userInputStream, options })) {
  // 处理 SDK 消息
  const chunks = transformSDKMessageToStreamParts(message, streamState)
  for (const chunk of chunks) {
    stream.emit('data', { type: 'chunk', chunk })
  }
}
```

#### Step 5: 消息转换

```typescript
// transform.ts - transformSDKMessageToStreamParts()

// SDK 消息类型处理
switch (sdkMessage.type) {
  case 'assistant':    // 处理助手消息
  case 'user':         // 处理用户消息 (工具结果)
  case 'stream_event': // 处理流式事件
  case 'system':      // 处理系统消息 (初始化)
  case 'result':      // 处理最终结果
}
```

## 5. 状态管理 (ClaudeStreamState)

### 5.1 状态追踪

```typescript
export class ClaudeStreamState {
  private blocksByIndex = new Map<number, BlockState>()      // 按索引跟踪块
  private toolIndexByNamespacedId = new Map<string, number>() // 工具 ID 映射
  private pendingUsage: PendingUsageState = {}                // 待处理的 usage
  private pendingToolCalls = new Map<string, PendingToolCall>() // 待处理的工具调用
  private stepActive = false                                  // 当前步骤是否活跃
}
```

### 5.2 块类型

```typescript
type TextBlockState = BaseBlockState & {
  kind: 'text'
  text: string
}

type ReasoningBlockState = BaseBlockState & {
  kind: 'reasoning'
  text: string
  redacted: boolean
}

type ToolBlockState = BaseBlockState & {
  kind: 'tool'
  toolCallId: string
  rawToolCallId: string
  toolName: string
  providerMetadata?: ProviderMetadata
}
```

## 6. 工具权限系统

### 6.1 架构

```
┌──────────────────┐    IPC    ┌───────────────────┐
│  ClaudeCode      │ ────────→ │  tool-permissions │
│  Service         │            │  .promptForTool   │
│                 │            │  Approval()       │
│  canUseTool     │            └─────────┬─────────┘
│  callback       │                      │
└─────────────────┘                      │
                                         ▼
                              ┌───────────────────────┐
                              │  pendingRequests Map  │
                              │  + timeout (60s)     │
                              └─────────┬───────────┘
                                        │
                                        ▼
                              ┌───────────────────────┐
                              │  broadcastToRenderer  │
                              │  IPC Channel         │
                              │  AgentToolPermission │
                              │  _Request            │
                              └─────────┬───────────┘
                                        │
┌───────────────────────────────────────┼───────────────────────────┐
│           Renderer Process            │                            │
│                            IPC Channel│                            │
│                            AgentTool │                            │
│                            Permission│                            │
│                            _Result   │                            │
│                                       ▼                            │
│  ┌─────────────────────────────────────────────┐                   │
│  │  toolPermissionsSlice (Redux)               │                   │
│  │  - requestReceived                          │                   │
│  │  - submissionSent                           │                   │
│  │  - requestResolved                          │                   │
│  └─────────────────────────────────────────────┘                   │
└───────────────────────────────────────────────────────────────────┘
```

### 6.2 内置工具定义 (tools.ts)

```typescript
export const builtinTools: Tool[] = [
  { id: 'Bash', name: 'Bash', requirePermissions: true, type: 'builtin' },
  { id: 'Edit', name: 'Edit', requirePermissions: true, type: 'builtin' },
  { id: 'Glob', name: 'Glob', requirePermissions: false, type: 'builtin' },
  { id: 'Grep', name: 'Grep', requirePermissions: false, type: 'builtin' },
  { id: 'MultiEdit', name: 'MultiEdit', requirePermissions: true, type: 'builtin' },
  { id: 'Read', name: 'Read', requirePermissions: false, type: 'builtin' },
  { id: 'Task', name: 'Task', requirePermissions: false, type: 'builtin' },
  { id: 'WebFetch', name: 'WebFetch', requirePermissions: true, type: 'builtin' },
  { id: 'WebSearch', name: 'WebSearch', requirePermissions: true, type: 'builtin' },
  { id: 'Write', name: 'Write', requirePermissions: true, type: 'builtin' },
  // ...
]
```

### 6.3 权限流程

```typescript
// 1. SDK 调用 canUseTool 回调
const canUseTool: CanUseTool = async (toolName, input, options) => {
  // 检查是否自动允许
  if (autoAllowTools.has(toolName)) {
    return { behavior: 'allow', updatedInput: input }
  }

  // 通过 IPC 等待用户响应
  return promptForToolApproval(toolName, input, { toolCallId, signal, suggestions })
}

// 2. 等待用户决策 (60s 超时)
return new Promise<PermissionResult>((resolve) => {
  const timeout = setTimeout(() => {
    finalizeRequest(requestId, { behavior: 'deny', message: 'Timed out' }, 'timeout')
  }, TOOL_APPROVAL_TIMEOUT_MS)

  pendingRequests.set(requestId, { fulfill: resolve, timeout, ... })
  broadcastToRenderer(IpcChannel.AgentToolPermission_Request, requestPayload)
})
```

## 7. SDK 消息转换 (transform.ts)

### 7.1 消息类型映射

| SDK 消息类型 | 转换后的事件 |
|-------------|-------------|
| `system/init` | `start`, `raw` |
| `assistant` | `start-step`, `text-start/delta/end`, `tool-call` |
| `stream_event/message_start` | `start-step` |
| `stream_event/content_block_start` | `text-start`, `reasoning-start`, `tool-input-start` |
| `stream_event/content_block_delta` | `text-delta`, `reasoning-delta`, `tool-input-delta` |
| `stream_event/content_block_stop` | `text-end`, `reasoning-end`, `tool-input-end` |
| `stream_event/message_delta` | (缓存 usage) |
| `stream_event/message_stop` | `finish-step` |
| `user/tool_result` | `tool-result` |
| `result/success` | `finish` |
| `result/error_*` | `error` |

### 7.2 Usage 转换

```typescript
// utils.ts
export function convertClaudeCodeUsage(usage: ClaudeCodeUsage): LanguageModelUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    totalTokens: inputTokens + outputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0
    }
  }
}
```

## 8. MCP 集成

### 8.1 MCP 配置

```typescript
// 在 session.mcps 中配置 MCP 服务器
if (session.mcps && session.mcps.length > 0) {
  const mcpList: Record<string, McpHttpServerConfig> = {}
  for (const mcpId of session.mcps) {
    mcpList[mcpId] = {
      type: 'http',
      url: `http://${apiConfig.host}:${apiConfig.port}/v1/mcps/${mcpId}/mcp`,
      headers: { Authorization: `Bearer ${apiConfig.apiKey}` }
    }
  }
  options.mcpServers = mcpList
  options.strictMcpConfig = true
}
```

## 9. 环境变量配置

| 变量名 | 说明 |
|-------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `ANTHROPIC_AUTH_TOKEN` | 认证令牌 (同 API Key) |
| `ANTHROPIC_BASE_URL` | API 基础 URL |
| `ANTHROPIC_MODEL` | 默认模型 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Opus 模型 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Sonnet 模型 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Haiku 模型 |
| `CLAUDE_CODE_USE_BEDROCK` | 禁用 Bedrock (设为 '0') |
| `CLAUDE_CONFIG_DIR` | SDK 配置目录 |
| `CLAUDE_CODE_GIT_BASH_PATH` | Windows Git Bash 路径 |

## 10. 错误处理

### 10.1 错误类型

```typescript
type AgentStreamEvent =
  | { type: 'chunk'; chunk: TextStreamPart<any> }
  | { type: 'error'; error: Error }
  | { type: 'complete' }
  | { type: 'cancelled'; error: Error }
```

### 10.2 错误映射

```typescript
// SDK 错误 → 应用错误
const isAborted =
  errorObj?.name === 'AbortError' ||
  errorObj?.message?.includes('aborted') ||
  options.abortController?.signal.aborted

if (isAborted) {
  stream.emit('data', { type: 'cancelled', error: new Error('Request aborted') })
} else {
  stream.emit('data', { type: 'error', error: new Error(errorMessage) })
}
```

## 11. 关键文件列表

| 文件 | 职责 |
|-----|------|
| `services/claudecode/index.ts` | 主服务入口，SDK 调用编排 |
| `services/claudecode/transform.ts` | SDK 消息 → AI SDK 格式转换 |
| `services/claudecode/claude-stream-state.ts` | 流式状态管理 |
| `services/claudecode/tool-permissions.ts` | 工具权限管理 |
| `services/claudecode/tools.ts` | 内置工具定义 |
| `services/claudecode/utils.ts` | 工具函数 (usage 转换等) |
| `interfaces/AgentStreamInterface.ts` | 通用接口定义 |
| `BaseService.ts` | 服务基类 |
| `store/toolPermissions.ts` | Redux 权限状态管理 (Renderer) |
| `useAgentToolApproval.ts` | 权限审批 Hook (Renderer) |
