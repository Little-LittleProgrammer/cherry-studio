/**
 * Claude → AiSDK 转换器共用的轻量状态机。
 *
 * Anthropic 中间内容块往往没有稳定 id，因此用「块索引 + 自生成 id」拼接；
 * 同时维护：文本/推理增量缓冲、`tool_result` 与先前 `tool_use` 的反向关联、
 * `message_delta` 到 `message_stop` 之间暂存的用量与结束原因。
 * 每个 Claude 轮次应使用独立实例，发出 finish 后须调用 `resetStep`，避免泄漏到下一轮。
 */
import { loggerService } from '@logger'
import type { FinishReason, LanguageModelUsage, ProviderMetadata } from 'ai'

/**
 * 用会话 ID 前缀拼接 SDK 原始 tool id，避免多会话下 raw id 撞车。
 *
 * @param sessionId - The agent session ID
 * @param rawToolCallId - The raw tool call ID from SDK (e.g., "WebFetch_0")
 */
export function buildNamespacedToolCallId(sessionId: string, rawToolCallId: string): string {
  return `${sessionId}:${rawToolCallId}`
}

/** Claude 可流式输出的块：文本 / 推理 / 工具 的公共字段 */
type BaseBlockState = {
  id: string
  index: number
}

type TextBlockState = BaseBlockState & {
  kind: 'text'
  text: string
}

type ReasoningBlockState = BaseBlockState & {
  kind: 'reasoning'
  text: string
  redacted: boolean
}

type ToolBlockState = BaseBlockState & {
  kind: 'tool'
  toolCallId: string
  rawToolCallId: string
  toolName: string
  providerMetadata?: ProviderMetadata
  resolvedInput?: unknown
}

export type BlockState = TextBlockState | ReasoningBlockState | ToolBlockState

type PendingUsageState = {
  usage?: LanguageModelUsage
  finishReason?: FinishReason
}

type PendingToolCall = {
  rawToolCallId: string
  toolCallId: string
  toolName: string
  input: unknown
  providerMetadata?: ProviderMetadata
}

type ClaudeStreamStateOptions = {
  agentSessionId: string
}

/**
 * 跟踪单次 assistant 消息内各 content block 的生命周期：
 * 拼接 delta、挂起/消费工具调用、在 message_stop 时带上 pending 用量。
 */
export class ClaudeStreamState {
  private logger
  private readonly agentSessionId: string
  private blocksByIndex = new Map<number, BlockState>()
  private toolIndexByNamespacedId = new Map<string, number>()
  private pendingUsage: PendingUsageState = {}
  private pendingToolCalls = new Map<string, PendingToolCall>()
  private stepActive = false
  /**
   * Tracks whether the next user message should be suppressed because it contains
   * skill content injected after a Skill tool result.
   */
  private expectingSkillContent = false

  constructor(options: ClaudeStreamStateOptions) {
    this.logger = loggerService.withContext('ClaudeStreamState')
    this.agentSessionId = options.agentSessionId
    this.logger.silly('ClaudeStreamState', options)
  }

  /** Marks the beginning of a new AiSDK step. */
  beginStep(): void {
    this.stepActive = true
  }

  hasActiveStep(): boolean {
    return this.stepActive
  }

  /** Creates a text block placeholder so future deltas can accumulate into it. */
  openTextBlock(index: number, id: string): TextBlockState {
    const block: TextBlockState = {
      kind: 'text',
      id,
      index,
      text: ''
    }
    this.blocksByIndex.set(index, block)
    return block
  }

  /** Starts tracking an Anthropic "thinking" block, optionally flagged as redacted. */
  openReasoningBlock(index: number, id: string, redacted: boolean): ReasoningBlockState {
    const block: ReasoningBlockState = {
      kind: 'reasoning',
      id,
      index,
      redacted,
      text: ''
    }
    this.blocksByIndex.set(index, block)
    return block
  }

  /** Caches tool metadata so subsequent input deltas and results can find it. */
  openToolBlock(
    index: number,
    params: { rawToolCallId: string; toolName: string; providerMetadata?: ProviderMetadata }
  ): ToolBlockState {
    const toolCallId = buildNamespacedToolCallId(this.agentSessionId, params.rawToolCallId)
    const block: ToolBlockState = {
      kind: 'tool',
      id: toolCallId,
      index,
      toolCallId,
      rawToolCallId: params.rawToolCallId,
      toolName: params.toolName,
      providerMetadata: params.providerMetadata
    }
    this.blocksByIndex.set(index, block)
    this.toolIndexByNamespacedId.set(toolCallId, index)
    return block
  }

  getBlock(index: number): BlockState | undefined {
    return this.blocksByIndex.get(index)
  }

