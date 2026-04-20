# 07-AI核心与模型接入

本章节聚焦 Cherry Studio 当前 AI 主链路：从渲染层请求入口，到 `@cherrystudio/ai-core` 统一执行，再到 MCP、知识库、记忆、Agent、Trace 等扩展能力协同。

覆盖范围不仅包括聊天补全，还包括：

- 图像生成、Embedding、Reranker、Speech、Transcription 等模型类型
- Provider Extension 注册与产品侧 Provider 适配
- 工具调用、Web Search、MCP、知识库与长期记忆
- Agent / Claude Code / CherryClaw 链路
- Trace、日志与调试入口

## 建议阅读顺序

1. [00-新人30分钟速通](./00-新人30分钟速通.md)
2. [01-AI总体架构与分层](./01-AI总体架构与分层.md)
3. [02-一次聊天请求的完整链路](./02-一次聊天请求的完整链路.md)
4. [03-aiCore执行引擎详解](./03-aiCore执行引擎详解.md)
5. [04-渲染侧AI编排层](./04-渲染侧AI编排层.md)
6. [05-插件系统与工具调用](./05-插件系统与工具调用.md)
7. [06-MCP集成与扩展能力](./06-MCP集成与扩展能力.md)
8. [07-知识库与长期记忆系统](./07-知识库与长期记忆系统.md)
9. [08-Agent与Claude Code链路](./08-Agent与Claude Code链路.md)
10. [09-可观测性与调试](./09-可观测性与调试.md)
11. [10-关键类型与扩展指南](./10-关键类型与扩展指南.md)
12. [11-提示词全集](./11-提示词全集.md)
13. [12-用户问题解答](./12-用户问题解答.md)
14. [13-AI Agent工程面试Q&A](./13-AI Agent工程面试Q&A.md)

## 全景图

```mermaid
flowchart TB
  User[用户发送消息]
  UI[渲染层\nmessageThunk / ApiService / store]
  Orchestration[渲染侧编排层\nprepareParams / PluginBuilder / AiProvider]
  Core[@cherrystudio/ai-core\nruntime / providers / plugins / options]
  Model[模型供应商 API]
  Tools[扩展能力\nMCP / 知识库 / 记忆 / WebSearch]
  Agent[Agent 子系统\nSession / Claude Code / CherryClaw]
  Trace[可观测性\nmcp-trace / SpanManager / NodeTrace]

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
| 业务调度 | `src/renderer/src/services/ApiService.ts` |
| 渲染侧 AI 入口 | `src/renderer/src/aiCore/index.ts`、`src/renderer/src/aiCore/AiProvider.ts` |
| 参数构建 | `src/renderer/src/aiCore/prepareParams/` |
| Provider 适配 | `src/renderer/src/aiCore/provider/` |
| 产品级插件 | `src/renderer/src/aiCore/plugins/` |
| Chunk 适配 | `src/renderer/src/aiCore/chunk/` |
| AI 执行内核 | `packages/aiCore/src/core/runtime/` |
| Provider Extension | `packages/aiCore/src/core/providers/` |
| 插件核心 | `packages/aiCore/src/core/plugins/` |
| MCP 主进程服务 | `src/main/services/MCPService.ts` |
| 知识库服务 | `src/main/services/KnowledgeService.ts` |
| 长期记忆服务 | `src/main/services/memory/MemoryService.ts` |
| Agent 服务 | `src/main/services/agents/services/` |
| Claude Code 适配 | `src/main/services/agents/services/claudecode/` |
| 链路追踪 | `packages/mcp-trace/`、`src/renderer/src/services/SpanManagerService.ts`、`src/main/services/NodeTraceService.ts` |

## 阅读提示

- 先看 `02`，再回头看 `03`、`04`、`05`，会更容易理解“谁负责什么”。
- 需要排查请求问题时，优先沿着 `messageThunk -> ApiService -> AiProvider -> packages/aiCore` 这条链读。
- 需要扩展能力时，先判断应该改执行内核、渲染侧编排，还是主进程服务。
