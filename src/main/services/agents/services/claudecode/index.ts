// src/main/services/agents/services/claudecode/index.ts
/**
 * Claude Code（Claude Agent SDK）主进程适配层。
 *
 * ## 给首次阅读者：整体在干什么
 *
 * UI 侧的 Agent 聊天不直接拼 Anthropic HTTP，而是由**主进程**调用 `@anthropic-ai/claude-agent-sdk` 的
 * `query()`。SDK 会根据 `pathToClaudeCodeExecutable` 拉起内置 **CLI 子进程**，在 `cwd` 下执行
 * 「多轮对话 + 读写文件/Bash/工具」等 Claude Code 行为；模型 endpoint、密钥等通过 **环境变量**
 *（如 `ANTHROPIC_BASE_URL`）注入子进程。
 *
 * 本文件职责可以记成三件事：**准备子进程怎么跑**（cwd、env、权限、MCP、插件、恢复会话）、
 * **把用户输入喂给 SDK**（`prompt` 异步流）、**把 SDK 原始消息转成应用统一事件**
 *（`transformSDKMessageToStreamParts`，见 `transform.ts`）。
 *
 * ## 数据流（从一次发送到界面更新）
 *
 * ```
 * invoke() 同步创建 ClaudeCodeStream 并 return
 *        → 调用方立即 stream.on('data', handler)   // 必须先订阅，见下节
 *        → setImmediate → processSDKQuery()
 *        → for await (query({ prompt: userInputStream, options }))
 *        → 每条 SDKMessage → transform → emit('data', { type: 'chunk', chunk })
 *        → 循环正常结束 → emit('data', { type: 'complete' })
 *        → 用户取消 / 异常 → cancelled 或 error
 * ```
 *
 * **为何用 `setImmediate`**：`invoke` 必须**先**把 `ClaudeCodeStream` 返回给上层，上层才能注册
 * `'data'` 监听；若同步进入 `for await`，首批 chunk 可能在订阅前发出导致丢失，故放到下一个事件循环启动。
 *
 * ## 工具权限：`canUseTool` 与 `PreToolUse` 为何要同时存在
 *
 * - **`canUseTool`**：SDK 在执行敏感工具前会 await 这里；若返回 deny，工具不会跑。自动放行列表里的工具
 *   有时**不会**再走 `canUseTool`，UI 也就收不到「即将执行」的通知。
 * - **`preToolUseHook`**：在工具真正执行前的 Hook；对「自动放行 / bypass」路径也会触发，这里会带
 *   `autoApprove: true` 调 `promptForToolApproval`，让渲染进程仍能展示或记录本次工具调用（与 `tool-permissions.ts` 配合）。
 *
 * ## MCP 如何接上
 *
 * 会话里配置的 MCP id 会映射成指向**本应用内嵌 API 服务**的 HTTP URL（带 Bearer），
 * SDK 子进程只当普通 HTTP MCP 去连，无需渲染进程参与。
 *
 * ## 延伸阅读
 *
 * - 流式消息 → UI chunk：`transform.ts`、`claude-stream-state.ts`
 * - 弹窗审批 IPC：`tool-permissions.ts`
 */
import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'

import type {
  CanUseTool,
  HookCallback,
  McpHttpServerConfig,
  Options,
  SDKMessage,
  SdkPluginConfig,
  SpawnedProcess
} from '@anthropic-ai/claude-agent-sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { loggerService } from '@logger'
import { config as apiConfigService } from '@main/apiServer/config'
import { validateModelId } from '@main/apiServer/utils'
import { isWin } from '@main/constant'
import { pluginService } from '@main/services/agents/plugins/PluginService'
import { configManager } from '@main/services/ConfigManager'
import { autoDiscoverGitBash } from '@main/utils/process'
import { rtkRewrite } from '@main/utils/rtk'
import getLoginShellEnvironment from '@main/utils/shell-env'
import { languageEnglishNameMap } from '@shared/config/languages'
import { withoutTrailingApiVersion } from '@shared/utils'
import { app } from 'electron'

