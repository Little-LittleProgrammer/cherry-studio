/**
 * 【中文】与具体厂商无关的「流式 Agent」契约，供 `SessionMessageService` 等调用方依赖抽象而非某一实现。
 *
 * - **AgentStream**：基于 Node `EventEmitter`，事件名为 `data`，载荷为 {@link AgentStreamEvent}。
 * - **chunk**：内容为 Vercel AI SDK 的 `TextStreamPart`，前端渲染与工具块解析都围绕这一形状。
 * - **AgentServiceInterface.invoke**：给定用户 prompt、会话实体、`AbortController`，返回上述流；Claude Code 实现在 `services/claudecode/index.ts`。
 */
// Agent-agnostic streaming interface
// This interface should be implemented by all agent services

import type { EventEmitter } from 'node:events'

import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { GetAgentSessionResponse } from '@types'
import type { TextStreamPart } from 'ai'

// Generic agent stream event that works with any agent type
export interface AgentStreamEvent {
  type: 'chunk' | 'error' | 'complete' | 'cancelled'
  chunk?: TextStreamPart<any> // Standard AI SDK chunk for UI consumption
  error?: Error
}

// Agent stream interface that all agents should implement
export interface AgentStream extends EventEmitter {
  emit(event: 'data', data: AgentStreamEvent): boolean
  on(event: 'data', listener: (data: AgentStreamEvent) => void): this
  once(event: 'data', listener: (data: AgentStreamEvent) => void): this
  /** SDK session_id captured from the init message, used for resume. */
  sdkSessionId?: string
}

export interface AgentThinkingOptions {
  effort?: Options['effort']
  thinking?: Options['thinking']
}

// Base agent service interface
export interface AgentServiceInterface {
  invoke(
    prompt: string,
    session: GetAgentSessionResponse,
    abortController: AbortController,
    lastAgentSessionId?: string,
    thinkingOptions?: AgentThinkingOptions,
    images?: Array<{ data: string; media_type: string }>
  ): Promise<AgentStream>
}