  getFirstOpenTextBlock(): TextBlockState | undefined {
    const candidates: TextBlockState[] = []
    for (const block of this.blocksByIndex.values()) {
      if (block.kind === 'text') {
        candidates.push(block)
      }
    }
    if (candidates.length === 0) {
      return undefined
    }
    candidates.sort((a, b) => a.index - b.index)
    return candidates[0]
  }

  getToolBlockById(toolCallId: string): ToolBlockState | undefined {
    const index = this.toolIndexByNamespacedId.get(toolCallId)
    if (index === undefined) return undefined
    const block = this.blocksByIndex.get(index)
    if (!block || block.kind !== 'tool') return undefined
    return block
  }

  getToolBlockByRawId(rawToolCallId: string): ToolBlockState | undefined {
    return this.getToolBlockById(buildNamespacedToolCallId(this.agentSessionId, rawToolCallId))
  }

  /** Appends streamed text to a text block, returning the updated state when present. */
  appendTextDelta(index: number, text: string): TextBlockState | undefined {
    const block = this.blocksByIndex.get(index)
    if (!block || block.kind !== 'text') return undefined
    block.text += text
    return block
  }

  /** Appends streamed "thinking" content to the tracked reasoning block. */
  appendReasoningDelta(index: number, text: string): ReasoningBlockState | undefined {
    const block = this.blocksByIndex.get(index)
    if (!block || block.kind !== 'reasoning') return undefined
    block.text += text
    return block
  }

  /** Records a tool call to be consumed once its result arrives from the user. */
  registerToolCall(
    rawToolCallId: string,
    payload: { toolName: string; input: unknown; providerMetadata?: ProviderMetadata }
  ): void {
    const toolCallId = buildNamespacedToolCallId(this.agentSessionId, rawToolCallId)
    this.pendingToolCalls.set(rawToolCallId, {
      rawToolCallId,
      toolCallId,
      toolName: payload.toolName,
      input: payload.input,
      providerMetadata: payload.providerMetadata
    })
  }

  /** Retrieves and clears the buffered tool call metadata for the given id. */
  consumePendingToolCall(rawToolCallId: string): PendingToolCall | undefined {
    const entry = this.pendingToolCalls.get(rawToolCallId)
    if (entry) {
      this.pendingToolCalls.delete(rawToolCallId)
    }
    return entry
  }

  /**
   * Persists the final input payload for a tool block once the provider signals
   * completion so that downstream tool results can reference the original call.
   */
  completeToolBlock(toolCallId: string, toolName: string, input: unknown, providerMetadata?: ProviderMetadata): void {
    const block = this.getToolBlockByRawId(toolCallId)
    this.registerToolCall(toolCallId, {
      toolName,
      input,
      providerMetadata
    })
    if (block) {
      block.resolvedInput = input
    }
  }

  /** Removes a block from the active index map when Claude signals it is done. */
  closeBlock(index: number): BlockState | undefined {
    const block = this.blocksByIndex.get(index)
    if (!block) return undefined
    this.blocksByIndex.delete(index)
    if (block.kind === 'tool') {
      this.toolIndexByNamespacedId.delete(block.toolCallId)
    }
    return block
  }

  /** Stores interim usage metrics so they can be emitted with the `finish-step`. */
  setPendingUsage(usage?: LanguageModelUsage, finishReason?: FinishReason): void {
    if (usage) {
      this.pendingUsage.usage = usage
    }
    if (finishReason) {
      this.pendingUsage.finishReason = finishReason
    }
  }

  getPendingUsage(): PendingUsageState {
    return { ...this.pendingUsage }
  }

  /** Clears any accumulated usage values for the next streamed message. */
  resetPendingUsage(): void {
    this.pendingUsage = {}
  }

  /** Drops cached block metadata for the currently active message. */
  resetBlocks(): void {
    this.blocksByIndex.clear()
    this.toolIndexByNamespacedId.clear()
  }

  /** Resets the entire step lifecycle after emitting a terminal frame. */
  resetStep(): void {
    this.resetBlocks()
    this.resetPendingUsage()
    this.stepActive = false
    this.expectingSkillContent = false
  }

  getNamespacedToolCallId(rawToolCallId: string): string {
    return buildNamespacedToolCallId(this.agentSessionId, rawToolCallId)
  }

  /**
   * Marks that the next user message should be suppressed because it will contain
   * skill content injected after a Skill tool invocation.
   */
  setExpectingSkillContent(expecting: boolean): void {
    this.expectingSkillContent = expecting
  }

  /**
   * Checks and clears the skill content expectation flag.
   * Returns true if skill content was expected (and should be suppressed).
   */
  consumeExpectingSkillContent(): boolean {
    const wasExpecting = this.expectingSkillContent
    this.expectingSkillContent = false
    return wasExpecting
  }
}

export type { PendingToolCall }
