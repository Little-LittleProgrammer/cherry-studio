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

## 配置管理与服务关联

### 服务层级架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            AgentService                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                      Agent 配置（数据库: agents 表）                   │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  id, type, name, description                                    │  │  │
│  │  │  instructions                    ← 系统提示词                    │  │  │
│  │  │  accessible_paths[]              ← 工作区路径                    │  │  │
│  │  │  model, plan_model, small_model  ← 模型配置                      │  │  │
│  │  │  mcps[]                          ← 绑定的 MCP 服务 ID            │  │  │
│  │  │  allowed_tools[]                 ← 工具白名单                    │  │  │
│  │  │  configuration{}                 ← 扩展配置（JSON）              │  │  │
│  │  │  installed_plugins[]             ← 已装插件（从 plugins.json 读）│  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                     │                                       │
│                                     │ 创建 Session 时继承                   │
│                                     ▼                                       │
└─────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────────┐
│                            SessionService                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    Session 会话（数据库: sessions 表）                 │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  id, agent_id (FK → agents.id), agent_type                      │  │  │
│  │  │  ──────────────────────────────────────────────────────────────  │  │  │
│  │  │  继承自 AgentBaseSchema（可覆盖）：                              │  │  │
│  │  │  name, description, instructions                                │  │  │
│  │  │  accessible_paths[]   ← 可覆盖 Agent 默认路径                    │  │  │
│  │  │  model, plan_model... ← 可覆盖 Agent 默认模型                    │  │  │
│  │  │  mcps[]               ← 可覆盖 Agent 的 MCP 绑定                 │  │  │
│  │  │  allowed_tools[]      ← 可覆盖 Agent 的工具白名单                │  │  │
│  │  │  configuration{}      ← 可覆盖 Agent 的扩展配置                  │  │  │
│  │  │  ──────────────────────────────────────────────────────────────  │  │  │
│  │  │  Session 特有字段：                                              │  │  │
│  │  │  slash_commands[]     ← SDK 初始化返回的斜杠命令快照             │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                       │  │
│  │  getSession() 返回时动态注入：                                        │  │
│  │  - tools[]              ← 根据 mcps 调用 listMcpTools() 生成          │  │
│  │  - normalized allowed_tools ← 兼容旧版 MCP 工具 ID 格式               │  │
│  │  - slash_commands[]     ← 合并内置命令 + 本地命令插件                 │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                     │                                       │
│                                     │ invoke() 调用时传入                   │
│                                     ▼                                       │
└─────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ClaudeCodeService                                   │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     SDK 调用配置组装                                  │  │
│  │                                                                       │  │
│  │  invoke(prompt, session, abortController, lastAgentSessionId)        │  │
│  │                                                                       │  │
│  │  ┌───────────────────────────────────────────────────────────────┐   │  │
│  │  │  从 session 提取的运行时配置：                                  │   │  │
│  │  │                                                                 │   │  │
│  │  │  cwd = session.accessible_paths[0]                             │   │  │
│  │  │                                                                 │   │  │
│  │  │  环境变量 (env):                                                │   │  │
│  │  │    ANTHROPIC_API_KEY ← provider.apiKey                         │   │  │
│  │  │    ANTHROPIC_BASE_URL ← provider.anthropicApiHost              │   │  │
│  │  │    ANTHROPIC_MODEL ← session.model                             │   │  │
│  │  │    CLAUDE_CONFIG_DIR ← userData/.claude                        │   │  │
│  │  │    + session.configuration.env_vars (用户自定义)               │   │  │
│  │  │                                                                 │   │  │
│  │  │  SDK Options:                                                  │   │  │
│  │  │    cwd ← session.accessible_paths[0]                           │   │  │
│  │  │    systemPrompt.append ← session.instructions                  │   │  │
│  │  │    permission_mode ← session.configuration.permission_mode     │   │  │
│  │  │    max_turns ← session.configuration.max_turns                 │   │  │
│  │  │    allowed_tools ← session.allowed_tools                       │   │  │
│  │  │    mcp_servers ← session.mcps → 转换为 HTTP MCP URL            │   │  │
│  │  │    plugins ← agent.installed_plugins → 本地插件路径            │   │  │
│  │  └───────────────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 配置字段详解