import type { GetAgentSessionResponse } from '../..'
import type {
  AgentServiceInterface,
  AgentStream,
  AgentStreamEvent,
  AgentThinkingOptions
} from '../../interfaces/AgentStreamInterface'
import { sessionService } from '../SessionService'
import { buildNamespacedToolCallId } from './claude-stream-state'
import { promptForToolApproval } from './tool-permissions'
import { ClaudeStreamState, transformSDKMessageToStreamParts } from './transform'

const require_ = createRequire(import.meta.url)
const logger = loggerService.withContext('ClaudeCodeService')
/** 默认无需弹窗即可放行的内置工具（只读/搜索类） */
const DEFAULT_AUTO_ALLOW_TOOLS = new Set(['Read', 'Glob', 'Grep'])
/** 测试用：环境变量开启时跳过所有工具人工审批 */
const shouldAutoApproveTools = process.env.CHERRY_AUTO_ALLOW_TOOLS === '1'
/** 包含这些子串的用户输入时不恢复历史会话（新开对话） */
const NO_RESUME_COMMANDS = ['/clear']

/** 根据应用语言生成追加到 system prompt 的输出语言约束 */
const getLanguageInstruction = () => {
  const lang = configManager.getLanguage()
  return `
  IMPORTANT: You MUST use ${languageEnglishNameMap[lang]} language for ALL your outputs, including:
  (1) text responses, (2) tool call parameters like "description" fields, and (3) any user-facing content.
  ${lang === 'en-US' ? '' : 'Never use English unless the content is code, file paths, or technical identifiers.'}
  `
}

/** 送入 SDK `query({ prompt: stream })` 的单条用户消息结构 */
type UserInputMessage = {
  type: 'user'
  parent_tool_use_id: string | null
  session_id: string
  message: {
    role: 'user'
    content: string
  }
}

/** 对渲染进程暴露的 EventEmitter 流，事件名为 `data`，载荷为 {@link AgentStreamEvent} */
class ClaudeCodeStream extends EventEmitter implements AgentStream {
  declare emit: (event: 'data', data: AgentStreamEvent) => boolean
  declare on: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
  declare once: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
}

/** 实现 {@link AgentServiceInterface}，封装一次完整的 Claude Code 调用生命周期 */
class ClaudeCodeService implements AgentServiceInterface {
  private claudeExecutablePath: string

  constructor() {
    // 解析 CLI 入口：开发态与 asar 打包后路径均可用；asar 需映射到 .asar.unpacked
    this.claudeExecutablePath = path.join(path.dirname(require_.resolve('@anthropic-ai/claude-agent-sdk')), 'cli.js')
    if (app.isPackaged) {
      this.claudeExecutablePath = this.claudeExecutablePath.replace(/\.asar([\\/])/, '.asar.unpacked$1')
    }
  }

