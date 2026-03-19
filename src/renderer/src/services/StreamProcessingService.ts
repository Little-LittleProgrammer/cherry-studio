import { loggerService } from '@logger'
import type {
  ExternalToolResult,
  GenerateImageResponse,
  MCPToolResponse,
  NormalToolResponse,
  WebSearchResponse
} from '@renderer/types'
import type { Chunk, ProviderMetadata } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'
import type { Response } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'

const logger = loggerService.withContext('StreamProcessingService')

/**
 * 流处理器回调函数接口
 *
 * ## 职责
 * 定义当流处理器遇到不同 Chunk 类型时应调用的回调函数。
 * 这些回调函数负责将 Chunk 数据转换为具体的业务操作（如创建/更新 Block）。
 *
 * ## 回调分类
 * | 类别 | 回调函数 | 说明 |
 * |------|----------|------|
 * | 生命周期 | onLLMResponseCreated, onComplete | 响应开始/结束 |
 * | 文本处理 | onTextStart, onTextChunk, onTextComplete | 文本块处理 |
 * | 思考过程 | onThinkingStart, onThinkingChunk, onThinkingComplete | 推理/思考块 |
 * | 工具调用 | onToolCallPending/InProgress/Complete | MCP 工具调用 |
 * | 外部工具 | onExternalToolInProgress/Complete | 知识库/网络搜索 |
 * | 图片生成 | onImageCreated, onImageDelta, onImageGenerated | DALL-E 等 |
 * | 错误处理 | onError | 异常情况 |
 */
export interface StreamProcessorCallbacks {
  // ==================== 生命周期回调 ====================

  /** LLM 响应创建时调用，用于初始化响应状态 */
  onLLMResponseCreated?: () => void

  // ==================== 文本处理回调 ====================

  /** 文本块开始时调用，用于创建 MAIN_TEXT Block */
  onTextStart?: () => void
  // Text content chunk received
  onTextChunk?: (text: string, providerMetadata?: ProviderMetadata) => void
  // Full text content received
  onTextComplete?: (text: string, providerMetadata?: ProviderMetadata) => void
  // thinking content start
  onThinkingStart?: () => void

  /** 思考内容增量到达时调用 */
  onThinkingChunk?: (text: string, thinking_millsec?: number) => void

  /** 思考块完成时调用 */
  onThinkingComplete?: (text: string, thinking_millsec?: number) => void

  // ==================== 工具调用回调 ====================

  /** MCP 工具调用等待中（已发送请求，等待响应） */
  onToolCallPending?: (toolResponse: MCPToolResponse | NormalToolResponse) => void

  /** MCP 工具调用进行中（正在执行） */
  onToolCallInProgress?: (toolResponse: MCPToolResponse | NormalToolResponse) => void

  /** MCP 工具调用完成（已收到结果） */
  onToolCallComplete?: (toolResponse: MCPToolResponse | NormalToolResponse) => void

  /** 工具参数流式传输中（部分参数到达） */
  onToolArgumentStreaming?: (toolResponse: MCPToolResponse | NormalToolResponse) => void

  // ==================== 外部工具回调 ====================

  /** 外部工具（知识库、网络搜索）进行中 */
  onExternalToolInProgress?: () => void

  /** 外部工具完成，返回引用数据 */
  onExternalToolComplete?: (externalToolResult: ExternalToolResult) => void | Promise<void>

  // ==================== LLM 原生搜索回调 ====================

  /** LLM 原生网络搜索进行中（如 Gemini grounding、OpenAI web search） */
  onLLMWebSearchInProgress?: () => void

  /** LLM 原生网络搜索完成 */
  onLLMWebSearchComplete?: (llmWebSearchResult: WebSearchResponse) => void

  // ==================== 引用块管理 ====================

  /** 获取当前引用块 ID */
  getCitationBlockId?: () => string | null

  /** 设置引用块 ID */
  setCitationBlockId?: (blockId: string) => void

  // ==================== 图片生成回调 ====================

  /** 图片开始生成 */
  onImageCreated?: () => void

  /** 图片生成增量数据（部分图片数据） */
  onImageDelta?: (imageData: GenerateImageResponse) => void

