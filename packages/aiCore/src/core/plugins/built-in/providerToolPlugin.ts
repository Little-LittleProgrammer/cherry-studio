/**
 * 通用 provider 工具注入插件
 *
 * 查找 extensionRegistry 中声明的 toolFactory，
 * 将返回的 ToolFactoryPatch（tools / providerOptions）合并到 params。
 */

import { mergeProviderOptions } from '../../options'
import { extensionRegistry } from '../../providers'
import type { ToolCapability } from '../../providers/types/toolFactory'
import { definePlugin } from '../'
/**
 * providerToolPlugin 插件
 *
 * 这是一个用于通用 provider “工具注入”的插件工厂函数。其作用是自动将特定 provider 下扩展注册表（extensionRegistry）声明的 tool factory 所返回的 patch 信息（包含工具列表与 provider 选项）合并进当前的调用参数 params 中。
 *
 * 主要参数如下：
 * - capability: ToolCapability        —— 指定能力名称（如 'function-calling' 等）。
 * - config: Record<string, any>       —— 针对不同 provider 的自定义配置，结构为 { [providerId]: userConfig }。
 *
 * 插件的工作流程如下：
 * 1. 定义插件名称与执行顺序（enforce: 'pre'，表示在早期阶段处理）。
 * 2. 在 transformParams 钩子中，会获取当前请求的 providerId，以及 model 对象内可能存在的实际 provider 信息，按需传递给扩展注册表。
 * 3. 调用 extensionRegistry.resolveToolCapability 查找该 provider/capability/model 下是否注册了相关工具工厂（toolFactory）。
 *    - 若未找到任何内容，则直接返回原始 params。
 * 4. 找到工厂后，组合 providerId 对应的 userConfig，并执行工厂函数，得到带有 patch 信息（tools 与 providerOptions）。
 * 5. 如果 patch.tools 存在，则将其合并进 params.tools；如果 patch.providerOptions 存在，则用 mergeProviderOptions 方法将其合并进 params.providerOptions。
 * 6. 返回合并后的参数 params。
 *
 * 总结：本插件用于自动注入 provider 所需的工具定义和特定扩展参数，极大提升了第三方扩展工具的灵活性与自动集成能力。
 */
export const providerToolPlugin = (capability: ToolCapability, config: Record<string, any> = {}) =>
  definePlugin({
    // 插件名称为能力名
    name: capability,
    // 优先级配置为 'pre'，即优先处理
    enforce: 'pre',

    /**
     * transformParams 钩子实现
     * 作用: 根据 providerId、capability 和模型的实际 provider，从扩展注册表中解析工具定义与 provider 选项，将其合入原有参数
     */
    transformParams: async (params: any, context) => {
      // 从 context 中获取当前 providerId
      const { providerId } = context

      // 若 context.model 是对象且包含 'provider' 字段，则取其 provider 字段
      // 否则，modelProvider 设为 undefined
      const modelProvider =
        context.model && typeof context.model !== 'string' && 'provider' in context.model
          ? context.model.provider
          : undefined

      // 从 extensionRegistry 查找该 provider （连带指定模型提供者与能力）的工具工厂
      const resolved = await extensionRegistry.resolveToolCapability(providerId, capability, modelProvider)
      // 若没有查到扩展内容，则直接返回 params
      if (!resolved) return params

      // 提取用户为当前 provider 配置的合并配置
      const userConfig = config[providerId] ?? {}
      // 执行扩展工厂，生成 patch（包含 tools 和 providerOptions），provider 参数取自 resolved.provider
      const patch = resolved.factory(resolved.provider)(userConfig)

      // 合并 patch 返回的工具定义到原参数中
      if (patch.tools) {
        params.tools = { ...params.tools, ...patch.tools }
      }
      // 合并 patch 返回的 providerOptions 到原参数（通过工具函数合并以确保深合并）
      if (patch.providerOptions) {
        params.providerOptions = mergeProviderOptions(params.providerOptions, patch.providerOptions)
      }

      // 返回最终构造后的参数
      return params
    }
  })
