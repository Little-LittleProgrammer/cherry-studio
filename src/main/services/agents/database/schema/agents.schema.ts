/**
 * Drizzle ORM schema for agents table
 *
 * 【中文】`agents` 表：一条记录对应侧边栏里的一个 **Agent 配置**（类型、名称、主/备模型、指令、工作区路径、MCP 与工具白名单等）。
 * 多数字段以 JSON 字符串存储，读写时由 `BaseService` 序列化；`sort_order` 控制列表展示顺序。
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const agentsTable = sqliteTable('agents', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  accessible_paths: text('accessible_paths'), // JSON array of directory paths the agent can access

  instructions: text('instructions'),

  model: text('model').notNull(), // Main model ID (required)
  plan_model: text('plan_model'), // Optional plan/thinking model ID
  small_model: text('small_model'), // Optional small/fast model ID

  mcps: text('mcps'), // JSON array of MCP tool IDs
  allowed_tools: text('allowed_tools'), // JSON array of allowed tool IDs (whitelist)

  configuration: text('configuration'), // JSON, extensible settings

  sort_order: integer('sort_order').notNull().default(0), // Manual sort order (lower = first)

  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull()
})

// Indexes for agents table
export const agentsNameIdx = index('idx_agents_name').on(agentsTable.name)
export const agentsTypeIdx = index('idx_agents_type').on(agentsTable.type)
export const agentsCreatedAtIdx = index('idx_agents_created_at').on(agentsTable.created_at)
export const agentsSortOrderIdx = index('idx_agents_sort_order').on(agentsTable.sort_order)

export type AgentRow = typeof agentsTable.$inferSelect
export type InsertAgentRow = typeof agentsTable.$inferInsert
