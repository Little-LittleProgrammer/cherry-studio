# 07-AI核心与模型接入

本章节聚焦 Cherry Studio 的 AI 主链路：从渲染层发起请求，到 `@cherrystudio/ai-core` 执行，再到 MCP/知识库/记忆/Agent/Trace 等扩展能力协同。

覆盖范围不仅包括聊天补全，还包括：

- 图像生成与图像端点回退
- Embedding / Reranker / Speech / Transcription 等模型类型的内核支持
- Provider / Extension / alias 注册体系
- 模型原生搜索与外部 Web Search Provider
- 知识库预处理、RAG 检索、Reranker
- 长期记忆的抽取、去重、恢复、检索
- Agent / Claude Code 与兼容 Anthropic API provider

目标是回答三个问题：

1. AI 相关代码分层在哪里，边界怎么划分？
2. 一次消息请求经过哪些模块，哪些节点最容易出问题？
3. 如果要扩展 Provider、工具调用、知识记忆、Agent，应该改哪一层？

## 推荐阅读顺序

1. [00-新人30分钟速通.md](./00-新人30分钟速通.md)
2. [01-AI总体架构与分层.md](./01-AI总体架构与分层.md)
3. [02-一次聊天请求的完整链路.md](./02-一次聊天请求的完整链路.md)
4. [03-aiCore执行引擎详解.md](./03-aiCore执行引擎详解.md)
5. [04-渲染侧AI编排层.md](./04-渲染侧AI编排层.md)
6. [05-插件系统与工具调用.md](./05-插件系统与工具调用.md)
7. [06-MCP集成与扩展能力.md](./06-MCP集成与扩展能力.md)
8. [07-知识库与长期记忆系统.md](./07-知识库与长期记忆系统.md)
9. [08-Agent与Claude Code链路.md](./08-Agent与Claude Code链路.md)
10. [09-可观测性与调试.md](./09-可观测性与调试.md)
11. [10-关键类型与扩展指南.md](./10-关键类型与扩展指南.md)
12. [11-提示词全集.md](./11-提示词全集.md)

## 全景图

```mermaid
flowchart TB
  User[用户发送消息]
  UI[渲染层\nRedux Thunk / ApiService]
  Orchestration[渲染AI编排层\nprepareParams / PluginBuilder / AiProvider]
  Core[@cherrystudio/ai-core\nruntime / providers / models / plugins / options]
  Model[模型供应商 API]
  Tools[工具与扩展\nMCP / 知识库 / 记忆 / WebSearch]
  Agent[Agent 子系统\nSession / Claude Code]
  Trace[Trace 与日志\nmcp-trace / SpanManager]

  User --> UI --> Orchestration --> Core --> Model
  Orchestration --> Tools
  UI --> Agent
  Core --> Trace
  Orchestration --> Trace
  Agent --> Trace
```

## 代码入口索引

| 主题 | 主要入口 |
| --- | --- |
| AI 请求入口 | `src/renderer/src/store/thunk/messageThunk.ts` |
| API 编排 | `src/renderer/src/services/ApiService.ts` |
| 渲染侧 AI 入口 | `src/renderer/src/aiCore/index.ts`、`src/renderer/src/aiCore/AiProvider.ts` |
| 参数构建 | `src/renderer/src/aiCore/prepareParams/` |
| Provider 适配 | `src/renderer/src/aiCore/provider/` |
| aiCore 运行时 | `packages/aiCore/src/core/runtime/` |
| aiCore Provider 注册 | `packages/aiCore/src/core/providers/` |
| 插件系统 | `packages/aiCore/src/core/plugins/`、`src/renderer/src/aiCore/plugins/` |
| MCP 主进程服务 | `src/main/services/MCPService.ts` |
| 知识库服务 | `src/main/services/KnowledgeService.ts` |
| 知识预处理 | `src/main/knowledge/preprocess/` |
| 知识重排 | `src/main/knowledge/reranker/` |
| 记忆服务 | `src/main/services/memory/MemoryService.ts`、`src/renderer/src/services/MemoryService.ts` |
| WebSearch Provider | `src/renderer/src/providers/WebSearchProvider/` |
| Agent 服务 | `src/main/services/agents/services/` |
| Claude Code 适配 | `src/main/services/agents/services/claudecode/index.ts` |
| 链路追踪 | `packages/mcp-trace/`、`src/renderer/src/services/SpanManagerService.ts`、`src/main/services/NodeTraceService.ts` |

## 迁移说明

旧文档仍保留文件名以兼容历史链接，但核心内容已迁移到本次重构的 `01~10` 文档：

- `请求流程完整指南.md` -> 迁移到 `02`、`04`、`05`、`07`
- `工具调用详解.md` -> 迁移到 `05`
- `知识记忆系统.md` -> 迁移到 `07`
- `aiCoreSdk.md` -> 迁移到 `03`
- `claude-agent-sdk-design.md` -> 迁移到 `08`
