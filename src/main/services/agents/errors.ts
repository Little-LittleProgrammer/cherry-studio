/**
 * 【中文】Agent 配置校验相关错误类型。
 * `AgentModelValidationError` 在模型 id 未通过 `validateModelId` 时抛出，携带字段名与详细原因，便于 API/IPC 层返回结构化错误。
 */
import type { ModelValidationError } from '@main/apiServer/utils'
import type { AgentType } from '@types'

export type AgentModelField = 'model' | 'plan_model' | 'small_model'

export interface AgentModelValidationContext {
  agentType: AgentType
  field: AgentModelField
  model?: string
}

export class AgentModelValidationError extends Error {
  readonly context: AgentModelValidationContext
  readonly detail: ModelValidationError

  constructor(context: AgentModelValidationContext, detail: ModelValidationError) {
    super(`Validation failed for ${context.agentType}.${context.field}: ${detail.message}`)
    this.name = 'AgentModelValidationError'
    this.context = context
    this.detail = detail
  }
}
