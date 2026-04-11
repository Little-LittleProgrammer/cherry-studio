# 08-Agent与Claude Code链路

Cherry Studio 的 Agent 子系统是一套独立于普通助手聊天的完整执行体系，位于 `src/main/services/agents/`。它使用主进程 SQLite（Drizzle ORM）进行数据持久化，支持自主 Agent、Claude Code 集成、多渠道接入（飞书/Slack/Telegram/微信/QQ/Discord）和定时任务调度。

## 架构总览

Agent 子系统可以分成四个逻辑层次：

```
┌─────────────────────────────────────────────────────────┐
│                   渲染侧 UI 集成层                        │
│  messageThunk Agent 分支 → Chunk/Block 统一渲染模型       │
├─────────────────────────────────────────────────────────┤
│                   服务编排层                              │
│  AgentService │ SessionService │ SessionMessageService   │
│  SchedulerService │ TaskService │ ChannelService         │
├─────────────────────────────────────────────────────────┤
│                   渠道适配层                              │
│  ChannelManager → Feishu/Slack/Telegram/WeChat/QQ/       │
│  Discord Adapter │ SessionStreamBus │ SessionStreamIpc   │
├─────────────────────────────────────────────────────────┤
│                   执行层                                  │
│  ClaudeCodeService → @anthropic-ai/claude-agent-sdk       │
│  CherryClaw → Soul Mode Prompt + Heartbeat               │
│  Claude Stream State → 增量流式处理                       │
└─────────────────────────────────────────────────────────┘
```

## 数据与状态

Agent 子系统使用主进程 SQLite（Drizzle ORM + LibSQL），而非渲染层 Dexie（IndexedDB）：

| 表 | 职责 |
|----|------|
| `agents` | Agent 定义（类型、名称、绑定模型、MCP 配置、指令） |
| `sessions` | 会话定义（所属 Agent、模型覆盖、创建时间） |
| `messages` | 会话消息（角色、内容、工具调用记录、block 引用） |
| `migrations` | Drizzle 迁移记录 |
| `channels` | 渠道订阅（平台、会话绑定、消息路由） |
| `skills` | Agent 技能定义 |
| `tasks` | 定时任务（Cron 表达式、运行日志、心跳） |

数据库路径：`{userData}/Data/agents.db`（开发环境 `~/Library/Application Support/CherryStudioDev/Data/agents.db`，生产环境 `~/Library/Application Support/CherryStudio/Data/agents.db`）。

**为什么用 SQLite 而非 Dexie？**
- 主进程直接访问，不依赖渲染层
- 支持 Drizzle ORM 的关系查询和迁移管理
- 可被 MCPService、Claude Code 子进程等多方共享
- 适合跨窗口、跨会话的持久状态

## 服务层详解

### AgentService

Agent 实体的 CRUD 管理：

- 创建/更新/删除 Agent，校验模型合法性（`provider:model_id` 格式）
- 内置 Agent 初始化（`BuiltinAgentBootstrap`）
- CherryClaw 默认 Agent 初始化（`CherryClawProvisioner`）
- MCP 工具合并（将 session 级 MCP 配置与 Agent 级合并）
- 排序管理（`reorder`）
- **启动优化**：内置 Agent 的启动从 ~1.6s 优化到 ~270ms（通过异步批量初始化）

### SessionService

会话级管理：

- 会话 CRUD
- 模型校验（确保模型与 Agent 类型匹配）
- Slash commands 列表获取
- 会话排序

### SessionMessageService

会话消息持久化：

- 消息写入 SQLite
- 流式消息增量写入（`ReadableStream` 逐块写入）
- Block 引用迁移（消息块格式升级时的迁移）
- 自定义序列化/反序列化（JSON 字段处理）

### SchedulerService — 定时任务调度

60 秒轮询的定时任务调度器：

- 启动 `startLoop()` 后每 60 秒检查是否有到期的定时任务
- 从 `TaskService` 获取到期任务，为每个任务创建 `AbortController` 并执行
- 支持最大连续错误次数（`MAX_CONSECUTIVE_ERRORS = 3`），超限后暂停任务
- 应用关闭时 `stopLoop()` 中止所有运行中的任务
- `restoreSchedulers()` 在应用重启后自动恢复调度器
- 与 CherryClaw 的 `heartbeat.md` 配合，支持心跳定时任务

### TaskService

定时任务的 CRUD 和运行日志：

- 创建/更新/删除定时任务（Cron 表达式、Agent ID、会话 ID）
- 计算到期任务列表
- 记录运行日志（成功/失败/耗时）
- `hasActiveTasks()` 快速判断是否需要启动调度器

### ChannelService — 多渠道接入

渠道订阅管理：

