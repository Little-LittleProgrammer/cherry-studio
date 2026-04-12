/**
 * Runtime 模块导出
 * 专注于运行时插件化AI调用处理
 */

// 主要的运行时执行器
export { RuntimeExecutor } from './executor'

// 导出类型
export type { EmbedManyParams, EmbedManyResult, RuntimeConfig } from './types'

// === 便捷工厂函数 ===

import { type AiPlugin } from '../plugins'
import { extensionRegistry } from '../providers'
import { type CoreProviderSettingsMap, type StringKeys } from '../providers/types'
import { RuntimeExecutor } from './executor'

/**
 * 创建运行时执行器 - 支持类型安全的已知provider
 * 自动确保 provider 已初始化
 */
/**
 * 创建并返回一个 RuntimeExecutor 执行器实例。
 *
 * 执行器（Executor）是运行时的核心组件，负责将已初始化的 AI Provider（如 OpenAI、Azure 等）
 * 及其中间件插件、模型解析逻辑等组装在一起，并通过标准接口对外暴露 AI 调用能力。
 * 执行器屏蔽了底层 Provider 细节，使得上层可以以统一方式进行文本生成、图像生成等任务。
 *
 * @param providerId 指定的 Provider 扩展 ID
 * @param options    对应 Provider 需要的配置参数
 * @param plugins    可选插件列表，会注入到执行器中参与调用流程
 * @returns          创建好的类型安全的 RuntimeExecutor 实例
 */
export async function createExecutor<
  TSettingsMap extends Record<string, any> = CoreProviderSettingsMap,
  T extends StringKeys<TSettingsMap> = StringKeys<TSettingsMap>
>(providerId: T, options: TSettingsMap[T], plugins?: AiPlugin[]): Promise<RuntimeExecutor<TSettingsMap, T>> {
  // 检查 provider 是否已被注册
  if (!extensionRegistry.has(providerId)) {
    throw new Error(`Provider extension "${providerId}" not registered`)
  }

  // 创建 provider 实例（如果尚未初始化则会初始化）
  const provider = await extensionRegistry.createProvider(providerId, options || {})

  // 从扩展注册表提取此 Provider 的模型解析器（用于选择和解析具体实现的 AI 模型）
  const resolver = extensionRegistry.getModelResolver(providerId as string)
  const modelResolver = resolver ? (modelId: string) => resolver(provider, modelId) : undefined

  // 最终组装并返回 RuntimeExecutor 实例
  return RuntimeExecutor.create<TSettingsMap, T>(providerId, provider, options, plugins, modelResolver)
}

/**
 * 直接流式文本生成
 */
export async function streamText<
  TSettingsMap extends Record<string, any> = CoreProviderSettingsMap,
  T extends StringKeys<TSettingsMap> = StringKeys<TSettingsMap>
>(
  providerId: T,
  options: TSettingsMap[T],
  params: Parameters<RuntimeExecutor<TSettingsMap, T>['streamText']>[0],
  plugins?: AiPlugin[]
): Promise<ReturnType<RuntimeExecutor<TSettingsMap, T>['streamText']>> {
  const executor = await createExecutor<TSettingsMap, T>(providerId, options, plugins)
  return executor.streamText(params)
}

/**
 * 直接生成文本
 */
export async function generateText<
  TSettingsMap extends Record<string, any> = CoreProviderSettingsMap,
  T extends StringKeys<TSettingsMap> = StringKeys<TSettingsMap>
>(
  providerId: T,
  options: TSettingsMap[T],
  params: Parameters<RuntimeExecutor<TSettingsMap, T>['generateText']>[0],
  plugins?: AiPlugin[]
): Promise<ReturnType<RuntimeExecutor<TSettingsMap, T>['generateText']>> {
  const executor = await createExecutor<TSettingsMap, T>(providerId, options, plugins)
  return executor.generateText(params)
}

/**
 * 直接生成图像 - 支持middlewares
 */
export async function generateImage<
  TSettingsMap extends Record<string, any> = CoreProviderSettingsMap,
  T extends StringKeys<TSettingsMap> = StringKeys<TSettingsMap>
>(
  providerId: T,
  options: TSettingsMap[T],
  params: Parameters<RuntimeExecutor<TSettingsMap, T>['generateImage']>[0],
  plugins?: AiPlugin[]
): Promise<ReturnType<RuntimeExecutor<TSettingsMap, T>['generateImage']>> {
  const executor = await createExecutor<TSettingsMap, T>(providerId, options, plugins)
  return executor.generateImage(params)
}

/**
 * 直接批量嵌入文本
 * AI SDK v6 只有 embedMany，没有 embed
 */
export async function embedMany<
  TSettingsMap extends Record<string, any> = CoreProviderSettingsMap,
  T extends StringKeys<TSettingsMap> = StringKeys<TSettingsMap>
>(
  providerId: T,
  options: TSettingsMap[T],
  params: Parameters<RuntimeExecutor<TSettingsMap, T>['embedMany']>[0],
  plugins?: AiPlugin[]
): Promise<ReturnType<RuntimeExecutor<TSettingsMap, T>['embedMany']>> {
  const executor = await createExecutor<TSettingsMap, T>(providerId, options, plugins)
  return executor.embedMany(params)
}

/**
 * 创建 OpenAI Compatible 执行器
 */
export async function createOpenAICompatibleExecutor(
  options: CoreProviderSettingsMap['openai-compatible'],
  plugins?: AiPlugin[]
): Promise<RuntimeExecutor<CoreProviderSettingsMap, 'openai-compatible'>> {
  const provider = await extensionRegistry.createProvider('openai-compatible', options)

  return RuntimeExecutor.createOpenAICompatible(provider, options, plugins)
}

// === Agent 功能预留 ===
// 未来将在 ../agents/ 文件夹中添加：
// - AgentExecutor.ts
// - WorkflowManager.ts
// - ConversationManager.ts
// 并在此处导出相关API
