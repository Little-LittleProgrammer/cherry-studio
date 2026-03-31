/**
 * Claude Code 侧内置斜杠命令列表（展示用）；运行时还会与 SDK 返回的命令合并。
 */
import type { SlashCommand } from '@types'

export const builtinSlashCommands: SlashCommand[] = [
  { command: '/clear', description: 'Clear conversation history' },
  { command: '/compact', description: 'Compact conversation with optional focus instructions' },
  { command: '/context', description: 'Visualize current context usage as a colored grid' },
  {
    command: '/cost',
    description: 'Show token usage statistics (see cost tracking guide for subscription-specific details)'
  },
  { command: '/todos', description: 'List current todo items' }
]
