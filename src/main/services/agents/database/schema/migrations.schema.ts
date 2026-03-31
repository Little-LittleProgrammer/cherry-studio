/**
 * Migration tracking schema
 *
 * 【中文】`migrations` 表：记录已执行的迁移（含 Drizzle 结构迁移与 `data_*` 数据迁移），防止重复执行。
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const migrations = sqliteTable('migrations', {
  version: integer('version').primaryKey(),
  tag: text('tag').notNull(),
  executedAt: integer('executed_at').notNull()
})

export type Migration = typeof migrations.$inferSelect
export type NewMigration = typeof migrations.$inferInsert
