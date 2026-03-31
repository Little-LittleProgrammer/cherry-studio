/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
/**
 * Drizzle Kit configuration for agents database
 *
 * 【中文】仅用于 **CLI**（`pnpm agents:generate` 等）：指定 schema 入口与迁移 SQL 输出目录 `resources/database/drizzle`。
 * 运行时真正使用的库路径由 `getDbPath()`（Electron `userData`）决定，与这里的 `dbCredentials.url` 在开发机上可能一致，但部署路径以应用为准。
 */

import path from 'node:path'

import { defineConfig } from 'drizzle-kit'
import { app } from 'electron'

function getDbPath() {
  return path.join(app.getPath('userData'), 'Data', 'agents.db')
}

export function getOldDbPath() {
  // production
  return path.join(app.getPath('userData'), 'agents.db')
}

const resolvedDbPath = getDbPath()

export const dbPath = resolvedDbPath

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/services/agents/database/schema/index.ts',
  out: './resources/database/drizzle',
  dbCredentials: {
    url: `file:${resolvedDbPath}`
  },
  verbose: true,
  strict: true
})
