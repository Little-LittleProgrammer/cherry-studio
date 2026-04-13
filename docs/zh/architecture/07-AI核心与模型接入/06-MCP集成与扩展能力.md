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
- `knowledgeMem` 走特化的本地 HTTP MCP 路径（StreamableHTTP），而不是普通 in-memory。
- `flomo` 使用 StreamableHTTP 连接到特定 URL（最近新增的内置服务）。

**新增内置 server 的常见场景**：

| Server | Transport | 用途 |
|--------|-----------|------|
| knowledge | StreamableHTTP | 知识库记忆服务 |
| flomo | StreamableHTTP | Flomo 笔记集成 |
| 其他 builtin | InMemory | 浏览器自动化、Claw、Assistant 等 |

这些特例是产品层”内置工具能力”的落点，扩展时需要和通用外部 MCP server 区分。

### Hub MCP Server（元服务器）

Hub MCP Server 是一个**内置的元服务器（meta-server）**，用于聚合所有已激活的 MCP Server，并通过一组通用元工具暴露给 LLM。

- 源码：`src/main/mcpServers/hub/`
- 核心类：`HubServer`（位于 `src/main/mcpServers/hub/index.ts`）

#### 设计目的

Hub 的核心价值是支撑 **Auto Mode（自动模式）**——让 LLM 能够**动态发现和调用**所有 MCP 工具，而不需要在每次请求前手动配置工具列表。

对比两种模式：

| | 普通模式（Manual） | Hub 模式（Auto） |
|---|---|---|
| 工具注入方式 | 将所有 MCP 工具的描述完整塞入 system prompt | 只注入 4 个元工具（`list`/`inspect`/`invoke`/`exec`） |
| 工具发现 | 静态的，请求前决定注入哪些 | 动态的，LLM 通过 `list` 按需探索 |
| 灵活性 | 新增 MCP Server 后需重新配置助手 | Hub 自动聚合，无需额外配置 |
| 系统 prompt 大小 | 工具多时 prompt 很长 | 固定 4 个工具描述，较轻量 |

#### 四个元工具

| 工具 | 用途 | 输入参数 |
|------|------|----------|
| `list` | 分页列出所有可用 MCP 工具 | `limit`（默认 30，最大 100）、`offset`（默认 0） |
| `inspect` | 获取单个工具签名（JSDoc 格式） | `name`（JS 名称或 `serverId__toolName`） |
| `invoke` | 调用单个工具 | `name`、`params` |
| `exec` | 执行 JS 代码编排多步工具调用 | `code`（可使用 `mcp.callTool()`、`mcp.log()`、`parallel()`、`settle()`） |

#### Auto Mode 集成流程

当助手设置为 Auto 模式时：

1. Hub Server 作为唯一的 MCP Server 注入到模型参数中
2. 拼接专用的 system prompt，指导 LLM 如何使用 `list`/`inspect`/`invoke`/`exec`
3. LLM 的典型使用流程：`list` 发现工具 → `inspect` 了解参数 → `invoke`/`exec` 执行

#### 工具名称映射

Hub 同时支持两种工具名称格式：

- **JS 格式（camelCase）**：如 `githubSearchRepos`，方便 LLM 编写代码调用
- **原始命名（namespaced）**：如 `github__search_repos`（`serverId__toolName`）

两者均可用于 `inspect`、`invoke` 和 `mcp.callTool()`。映射关系由 `src/main/mcpServers/hub/toolname.ts` 中的 `buildToolNameMapping` 构建。

#### 调用桥接（mcp-bridge）

Hub 不直接执行工具，而是通过 `mcp-bridge.ts` 桥接到 `MCPService`：

```
HubServer → callMcpTool(name, params) → mcp-bridge → MCPService.callToolById(toolId) → 具体 MCP Server
```

- `callMcpTool()` 接收 JS 名称或 namespaced ID，解析后路由到对应的 MCP Server
- 工具定义缓存 **1 分钟**，MCP Server 连接/断开时通过 `invalidateCache()` 失效
- 错误处理：通过 `extractToolResult()` 提取结果，`throwIfToolError()` 抛出异常

#### 缓存机制

- 工具定义缓存 key：`hub:tools:v2`
- TTL：60 秒
- 缓存失效时机：MCP Server 连接/断开时调用 `invalidateCache()`
- 缓存命中时同步工具映射，避免重复遍历

#### 调用链路（Hub 如何调用其他 MCP）

Hub 本身不直接连接外部 MCP Server，而是通过 `mcp-bridge.ts` 桥接到 `MCPService`，由 `MCPService` 路由到具体的 MCP Server 实例。

**完整调用链路：**

```
LLM 请求
  │
  ├─ invoke 模式 ────────────────────────────────────────────┐
  │   HubServer.handleInvoke()                                │
  │   → callMcpTool(name, params)                             │
  │                                                          │
  ├─ exec 模式                                               │
  │   Runtime.execute(code)                                   │
  │     └─ new Worker(hubWorkerSource)  // 独立 Worker 沙箱    │
  │          用户代码: mcp.callTool("xxx")                    │
  │          worker.postMessage("callTool")                   │
  │          ↓                                                │
  │     handleMessage → handleToolCall                        │
  │                                                          │
  └──────────────────────────────────────────────────────────┘
                        │
                        ▼
              callMcpTool(nameOrId, params, callId)
              [mcp-bridge.ts:87]
                        │
              1. resolveToolId(nameOrId)
                 "githubSearchRepos" → "github__search_repos"
                        │
              2. mcpService.callToolById(toolId, params, callId)
                 [MCPService.ts:207]
                        │
              3. toolId.split('__')
                 → serverId = "github", toolName = "search_repos"
                        │
              4. 找到对应的 MCP Server 实例
                 server.client.callTool({ name, params })
                        │
                        ▼
              具体的 MCP Server (stdio/SSE/HTTP...)
```

**两种调用模式的区别：**

| | `invoke` | `exec` |
|---|---|---|
| 执行环境 | 主进程直接调用 | 独立 Node.js Worker（`Worker` 线程） |
| 隔离性 | 无 | 代码沙箱隔离 |
| 能力 | 调用单个工具 | 可编排多步调用，支持 `parallel()`、`settle()` |
| 超时 | 跟随模型请求 | 固定 60 秒（`EXECUTION_TIMEOUT`） |
| 日志 | MCP Server 自身日志 | Worker 通过 `mcp.log()` / `console.*` 回传，最多 1000 条 |

**exec 模式的 Worker 通信流程：**

```
Runtime.execute(code)
  → 创建 Worker，postMessage("exec", code)
  → Worker 运行代码
  → Worker 调用 mcp.callTool("xxx") → postMessage("callTool")
  → 主线程收到 "callTool" → callMcpTool() → 调用目标 MCP
  → 结果 postMessage("toolResult") 回传 Worker
  → Worker 继续执行，最终 postMessage("result")
  → Runtime finalize，返回 ExecOutput
```

- 超时或异常时，通过 `abortMcpTool(callId)` 取消所有活跃的工具调用（`runtime.ts:64-69`）
- Worker 退出码非 0 或意外退出时，记录错误并标记 `isError: true`

### 连接超时与重试

MCP 客户端初始化支持连接超时配置。对于 stdio 传输，还会解析登录 shell 环境变量，处理 bundle 降级（npx → bun，uv/uvx 使用内置版本），以及 DXT server 配置解析。

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