#### AgentBaseSchema（Agent 和 Session 共享的基础字段）

| 字段 | 类型 | 用途 |
|-----|------|-----|
| `name` | string | 显示名称 |
| `description` | string | 描述 |
| `accessible_paths` | string[] | 工作区路径（首项作为 `cwd`） |
| `instructions` | string | 系统提示词（追加到 SDK 默认 prompt） |
| `model` | string | 主模型 ID（必填） |
| `plan_model` | string | 规划/思考模型 ID |
| `small_model` | string | 小模型 ID（快速任务） |
| `mcps` | string[] | 绑定的 MCP 服务 ID 列表 |
| `allowed_tools` | string[] | 自动放行的工具 ID 白名单 |
| `slash_commands` | SlashCommand[] | 斜杠命令列表 |
| `configuration` | object | 扩展配置（见下表） |

#### configuration 扩展配置

| 字段 | 类型 | 用途 |
|-----|------|-----|
| `permission_mode` | 'auto' \| 'plan' \| 'acceptEdits' | SDK 权限模式 |
| `max_turns` | number | 最大对话轮次 |
| `env_vars` | Record<string, string> | 自定义环境变量（注入 SDK 子进程） |

### 配置继承与覆盖规则

```typescript
// SessionService.createSession()
const sessionData: Partial<CreateSessionRequest> = {
  ...agent,      // 1. 先继承 Agent 的所有配置
  ...req         // 2. 再用请求体覆盖
}
```

**示例：**

```typescript
// Agent 配置
{
  model: 'claude-sonnet-4-20250514',
  accessible_paths: ['/Users/work/project-a'],
  mcps: ['mcp-filesystem', 'mcp-github'],
  allowed_tools: ['Read', 'Glob', 'Grep']
}

// 创建 Session 时覆盖模型
{
  model: 'claude-opus-4-20250514',  // 覆盖使用 Opus
  // 其他字段继承自 Agent
}

// 最终 session 配置
{
  model: 'claude-opus-4-20250514',  // 使用覆盖值
  accessible_paths: ['/Users/work/project-a'],  // 继承
  mcps: ['mcp-filesystem', 'mcp-github'],  // 继承
  allowed_tools: ['Read', 'Glob', 'Grep']  // 继承
}
```

### 动态注入字段

`getSession()` / `getAgent()` 返回时会动态计算以下字段：

```typescript
// BaseService.listMcpTools()
const { tools, legacyIdMap } = await this.listMcpTools(agent.type, agent.mcps)
session.tools = tools  // 内置工具 + MCP 工具列表

// BaseService.normalizeAllowedTools()
session.allowed_tools = this.normalizeAllowedTools(session.allowed_tools, tools, legacyIdMap)
// 兼容旧版 MCP 工具 ID：mcp__serverId__tool → mcp__serverName__tool

// SessionService.listSlashCommands()
session.slash_commands = await this.listSlashCommands(session.agent_type, agentId)
// 内置斜杠命令 + .claude/commands/ 下的本地命令

// AgentService.getAgent()
agent.installed_plugins = await pluginService.listInstalledFromCache(workdir)
// 从 .claude/plugins.json 读取已安装插件
```

### 数据库表结构

#### agents 表

```typescript
// src/main/services/agents/database/schema/agents.schema.ts
export const agentsTable = sqliteTable('agents', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),              // 'claude-code' | 其他类型
  name: text('name').notNull(),
  description: text('description'),
  accessible_paths: text('accessible_paths'), // JSON array
  instructions: text('instructions'),
  model: text('model').notNull(),            // 必填
  plan_model: text('plan_model'),
  small_model: text('small_model'),
  mcps: text('mcps'),                        // JSON array of MCP IDs
  allowed_tools: text('allowed_tools'),      // JSON array of tool IDs
  configuration: text('configuration'),      // JSON object
  sort_order: integer('sort_order').default(0),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull()
})
```

#### sessions 表

