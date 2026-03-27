# Cherry Studio - Claude Agent SDK 设计与调用链路

## 概述

Cherry Studio 集成了 `@anthropic-ai/claude-agent-sdk` (v0.2.56) 来实现 Claude Code 的 Agent 能力。本文档详细描述了 SDK 的集成方式、架构设计和调用链路。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Renderer Process                                 │
│  ┌────────────────┐  ┌──────────────────┐  ┌─────────────────────────────┐  │
│  │  React UI      │  │  Redux Store     │  │  useAgentToolApproval Hook │  │
│  │  Components    │◄─┤  toolPermissions │◄─┤  (Tool Permission Handler)  │  │
│  └────────────────┘  └──────────────────┘  └─────────────────────────────┘  │
│           │                    │                         ▲                   │
│           │                    │                         │ IPC              │
│           ▼                    ▼                         │                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                       Preload (contextBridge)                         │   │
│  │  window.api.agentTools.respondToPermission()                         │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ IPC
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                               Main Process                                   │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    ClaudeCodeService (SDK Wrapper)                     │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌───────────────────────┐  │  │
│  │  │   invoke()      │  │ processSDKQuery │  │ promptForToolApproval │  │  │
│  │  │   Entry Point   │──►│  Stream Handler │──►│  Permission Manager  │  │  │
│  │  └─────────────────┘  └─────────────────┘  └───────────────────────┘  │  │
│  │           │                    │                         │             │  │
│  │           │                    ▼                         ▼             │  │
│  │           │         ┌───────────────────┐    ┌───────────────────┐    │  │
│  │           │         │ transform.ts      │    │ tool-permissions  │    │  │
│  │           │         │ SDK→AI SDK Stream │    │ .ts               │    │  │
│  │           │         └───────────────────┘    └───────────────────┘    │  │
│  │           │                                                           │  │
│  │           ▼                                                           │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │            @anthropic-ai/claude-agent-sdk                        │  │  │
│  │  │            query({ prompt, options })                             │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 核心文件结构

```
src/main/services/agents/
├── BaseService.ts                          # 基础服务类，提供共享工具方法
├── services/
│   ├── AgentService.ts                     # Agent 管理 CRUD 服务
│   ├── SessionService.ts                   # Session 管理服务
│   ├── SessionMessageService.ts            # 消息管理服务
│   └── claudecode/                         # Claude Agent SDK 集成核心
│       ├── index.ts                        # ClaudeCodeService 主入口
│       ├── transform.ts                    # SDK 消息转换器
│       ├── utils.ts                        # 工具函数
│       ├── tool-permissions.ts             # 工具权限管理
│       ├── tools.ts                        # 内置工具定义
│       ├── commands.ts                     # 斜杠命令定义
│       └── claude-stream-state.ts          # 流状态管理
├── plugins/
│   └── PluginService.ts                    # 插件服务
├── interfaces/
│   └── AgentStreamInterface.ts             # Agent 流接口定义
└── database/
    └── schema/                             # 数据库 Schema

src/renderer/src/
├── store/
│   └── toolPermissions.ts                  # Redux 状态管理
├── hooks/
│   └── useAppInit.ts                       # IPC 事件监听注册
└── pages/home/Messages/Tools/hooks/
    └── useAgentToolApproval.ts             # 工具审批 Hook

src/preload/index.ts                        # IPC 桥接层

scripts/
└── patch-claude-agent-sdk.ts               # SDK 补丁脚本

patches/
└── @anthropic-ai__claude-agent-sdk@0.1.76.patch
```

## 核心组件详解

### 1. ClaudeCodeService (`src/main/services/agents/services/claudecode/index.ts`)

主要职责：
- 封装 `@anthropic-ai/claude-agent-sdk` 的 `query` 函数
- 管理 SDK 调用的生命周期
- 处理工具权限请求
- 配置环境变量和运行参数

#### 关键方法：`invoke()`

```typescript
async invoke(
  prompt: string,
  session: GetAgentSessionResponse,
  abortController: AbortController,
  lastAgentSessionId?: string,
  thinkingOptions?: AgentThinkingOptions
): Promise<AgentStream>
```

**调用流程：**

1. **验证阶段**
   - 检查 `accessible_paths` 是否存在
   - 验证模型 ID 和 Provider 配置

2. **环境配置**
   ```typescript
   const env = {
     ANTHROPIC_API_KEY: modelInfo.provider.apiKey,
     ANTHROPIC_BASE_URL: anthropicBaseUrl,
     ANTHROPIC_MODEL: modelInfo.modelId,
     CLAUDE_CONFIG_DIR: path.join(app.getPath('userData'), '.claude'),
     // ... 其他配置
   }
   ```

3. **工具权限处理**
   - `canUseTool` 回调：处理需要权限的工具
   - `PreToolUse` Hook：在工具执行前触发

4. **SDK 选项配置**
   ```typescript
   const options: Options = {
     abortController,
     cwd,
     env,
     pathToClaudeCodeExecutable: this.claudeExecutablePath,
     systemPrompt: { type: 'preset', preset: 'claude_code', append: ... },
     permissionMode: session.configuration?.permission_mode,
     maxTurns: session.configuration?.max_turns,
     allowedTools: session.allowed_tools,
     plugins,
     canUseTool,
     hooks: { PreToolUse: [...] },
     mcpServers,  // MCP 服务器配置
     // ...
   }
   ```

