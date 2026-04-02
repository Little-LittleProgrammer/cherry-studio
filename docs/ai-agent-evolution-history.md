# Cherry Studio AI Agent 进化史

基于仓库全部commit history的分析，记录AI Agent从起源到成熟的演进路径。

---

## 一、项目起源（2024年5月-7月）

| 时间 | 里程碑 | 说明 |
|-----|--------|------|
| 2024-05-24 | Initial commit | 基于vite-electron模板启动 |
| 2024-06-28 | thread → agent | 首次引入"agent"概念 |
| 2024-07-03 | agent → assistant | 术语统一为"assistant" |
| 2024-07-19 | Anthropic Provider | 首次集成Claude |

### Provider集成爆发期（2024年7月-8月）

```
2024-07-08: 01-yi (零一万物)
2024-07-10: zhipu (智谱), ollama
2024-07-11: moonshot, openrouter
2024-07-17: baichuan
2024-07-19: DashScope, anthropic
2024-08-13: gemini, stepfun, doubao
```

---

## 二、工具调用的四阶段演进 ⭐

### 阶段1：Prompt注入 + XML解析（2025年3月-5月）

**方式**：在system prompt中注入工具描述 → 模型返回XML标签 → 前端解析执行

**格式**：
```xml
<tool_use>
  <name>search</name>
  <arguments>{"query": "..."}</arguments>
</tool_use>
```

**关键commit**：
- `c95c7faa5` (2025-03-05): 首次引入MCP支持
- `24e28b86c` (2025-04-09): "support MCP by prompt" - 为不支持原生Function Call的模型提供工具调用能力

**特点**：
- 依赖prompt engineering
- 前端手动解析XML字符串
- 适用于不支持原生tool call的模型

### 阶段2：Function Call + Prompt双模式（2025年5月-9月）

**关键commit**：
- `ce8b85020` (2025-05-09): "support both function call and system prompt for MCP tools"
- `49d29d78d` (2025-03-08): "Add tool calling support for models"
- `56dd2d17e` (2025-03-11): "Add Qwen to tool calling models"

**特点**：
- 用户可选择`enable_tool_use`设置
- 原生Function Call与prompt模式共存
- 模型API开始原生支持`tools`参数

### 阶段3：AI SDK中间件架构（2025年9月）

**关键commit**：
- `a227f6dcb` (2025-09-04): "Feat/aisdk package" - **架构重大重构**
- `5f4d73b00` (2025-06-12): "add middleware support for provider"
- `e10042a43` (2025-09-10): "Feat/provider options and built-in tools"
- `483b4e090` (2025-09-28): "separate provider-defined tools from prompt tool"

**架构变化**：
```
packages/aiCore/src/
├── core/
│   ├── middleware/
│   │   ├── manager.ts       # 中间件管理
│   │   └── wrapper.ts       # 中间件包装
│   ├── plugins/
│   │   └── built-in/
│   │       ├── toolUsePlugin/   # Prompt工具调用插件
│   │       ├── webSearchPlugin/ # 网络搜索插件
│   │       └── googleToolsPlugin/
│   └── providers/
│       ├── factory.ts       # Provider工厂
│       ├── registry.ts      # Provider注册表
│       └── HubProvider.ts   # Hub Provider
```

**特点**：
- 基于**Vercel AI SDK v5**的`LanguageModelV2Middleware`
- 统一了20+个provider的工具调用逻辑
- 插件化工具处理：`promptToolUsePlugin.ts`

### 阶段4：Claude Agent SDK原生集成（2025年9月-至今）

**关键commit**：
- `2f74becb3` (2025-09-15): "add @anthropic-ai/claude-code package"
- `58dbb514e` (2025-09-16): "Implement Claude Code service with streaming"
- `7abd5da57` (2025-09-18): "replace ClaudeCodeService child process with SDK query"
- `422ba5209` (2025-09-30): "migrate to Claude Agent SDK v0.1.1"
- `e2c1d5346` (2026-03-22): "upgrade Agent SDK, enable ToolSearch"

**关键演进**：
| 模式 | 时间 | 说明 |
|-----|------|------|
| 子进程模式 | 2025-09-16 | 启动claude-code CLI子进程 |
| SDK query | 2025-09-18 | 直接调用SDK，取消子进程 |
| Agent SDK | 2025-09-30 | 迁移到专用Agent SDK |
| ToolSearch | 2026-03-22 | 模型动态搜索和选择工具 |

---

## 三、架构演进图示