```typescript
// src/main/services/agents/database/schema/sessions.schema.ts
export const sessionsTable = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  agent_id: text('agent_id').notNull(),      // FK → agents.id (CASCADE DELETE)
  agent_type: text('agent_type').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  accessible_paths: text('accessible_paths'), // 可覆盖 Agent 默认值
  instructions: text('instructions'),
  model: text('model').notNull(),
  plan_model: text('plan_model'),
  small_model: text('small_model'),
  mcps: text('mcps'),
  allowed_tools: text('allowed_tools'),
  slash_commands: text('slash_commands'),    // Session 特有
  configuration: text('configuration'),
  sort_order: integer('sort_order').default(0),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull()
})
```

### 调用链路中的配置流转

```
API: POST /v1/agents/:agentId/sessions/:sessionId/messages
    │
    ▼
SessionMessageService.createSessionMessage(session, messageData, abortController)
    │
    ├─► session 来自 SessionService.getSession()
    │   包含：model, accessible_paths, mcps, allowed_tools, configuration, tools, slash_commands
    │
    ▼
ClaudeCodeService.invoke(prompt, session, abortController, lastAgentSessionId, thinkingOptions)
    │
    ├─► 校验 session.model → validateModelId()
    │
    ├─► 校验 session.accessible_paths[0] 作为 cwd
    │
    ├─► 组装环境变量
    │   - provider 信息从 model 解析
    │   - env_vars 从 session.configuration 合并
    │
    ├─► 组装 SDK Options
    │   - permission_mode ← session.configuration.permission_mode
    │   - max_turns ← session.configuration.max_turns
    │   - allowed_tools ← session.allowed_tools
    │   - mcpServers ← session.mcps（转换为 HTTP URL）
    │   - plugins ← pluginService.listInstalledPluginPackagePaths(session.agent_id)
    │
    └─► 调用 SDK query()
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

Cherry Studio 实现了完整的 Claude Code 插件系统，支持从市场、ZIP 包和本地目录安装插件。

### 插件类型

| 类型 | 说明 | 存储位置 | 文件格式 |
|-----|------|---------|---------|
| `agent` | 自定义 Agent 行为 | `.claude/agents/` | 单文件 `.md` |
| `command` | 斜杠命令 | `.claude/commands/` | 单文件 `.md` |
| `skill` | 技能模块 | `.claude/skills/<文件夹>/` | 目录 + `SKILL.md` |
| `plugin package` | 插件包（可含多组件） | `.claude/plugins/<包名>/` | `.claude-plugin/plugin.json` |

### 磁盘布局

```
<workdir>/
└── .claude/
    ├── agents/           # Agent 单文件插件
    │   └── my-agent.md
    ├── commands/         # 斜杠命令单文件
    │   └── my-command.md
    ├── skills/           # 技能目录
    │   └── my-skill/
    │       └── SKILL.md
    ├── plugins/          # 插件包（含多组件）
    │   └── my-plugin/
    │       ├── .claude-plugin/
    │       │   └── plugin.json    # 插件清单
    │       ├── agents/
    │       ├── commands/
    │       └── skills/
    └── plugins.json      # 已安装列表缓存
