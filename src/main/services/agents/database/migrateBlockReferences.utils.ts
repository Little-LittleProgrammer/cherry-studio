/**
 * Pure utility functions for block reference migration.
 * Separated from the main migration module to avoid Electron dependencies in tests.
 *
 * 【中文】块引用迁移的纯函数：计算 `message.blocks` 相对 `blocks[]` 缺失的 id 并合并，便于单测且不依赖 Electron。
 */

export interface MigrationResult {
  totalMessages: number
  messagesFixed: number
  blockReferencesAdded: number
  errors: Array<{ sessionId: string; messageId: string; error: string }>
}

/**
 * Find block IDs that exist in blocks array but not in message.blocks
 */
export function findMissingBlockIds(messageBlocks: string[], blocks: Array<{ id?: string }>): string[] {
  const messageBlockSet = new Set(messageBlocks)
  const missingIds: string[] = []

  for (const block of blocks) {
    if (block.id && !messageBlockSet.has(block.id)) {
      missingIds.push(block.id)
    }
  }

  return missingIds
}

/**
 * Merge missing block IDs into message.blocks
 */
export function mergeBlockReferences(messageBlocks: string[], missingIds: string[]): string[] {
  return [...messageBlocks, ...missingIds]
}