5. **启动 SDK 查询**
   ```typescript
   for await (const message of query({ prompt: promptStream, options })) {
     // 处理 SDK 消息
   }
   ```

### 2. 消息转换器 (`transform.ts`)

将 SDK 的 `SDKMessage` 转换为 AI SDK 的 `TextStreamPart` 格式。

#### 消息类型处理：

| SDK 类型 | 处理函数 | 输出 |
|---------|---------|------|
| `assistant` | `handleAssistantMessage` | text-*, tool-call, finish-step |
| `user` | `handleUserMessage` | tool-result, tool-error |
| `stream_event` | `handleStreamEvent` | start-step, text-*, reasoning-*, tool-input-*, finish-step |
| `system` | `handleSystemMessage` | start, raw (init/compact) |
| `result` | `handleResultMessage` | finish, error |

#### 流生命周期：

```
message_start → start-step
content_block_start → text-start | reasoning-start | tool-input-start
content_block_delta → text-delta | reasoning-delta | tool-input-delta
content_block_stop → text-end | reasoning-end | tool-input-end
message_delta → (缓存 usage + finishReason)
message_stop → finish-step
```

### 3. 流状态管理 (`claude-stream-state.ts`)

`ClaudeStreamState` 类管理单个 Agent 会话的流状态：

```typescript
class ClaudeStreamState {
  // 内容块状态
  private blocksByIndex = new Map<number, BlockState>()

  // 工具调用 ID 映射
  private toolIndexByNamespacedId = new Map<string, number>()

  // 待处理的 token 使用量
  private pendingUsage: PendingUsageState = {}

  // 待处理的工具调用（用于结果匹配）
  private pendingToolCalls = new Map<string, PendingToolCall>()
}
```

**关键功能：**
- `buildNamespacedToolCallId()`: 生成命名空间的工具调用 ID (`sessionId:rawToolCallId`)
- `openTextBlock/openReasoningBlock/openToolBlock()`: 打开内容块
- `appendTextDelta/appendReasoningDelta()`: 追加增量内容
- `registerToolCall/consumePendingToolCall()`: 注册/消费工具调用

### 4. 工具权限管理 (`tool-permissions.ts`)

#### 权限请求流程：

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   SDK Callback   │────►│ promptForToolApproval │────►│  IPC Broadcast  │
│   canUseTool     │     │   (Main Process)       │     │  to Renderer    │
└──────────────────┘     └──────────────────┘     └──────────────────┘
                                                          │
                                                          ▼
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   SDK Continue   │◄────│  IPC Response   │◄────│  User Decision   │
│   Execution      │     │   Handler       │     │  (Allow/Deny)    │
└──────────────────┘     └──────────────────┘     └──────────────────┘
```

#### 关键数据结构：

```typescript
type RendererPermissionRequestPayload = {
  requestId: string
  toolName: string
  toolId: string
  toolCallId: string
  description?: string
  requiresPermissions: boolean
  input: Record<string, unknown>
  inputPreview: string
  createdAt: number
  expiresAt: number
  suggestions: PermissionUpdate[]
  autoApprove?: boolean
}
```

#### IPC 通道：

| 通道 | 方向 | 用途 |
|-----|------|-----|
| `AgentToolPermission_Request` | Main → Renderer | 发送权限请求 |
| `AgentToolPermission_Result` | Main → Renderer | 通知结果 |
| `AgentToolPermission_Response` | Renderer → Main | 用户响应 |

### 5. SDK 补丁 (`scripts/patch-claude-agent-sdk.ts`）

由于 SDK 是压缩/混淆后的代码，Cherry Studio 需要打补丁以支持 Electron IPC：

**补丁内容：**

1. **spawn → fork**：将 `child_process.spawn` 改为 `fork`
2. **移除 command 参数**：修改 `spawnLocalProcess` 的解构
3. **重写 stdio 配置**：添加 IPC 通道支持
   ```javascript
   // Before
   stdio: ["pipe", "pipe", stderrMode]

   // After
   stdio: stderrMode === "pipe"
     ? ["pipe", "pipe", "pipe", "ipc"]
     : ["pipe", "pipe", "ignore", "ipc"]
   ```

## 内置工具定义 (`tools.ts`)

```typescript
export const builtinTools: Tool[] = [
  { id: 'Bash', name: 'Bash', requirePermissions: true },
  { id: 'Edit', name: 'Edit', requirePermissions: true },
  { id: 'Glob', name: 'Glob', requirePermissions: false },
  { id: 'Grep', name: 'Grep', requirePermissions: false },
  { id: 'MultiEdit', name: 'MultiEdit', requirePermissions: true },
  { id: 'NotebookEdit', name: 'NotebookEdit', requirePermissions: true },
  { id: 'NotebookRead', name: 'NotebookRead', requirePermissions: false },
  { id: 'Read', name: 'Read', requirePermissions: false },
  { id: 'Task', name: 'Task', requirePermissions: false },
  { id: 'TodoWrite', name: 'TodoWrite', requirePermissions: false },
  { id: 'WebFetch', name: 'WebFetch', requirePermissions: true },
  { id: 'WebSearch', name: 'WebSearch', requirePermissions: true },
  { id: 'Write', name: 'Write', requirePermissions: true }
]
```

**自动允许的工具：**
- `Read`, `Glob`, `Grep` - 默认自动允许
- Session 配置的 `allowed_tools` - 自动允许

## 渲染器端处理

### Redux Store (`toolPermissions.ts`)

```typescript
interface ToolPermissionsState {
  requests: Record<string, ToolPermissionEntry>
  resolvedInputs: Record<string, Record<string, unknown>>
}