```

### 核心服务架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PluginService (单例)                            │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                           安装来源处理                                  │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌───────────────────────┐  │  │
│  │  │ marketplace:    │  │ ZIP 上传        │  │ 本地目录              │  │  │
│  │  │ plugin/skill:.. │  │ installFromZip  │  │ installFromDirectory │  │  │
│  │  └─────────────────┘  └─────────────────┘  └───────────────────────┘  │  │
│  │           │                    │                    │                  │  │
│  │           └────────────────────┼────────────────────┘                  │  │
│  │                                ▼                                       │  │
│  │                    ┌───────────────────┐                               │  │
│  │                    │ findPluginRoots   │ ← 找 plugin.json 或 SKILL.md  │  │
│  │                    └───────────────────┘                               │  │
│  │                                │                                       │  │
│  │                                ▼                                       │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │              installPluginRoots / installSkillRoots             │  │  │
│  │  │              扫描 agents/commands/skills 并注册                  │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                     │                                       │
│                                     ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    PluginCacheStore (缓存管理)                        │  │
│  │  - listInstalled(): 读 plugins.json，缺失则 rebuild                  │  │
│  │  - upsert(): 新增/更新已安装项                                        │  │
│  │  - remove(): 移除已安装项                                             │  │
│  │  - rebuild(): 全量扫描文件系统重建缓存                                │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                     │                                       │
│                                     ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    PluginInstaller (磁盘操作)                         │  │
│  │  - installFilePlugin(): 单文件安装（备份-复制-恢复模式）              │  │
│  │  - installSkill(): 技能目录安装                                       │  │
│  │  - uninstallFilePlugin(): 删除单文件                                  │  │
│  │  - uninstallSkill(): 删除技能目录                                     │  │
│  │  - updateFilePluginContent(): 更新文件内容                            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 安装流程

#### 1. 市场安装

```
用户选择 marketplace:plugin:owner/repo/name 或 marketplace:skill:owner/repo/name
    │
    ▼
PluginService.install()
    │
    ├─► parseMarketplaceSource() → 解析标识符
    │
    ├─► Plugin: 调用 /api/resolve/{owner}/{repo}/{name} 获取 Git URL
    │   Skill: 调用 /api/v2/skills/resolve 获取 sourceUrl + relDir
    │
    ├─► createMarketplaceTempDir() → 创建临时目录
    │
    ├─► cloneRepository() → git clone --depth 1
    │       │
    │       ├─► resolveDefaultBranch() → 获取默认分支名
    │       └─► 执行 git clone 命令
    │
    ├─► findPluginRoots() / resolveSkillDirectory()
    │
    ├─► installSinglePlugin() / installSkillFromDirectory()
    │       │
    │       ├─► 复制到 .claude/plugins/<包名>/ 或 .claude/skills/<名>/
    │       ├─► 扫描 agents/commands/skills 子目录
    │       ├─► 解析 Markdown frontmatter 元数据
    │       └─► registerPluginInCache() → 更新 plugins.json
    │
    └─► safeRemoveDirectory() → 清理临时目录
```

#### 2. ZIP/目录安装

```
用户上传 ZIP 或选择本地目录
    │
    ▼
PluginService.installFromZip() / installFromDirectory()
    │
    ├─► 校验 ZIP 格式 / 目录存在性
    │
    ├─► extractZip() → 解压到临时目录（防 zip bomb）
    │       │
    │       ├─► 检查总大小 < 100MB
    │       ├─► 检查文件数 < 1000
    │       └─► 解压
    │
    ├─► installFromSourceDir()
    │       │
    │       ├─► findPluginRoots() → 找含 .claude-plugin/plugin.json 的目录
    │       │       │
    │       │       ├─► 检查 marketplace.json 聚合市场
    │       │       ├─► 递归扫描子目录（最大深度 10）
    │       │       └─► 返回所有插件根目录
    │       │
    │       ├─► 若找到 plugin roots → installPluginRoots()
    │       │
    │       └─► 否则 → findAllSkillDirectories() → installSkillRoots()
    │
    └─► 返回 { packages, totalInstalled, totalFailed }
