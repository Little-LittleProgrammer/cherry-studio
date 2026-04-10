# 06-MCP集成与扩展能力

MCP（Model Context Protocol）是工具生态接入层，主实现位于 `src/main/services/MCPService.ts`。

## MCPService 的职责

1. 管理 MCP client 生命周期（初始化、重连、关闭）。
2. 提供 `listTools`、`callTool`、`listPrompts`、`listResources` 等能力。
3. 支持多种 transport（stdio、SSE、streamable HTTP、in-memory）。
4. 提供 OAuth 支持与日志缓冲。
5. 维护工具调用中止（`AbortController`）与缓存。

## 关键能力拆解

### 连接与传输

支持：

- `StdioClientTransport`
- `SSEClientTransport`
- `StreamableHTTPClientTransport`
- `InMemoryTransport`

这使本地 CLI 工具、远程 HTTP MCP 服务、内置服务都可统一接入。

### 工具聚合

`listAllActiveServerTools` 会遍历所有激活 MCP 服务，聚合工具清单并过滤禁用工具。

在自动模式下，渲染侧通常只面向“Hub MCP Server”工作，具体路由在主进程完成。

这里除了“聚合”，还有几个容易被忽略的运行时特征：

- 工具聚合会跳过未激活 server。
- `server.disabledTools` 会在主进程聚合阶段生效。
- 通过 `callToolById(serverId__toolName)` 可以把聚合后的工具重新路由回具体 server。

### 工具调用与取消

调用入口：

- `callTool`
- `callToolById(serverId__toolName)`

运行中调用可通过 `abortTool` 取消，状态与日志通过 IPC 回传渲染层。

此外，MCPService 还会对部分高频调用做缓存包装，减少重复 `listTools` / 资源获取带来的启动开销。

### OAuth 与日志

MCP OAuth 相关实现位于 `src/main/services/mcp/oauth/`。

服务日志通过 `ServerLogBuffer` 缓存，并可推送到主窗口：

- 便于调试工具执行失败
- 便于定位 transport/鉴权问题

日志侧还有两点很关键：

- 会对 headers、token、api key 等敏感字段做脱敏。
- 服务端 `logging` notification 会被接住并缓存，而不只是本地初始化日志。

### 动态通知与状态同步

当前实现不只做“请求-响应”，还监听 MCP SDK 的动态通知：

- `ToolListChanged`
- `PromptListChanged`
- `ResourceListChanged`
- `ResourceUpdated`
- `LoggingMessage`

这意味着 MCP server 的工具、资源、提示词不是静态快照，而可以在运行中刷新。

### 内置 Server 与特殊传输

除了 stdio / SSE / streamable HTTP / in-memory 四种通用 transport，当前还有一些特例：

- builtin MCP server 会在主进程内直接创建并接入。
- 部分 builtin server 使用 in-memory transport。
- `nowledgeMem` 当前走特化的本地 HTTP MCP 路径，而不是普通 in-memory。

这些特例是产品层“内置工具能力”的落点，扩展时需要和通用外部 MCP server 区分。

## 渲染侧如何使用 MCP

入口：`src/renderer/src/services/ApiService.ts`

流程：

1. 依据助手配置（auto/manual/disabled）计算可用 MCP 服务器。
2. 调 `window.api.mcp.listTools()` 获取工具。
3. 将工具注入到模型参数（原生或 prompt 工具调用路径）。
4. 工具执行过程通过 `Chunk` 更新 UI。

补充：

- 渲染侧最终只消费统一工具清单与调用事件，不直接感知 transport、OAuth、notification 细节。
- 这也是 MCP 能同时支撑外部 server 与内置产品能力的关键边界。

## 扩展建议

新增 MCP 能力优先在主进程落地，再通过 preload API 暴露给渲染侧，避免在前端直接耦合 SDK 连接细节。
