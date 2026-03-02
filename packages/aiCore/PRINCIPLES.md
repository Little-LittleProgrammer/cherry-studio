# @cherrystudio/ai-core 核心原理详解

> 本文档深入剖析 aiCore 包的内部机制，帮助开发者快速精通此包的设计哲学和实现细节。

## 目录

1. [设计哲学](#1-设计哲学)
2. [整体架构](#2-整体架构)
3. [核心模块详解](#3-核心模块详解)
4. [数据流分析](#4-数据流分析)
5. [插件系统深度解析](#5-插件系统深度解析)
6. [Provider 管理机制](#6-provider-管理机制)
7. [使用模式与最佳实践](#7-使用模式与最佳实践)
8. [扩展开发指南](#8-扩展开发指南)

---

## 1. 设计哲学

### 1.1 核心设计原则

| 原则 | 说明 | 实现方式 |
|------|------|----------|
| **最小包装** | 直接使用 AI SDK 接口，避免重复定义 | 复用 `ai` 包的类型和函数 |
| **函数式优先** | 避免过度抽象，提供简洁 API | 使用工厂函数替代复杂类层次 |
| **分层清晰** | 职责分离，降低耦合 | Models 层 + Runtime 层 + Plugins 层 |
| **类型安全** | 完整的 TypeScript 支持 | 基于 Zod Schema 的类型推导 |
| **插件化扩展** | 全生命周期钩子支持 | Rollup 风格的钩子分类设计 |

### 1.2 与 AI SDK 的关系

```
┌─────────────────────────────────────────────────────────────┐
│                      User Application                        │
│                   (Cherry Studio / Others)                   │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│                   @cherrystudio/ai-core                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │   Runtime   │  │   Plugins    │  │     Providers       │ │
│  │   Layer     │◄─┤   System     │◄─┤    Registry         │ │
│  └─────────────┘  └──────────────┘  └─────────────────────┘ │
│           │                  │                    │         │
│           └──────────────────┼────────────────────┘         │
│                              ▼                              │
│              ┌───────────────────────────────┐              │
│              │    Vercel AI SDK (ai package) │              │
│              └───────────────────────────────┘              │
└─────────────────────────────────────────────────────────────┘
```

**设计要点**：
- aiCore 是 AI SDK 的**增强包装层**，而非替代
- 保留 AI SDK 的所有能力，同时添加插件化扩展机制
- 通过 `experimental_transform` 实现流转换（AI SDK 原生支持）

---

## 2. 整体架构

### 2.1 架构分层

```
┌─────────────────────────────────────────────────────────────────┐
│                         API 层                                   │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ 便捷函数 API  │ │ 执行器 API   │ │      静态工厂 API        │ │
│  │streamText()  │ │executor.     │ │RuntimeExecutor.create()  │ │
│  │generateText()│ │streamText()  │ │createExecutor()          │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                       Runtime 层                                 │
│  ┌──────────────────┐  ┌──────────────────────────────────────┐ │
│  │  RuntimeExecutor │  │           PluginEngine               │ │
│  │  (执行器核心)     │◄─┤      (插件生命周期管理)               │ │
│  └──────────────────┘  └──────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                       Plugin 层                                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ PluginManager│ │  内置插件     │ │      自定义插件          │ │
│  │ (插件管理)   │ │webSearch,    │ │  (用户扩展)              │ │
│  │              │ │promptToolUse │ │                          │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                       Model 层                                   │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ModelResolver │ │ wrapLanguage │ │   Middleware Manager     │ │
│  │(模型解析器)  │ │    Model     │ │   (中间件包装)           │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                       Provider 层                                │
│  ┌──────────────────┐  ┌──────────────────────────────────────┐ │
│  │  ProviderRegistry│  │        RegistryManagement            │ │
│  │  (配置注册)      │◄─┤      (实例管理与命名空间)             │ │
│  └──────────────────┘  └──────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                    Vercel AI SDK                                 │
│         streamText / generateText / streamObject ...            │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 模块依赖关系

```
index.ts (入口)
    │
    ├──► core/runtime/index.ts ───► executor.ts ───► pluginEngine.ts
    │                                    │                 │
    │                                    ▼                 ▼
    │                              ┌──────────────────────────────┐
    │                              │      PluginManager           │
    │                              │  (transformParams,           │
    │                              │   transformResult,           │
    │                              │   onRequestStart/End...)     │
    │                              └──────────────────────────────┘
    │
    ├──► core/models/index.ts ───► ModelResolver.ts
    │                                    │
    │                                    ▼
    │                         RegistryManagement.languageModel()
    │
    ├──► core/providers/index.ts ───► registry.ts / RegistryManagement.ts
    │
    └──► core/plugins/index.ts ───► manager.ts / types.ts
```

---

## 3. 核心模块详解

### 3.1 RuntimeExecutor（运行时执行器）

`RuntimeExecutor` 是用户与 AI SDK 交互的主要接口，负责协调模型解析、插件执行和 API 调用。

**核心职责**：
1. **模型解析**：将字符串 modelId 解析为 AI SDK 的 LanguageModel 对象
2. **插件集成**：自动注入内部插件（模型解析、上下文配置）
3. **API 代理**：代理调用 AI SDK 的 `streamText`、`generateText` 等方法

**关键源码分析** (`src/core/runtime/executor.ts`)：

```typescript
export class RuntimeExecutor<T extends ProviderId = ProviderId> {
  public pluginEngine: PluginEngine<T>
  private config: RuntimeConfig<T>

  constructor(config: RuntimeConfig<T>) {
    this.config = config
    // 创建插件引擎，传入用户插件
    this.pluginEngine = new PluginEngine(config.providerId, config.plugins || [])
  }

  // 内部插件：模型解析
  private createResolveModelPlugin() {
    return definePlugin({
      name: '_internal_resolveModel',
      enforce: 'post',  // 后置执行，确保用户插件先处理
      resolveModel: async (modelId: string) => {
        return await this.resolveModel(modelId)
      }
    })
  }

  // 流式文本生成
  async streamText(params: streamTextParams): Promise<ReturnType<typeof _streamText>> {
    const { model } = params

    // 根据 model 类型决定插件配置
    if (typeof model === 'string') {
      // 字符串 modelId：需要注入模型解析插件
      this.pluginEngine.usePlugins([
        this.createResolveModelPlugin(),
        this.createConfigureContextPlugin()
      ])
    } else {
      // 已经是模型对象：只需上下文配置
      this.pluginEngine.usePlugins([this.createConfigureContextPlugin()])
    }

    // 委托给 PluginEngine 执行
    return this.pluginEngine.executeStreamWithPlugins(...)
  }
}
```

**设计要点**：
- **延迟绑定**：模型解析在请求执行时才进行，支持动态配置
- **内部插件化**：将模型解析、上下文配置也实现为插件，保持架构一致性
- **enforce: 'post'**：内部插件后置执行，确保用户插件的 `resolveModel` 优先

### 3.2 PluginEngine（插件引擎）

`PluginEngine` 是插件系统的核心执行器，负责管理插件生命周期和执行钩子。

**核心方法**：

| 方法 | 用途 | 执行模式 |
|------|------|----------|
| `executeWithPlugins` | 非流式调用（generateText/generateObject） | 串行 |
| `executeStreamWithPlugins` | 流式调用（streamText/streamObject） | 串行 + 流转换 |
| `executeImageWithPlugins` | 图像生成调用 | 串行 |

**执行流程** (`src/core/runtime/pluginEngine.ts`)：

```typescript
async executeWithPlugins<TParams, TResult>(
  methodName: string,
  params: TParams,
  executor: (model, transformedParams) => TResult
): Promise<TResult> {
  // 1. 创建上下文
  const context = createContext(this.providerId, model, params)

  // 2. 配置上下文（configureContext 钩子）
  await manager.executeConfigureContext(context)

  // 3. 触发请求开始事件（并行）
  await manager.executeParallel('onRequestStart', context)

  // 4. 解析模型（First 钩子）
  const resolvedModel = await manager.executeFirst<LanguageModel>('resolveModel', modelId, context)

  // 5. 应用中间件
  if (context.middlewares?.length > 0) {
    resolvedModel = wrapLanguageModel({ model: resolvedModel, middleware: context.middlewares })
  }

  // 6. 转换参数（Sequential 钩子链）
  const transformedParams = await manager.executeTransformParams(params, context)

  // 7. 执行实际 API 调用
  const result = await executor(resolvedModel, transformedParams)

  // 8. 转换结果（Sequential 钩子链）
  const transformedResult = await manager.executeTransformResult(result, context)

  // 9. 触发请求完成事件（并行）
  await manager.executeParallel('onRequestEnd', context, transformedResult)

  return transformedResult
}
```

**递归调用机制**：
- 支持插件内部递归调用（如 promptToolUse 插件的工具调用循环）
- 通过 `context.recursiveCall` 实现
- 内置递归深度限制（默认 maxDepth = 10）
- 使用 `try/finally` 确保递归状态正确恢复

### 3.3 ModelResolver（模型解析器）

`ModelResolver` 负责将 modelId 字符串解析为 AI SDK 的 LanguageModel 实例。

**支持的 ModelId 格式**：

| 格式 | 示例 | 说明 |
|------|------|------|
| 传统格式 | `'gpt-4'` | 配合 providerId 使用，内部转为 `${providerId}:gpt-4` |
| 命名空间格式 | `'anthropic:claude-3'` | 直接指定 provider 和 model |
| 嵌套命名空间 | `'aihubmix:anthropic:claude-3'` | 支持多层级命名空间 |

**解析流程** (`src/core/models/ModelResolver.ts`)：

```typescript
async resolveLanguageModel(
  modelId: string,
  fallbackProviderId: string,
  providerOptions?: any
): Promise<LanguageModelV3> {
  // 特殊处理：OpenAI/Azure 的 chat/responses 模式选择
  if ((fallbackProviderId === 'openai' || fallbackProviderId === 'azure')
      && providerOptions?.mode === 'chat') {
    finalProviderId = `${fallbackProviderId}-chat`
  }

  // 检查是否包含命名空间分隔符
  if (modelId.includes(DEFAULT_SEPARATOR)) {  // ':'
    return this.resolveNamespacedModel(modelId)
  } else {
    return this.resolveTraditionalModel(finalProviderId, modelId)
  }
}

private resolveNamespacedModel(modelId: string): LanguageModelV3 {
  // 直接使用 RegistryManagement 获取模型
  return globalRegistryManagement.languageModel(modelId as any)
}

private resolveTraditionalModel(providerId: string, modelId: string): LanguageModelV3 {
  const fullModelId = `${providerId}${DEFAULT_SEPARATOR}${modelId}`
  return globalRegistryManagement.languageModel(fullModelId as any)
}
```

### 3.4 RegistryManagement（注册表管理）

`RegistryManagement` 是 provider 实例的全局管理器，基于 AI SDK 的 `customProvider` 实现。

**核心功能**：
1. **Provider 注册**：`registerProvider(providerId, providerInstance, aliases?)`
2. **模型获取**：`languageModel(id)` / `embeddingModel(id)` / `imageModel(id)`
3. **命名空间管理**：支持 `providerId:modelId` 格式
4. **别名支持**：一个 provider 可以有多个别名

**内部结构**：

```typescript
class RegistryManagement {
  private providers = new Map<string, ProviderV3>()
  private aliases = new Map<string, string>()  // alias -> realId

  registerProvider(id: string, provider: ProviderV3, aliases?: string[]) {
    this.providers.set(id, provider)
    aliases?.forEach(alias => this.aliases.set(alias, id))
  }

  languageModel(id: string) {
    // 解析命名空间：'openai:gpt-4' -> provider='openai', modelId='gpt-4'
    const { providerId, modelId } = this.parseNamespacedId(id)
    const provider = this.providers.get(providerId)
    return provider.languageModel(modelId)
  }
}
```

---

## 4. 数据流分析

### 4.1 流式请求完整数据流

```
User Call
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ executor.streamText({ model: 'gpt-4', messages: [...] })    │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. PluginEngine.executeStreamWithPlugins()                  │
│    - 创建 AiRequestContext                                  │
│    - 创建 PluginManager                                     │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. executeConfigureContext(context)                         │
│    - 各插件配置 context (如设置 middlewares)                 │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. executeParallel('onRequestStart', context)               │
│    - 日志插件记录请求开始                                    │
│    - 统计插件初始化计数器                                    │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. executeFirst('resolveModel', modelId, context)           │
│    - 内部插件：ModelResolver.resolveLanguageModel()         │
│    - 'gpt-4' -> globalRegistryManagement.languageModel()    │
│    - 返回 LanguageModelV3 实例                              │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. 应用 context.middlewares                                 │
│    - wrapLanguageModel({ model, middleware: context.middlewares }) │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. executeTransformParams(params, context)                  │
│    - webSearchPlugin: 添加 search 工具配置                   │
│    - promptToolUsePlugin: 转换 tools 为 system prompt       │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. collectStreamTransforms()                                │
│    - promptToolUsePlugin.transformStream()                  │
│    - 返回 TransformStream 数组                              │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 8. ai.streamText({ model, ...transformedParams, experimental_transform }) │
│    - 调用 AI SDK 发起实际请求                                │
│    - 流转换器开始工作                                       │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 9. TransformStream (promptToolUsePlugin)                    │
│    - text-delta: 过滤 <tool_use> 标签，传递给 UI            │
│    - finish-step: 检测工具调用，执行工具                     │
│    - 递归调用 recursiveCall() 继续对话                      │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 10. executeParallel('onRequestEnd', context, result)        │
│     - 日志插件记录请求完成                                   │
│     - 统计插件更新指标                                       │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
              Return StreamResult
```

### 4.2 插件钩子执行顺序

```
请求生命周期：
─────────────────────────────────────────────────────────────►

  │         │          │          │          │          │
  ▼         ▼          ▼          ▼          ▼          ▼
configure  onRequest  resolve  transform  [AI SDK  transform  onRequest
Context    Start      Model    Params     Call]    Result     End
  │         │          │          │          │          │
  │         │          │          │          │          │
  └─────────┴──────────┴──────────┴──────────┴──────────┘
              【串行执行（按 enforce 排序）】

并行执行（不阻塞主流程）：
- onRequestStart: 所有插件同时执行
- onRequestEnd: 所有插件同时执行
- onError: 出错时所有插件同时执行
```

---

## 5. 插件系统深度解析

### 5.1 钩子分类设计

借鉴 Rollup 的插件设计，aiCore 将钩子分为四类：

#### 5.1.1 First 钩子（首个返回有效）

```typescript
// 只执行第一个返回非 null/undefined 的插件
resolveModel?: (modelId: string, context) => Promise<LanguageModel | null>
loadTemplate?: (templateName: string, context) => Promise<JSONValue | null>
```

**执行逻辑**：
```typescript
async executeFirst<T>(hookName, arg, context): Promise<T | null> {
  for (const plugin of this.plugins) {
    const hook = plugin[hookName]
    if (hook) {
      const result = await hook(arg, context)
      if (result !== null && result !== undefined) {
        return result as T  // 第一个有效结果立即返回
      }
    }
  }
  return null
}
```

#### 5.1.2 Sequential 钩子（链式执行）

```typescript
// 链式执行，每个插件接收上一个插件的输出
configureContext?: (context) => Promise<void>
transformParams?: (params, context) => Promise<Partial<TParams>>
transformResult?: (result, context) => Promise<TResult>
```

**执行逻辑**（以 transformParams 为例）：
```typescript
async executeTransformParams(initialValue, context): Promise<TParams> {
  let result = initialValue
  for (const plugin of this.plugins) {
    if (plugin.transformParams) {
      const partial = await plugin.transformParams(result, context)
      result = { ...result, ...partial }  // 合并 Partial 到结果
    }
  }
  return result
}
```

#### 5.1.3 Parallel 钩子（并行执行）

```typescript
// 同时执行所有插件，不阻塞主流程，用于副作用
onRequestStart?: (context) => Promise<void>
onRequestEnd?: (context, result) => Promise<void>
onError?: (error, context) => Promise<void>
```

**执行逻辑**：
```typescript
async executeParallel(hookName, context, result?, error?): Promise<void> {
  const promises = this.plugins
    .map(plugin => {
      const hook = plugin[hookName]
      if (!hook) return null
      return hook(context, result, error)  // 并行执行
    })
    .filter(Boolean)

  await Promise.all(promises)  // 等待所有完成
}
```

#### 5.1.4 Stream 钩子（流转换）

```typescript
// 返回 TransformStream 用于流数据处理
transformStream?: (params, context) => <TOOLS>(options) => TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>
```

### 5.2 插件排序（enforce）

```typescript
export interface AiPlugin {
  name: string
  enforce?: 'pre' | 'post'  // 执行顺序控制
}

// 排序逻辑
private sortPlugins(plugins): AiPlugin[] {
  const pre: AiPlugin[] = []
  const normal: AiPlugin[] = []
  const post: AiPlugin[] = []

  plugins.forEach(plugin => {
    if (plugin.enforce === 'pre') pre.push(plugin)
    else if (plugin.enforce === 'post') post.push(plugin)
    else normal.push(plugin)
  })

  return [...pre, ...normal, ...post]
}
```

**典型使用场景**：
- `enforce: 'pre'`：参数预处理插件（如添加系统提示）
- 无 enforce：普通功能插件
- `enforce: 'post'`：结果后处理插件（如日志记录）

### 5.3 内置插件实现原理

#### 5.3.1 webSearchPlugin

**核心功能**：为不同 Provider 配置对应的搜索工具参数。

```typescript
export const webSearchPlugin = (config: WebSearchPluginConfig) =>
  definePlugin({
    name: 'webSearch',
    enforce: 'pre',
    transformParams: async (params, context) => {
      const { providerId } = context

      // 根据 providerId 应用不同的搜索配置
      switch (providerId) {
        case 'openai':
          params.tools = {
            web_search_preview: {  // OpenAI 的搜索工具配置
              type: 'provider',
              ...config.openai
            }
          }
          break
        case 'xai':
          // xAI 的搜索配置
          break
        case 'anthropic':
          // Anthropic 的搜索配置
          break
      }
      return params
    }
  })
```

#### 5.3.2 promptToolUsePlugin

**核心功能**：为不支持原生 Function Call 的模型提供基于 Prompt 的工具调用能力。

**工作流程**：

```
1. transformParams 阶段：
   - 分离 providerDefinedTools 和 promptTools
   - 将 promptTools 转换为 XML 格式的 system prompt
   - 保留 providerDefinedTools 在 params.tools 中

2. transformStream 阶段：
   - 创建 TransformStream 拦截流数据
   - text-delta: 使用 TagExtractor 过滤 <tool_use> 标签
   - finish-step: 解析工具调用，执行工具
   - 递归调用 recursiveCall 继续对话
```

**标签提取器** (`TagExtractor`)：
```typescript
class TagExtractor {
  processText(text: string): ExtractionResult[] {
    // 识别 <tool_use>...</tool_use> 标签
    // 返回标签内容和普通文本内容
    // 用于在 UI 层隐藏工具调用标签
  }
}
```

**流转换器架构**：
```typescript
transformStream: (_, context) => () => {
  const tagExtractor = new TagExtractor(TOOL_USE_TAG_CONFIG)
  const toolExecutor = new ToolExecutor()
  const streamEventManager = new StreamEventManager()

  return new TransformStream({
    async transform(chunk, controller) {
      switch (chunk.type) {
        case 'text-delta':
          // 收集文本，过滤标签，传递非标签内容到 UI
          break
        case 'finish-step':
          // 解析工具调用，执行工具，递归继续
          break
        case 'finish':
          // 汇总 usage 信息
          break
      }
    }
  })
}
```

---

## 6. Provider 管理机制

### 6.1 Provider 注册流程

```
Step 1: 注册配置 (registerProviderConfig)
─────────────────────────────────────────────────
registerProviderConfig({
  id: 'groq',
  name: 'Groq',
  creator: createGroq,  // 方式1: 直接提供 creator
  // 或
  import: () => import('@ai-sdk/groq'),  // 方式2: 动态导入
  creatorFunctionName: 'createGroq'
})
    │
    ▼
存储到 providerConfigs Map


Step 2: 创建 Provider (createProvider)
─────────────────────────────────────────────────
createProvider('groq', { apiKey: 'xxx' })
    │
    ▼
查找 providerConfigs 获取配置
    │
    ├── 方式1: 直接调用 config.creator(options)
    │
    └── 方式2: 动态导入后调用 module[creatorFunctionName](options)
    │
    ▼
返回 ProviderV3 实例


Step 3: 注册到全局 (registerProvider)
─────────────────────────────────────────────────
registerProvider('groq', providerInstance)
    │
    ▼
// 特殊处理 OpenAI/Azure 的 chat/responses 变体
if (providerId === 'openai') {
  // 注册 openai（默认 responses）
  globalRegistryManagement.registerProvider('openai', provider)
  // 创建并注册 openai-chat 变体
  const chatProvider = customProvider({
    fallbackProvider: { ...provider, languageModel: (id) => provider.chat(id) }
  })
  globalRegistryManagement.registerProvider('openai-chat', chatProvider)
} else {
  globalRegistryManagement.registerProvider(providerId, provider, aliases)
}
```

### 6.2 Provider 模式处理

**OpenAI 的特殊处理**（chat vs responses API）：

```typescript
// 默认 openai provider 使用 responses API
const openai = createOpenAI({ apiKey: 'xxx' })
// openai('gpt-4') -> responses API
// openai.chat('gpt-4') -> chat API

// 通过 customProvider 创建 chat 变体
const openaiChatProvider = customProvider({
  fallbackProvider: {
    ...provider,
    languageModel: (modelId: string) => provider.chat(modelId)
  }
})
// 现在 openai-chat:gpt-4 使用 chat API
```

**Azure 的相反处理**：
```typescript
// Azure 的 creator 默认返回 chat API 的 provider
// 所以需要创建 responses 变体
const azureResponsesProvider = customProvider({
  fallbackProvider: {
    ...provider,
    languageModel: (modelId: string) => provider.responses(modelId)
  }
})
```

---

## 7. 使用模式与最佳实践

### 7.1 三种使用模式对比

| 模式 | 适用场景 | 代码示例 | 特点 |
|------|----------|----------|------|
| **便捷函数** | 简单一次性调用 | `streamText(providerId, options, params, plugins)` | 即用即走，无需管理实例 |
| **执行器实例** | 多次调用，相同配置 | `createExecutor(providerId, options, plugins)` | 可复用，支持状态保持 |
| **静态工厂** | 需要完整类型支持 | `RuntimeExecutor.create(providerId, options)` | 最完整的类型推导 |

### 7.2 性能优化建议

**1. 复用 Executor 实例**
```typescript
// ✅ 推荐：复用执行器
const executor = createExecutor('openai', { apiKey })
for (const message of messages) {
  await executor.streamText({ model: 'gpt-4', messages: [message] })
}

// ❌ 避免：每次创建新实例
for (const message of messages) {
  const executor = createExecutor('openai', { apiKey })  // 重复创建
  await executor.streamText({ ... })
}
```

**2. 合理使用 enforce 顺序**
```typescript
const plugins = [
  // pre: 参数预处理
  { name: 'auth', enforce: 'pre', transformParams: ... },
  // normal: 主要功能
  { name: 'webSearch', transformParams: ... },
  // post: 后处理
  { name: 'logging', enforce: 'post', onRequestEnd: ... }
]
```

**3. 流转换器注意事项**
- 流转换器会累积内存（textBuffer）
- 长文本对话需要注意内存使用
- 及时清理 pending 状态（flush 方法）

### 7.3 错误处理最佳实践

```typescript
import { ModelResolutionError, RecursiveDepthError } from '@cherrystudio/ai-core'

try {
  const result = await executor.streamText({ ... })
} catch (error) {
  if (error instanceof ModelResolutionError) {
    // 模型解析失败
    console.error(`Model ${error.context.modelId} not found`)
  } else if (error instanceof RecursiveDepthError) {
    // 递归深度超限
    console.error(`Max depth ${error.context.maxDepth} exceeded`)
  } else if (error instanceof AiCoreError) {
    // 其他 aiCore 错误
    console.error(`${error.code}: ${error.message}`)
  } else {
    // AI SDK 或其他错误
    console.error('Unexpected error:', error)
  }
}
```

---

## 8. 扩展开发指南

### 8.1 创建自定义 Provider

```typescript
import { registerProviderConfig, createAndRegisterProvider } from '@cherrystudio/ai-core'

// 步骤1: 定义 Provider 配置
registerProviderConfig({
  id: 'my-provider',
  name: 'My Custom Provider',
  // 方式1: 直接提供 creator
  creator: (options: { apiKey: string; baseURL?: string }) => {
    return createOpenAICompatible({
      name: 'my-provider',
      headers: { 'Authorization': `Bearer ${options.apiKey}` },
      baseURL: options.baseURL || 'https://api.myprovider.com/v1'
    })
  },
  supportsImageGeneration: false,
  aliases: ['mp']  // 可选别名
})

// 步骤2: 初始化 Provider
await createAndRegisterProvider('my-provider', {
  apiKey: 'your-api-key',
  baseURL: 'https://custom-endpoint.com'
})

// 现在可以使用
const executor = createExecutor('my-provider', { apiKey: 'xxx' })
```

### 8.2 创建自定义插件

```typescript
import { definePlugin } from '@cherrystudio/ai-core'

// 缓存插件示例
export const cachePlugin = (options: { ttl: number }) => {
  const cache = new Map<string, { data: any; timestamp: number }>()

  return definePlugin({
    name: 'cache',
    enforce: 'pre',  // 优先执行

    // 转换参数：添加缓存标识
    transformParams: async (params, context) => {
      const cacheKey = JSON.stringify(params.messages)
      context.cacheKey = cacheKey
      return params
    },

    // 转换结果：缓存响应
    transformResult: async (result, context) => {
      const { cacheKey } = context
      if (cacheKey) {
        cache.set(cacheKey, {
          data: result,
          timestamp: Date.now()
        })
      }
      return result
    },

    // 并行钩子：检查缓存命中
    onRequestStart: async (context) => {
      const cached = cache.get(context.cacheKey)
      if (cached && Date.now() - cached.timestamp < options.ttl) {
        // 可以在这里抛出特殊错误或使用其他机制返回缓存
        context.cacheHit = true
      }
    }
  })
}
```

### 8.3 流转换插件开发

```typescript
import { definePlugin } from '@cherrystudio/ai-core'

// 敏感词过滤流转换插件
export const sensitiveWordFilterPlugin = () => {
  const sensitiveWords = ['word1', 'word2']

  return definePlugin({
    name: 'sensitive-word-filter',

    transformStream: (params, context) => () => {
      let buffer = ''

      return new TransformStream({
        transform(chunk, controller) {
          if (chunk.type === 'text-delta') {
            buffer += chunk.text

            // 检查并替换敏感词
            let filtered = buffer
            sensitiveWords.forEach(word => {
              filtered = filtered.replaceAll(word, '***')
            })

            // 只发送新增的部分
            const newContent = filtered.slice(buffer.length - chunk.text.length)
            controller.enqueue({
              ...chunk,
              text: newContent
            })
          } else {
            controller.enqueue(chunk)
          }
        }
      })
    }
  })
}
```

### 8.4 中间件开发

```typescript
import { type LanguageModelV3Middleware } from '@ai-sdk/provider'

// 自定义中间件：添加请求头
const customHeaderMiddleware: LanguageModelV3Middleware = {
  wrapGenerate: async ({ model, params, run }) => {
    // 在 generateText 调用前后执行逻辑
    console.log('Before generate')
    const result = await run({ ...params })
    console.log('After generate')
    return result
  },

  wrapStream: async ({ model, params, run }) => {
    // 在 streamText 调用前后执行逻辑
    return run({ ...params })
  }
}

// 使用中间件（通过 context.middlewares）
const middlewarePlugin = definePlugin({
  name: 'middleware-plugin',
  configureContext: (context) => {
    context.middlewares = [
      ...(context.middlewares || []),
      customHeaderMiddleware
    ]
  }
})
```

---

## 9. 总结

### 9.1 核心设计亮点

1. **分层清晰**：Models（创建）+ Runtime（执行）+ Plugins（扩展）
2. **插件强大**：四类钩子（First/Sequential/Parallel/Stream）覆盖全生命周期
3. **Provider 灵活**：支持内置 + 自定义 + 动态导入
4. **类型安全**：基于 Zod Schema 的完整类型推导
5. **最小包装**：直接复用 AI SDK，无重复抽象

### 9.2 关键扩展点

| 扩展需求 | 推荐方式 | 文件位置 |
|----------|----------|----------|
| 添加新 Provider | `registerProviderConfig` + `createAndRegisterProvider` | `src/core/providers/registry.ts` |
| 自定义插件 | `definePlugin` | `src/core/plugins/built-in/` |
| 流处理 | `transformStream` 钩子 | 插件中实现 |
| 参数转换 | `transformParams` 钩子 | 插件中实现 |
| 模型包装 | `context.middlewares` | `configureContext` 钩子 |

### 9.3 调试技巧

```typescript
// 启用日志插件查看详细流程
import { createLoggingPlugin } from '@cherrystudio/ai-core/built-in/plugins'

const executor = createExecutor('openai', { apiKey }, [
  createLoggingPlugin({
    level: 'debug',
    logParams: true,
    logResult: true,
    logPerformance: true
  })
])

// 查看插件统计
console.log(executor.pluginEngine.getPluginStats())
```

---

**掌握这些原理后，你可以：**
- 深度定制 aiCore 的行为
- 开发复杂的插件扩展
- 优化性能瓶颈
- 调试疑难问题
- 为项目贡献代码
