# 07-AI 核心与模型接入

## 设计目标

Cherry Studio 最大的复杂度之一，不在界面，而在“如何以统一方式接入不同模型”。

项目没有把模型调用直接写死在页面里，而是抽出 `packages/aiCore` 作为统一执行抽象层。

## `packages/aiCore` 的职责

从目录结构看，AI Core 的核心模块包括：

- `providers/`
- `runtime/`
- `plugins/`
- `options/`
- `models/`
- `errors/`

这说明它的职责拆分非常明确：

- `providers` 解决“谁来调”
- `runtime` 解决“怎么调”
- `plugins` 解决“调用过程如何扩展”
- `options` 解决“不同 provider 参数如何组装”
- `models` 解决“模型能力与解析”

## Runtime 模型

`packages/aiCore/src/core/runtime/index.ts` 暴露的核心 API 包括：

- `createExecutor`
- `createOpenAICompatibleExecutor`
- `streamText`
- `generateText`
- `generateImage`

这里最关键的设计是 `RuntimeExecutor`：

- 按 provider 创建执行器
- 封装文本流式生成、非流式生成、图像生成
- 支持插件链

## Provider 注册体系

`providers/index.ts` 暴露了一整套 registry 能力：

- `registerProvider`
- `registerProviderConfig`
- `createProvider`
- `getLanguageModel`
- `getImageModel`
- `resolveProviderConfigId`

它的意义是：Cherry Studio 不是只支持预定义 provider，而是保留了动态扩展能力。

## 插件系统

AI Core 的一个关键原理是“调用过程可插拔”。

文档和导出中能看到的内置思路包括：

- webSearch
- logging
- prompt tool use

因此一次模型调用并不是简单的 `fetch`：

1. 解析模型与 provider。
2. 组装 provider options。
3. 执行插件前置逻辑。
4. 发起模型请求。
5. 对流或结果做转换。
6. 执行后置逻辑与统计。

## 模型调用抽象图

```mermaid
flowchart LR
  Input[用户请求参数]
  Model[模型解析]
  Opt[provider options 组装]
  Plugin1[插件链]
  Provider[具体 AI Provider]
  Result[文本/图像/工具结果]

  Input --> Model --> Opt --> Plugin1 --> Provider --> Result
```

## 渲染层与 AI Core 的关系

仓库里同时存在：

- `packages/aiCore`
- `src/renderer/src/aiCore`

它们不是重复代码，而是两层分工：

- `packages/aiCore` 是通用执行引擎和 provider 抽象
- `src/renderer/src/aiCore` 更贴近产品逻辑、参数预处理、兼容层和页面使用方式

可以把它理解成：

- 包层偏“平台能力”
- 渲染侧偏“应用编排”

## `ai-sdk-provider` 的角色

`packages/ai-sdk-provider` 主要是对 Vercel AI SDK provider 体系的扩展，当前可见重点是 CherryIN 的 provider bundle。

这层的意义在于：

- 让项目可复用 AI SDK 生态
- 对外部 provider 做统一包装
- 支持特定平台的动态路由或协议兼容

## 为什么不直接在页面里调 OpenAI

如果直接在页面里逐个写 provider 逻辑，会出现几个问题：

- 参数格式不统一
- 工具调用和 Web Search 无法复用
- 流式回调逻辑分散
- 日志、追踪、统计难以统一
- 扩展新 provider 成本过高

抽出 AI Core 的本质是把“模型接入复杂度”从业务页面里剥离出来。

## 这层解决的核心问题

- 多 provider 接入差异
- 文本与图像生成的统一入口
- 插件化扩展
- 类型安全
- 模型能力抽象
- 未来 agent/workflow 扩展的基础