- 渠道的 CRUD（飞书/Slack/Telegram/微信/QQ/Discord）
- 渠道与 Agent 会话的绑定关系
- 渠道状态管理（启用/禁用）
- **热修复**：切换单个渠道不再重连所有渠道

### ChannelManager — 渠道适配器管理

管理所有渠道适配器的生命周期：

- 统一初始化/启动/停止
- 消息路由到对应的 `ChannelAdapter`
- 日志缓冲（`ChannelLogBuffer`）
- 会话流路由（`SessionStreamBus`）
- IPC 桥接（`sessionStreamIpc` 将 Agent 流式事件推送到渲染侧）

### ChannelAdapter — 渠道适配器接口

抽象接口，各平台实现：

| 适配器 | 路径 |
|--------|------|
| `FeishuAdapter` | `adapters/feishu/FeishuAdapter.ts` |
| `SlackAdapter` | `adapters/slack/SlackAdapter.ts` |
| `TelegramAdapter` | `adapters/telegram/TelegramAdapter.ts` |
| `WeChatAdapter` | `adapters/wechat/WeChatAdapter.ts` |
| `QQAdapter` | `adapters/qq/QQAdapter.ts` |
| `DiscordAdapter` | `adapters/discord/DiscordAdapter.ts` |

每个适配器负责：
- 平台 API 连接与认证
- 消息接收与格式转换为内部格式
- Agent 响应发送回平台
- 平台特定能力（附件、按钮等）

### 安全与内容控制

| 模块 | 职责 |
|------|------|
| `ExternalContentGuard` | 外部内容过滤，防止恶意输入 |
| `OutputSanitizer` | 输出消毒，防止 XSS 等注入 |

### CherryClaw — 自主 Agent

CherryClaw 是一套自主 Agent 实现：

- `heartbeat.ts` — 心跳文件读取，检测 Agent 活跃状态
- `prompt.ts` — `PromptBuilder` 构建 Soul Mode 系统提示词
- `seedWorkspace.ts` — 工作空间模板初始化

## Claude Code 执行层

Claude Code 是 Agent 子系统的核心执行能力，位于 `src/main/services/agents/services/claudecode/`。

### 整体流程

```
UI 发起 Agent 请求
  │
  ▼
ClaudeCodeService.invoke()
  │
  ├─ 1. 校验会话路径与模型合法性
  ├─ 2. 构建子进程环境变量
  ├─ 3. 映射 MCP 配置为 HTTP MCP 服务器
  ├─ 4. 同步创建 ClaudeCodeStream（EventEmitter）
  ├─ 5. setImmediate → processSDKQuery()
  │     └─ for await (query({ prompt, options }))
  │        └─ 每条 SDKMessage → transform → emit('data', chunk)
  ▼
上层订阅 stream.on('data', handler)
  │
  ▼
transform.ts → 统一 Chunk 事件
  │
  ▼
渲染侧通过 messageThunk Agent 分支接收
```

### 详细步骤

#### 1. 子进程环境准备

**环境变量构建**：

- `ANTHROPIC_API_KEY` — API 密钥
- `ANTHROPIC_BASE_URL` — API 地址（自动去掉尾部版本号，如 `/v1/messages` → `/v1`）
- `CLAUDE_CONFIG_DIR` — 设为 `userData` 路径（避免 Windows 中文用户名路径问题）
- 代理配置 — 通过 `getProxyEnvironment()` 和 `getProxyProtocol()` 注入子进程，路由配置的代理
- `NODE_EXTRA_CA_CERTS` — 自定义 CA 证书

**路径处理**：

- `CLAUDE_CODE_PATH` — 通过 `getBinaryPath()` 解析 Claude Code 可执行文件路径
- Windows 上自动发现 Git Bash 路径
- ASAR 打包路径通过 `toAsarUnpackedPath()` 转换

**抑制警告**：子进程启动时注入环境变量抑制 `UNDICI-EHPA` 警告。

#### 2. 进程创建

使用 `fork()` 而非 `spawn()` 启动子进程，支持 `--require` 代理引导注入。SDK 升级后通过 `spawnClaudeCodeProcess` 选项替代了原有的 postinstall patch 方式。

#### 3. MCP 注入

会话中配置的 MCP 会被映射为指向**应用内嵌 API 服务**的 HTTP URL（带 Bearer token），Claude Code 子进程当作普通 HTTP MCP 连接。此外还注入以下内置 MCP：

- `@cherry/browser` — 浏览器自动化 MCP（内存模式）
- Exa MCP — 网页搜索
- `claw` MCP — CherryClaw Soul Mode 支持
- `assistant` MCP — Cherry Assistant 支持

#### 4. setImmediate 启动处理