```

### 插件清单格式 (plugin.json)

```json
{
  "name": "my-plugin",           // 必填：kebab-case 包名
  "version": "1.0.0",
  "description": "插件描述",
  "author": { "name": "作者", "email": "email@example.com" },
  "keywords": ["ai", "automation"],

  // 组件路径（相对路径）
  "commands": "./commands",      // 或 ["./cmd1", "./cmd2"]
  "agents": "./agents",
  "skills": "./skills",

  // 配置路径
  "hooks": "./hooks.json",       // 或内联对象
  "mcpServers": "./mcp.json",
  "lspServers": "./lsp.json"
}
```

### 市场聚合清单 (marketplace.json)

```json
{
  "name": "My Marketplace",
  "owner": { "name": "组织名" },
  "plugins": [
    {
      "name": "plugin-a",
      "source": "./plugins/plugin-a",  // 相对路径
      "strict": true                   // 必须有 plugin.json
    },
    {
      "name": "plugin-b",
      "source": { "github": "owner/repo" }  // Git 源
    }
  ],
  "metadata": {
    "pluginRoot": "./plugins"  // 所有插件的基准路径
  }
}
```

### SDK 插件集成

`ClaudeCodeService.invoke()` 调用时，收集已安装插件包路径传递给 SDK：

```typescript
// ClaudeCodeService.invoke() 内部
const pluginPaths = await pluginService.listInstalledPluginPackagePaths(session.agent_id)
if (pluginPaths.length > 0) {
  plugins = pluginPaths.map((pluginPath) => ({ type: 'local', path: pluginPath }))
}
options.plugins = plugins
```

**路径获取逻辑：**

```typescript
async listInstalledPluginPackagePaths(agentId: string): Promise<string[]> {
  // 1. 从缓存获取已安装列表
  const installedPlugins = await this.listInstalledFromCache(workdir)

  // 2. 收集所有 packageName
  const packageNames = new Set<string>()
  for (const plugin of installedPlugins) {
    if (plugin.metadata.packageName) {
      packageNames.add(plugin.metadata.packageName)
    }
  }

  // 3. 验证每个包的 plugin.json 存在
  for (const packageName of packageNames) {
    const pluginPath = path.join(workdir, '.claude', 'plugins', packageName)
    const manifestPath = path.join(pluginPath, '.claude-plugin', 'plugin.json')
    if (await fileExists(manifestPath)) {
      pluginPaths.push(pluginPath)
    }
  }

  return pluginPaths
}
```

### 安全措施

| 威胁 | 防护措施 |
|-----|---------|
| **路径穿越** | `isPathInside()` 校验自定义路径必须在插件目录内 |
| **ZIP 炸弹** | 总大小 < 100MB，文件数 < 1000 |
| **符号链接环** | `findPluginRoots()` 最大递归深度 10，`dereference: true` 解引用 |
| **文件名攻击** | `sanitizeFilename()` / `sanitizeFolderName()` 移除非法字符，截断过长名称 |
| **Windows EPERM** | `PluginInstaller` 使用备份-复制-恢复模式，减少直接覆盖 |
| **重复安装** | `upsert()` 按 filename+type 去重更新 |

### 缓存重建流程

当 `plugins.json` 缺失或损坏时，`PluginCacheStore.rebuild()` 全量扫描：

```typescript
async rebuild(workdir: string): Promise<InstalledPlugin[]> {
  // 并行收集四类来源
  await Promise.all([
    collectFilePlugins(workdir, 'agent'),   // 扫描 .claude/agents/*.md
    collectFilePlugins(workdir, 'command'), // 扫描 .claude/commands/*.md
    collectSkillPlugins(workdir),           // 扫描 .claude/skills/*/SKILL.md
    collectPackagePlugins(workdir),         // 扫描 .claude/plugins/*/ 并读 manifest
  ])

  // 写回缓存文件
  await writeCacheFile(claudePath, { version: 1, lastUpdated: Date.now(), plugins })
}
```

### IPC 通道

| 通道 | 方向 | 用途 |
|-----|------|-----|
| `claudeCodePlugin:list-available` | Renderer → Main | 查询可安装插件（预留） |
| `claudeCodePlugin:install` | Renderer → Main | 安装插件 |
| `claudeCodePlugin:uninstall` | Renderer → Main | 卸载插件 |
| `claudeCodePlugin:list-installed` | Renderer → Main | 列出已安装插件 |
| `claudeCodePlugin:invalidate-cache` | Renderer → Main | 刷新缓存 |

### 市场 Registry API

| Endpoint | 用途 |
|----------|-----|
| `GET /api/resolve/{owner}/{repo}/{plugin}` | 解析插件 Git URL |
| `POST /api/v2/skills/resolve` | 解析技能源 URL（body: `{ target, limit, offset }`） |
| `POST /api/skills/{owner}/{repo}/{name}/install` | 回报技能安装次数 |

**API 基地址：** `https://api.claude-plugins.dev`

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