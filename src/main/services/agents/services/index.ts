/**
 * Agent Services Module
 *
 * This module provides service classes for managing agents, sessions, and session messages.
 * All services extend BaseService and provide database operations with proper error handling.
 *
 * 【中文】业务服务聚合导出：
 * - **AgentService**：Agent 的创建、读取、更新、删除与排序；读取时会合并 MCP 工具列表与插件缓存。
 * - **SessionService**：某 Agent 下的会话 CRUD、模型字段校验、斜杠命令列表（内置 + 本地插件）。
 * - **SessionMessageService**：发送消息、拉起流式对话、落库用户/助手消息（内部委托 `claudecode` 等）。
 * 默认导出单例 `agentService` / `sessionService` / `sessionMessageService` 供主进程其它模块直接引用。
 */

// Service classes
export { AgentService } from './AgentService'
export { SessionMessageService } from './SessionMessageService'
export { SessionService } from './SessionService'
export { TaskService } from './TaskService'

// Service instances (singletons)
export { agentService } from './AgentService'
export { schedulerService } from './SchedulerService'
export { sessionMessageService } from './SessionMessageService'
export { sessionService } from './SessionService'
export { taskService } from './TaskService'

// Type definitions for service requests and responses
export type { AgentEntity, AgentSessionEntity, CreateAgentRequest, UpdateAgentRequest } from '@types'
export type {
  AgentSessionMessageEntity,
  CreateSessionRequest,
  GetAgentSessionResponse,
  ListOptions as SessionListOptions,
  UpdateSessionRequest
} from '@types'
