/**
 * Database Module
 *
 * This module provides centralized access to Drizzle ORM schemas
 * for type-safe database operations.
 *
 * Schema evolution is handled by Drizzle Kit migrations.
 *
 * 【中文】Agent 子系统专用 SQLite 数据访问层：
 * - **DatabaseManager**：创建 LibSQL 连接、执行 **结构迁移**（`MigrationService` + `resources/database/drizzle` SQL）。
 * - **DataMigrationService**：在表结构就绪后跑 **数据迁移**（逻辑在 TS 里，版本号通常 ≥10000 以免与 Drizzle 版本冲突）。
 * - **schema/**：表定义（agents、sessions、session_messages、migrations 等）；`sessionMessageRepository` 封装消息持久化。
 * 路径配置见同目录上一级的 `drizzle.config.ts`（`pnpm agents:generate` 等脚本依赖它）。
 */

// Database Manager (Singleton)
export * from './DatabaseManager'

// Drizzle ORM schemas
export * from './schema'

// Repository helpers
export * from './sessionMessageRepository'

// Migration Service
export * from './MigrationService'