  /**
   * 启动一次 Claude Code 会话回合。
   *
   * 注意：**先返回** `AgentStream`，再在下一 tick 跑 SDK；调用方必须在拿到流后立刻订阅 `data`，
   * 否则可能漏掉早期 chunk。取消请求时 abort `abortController`，子进程侧会中止，`processSDKQuery` 会发 `cancelled`。
   */
  async invoke(
    prompt: string,
    session: GetAgentSessionResponse,
    abortController: AbortController,
    lastAgentSessionId?: string,
    thinkingOptions?: AgentThinkingOptions
  ): Promise<AgentStream> {
    const aiStream = new ClaudeCodeStream()

    // --- 阶段 A：会话与模型校验（失败则只 emit error 并 return 流）---

    // 工作目录：取会话可访问路径列表首项，且需为有效目录
    const cwd = session.accessible_paths[0]
    if (!cwd) {
      aiStream.emit('data', {
        type: 'error',
        error: new Error('No accessible paths defined for the agent session')
      })
      return aiStream
    }

    // 校验模型 ID 与解析后的提供商信息（Anthropic 直连或兼容网关）
    const modelInfo = await validateModelId(session.model)
    if (!modelInfo.valid) {
      aiStream.emit('data', {
        type: 'error',
        error: new Error(`Invalid model ID '${session.model}': ${JSON.stringify(modelInfo.error)}`)
      })
      return aiStream
    }
    if (
      modelInfo.provider?.type !== 'anthropic' &&
      (modelInfo.provider?.anthropicApiHost === undefined || modelInfo.provider.anthropicApiHost.trim() === '')
    ) {
      logger.error('Anthropic provider configuration is missing', {
        modelInfo
      })

      aiStream.emit('data', {
        type: 'error',
        error: new Error(`Invalid provider type '${modelInfo.provider?.type}'. Expected 'anthropic' provider type.`)
      })
      return aiStream
    }

    // 部分提供商无真实 API Key；SDK 仍要求非空占位，用 provider id 兜底
    if (!modelInfo.provider.apiKey) {
      modelInfo.provider.apiKey = modelInfo.provider.id
    }

    // --- 阶段 B：子进程环境变量（模型、密钥、BASE_URL、Electron 下 CLI 所需变量等）---

    const apiConfig = await apiConfigService.get()
    const loginShellEnv = await getLoginShellEnvironment()
    const loginShellEnvWithoutProxies = Object.fromEntries(
      Object.entries(loginShellEnv).filter(([key]) => !key.toLowerCase().endsWith('_proxy'))
    ) as Record<string, string>

    // Windows 下自动发现 Git Bash（内部会打日志）
    const customGitBashPath = isWin ? autoDiscoverGitBash() : null

    // SDK 会拼接 `${ANTHROPIC_BASE_URL}/v1/messages`，需去掉 host 上多余的 `/v1` 避免重复路径
    const anthropicBaseUrl = withoutTrailingApiVersion(
      modelInfo.provider.anthropicApiHost?.trim() || modelInfo.provider.apiHost
    )

    const env = {
      ...loginShellEnvWithoutProxies,
      // 禁用 Bedrock 分支，走标准 Anthropic 兼容 HTTP
      CLAUDE_CODE_USE_BEDROCK: '0',
      // TODO: fix the proxy api server
      // ANTHROPIC_API_KEY: apiConfig.apiKey,
      // ANTHROPIC_AUTH_TOKEN: apiConfig.apiKey,
      // ANTHROPIC_BASE_URL: `http://${apiConfig.host}:${apiConfig.port}/${modelInfo.provider.id}`,
      ANTHROPIC_API_KEY: modelInfo.provider.apiKey,
      ANTHROPIC_AUTH_TOKEN: modelInfo.provider.apiKey,
      ANTHROPIC_BASE_URL: anthropicBaseUrl,
      ANTHROPIC_MODEL: modelInfo.modelId,
      ANTHROPIC_DEFAULT_OPUS_MODEL: modelInfo.modelId,
      ANTHROPIC_DEFAULT_SONNET_MODEL: modelInfo.modelId,
      // TODO: support set small model in UI
      ANTHROPIC_DEFAULT_HAIKU_MODEL: modelInfo.modelId,
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      // 配置目录放到 userData，避免 Windows 用户主目录含中文等导致 SDK 路径编码问题
      CLAUDE_CONFIG_DIR: path.join(app.getPath('userData'), '.claude'),
      ENABLE_TOOL_SEARCH: 'auto',
      ...(customGitBashPath ? { CLAUDE_CODE_GIT_BASH_PATH: customGitBashPath } : {})
    }

    // 合并会话里用户自定义环境变量（屏蔽会覆盖关键安全/运行变量的键）
    const userEnvVars = session.configuration?.env_vars
    if (userEnvVars && typeof userEnvVars === 'object') {
      const BLOCKED_ENV_KEYS = new Set([
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ELECTRON_RUN_AS_NODE',
        'ELECTRON_NO_ATTACH_CONSOLE',
        'CLAUDE_CONFIG_DIR',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_GIT_BASH_PATH',
        'NODE_OPTIONS',
        '__PROTO__',
        'CONSTRUCTOR',
        'PROTOTYPE'
      ])
      for (const [key, value] of Object.entries(userEnvVars)) {
        const upperKey = key.toUpperCase()
        if (BLOCKED_ENV_KEYS.has(upperKey)) {
          logger.warn('Blocked user env var override for system-critical variable', { key })
        } else if (typeof value === 'string') {
          env[key] = value
        }
      }
    }

    const errorChunks: string[] = []

    // --- 阶段 C：工具白名单、本地插件路径（供 SDK Options.plugins）---

    const sessionAllowedTools = new Set<string>(session.allowed_tools ?? [])
    const autoAllowTools = new Set<string>([...DEFAULT_AUTO_ALLOW_TOOLS, ...sessionAllowedTools])
    const normalizeToolName = (name: string) => (name.startsWith('builtin_') ? name.slice('builtin_'.length) : name)

    let plugins: SdkPluginConfig[] | undefined
    try {
      const pluginPaths = await pluginService.listInstalledPluginPackagePaths(session.agent_id)
      if (pluginPaths.length > 0) {
        plugins = pluginPaths.map((pluginPath) => ({ type: 'local', path: pluginPath }))
      }
    } catch (error) {
      logger.warn('Failed to load plugin packages for Claude Code', {
        agentId: session.agent_id,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    // --- 阶段 D：canUseTool —— SDK 执行工具前的「闸门」（自动放行 / 弹窗 / 测试全放行）---

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      logger.info('Handling tool permission check', {
        toolName,
        suggestionCount: options.suggestions?.length ?? 0
      })

      if (shouldAutoApproveTools) {
        logger.debug('Auto-approving tool due to CHERRY_AUTO_ALLOW_TOOLS flag', { toolName })
        return { behavior: 'allow', updatedInput: input }
      }

      if (options.signal.aborted) {
        logger.debug('Permission request signal already aborted; denying tool', { toolName })
        return {
          behavior: 'deny',
          message: 'Tool request was cancelled before prompting the user'
        }
      }

      const normalizedToolName = normalizeToolName(toolName)
      if (autoAllowTools.has(toolName) || autoAllowTools.has(normalizedToolName)) {
        logger.debug('Auto-allowing tool from allowed list', {
          toolName,
          normalizedToolName
        })
        return { behavior: 'allow', updatedInput: input }
      }

      return promptForToolApproval(toolName, input, {
        ...options,
        toolCallId: buildNamespacedToolCallId(session.id, options.toolUseID)
      })
    }

    // --- 阶段 E：PreToolUse —— 补齐「未走 canUseTool 的自动放行」在前端的可见性（autoApprove）---

    const preToolUseHook: HookCallback = async (input, toolUseID, options) => {
      // 仅处理 PreToolUse；其它 hook 事件直接放行
      if (input.hook_event_name !== 'PreToolUse') {
        return {}
      }

      const hookInput = input
      const toolName = hookInput.tool_name

      logger.debug('PreToolUse hook triggered', {
        session_id: hookInput.session_id,
        tool_name: hookInput.tool_name,
        tool_use_id: toolUseID,
        tool_input: hookInput.tool_input,
        cwd: hookInput.cwd,
        permission_mode: hookInput.permission_mode,
        autoAllowTools: autoAllowTools
      })

      if (options?.signal?.aborted) {
        logger.debug('PreToolUse hook signal already aborted; skipping tool use', {
          tool_name: hookInput.tool_name
        })
        return {}
      }

      // 自动放行列表中的工具不会走 canUseTool，需在 PreToolUse 里同步通知前端（用于展示/审计）
      const normalizedToolName = normalizeToolName(toolName)
      if (toolUseID) {
        const bypassAll = input.permission_mode === 'bypassPermissions'
        const autoAllowed = autoAllowTools.has(toolName) || autoAllowTools.has(normalizedToolName)
        if (bypassAll || autoAllowed) {
          const namespacedToolCallId = buildNamespacedToolCallId(session.id, toolUseID)
          logger.debug('handling auto approved tools', {
            toolName,
            normalizedToolName,
            namespacedToolCallId,
            permission_mode: input.permission_mode,
            autoAllowTools
          })
          const isRecord = (v: unknown): v is Record<string, unknown> => {
            return !!v && typeof v === 'object' && !Array.isArray(v)
          }
          const toolInput = isRecord(input.tool_input) ? input.tool_input : {}

          await promptForToolApproval(toolName, toolInput, {
            ...options,
            toolCallId: namespacedToolCallId,
            autoApprove: true
          })
        }
      }

      return {}
    }

    // --- 阶段 F：Options 总装（含 MCP、多目录、resume、thinking）---

    const rtkRewriteHook: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') {
        return {}
      }

      // Only rewrite Bash tool commands
      if (input.tool_name !== 'Bash' && input.tool_name !== 'builtin_Bash') {
        return {}
      }

      const toolInput = input.tool_input as Record<string, unknown> | undefined
      const command = toolInput?.command
      if (typeof command !== 'string' || !command.trim()) {
        return {}
      }

      const rewritten = await rtkRewrite(command)
      if (!rewritten) {
        return {}
      }

      logger.info('rtk rewrote Bash command', { original: command, rewritten })

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { ...toolInput, command: rewritten }
        }
      }
    }

    // Build SDK options from parameters
    const options: Options = {
      abortController,
      cwd,
      env,
      // model: modelInfo.modelId,
      pathToClaudeCodeExecutable: this.claudeExecutablePath,
      stderr: (chunk: string) => {
        logger.warn('claude stderr', { chunk })
        errorChunks.push(chunk)
      },
      spawnClaudeCodeProcess: (spawnOptions) => {
        const child = fork(spawnOptions.args[0], spawnOptions.args.slice(1), {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          signal: spawnOptions.signal
        })
        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString()
          logger.warn('claude stderr', { chunk: text })
          errorChunks.push(text)
        })
        return child as unknown as SpawnedProcess
      },
      systemPrompt: session.instructions
        ? {
            type: 'preset',
            preset: 'claude_code',
            append: `${session.instructions}\n\n${getLanguageInstruction()}`
          }
        : {
            type: 'preset',
            preset: 'claude_code',
            append: getLanguageInstruction()
          },
      settingSources: ['project', 'local'],
      includePartialMessages: true,
      permissionMode: session.configuration?.permission_mode,
      maxTurns: session.configuration?.max_turns,
      allowedTools: session.allowed_tools,
      plugins,
      canUseTool,
      hooks: {
        PreToolUse: [
          {
            hooks: [rtkRewriteHook, preToolUseHook]
          }
        ]
      },
      ...(thinkingOptions?.effort ? { effort: thinkingOptions.effort } : {}),
      ...(thinkingOptions?.thinking ? { thinking: thinkingOptions.thinking } : {})
    }

    if (session.accessible_paths.length > 1) {
      options.additionalDirectories = session.accessible_paths.slice(1)
    }

    if (session.mcps && session.mcps.length > 0) {
      // 通过本机 API 服务将 MCP 以 HTTP 方式暴露给 SDK（带 Bearer）
      const mcpList: Record<string, McpHttpServerConfig> = {}
      for (const mcpId of session.mcps) {
        mcpList[mcpId] = {
          type: 'http',
          url: `http://${apiConfig.host}:${apiConfig.port}/v1/mcps/${mcpId}/mcp`,
          headers: {
            Authorization: `Bearer ${apiConfig.apiKey}`
          }
        }
      }
      options.mcpServers = mcpList
      options.strictMcpConfig = true
    }

    if (lastAgentSessionId && !NO_RESUME_COMMANDS.some((cmd) => prompt.includes(cmd))) {
      options.resume = lastAgentSessionId
      // TODO: use fork session when we support branching sessions
      // options.forkSession = true
    }

    logger.info('Starting Claude Code SDK query', {
      prompt,
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
      maxTurns: options.maxTurns,
      allowedTools: options.allowedTools,
      resume: options.resume
    })

    // 用户输入流：SDK 的 `query` 支持 AsyncIterable；当前实现先入队首条用户消息，结束时 close 流
    const { stream: userInputStream, close: closeUserStream } = this.createUserMessageStream(
      prompt,
      abortController.signal
    )

    // 下一事件循环再启动 query，保证调用方已订阅 `data`（见文件头「为何 setImmediate」）
    setImmediate(() => {
      this.processSDKQuery(
        userInputStream,
        closeUserStream,
        options,
        aiStream,
        errorChunks,
        session.agent_id,
        session.id
      ).catch((error) => {
        logger.error('Unhandled Claude Code stream error', {
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error)
        })
        aiStream.emit('data', {
          type: 'error',
          error: error instanceof Error ? error : new Error(String(error))
        })
      })
    })

    return aiStream
  }

  /**
   * 构造 SDK `query({ prompt })` 所需的异步可迭代「用户消息」来源。
   *
   * 实现要点：`async function*` 一边被 SDK pull，一边我们用 **队列 + 等待 Promise** 做生产者：
   * 有消息时若已有等待者则直接 resolve，否则入队；`null` 表示流结束。`abortSignal` 触发时等价于 close，
   * 避免 SDK 侧永远挂起在 `for await`。
   */
  private createUserMessageStream(initialPrompt: string, abortSignal: AbortSignal) {
    const queue: Array<UserInputMessage | null> = []
    /** 当队列空且迭代器在等下一条时，enqueue 会 resolve 这里的 Promise */
    const waiters: Array<(value: UserInputMessage | null) => void> = []
    let closed = false

    const flushWaiters = (value: UserInputMessage | null) => {
      const resolve = waiters.shift()
      if (resolve) {
        resolve(value)
        return true
      }
      return false
    }

    const enqueue = (value: UserInputMessage | null) => {
      if (closed) return
      if (value === null) {
        closed = true
      }
      if (!flushWaiters(value)) {
        queue.push(value)
      }
    }

    const close = () => {
      if (closed) return
      enqueue(null)
    }

    const onAbort = () => {
      close()
    }

    if (abortSignal.aborted) {
      close()
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    const iterator = (async function* () {
      try {
        while (true) {
          let value: UserInputMessage | null
          if (queue.length > 0) {
            value = queue.shift() ?? null
          } else if (closed) {
            break
          } else {
            // 队列空且未关闭：阻塞直到 enqueue 或 close（null）
            value = await new Promise<UserInputMessage | null>((resolve) => {
              waiters.push(resolve)
            })
          }

          if (value === null) {
            break
          }

          yield value
        }
      } finally {
        closed = true
        abortSignal.removeEventListener('abort', onAbort)
        while (waiters.length > 0) {
          const resolve = waiters.shift()
          resolve?.(null)
        }
      }
    })()

    enqueue({
      type: 'user',
      parent_tool_use_id: null,
      session_id: '',
      message: {
        role: 'user',
        content: initialPrompt
      }
    })

    return {
      stream: iterator,
      enqueue,
      close
    }
  }

  /**
   * 在后台跑完整次 `query()`：持续把 {@link SDKMessage} 转成 chunk 事件，并在收尾发 `complete` / `error` / `cancelled`。
   *
   * - `streamState`：每条消息转换时传入，用于跨 message 关联工具 id、流式分块等（见 `ClaudeStreamState`）。
   * - `closePromptStream`：在 `finish`/`error` 或 `finally` 调用，防止用户输入流悬挂。
   */
  private async processSDKQuery(
    promptStream: AsyncIterable<UserInputMessage>,
    closePromptStream: () => void,
    options: Options,
    stream: ClaudeCodeStream,
    errorChunks: string[],
    agentId: string,
    sessionId: string
  ): Promise<void> {
    const jsonOutput: SDKMessage[] = []
    let hasCompleted = false
    const startTime = Date.now()
    const streamState = new ClaudeStreamState({ agentSessionId: sessionId })

    try {
      // SDK 异步迭代器：每元素是一条结构化消息（assistant/user/stream_event/system/result 等）
      for await (const message of query({ prompt: promptStream, options })) {
        if (hasCompleted) break

        jsonOutput.push(message)

        // system/init：Cherry 侧维护「内置 + 会话本地」斜杠命令；SDK 启动时也会带一份，这里合并去重后写库，供 UI 展示
        if (message.type === 'system' && message.subtype === 'init') {
          const sdkSlashCommands = message.slash_commands || []
          logger.info('Received init message with slash commands', {
            sessionId,
            commands: sdkSlashCommands
          })

          try {
            const existingCommands = await sessionService.listSlashCommands('claude-code', agentId)

            // SDK 给的是 string[]，统一成以 `/` 开头的命令名
            const sdkCommands = sdkSlashCommands.map((cmd) => {
              const normalizedCmd = cmd.startsWith('/') ? cmd : `/${cmd}`
              return {
                command: normalizedCmd,
                description: undefined
              }
            })

            // 已有命令优先保留（含 description），SDK 仅补充 Cherry 侧没有的项
            const commandMap = new Map<string, { command: string; description?: string }>()

            for (const cmd of existingCommands) {
              commandMap.set(cmd.command, cmd)
            }

            for (const cmd of sdkCommands) {
              if (!commandMap.has(cmd.command)) {
                commandMap.set(cmd.command, cmd)
              }
            }

            const mergedCommands = Array.from(commandMap.values())

            await sessionService.updateSession(agentId, sessionId, {
              slash_commands: mergedCommands
            })

            logger.info('Updated session with merged slash commands', {
              sessionId,
              existingCount: existingCommands.length,
              sdkCount: sdkCommands.length,
              totalCount: mergedCommands.length
            })
          } catch (error) {
            logger.error('Failed to update session slash_commands', {
              sessionId,
              error: error instanceof Error ? error.message : String(error)
            })
          }
        }

        // 单条 SDK 消息 → 0~N 个 AiSDK 风格 chunk（文本增量、tool-call、finish-step、raw init 等）
        const chunks = transformSDKMessageToStreamParts(message, streamState)
        for (const chunk of chunks) {
          stream.emit('data', {
            type: 'chunk',
            chunk
          })

          // finish/error 时关闭用户输入流，避免悬挂
          if (chunk.type === 'finish' || chunk.type === 'error') {
            logger.info('Closing prompt stream as SDK signaled completion', {
              chunkType: chunk.type,
              reason: chunk.type === 'finish' ? 'finished' : 'error_occurred'
            })
            closePromptStream()
            logger.info('Prompt stream closed successfully')
          }
        }
      }

      const duration = Date.now() - startTime

      logger.debug('SDK query completed successfully', {
        duration,
        messageCount: jsonOutput.length
      })

      // for-await 正常结束：一轮 query 会话结束（不等同于模型「停止生成」，见 SDK 语义）
      stream.emit('data', {
        type: 'complete'
      })
    } catch (error) {
      if (hasCompleted) return
      hasCompleted = true

      const duration = Date.now() - startTime
      const errorObj = error as any
      const isAborted =
        errorObj?.name === 'AbortError' ||
        errorObj?.message?.includes('aborted') ||
        options.abortController?.signal.aborted

      // 用户取消或 AbortController：与真实 API 错误区分，UI 可单独展示「已取消」
      if (isAborted) {
        logger.info('SDK query aborted by client disconnect', { duration })
        stream.emit('data', {
          type: 'cancelled',
          error: new Error('Request aborted by client')
        })
        return
      }

      // 合并之前 stderr 回调里收集的片段，便于排查子进程输出
      errorChunks.push(errorObj instanceof Error ? errorObj.message : String(errorObj))
      const errorMessage = errorChunks.join('\n\n')
      logger.error('SDK query failed', {
        duration,
        error: errorObj instanceof Error ? { name: errorObj.name, message: errorObj.message } : String(errorObj),
        stderr: errorChunks
      })

      stream.emit('data', {
        type: 'error',
        error: new Error(errorMessage)
      })
    } finally {
      // 无论成功/失败/取消，都关闭用户输入流，释放等待中的迭代器
      closePromptStream()
    }
  }
}

export default ClaudeCodeService
