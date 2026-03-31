/**
 * Agents Service Module
 *
 * This module provides a complete autonomous agent management system with:
 * - Agent lifecycle management (CRUD operations)
 * - Session handling with conversation history
 * - Comprehensive logging and audit trails
 * - Database operations with Drizzle ORM and migration support
 * - RESTful API endpoints for external integration
 *
 * 【中文 · 给首次阅读者】
 * 本目录是 Cherry Studio「智能体（Agent）」子系统的**主进程实现**，与渲染进程通过 IPC / API 协作。
 *
 * **分层速览**
 * 1. **服务层**（`services/`）：`AgentService` 管 Agent 配置与列表；`SessionService` 管会话；
 *    `SessionMessageService` 把用户消息交给具体 Agent 运行时（如 Claude Code）并持久化消息。
 * 2. **运行时适配**（`services/claudecode/`）：主进程调用 Claude Agent SDK，子进程跑 CLI，流式结果经
 *    `transform.ts` 转成统一 chunk 再给前端。
 * 3. **插件**（`plugins/`）：工作区 `.claude/` 下的 agent/command/skill/插件包，由 `PluginService` 安装并与 Agent 配置联动。
 * 4. **数据**（`database/`）：SQLite（LibSQL）+ Drizzle；库文件一般在 `{userData}/Data/agents.db`。
 *
 * 从这里 `export` 的内容即对外「子系统门面」；细读可从 `services/index.ts` 与各 Service 文件顶部的注释入手。
 */

// === Core Services ===
// Main service classes and singleton instances
export * from './services'

// === Error Types ===
export { type AgentModelField, AgentModelValidationError } from './errors'

// === Base Infrastructure ===
// Shared database utilities and base service class
export { BaseService } from './BaseService'

// === Database Layer ===
// Drizzle ORM schemas, migrations, and database utilities
export * as Database from './database'
