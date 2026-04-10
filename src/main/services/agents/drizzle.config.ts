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
import { defineConfig } from 'drizzle-kit'

function getDefaultDbUrl(): string {
  const platform = process.platform
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const appName = process.env.NODE_ENV === 'development' ? 'CherryStudioDev' : 'CherryStudio'

  switch (platform) {
    case 'darwin':
      return `${home}/Library/Application Support/${appName}/Data/agents.db`
    case 'win32':
      return `${process.env.APPDATA ?? `${home}/AppData/Roaming`}/${appName}/Data/agents.db`
    default:
      // Linux: ~/.config/<appName>
      return `${process.env.XDG_CONFIG_HOME ?? `${home}/.config`}/${appName}/Data/agents.db`
  }
}

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/services/agents/database/schema/index.ts',
  out: './resources/database/drizzle',
  dbCredentials: {
    url: process.env.AGENTS_DB_URL ?? getDefaultDbUrl()
  },
  verbose: true,
  strict: true
})