  /** 图片生成完成 */
  onImageGenerated?: (imageData?: GenerateImageResponse) => void

  /** LLM 响应完成（包含 usage 等元数据） */
  onLLMResponseComplete?: (response?: Response) => void

  // ==================== 错误与完成 ====================

  /** 处理过程中发生错误 */
  onError?: (error: any) => void

  /** 整个流处理完成（成功或失败） */
  onComplete?: (status: AssistantMessageStatus, response?: Response) => void

  // ==================== 其他 ====================

  /** 视频搜索结果 */
  onVideoSearched?: (video?: { type: 'url' | 'path'; content: string }, metadata?: Record<string, any>) => void

  /** Block 创建时调用 */
  onBlockCreated?: () => void

  /** 原始数据到达（如 Agent SDK 的 session_id 更新） */
  onRawData?: (content: unknown, metadata?: Record<string, any>) => void
}

/**
 * 创建流处理器实例
 *
 * ## 职责
 * 流处理器是 Chunk 到 Block 转换的**第二层**，负责：
 * 1. 接收 AiSdkToChunkAdapter 转换后的 Chunk 对象
 * 2. 根据 Chunk 类型路由到对应的回调函数
 * 3. 回调函数内部通过 BlockManager 创建/更新 Block
 *
 * ## 数据流
 * ```
 * AI SDK Stream → AiSdkToChunkAdapter → StreamProcessor → Callbacks → BlockManager
 *   (原始事件)      (Chunk 类型转换)      (回调分发)        (业务逻辑)    (Block 操作)
 * ```
 *
 * @param callbacks - 当遇到不同 Chunk 类型时调用的回调函数
 * @returns 返回一个函数，用于处理单个 Chunk
 *
 * @example
 * ```typescript
 * const callbacks = createCallbacks({ blockManager, ... })
 * const streamProcessor = createStreamProcessor(callbacks)
 *
 * // 在 AiSdkToChunkAdapter 中调用
 * streamProcessor({ type: ChunkType.TEXT_DELTA, text: 'Hello' })
 * ```
 */
