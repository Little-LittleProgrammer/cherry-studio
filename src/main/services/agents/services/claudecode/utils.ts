/**
 * Claude Code / Anthropic 与 Vercel AI SDK 之间的映射工具：结束原因、用量字段对齐。
 * finish reason 逻辑移植自 ai-sdk-provider-claude-code。
 * @see https://github.com/ben-vargas/ai-sdk-provider-claude-code/blob/main/src/map-claude-code-finish-reason.ts#L22
 */
import type { JSONObject } from '@ai-sdk/provider'
import type { BetaStopReason } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { FinishReason, LanguageModelUsage } from 'ai'

/**
 * 将 Claude Code SDK `result` 子类型映射为 AI SDK 的 `FinishReason`。
 *
 * @param subtype - The result subtype from Claude Code SDK
 * @returns The corresponding AI SDK finish reason with unified and raw values
 *
 * @example
 * ```typescript
 * const finishReason = mapClaudeCodeFinishReason('error_max_turns');
 * // Returns: 'length'
 * ```
 **/
export function mapClaudeCodeFinishReason(subtype?: string): FinishReason {
  switch (subtype) {
    case 'success':
      return 'stop'
    case 'error_max_turns':
      return 'length'
    case 'error_during_execution':
      return 'error'
    case undefined:
      return 'stop'
    default:
      // 未知子类型归为 other，与正常 stop 区分
      return 'other'
  }
}

/** Anthropic `stop_reason` → AI SDK `FinishReason`，供多提供商统一处理 */
const finishReasonMapping: Record<BetaStopReason, FinishReason> = {
  end_turn: 'stop',
  max_tokens: 'length',
  stop_sequence: 'stop',
  tool_use: 'tool-calls',
  pause_turn: 'other',
  refusal: 'content-filter'
}

/**
 * 将流式消息中的 Anthropic `stop_reason` 转为 AI SDK `FinishReason`。
 *
 * @param claudeStopReason - Anthropic Beta API 的 stop_reason，可为 null
 */
export function mapClaudeCodeStopReason(claudeStopReason: BetaStopReason | null): FinishReason {
  if (claudeStopReason === null) {
    return 'stop'
  }
  return finishReasonMapping[claudeStopReason] || 'other'
}

type ClaudeCodeUsage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

/**
 * 将 Claude Code SDK 扁平用量字段转为 AI SDK 稳定版 `LanguageModelUsage`（含 cache 细分）。
 *
 * @param usage - Raw usage data from Claude Code SDK
 * @returns Formatted usage object for AI SDK v6
 */
export function convertClaudeCodeUsage(usage: ClaudeCodeUsage): LanguageModelUsage {
  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined
    },
    raw: usage as JSONObject
  }
}
