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

### 工具调用与取消

调用入口：

- `callTool`
- `callToolById(serverId__toolName)`

运行中调用可通过 `abortTool` 取消，状态与日志通过 IPC 回传渲染层。

### OAuth 与日志

MCP OAuth 相关实现位于 `src/main/services/mcp/oauth/`。

服务日志通过 `ServerLogBuffer` 缓存，并可推送到主窗口：

- 便于调试工具执行失败
- 便于定位 transport/鉴权问题

## 渲染侧如何使用 MCP

入口：`src/renderer/src/services/ApiService.ts`

流程：

1. 依据助手配置（auto/manual/disabled）计算可用 MCP 服务器。
2. 调 `window.api.mcp.listTools()` 获取工具。
3. 将工具注入到模型参数（原生或 prompt 工具调用路径）。
4. 工具执行过程通过 `Chunk` 更新 UI。

## 扩展建议

新增 MCP 能力优先在主进程落地，再通过 preload API 暴露给渲染侧，避免在前端直接耦合 SDK 连接细节。