export function createStreamProcessor(callbacks: StreamProcessorCallbacks = {}) {
  return (chunk: Chunk) => {
    try {
      const data = chunk

      switch (data.type) {
        // ==================== 生命周期事件 ====================
        case ChunkType.BLOCK_COMPLETE: {
          // 整个 Block 处理完成，触发最终回调
          if (callbacks.onComplete) callbacks.onComplete(AssistantMessageStatus.SUCCESS, data?.response)
          break
        }
        case ChunkType.LLM_RESPONSE_CREATED: {
          // LLM 响应开始创建，用于初始化 UI 状态
          if (callbacks.onLLMResponseCreated) callbacks.onLLMResponseCreated()
          break
        }

        // ==================== 文本块事件 ====================
        case ChunkType.TEXT_START: {
          // 文本块开始 → 创建 MAIN_TEXT Block
          if (callbacks.onTextStart) callbacks.onTextStart()
          break
        }
        case ChunkType.TEXT_DELTA: {
          if (callbacks.onTextChunk) callbacks.onTextChunk(data.text, data.providerMetadata)
          break
        }
        case ChunkType.TEXT_COMPLETE: {
          if (callbacks.onTextComplete) callbacks.onTextComplete(data.text, data.providerMetadata)
          break
        }

        // ==================== 思考/推理块事件 ====================
        case ChunkType.THINKING_START: {
          // 思考块开始 → 创建 THINKING Block
          if (callbacks.onThinkingStart) callbacks.onThinkingStart()
          break
        }
        case ChunkType.THINKING_DELTA: {
          // 思考内容增量 → 更新 Block 内容
          if (callbacks.onThinkingChunk) callbacks.onThinkingChunk(data.text, data.thinking_millsec)
          break
        }
        case ChunkType.THINKING_COMPLETE: {
          // 思考完成 → 标记 Block 为 SUCCESS
          if (callbacks.onThinkingComplete) callbacks.onThinkingComplete(data.text, data.thinking_millsec)
          break
        }

        // ==================== MCP 工具调用事件 ====================
        case ChunkType.MCP_TOOL_PENDING: {
          // 工具调用等待中 → 显示等待状态
          if (callbacks.onToolCallPending) data.responses.forEach((toolResp) => callbacks.onToolCallPending!(toolResp))
          break
        }
        case ChunkType.MCP_TOOL_IN_PROGRESS: {
          // 工具调用执行中 → 显示执行状态
          if (callbacks.onToolCallInProgress)
            data.responses.forEach((toolResp) => callbacks.onToolCallInProgress!(toolResp))
          break
        }
        case ChunkType.MCP_TOOL_COMPLETE: {
          // 工具调用完成 → 显示结果
          if (callbacks.onToolCallComplete && data.responses.length > 0) {
            data.responses.forEach((toolResp) => callbacks.onToolCallComplete!(toolResp))
          }
          break
        }
        case ChunkType.MCP_TOOL_STREAMING: {
          // 工具参数流式传输 → 实时显示参数
          if (callbacks.onToolArgumentStreaming) {
            data.responses.forEach((toolResp) => callbacks.onToolArgumentStreaming!(toolResp))
          }
          break
        }

        // ==================== 外部工具事件 ====================
        case ChunkType.EXTERNEL_TOOL_IN_PROGRESS: {
          // 外部工具（知识库/网络搜索）执行中
          if (callbacks.onExternalToolInProgress) callbacks.onExternalToolInProgress()
          break
        }
        case ChunkType.EXTERNEL_TOOL_COMPLETE: {
          // 外部工具完成 → 创建 CITATION Block
          if (callbacks.onExternalToolComplete) callbacks.onExternalToolComplete(data.external_tool)
          break
        }

        // ==================== LLM 原生搜索事件 ====================
        case ChunkType.LLM_WEB_SEARCH_IN_PROGRESS: {
          // LLM 原生搜索进行中（如 Gemini grounding）
          if (callbacks.onLLMWebSearchInProgress) callbacks.onLLMWebSearchInProgress()
          break
        }
        case ChunkType.LLM_WEB_SEARCH_COMPLETE: {
          // LLM 原生搜索完成
          if (callbacks.onLLMWebSearchComplete) callbacks.onLLMWebSearchComplete(data.llm_web_search)
          break
        }

        // ==================== 图片生成事件 ====================
        case ChunkType.IMAGE_CREATED: {
          // 图片开始生成
          if (callbacks.onImageCreated) callbacks.onImageCreated()
          break
        }
        case ChunkType.IMAGE_DELTA: {
          // 图片增量数据（部分生成）
          if (callbacks.onImageDelta) callbacks.onImageDelta(data.image)
          break
        }
        case ChunkType.IMAGE_COMPLETE: {
          // 图片生成完成
          if (callbacks.onImageGenerated) callbacks.onImageGenerated(data.image)
          break
        }

        // ==================== 响应完成事件 ====================
        case ChunkType.LLM_RESPONSE_COMPLETE: {
          // LLM 响应完成，包含 usage 等元数据
          if (callbacks.onLLMResponseComplete) callbacks.onLLMResponseComplete(data.response)
          break
        }

        // ==================== 错误处理 ====================
        case ChunkType.ERROR: {
          // 处理过程中发生错误
          if (callbacks.onError) callbacks.onError(data.error)
          break
        }

        // ==================== 其他事件 ====================
        case ChunkType.VIDEO_SEARCHED: {
          // 视频搜索结果
          if (callbacks.onVideoSearched) callbacks.onVideoSearched(data.video, data.metadata)
          break
        }
        case ChunkType.BLOCK_CREATED: {
          // Block 创建通知
          if (callbacks.onBlockCreated) callbacks.onBlockCreated()
          break
        }
        case ChunkType.RAW: {
          // 原始数据（如 Agent SDK session_id 更新）
          if (callbacks.onRawData) callbacks.onRawData(data.content, data.metadata)
          break
        }

        default: {
          // 未知 Chunk 类型，记录警告
          logger.warn(`Unknown chunk type: ${data.type}`)
        }
      }
    } catch (error) {
      // 统一错误处理，确保流不会因单个 Chunk 处理失败而中断
      logger.error('Error processing stream chunk:', error as Error)
      callbacks.onError?.(error)
    }
  }
}