type ToolPermissionStatus = 'pending' | 'submitting-allow' | 'submitting-deny' | 'invoking'
```

### useAgentToolApproval Hook

```typescript
function useAgentToolApproval(
  block?: ToolMessageBlock | null,
  options?: { toolCallId?: string }
): ToolApprovalState & ToolApprovalActions
```

**返回值：**
- `isWaiting`: 等待用户响应
- `isExecuting`: 工具执行中
- `remainingSeconds`: 剩余时间
- `confirm()`: 允许工具执行
- `cancel()`: 拒绝工具执行
- `autoApprove()`: 自动批准（有建议时）

## 完整调用链路

### 1. 用户发起消息

```
User Input
    │
    ▼
API Server Route (/v1/agents/sessions/:sessionId/messages)
    │
    ▼
SessionMessageService.sendMessage()
    │
    ▼
ClaudeCodeService.invoke()
```

### 2. SDK 执行流程

```
ClaudeCodeService.invoke()
    │
    ├─► 验证 session 和 model
    │
    ├─► 配置环境变量
    │
    ├─► 创建 userInputStream
    │
    ├─► 调用 query({ prompt, options })
    │       │
    │       ▼
    │   SDK CLI Process (fork)
    │       │
    │       ├─► 执行工具调用
    │       │       │
    │       │       ├─► canUseTool callback
    │       │       │       │
    │       │       │       ▼
    │       │       │   promptForToolApproval()
    │       │       │       │
    │       │       │       ├─► IPC → Renderer
    │       │       │       │
    │       │       │       ◄─ IPC Response ◄─
    │       │       │       │
    │       │       │       ▼
    │       │       │   返回 { behavior: 'allow' | 'deny' }
    │       │       │
    │       │       └─► 执行/跳过工具
    │       │
    │       └─► 返回 SDKMessage
    │
    ├─► transformSDKMessageToStreamParts()
    │       │
    │       ▼
    │   AgentStreamPart[]
    │
    └─► emit('data', { type: 'chunk', chunk })
```

### 3. 前端渲染

```
AgentStream.emit('data')
    │
    ▼
API Server SSE Response
    │
    ▼
Renderer MessageHandler
    │
    ├─► 处理 text-delta → 更新消息内容
    │
    ├─► 处理 tool-call → 显示工具调用
    │
    ├─► 处理 tool-result → 显示工具结果
    │
    └─► 处理权限请求 → 显示确认对话框
```

## 环境变量配置

SDK 运行时依赖的环境变量：

| 变量名 | 用途 |
|-------|------|
| `ANTHROPIC_API_KEY` | API 密钥 |
| `ANTHROPIC_BASE_URL` | API 基础 URL |
| `ANTHROPIC_MODEL` | 默认模型 |
| `CLAUDE_CONFIG_DIR` | Claude 配置目录 |
| `CLAUDE_CODE_USE_BEDROCK` | 禁用 Bedrock (设为 '0') |
| `CLAUDE_CODE_GIT_BASH_PATH` | Windows Git Bash 路径 |

## MCP 服务器集成

SDK 支持通过 HTTP MCP 服务器扩展工具：

```typescript
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
}
```

## 插件系统

支持加载本地插件：

```typescript
const pluginPaths = await pluginService.listInstalledPluginPackagePaths(session.agent_id)
if (pluginPaths.length > 0) {
  plugins = pluginPaths.map((pluginPath) => ({ type: 'local', path: pluginPath }))
}
options.plugins = plugins
```

## 错误处理

- **AbortError**: 用户取消请求
- **Permission Denied**: 工具权限被拒绝
- **Timeout**: 权限请求超时 (60秒)
- **Model Validation**: 模型配置错误

## 总结

Cherry Studio 通过精心设计的架构实现了与 Claude Agent SDK 的深度集成：

1. **主进程封装**: `ClaudeCodeService` 提供统一的调用入口
2. **消息转换**: 将 SDK 消息转换为 AI SDK 兼容格式
3. **权限管理**: 完整的 IPC 通信机制处理工具权限
4. **状态管理**: Redux store 追踪权限请求状态
5. **插件支持**: 支持本地插件和 MCP 服务器扩展
6. **补丁机制**: 通过运行时补丁支持 Electron IPC

这种设计使得 Cherry Studio 能够充分利用 Claude Code 的强大能力，同时保持良好的用户体验和安全性。