`invoke()` 方法**同步**创建 `ClaudeCodeStream` 并返回，上层先注册 `'data'` 监听。然后用 `setImmediate` 异步启动 SDK `query()`。这避免了首批 chunk 在订阅前发出导致丢失的问题。

#### 5. 工具权限：双机制

| 机制 | 触发时机 | 职责 |
|------|---------|------|
| `canUseTool` | SDK 执行敏感工具前 | 返回 deny 时工具不会执行；自动放行列表中的工具有时不走此路径 |
| `PreToolUse` Hook | 工具执行前 | 对「自动放行/bypass」路径也会触发，带 `autoApprove: true` 调用 `promptForToolApproval`，让渲染进程仍能展示工具调用 |

两者配合确保 UI 始终能感知工具调用，即使 SDK 内部跳过了 `canUseTool`。

#### 6. 流式处理：增量 Delta

`claude-stream-state.ts` 维护流式处理状态机：

- 增量 delta 发送（`perf: send incremental delta instead of full inputBuffer`）
- 工具调用状态跟踪
- 多消息合并处理
- 错误恢复

#### 7. SDK 消息转换

`transform.ts` 将 `@anthropic-ai/claude-agent-sdk` 的原始消息转换为 Cherry Studio 统一的流事件格式：

- 文本 chunk → `TEXT_DELTA`
- 工具调用 → `TOOL_CALL`
- 思考内容 → `THINKING`
- 完成 → `COMPLETE`

#### 8. RTK 重写

`rtkRewriteHook` 通过 RTK（Run Terminal Commands）重写 Bash 命令，实现终端命令的集中管理和审计。

#### 9. 图像处理

图片通过 `sharp` 自动缩放到 Claude API 限制（最大 2000px，最大 5MB）。

### Claude Code 的特殊能力

- **不局限于 Anthropic 官方 API**：通过 `ANTHROPIC_BASE_URL` 环境变量可接入任何 Anthropic-compatible provider
- **Soul Mode**：读取 `.claude/` 工作空间文件（`heartbeat.md` 等）构建系统提示词，实现个性化 Agent
- **Cherry Assistant**：构建轻量环境快照上下文（~200 tokens），用于只读指导模式
- **安全提示**：内置 `CHANNEL_SECURITY_PROMPT`、`GLOBALLY_DISALLOWED_TOOLS`、`SOUL_MODE_DISALLOWED_TOOLS`

## 渲染侧集成

### messageThunk Agent 分支

渲染侧通过 `messageThunk` 的 Agent 分支启动 Agent 流：

1. 创建 Agent 会话（或续接已有 `agentSessionId`）
2. 调用 IPC 接口触发 Agent 执行
3. 订阅流式事件
4. 收到 chunk 后走统一 `Chunk/Block` 渲染模型

### 统一渲染模型

Agent 消息和普通助手消息在 UI 层使用同一套渲染管线：

- Agent 流中的原始 SDK 事件先以 `RAW` chunk 进入统一适配层
- `AiSdkToChunkAdapter` 将 `RAW` chunk 转换为标准 `ChunkType`
- `StreamProcessingService` 分发到 UI 回调
- UI 根据 chunk 类型渲染对应的 Block 组件

### Session ID 同步

当 Claude Code 返回 `init` / `compact` 事件且带有 `session_id` 时，渲染侧会同步更新当前 session 标识，确保续接时上下文一致。

## Agent 类型

| 类型 | 说明 |
|------|------|
| `builtin` | 内置 Agent，应用启动时自动初始化 |
| `custom` | 用户自定义 Agent |
| `claude_code` | Claude Code Agent，使用 Claude Agent SDK |
| `cherry_claw` | CherryClaw 自主 Agent，Soul Mode + Heartbeat |

## 数据库管理

### 迁移

- 使用 Drizzle ORM 的 `migrate()` 函数
- 迁移文件位于 `resources/database/drizzle/`
- `MigrationService` 自动检测并应用未执行的迁移
- 启动时自动初始化（带重试逻辑）

### 开发命令

```bash
pnpm agents:generate    # 生成 Drizzle 迁移文件
pnpm agents:push        # 快速推送到 SQLite
pnpm agents:studio      # 打开 Drizzle Studio
pnpm agents:health      # 健康检查
```

## 约束说明

`agents/` 子系统正处于 v2 重构窗口，文档和改动应优先聚焦"关键修复与行为一致性"，避免扩散数据模型变更。涉及以下文件的修改需特别注意：

- `AgentService.ts` — 仅接受 Agent 创建/更新逻辑修复
- `SessionService.ts` — 仅接受会话管理逻辑修复
- `claudecode/index.ts` — 仅接受 Claude Code 执行行为一致性修复
- `SchedulerService.ts` — 仅接受定时任务调度逻辑修复

新增功能应在独立的 feature branch 上开发，经 v2 团队评审后合并。
