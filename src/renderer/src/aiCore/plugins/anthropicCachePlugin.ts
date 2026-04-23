/**
 * Anthropic Prompt Caching Middleware
 * @see https://ai-sdk.dev/providers/ai-sdk-providers/anthropic#cache-control
 */
import type { LanguageModelV3Message } from '@ai-sdk/provider'
import { definePlugin } from '@cherrystudio/ai-core/core/plugins'
import { estimateTextTokens } from '@renderer/services/TokenService'
import type { Provider } from '@renderer/types'
import type { LanguageModelMiddleware } from 'ai'

// 这是用于 Anthropic 缓存控制的 providerOptions 选项，配置请求的缓存控制行为。
// 它在 ai-sdk 联调时用于通过 providerOptions 触发分块缓存，通常不需用户手动配置。
const cacheProviderOptions = {
  anthropic: { cacheControl: { type: 'ephemeral' } }
}

function estimateContentTokens(content: LanguageModelV3Message['content']): number {
  if (typeof content === 'string') return estimateTextTokens(content)
  if (Array.isArray(content)) {
    return content.reduce((acc, part) => {
      if (part.type === 'text') {
        return acc + estimateTextTokens(part.text)
      }
      return acc
    }, 0)
  }
  return 0
}

/**
 * 举例说明：
 * 
 * 假设你有如下的 prompt 消息列表：
 * [
 *   { role: 'system', content: "你是一个 AI 助手。" },
 *   { role: 'user', content: "你好，请总结今天的新闻。" },
 *   { role: 'assistant', content: "今天的新闻有 A、B、C..." },
 *   { role: 'user', content: "帮我详细展开第一个新闻。" }
 * ]
 * 
 * provider.anthropicCacheControl 配置如下：
 * {
 *   tokenThreshold: 20,
 *   cacheSystemMessage: true,
 *   cacheLastNMessages: 2
 * }
 * 
 *  1. 首先判断 system 消息（第1条）Token 数是否 >= 20，如果是，则该条消息整体加上 providerOptions，触发缓存。
 * 2. 然后统计每条消息累积 Token 数（假设累计到第四条时已 >= 20）。
 * 3. 从最后一条消息往前数 2 条（满足配置 cacheLastNMessages: 2），比如第4和第3条，如果其累计 token 总数>=20且不是 system，并且内容不为空，则在最后一个内容片段上加 providerOptions。
 * 
 * 这样，最终会有三处被打上 providerOptions 标记，实现智能分块缓存，加速对话和复用部分上下文。
 * 
 * 1. 首先获取 provider 配置的 anthropicCacheControl 设置。
 * 2. 如果没有配置 tokenThreshold 或 prompt 数据格式不对，则直接返回原始参数，不做处理。
 * 3. 创建 prompt 消息的副本，方便后续操作。
 * 4. 如果设置了 cacheSystemMessage 为 true，则遍历消息，找到第一个 `role` 为 `'system'` 且 token 数超出阈值的消息，为其整体赋予 providerOptions，从而使其内容独立缓存，随后退出该循环。
 * 5. 如果配置了 cacheLastNMessages 且值大于 0，则按消息 token 量做累加统计。
 *    - 首先，从头到尾累积每条消息的 Token 数，形成前缀和数组 cumsumTokens。
 *    - 然后反向寻找最后 N 条非 system 且 Token 总量超过阈值且内容不为空的消息：
 *      - 将最后一条 content 的 Part（通常是最后一句话）赋予 providerOptions 触发缓存。
 *      - 直到计数达到 N 条后终止。
 * 6. 最后，将缓存指示（providerOptions）插入的新消息，整体作为新的 prompt 返回给下游 ai-sdk。
 * 

 */
function anthropicCacheMiddleware(provider: Provider): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      // 读取缓存相关配置
      const settings = provider.anthropicCacheControl

      // 必选配置校验，不满足则原样返回
      if (!settings?.tokenThreshold || !Array.isArray(params.prompt) || params.prompt.length === 0) {
        return params
      }

      const { tokenThreshold, cacheSystemMessage, cacheLastNMessages } = settings
      // 拷贝消息，避免直接修改入参
      const messages = [...params.prompt]
      let cachedCount = 0

      // ===== 1. 缓存 system 消息（配置项 cacheSystemMessage）=====
      if (cacheSystemMessage) {
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i]
          // 找到第一个 system 消息且 Token 超过阈值
          if (msg.role === 'system' && estimateContentTokens(msg.content) >= tokenThreshold) {
            // 给该消息整体添加 providerOptions
            messages[i] = { ...msg, providerOptions: cacheProviderOptions }
            break // 只处理第一个符合条件的
          }
        }
      }

      // ===== 2. 缓存最近 N 条非 system 消息内容片段（cacheLastNMessages）=====
      if (cacheLastNMessages > 0) {
        // 构造每条消息累计 Token 数的前缀和
        const cumsumTokens: number[] = []
        let tokenSum = 0
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i]
          tokenSum += estimateContentTokens(msg.content)
          cumsumTokens.push(tokenSum)
        }

        // 从后往前，查找符合条件的非 system 消息，将 providerOptions 注入 content 的最后一部分
        for (let i = messages.length - 1; i >= 0 && cachedCount < cacheLastNMessages; i--) {
          const msg = messages[i]
          // 跳过 system, token 累计值不达阈值，内容缺失的情况
          if (msg.role === 'system' || cumsumTokens[i] < tokenThreshold || !msg.content || msg.content.length === 0) {
            continue
          }

          // 拷贝内容片段数组
          const newContent = [...msg.content]
          const lastIndex = newContent.length - 1

          // 给最后一部分内容加 providerOptions，触发 SDK 局部缓存
          newContent[lastIndex] = {
            ...newContent[lastIndex],
            providerOptions: cacheProviderOptions
          }

          // 构造新的消息
          messages[i] = {
            ...msg,
            content: newContent
          } as LanguageModelV3Message

          cachedCount++
        }
      }

      // 返回修改后的参数
      return { ...params, prompt: messages }
    }
  }
}

export const createAnthropicCachePlugin = (provider: Provider) =>
  definePlugin({
    name: 'anthropicCache',
    enforce: 'pre',
    configureContext: (context) => {
      context.middlewares = context.middlewares || []
      context.middlewares.push(anthropicCacheMiddleware(provider))
    }
  })
