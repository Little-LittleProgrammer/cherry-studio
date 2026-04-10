# 08-Agent与Claude Code链路

Cherry Studio 的 Agent 链路与普通助手链路并行存在，重点实现位于 `src/main/services/agents/`。

## 主体结构

- `AgentService.ts`：Agent 实体管理（模型、指令、MCP 绑定、可访问路径）
- `SessionService.ts`：会话实体管理（会话级模型覆盖、排序、slash commands）
- `SessionMessageService.ts`：会话消息持久化
- `claudecode/index.ts`：Claude Agent SDK 适配执行层

## 数据与状态

Agent 子系统使用主进程 SQLite（Drizzle ORM）而非渲染层 Dexie：

- `agents`：Agent 定义
- `sessions`：会话定义
- `messages`：会话消息

这样可在多窗口和主进程服务间共享稳定状态。

## Claude Code 执行流程

入口：`src/main/services/agents/services/claudecode/index.ts`

执行步骤：

1. 校验会话路径与模型合法性。
2. 构建 Claude Code 子进程环境变量（API key、base URL、模型）。
3. 将会话中的 MCP 配置映射为 Claude SDK 可用 MCP 服务器配置。
4. 调用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 获取流式消息。
5. 转换 SDK 原始消息为统一事件并回传渲染层。

关键点：

- `setImmediate` 启动处理，避免上层尚未订阅就丢首批流事件。
- 工具权限通过 `canUseTool` + `preToolUseHook` 双机制兜底。
- Claude Code 不只和 Anthropic 官方 API 绑定，也存在一组 Anthropic-compatible provider 接入约束。

## 渲染侧集成

渲染侧通过 `messageThunk` 的 Agent 分支启动 Agent 流：

- 维护 `agentSessionId`，实现对话续接
- 收到流式事件后仍走统一 Chunk/Block 渲染模型

这保证 Agent 消息和普通助手消息在 UI 层可共存。

补充：

- Agent 流中的原始 SDK 事件会先以 `RAW` chunk 形式进入统一适配层。
- 当 Claude Code 返回 `init` / `compact` 事件且带有 `session_id` 时，渲染侧会同步更新当前 session 标识。
- 因此 Agent 链路虽然独立于普通聊天执行器，但在 UI 渲染层仍复用同一套消息块模型。

## 约束说明

`agents/` 子系统正处于 v2 重构窗口，文档和改动应优先聚焦“关键修复与行为一致性”，避免扩散数据模型变更。
