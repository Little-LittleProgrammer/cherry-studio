import { definePlugin } from '@cherrystudio/ai-core'
import { extractReasoningMiddleware } from 'ai'

/**
 * 推理提取插件
 * 从 OpenAI/Azure 响应中提取推理/思考标签
 * 使用 AI SDK 的 built-in extractReasoningMiddleware
 */
export const createReasoningExtractionPlugin = (options: { tagName?: string } = {}) =>
  definePlugin({
    name: 'reasoningExtraction',
    enforce: 'pre',

    configureContext: (context) => {
      context.middlewares = context.middlewares || []
      context.middlewares.push(
        extractReasoningMiddleware({
          tagName: options.tagName || 'thinking'
        })
      )
    }
  })