```
┌─────────────────────────────────────────────────────────────────┐
│  2024.05              2025.06            2025.09       2026.03  │
│     │                    │                 │            │       │
│  直接API调用 ──────> 中间件支持 ──────> AI SDK统一 ──> Agent SDK │
│     │                    │                 │            │       │
│  ProviderSDK          BaseProvider      aiCore包     Claude    │
│  (独立调用)          (middleware)      (插件架构)    Agent SDK │
│     │                    │                 │            │       │
│  Prompt注入          双模式共存        Middleware    ToolSearch│
│  +手动解析           +原生FC           管道处理      动态发现   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 四、SDK版本演进

### Claude Agent SDK版本时间线

```
v0.1.1  (2025-09-30) ─── 初始迁移，从Claude Code SDK迁移
v0.1.25 (2025-10-29) ─── Plugin系统支持
v0.1.53 (2025-11-19) ─── 功能增强
v0.1.76 (2025-12-19) ─── 稳定版本
v0.2.56 (2026-02-26) ─── 新功能迭代
v0.2.71 (2026-03-27) ─── ToolSearch + UI Renderer
```

### AI SDK迁移

- `842ccf027` (2026-02-27): "migrate to aisdk v6 Phase 1"
- `7f83f0700` (2025-10-11): 使用自定义fork的`@cherrystudio/openai`

---

## 五、Reasoning/Thinking模型演进

```
2025-01-22: reasoning_content提取
2025-02-05: reasoning_effort设置支持
2025-03-01: Claude 3.7 reasoning effort control
2025-04-19: Gemini reasoning budget support
```

思维链从单纯的prompt技巧演进为API原生支持的参数。

---

## 六、Agent概念演变

### 术语变迁

```
2024-06-28: thread → agent (首次引入)
2024-07-03: agent → assistant (术语统一)
2025-09-16: Claude Code Agent (真正自主工具调用的AI代理)
2026-03-14: Agent独立模块化 (从主应用分离)
```

### Agent核心能力演进

| 能力 | 时间 | Commit | 说明 |
|-----|------|--------|------|
| Session管理 | 2025-09-16 | `58dbb514e` | AgentService, SessionService分离 |
| Plugin系统 | 2025-10-29 | `352ecbc50` | Skills、Commands、Agents三种插件 |
| Tool Permission | 2025-10-31 | `5790c1201` | 实时工具审批系统 |
| MCP Hub | 2026-01-07 | `6d15b0dfd` | 多服务器工具编排 |
| Extended Thinking | 2026-03-02 | `e0cda0969` | thinking/reasoning effort控制 |

---

## 七、关键洞察

### 1. 范式转移

从"字符串解析"到"结构化API参数"是质的飞跃：

| 时代 | 工具调用方式 |
|-----|------------|
| 早期 | `<tool_use>` XML标签 → 手动字符串解析 |
| 现在 | SDK返回结构化`tool_use`对象 |

### 2. Provider统一化

Vercel AI SDK的引入让**20+个provider**的工具调用逻辑统一到一个middleware管道：

```
早期：每个Provider独立实现API调用逻辑
现在：统一的middleware管道处理所有Provider
```

### 3. Agent概念的回归

- **2024-07**：agent → assistant（简单的术语变更）
- **2025-09**：Claude Code Agent（真正具有自主工具调用能力的AI代理）

### 4. 从执行工具到规划工具

**ToolSearch**的启用意味着进化：
- **被动响应**：模型等待用户指定工具
- **主动发现**：模型可动态搜索和选择适合的工具

---

## 八、里程碑时间线总结

```
2024-05-24 ─────────── 项目启动
2024-07-03 ─────────── agent → assistant 术语统一
2024-07-19 ─────────── Anthropic Provider集成
2025-03-05 ─────────── MCP支持首次引入 ⭐ (重大突破)
2025-04-09 ─────────── Prompt模式Tool Call实现
2025-05-09 ─────────── Function Call + Prompt双模式
2025-06-12 ─────────── 中间件支持首次引入
2025-09-04 ─────────── AI SDK Package架构重构 ⭐ (重大架构升级)
2025-09-16 ─────────── Claude Code Service实现
2025-09-30 ─────────── Claude Agent SDK迁移 (v0.1.1)
2025-10-29 ─────────── Plugin管理系统 (Skills支持)
2026-02-27 ─────────── AI SDK v6迁移
2026-03-14 ─────────── Agent独立模块化
2026-03-22 ─────────── Agent SDK升级 + ToolSearch + UI Renderer
```

---

## 九、关键技术文件索引

| 文件 | 说明 |
|-----|------|
| `packages/aiCore/src/core/plugins/built-in/toolUsePlugin/promptToolUsePlugin.ts` | Prompt模式Tool Call核心实现 |
| `packages/aiCore/src/index.ts` | AI Core包入口 |
| `src/main/services/ClaudeCodeService.ts` | Claude Agent SDK集成服务 |
| `docs/claude-agent-sdk-design.md` | Claude Agent SDK架构详细文档 |

---

*文档生成时间：2026-03-29*
*基于Cherry Studio仓库commit history分析*