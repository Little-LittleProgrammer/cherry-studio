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
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import type {
  CanUseTool,
  HookCallback,
  McpHttpServerConfig,
  Options,
  SDKMessage,
  SdkPluginConfig,
  SDKUserMessage,
  SpawnedProcess
} from '@anthropic-ai/claude-agent-sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Base64ImageSource, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages'
import { loggerService } from '@logger'
import { config as apiConfigService } from '@main/apiServer/config'
import { validateModelId } from '@main/apiServer/utils'
import { isWin } from '@main/constant'
import AssistantServer from '@main/mcpServers/assistant'
import BrowserServer from '@main/mcpServers/browser/server'
import ClawServer from '@main/mcpServers/claw'
import { configManager } from '@main/services/ConfigManager'
import {
  getNodeProxyConfigFromEnvironment,
  getProxyEnvironment,
  getProxyProtocol
} from '@main/services/proxy/nodeProxy'
import { toAsarUnpackedPath } from '@main/utils'
import { autoDiscoverGitBash, getBinaryPath } from '@main/utils/process'
import { rtkRewrite } from '@main/utils/rtk'
import getLoginShellEnvironment from '@main/utils/shell-env'
import {
  CHANNEL_SECURITY_PROMPT,
  GLOBALLY_DISALLOWED_TOOLS,
  SOUL_MODE_DISALLOWED_TOOLS
} from '@shared/agents/claudecode/constants'
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
import { agentService } from '../AgentService'
import { isProvisioned, provisionBuiltinAgent } from '../builtin/BuiltinAgentProvisioner'
import { channelService } from '../ChannelService'
import { PromptBuilder } from '../cherryclaw/prompt'
import { sessionService } from '../SessionService'
import { buildNamespacedToolCallId } from './claude-stream-state'
import { promptForToolApproval } from './tool-permissions'
import { ClaudeStreamState, transformSDKMessageToStreamParts } from './transform'

const require_ = createRequire(import.meta.url)
const logger = loggerService.withContext('ClaudeCodeService')
const promptBuilder = new PromptBuilder()
const DEFAULT_AUTO_ALLOW_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const IMAGE_MAX_DIMENSION = 2000
const IMAGE_MAX_BYTES = 5 * 1024 * 1024 // 5MB API limit
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

type UserInputMessage = SDKUserMessage

/** 对渲染进程暴露的 EventEmitter 流，事件名为 `data`，载荷为 {@link AgentStreamEvent} */
class ClaudeCodeStream extends EventEmitter implements AgentStream {
  declare emit: (event: 'data', data: AgentStreamEvent) => boolean
  declare on: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
  declare once: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
  /** SDK session_id captured from the init message, used for resume. */
  sdkSessionId?: string
}

/** 实现 {@link AgentServiceInterface}，封装一次完整的 Claude Code 调用生命周期 */
class ClaudeCodeService implements AgentServiceInterface {
  private claudeExecutablePath: string
  private claudeProxyBootstrapPath: string

  constructor() {
    // Resolve Claude Code CLI robustly (works in dev and in asar)
    this.claudeExecutablePath = toAsarUnpackedPath(
      path.join(path.dirname(require_.resolve('@anthropic-ai/claude-agent-sdk')), 'cli.js')
    )
    this.claudeProxyBootstrapPath = toAsarUnpackedPath(path.join(app.getAppPath(), 'out', 'proxy', 'index.js'))
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
    thinkingOptions?: AgentThinkingOptions,
    images?: Array<{ data: string; media_type: string }>
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
    const provider = modelInfo.provider
    if (!provider) {
      aiStream.emit('data', {
        type: 'error',
        error: new Error('Provider not found for model')
      })
      return aiStream
    }

    const isAzureOpenAI = provider.type === 'azure-openai'
    const isAnthropicType = provider.type === 'anthropic'
    const hasAnthropicHost = provider.anthropicApiHost?.trim()

    if (!isAnthropicType && !isAzureOpenAI && !hasAnthropicHost) {
      logger.error('Anthropic provider configuration is missing', {
        modelInfo
      })

      aiStream.emit('data', {
        type: 'error',
        error: new Error(`Invalid provider type '${provider.type}'. Expected 'anthropic' provider type.`)
      })
      return aiStream
    }

    // Providers like Ollama and LM Studio don't require real API keys,
    // but the Claude Agent SDK needs a non-empty placeholder value
    if (!provider.apiKey) {
      provider.apiKey = provider.id
    }

    // --- 阶段 B：子进程环境变量（模型、密钥、BASE_URL、Electron 下 CLI 所需变量等）---

    const apiConfig = await apiConfigService.get()
    const loginShellEnv = await getLoginShellEnvironment()

    // Windows 下自动发现 Git Bash（内部会打日志）
    const customGitBashPath = isWin ? autoDiscoverGitBash() : null
    const bunPath = await getBinaryPath('bun')

    // Claude Agent SDK builds the final endpoint as `${ANTHROPIC_BASE_URL}/v1/messages`.
    // To avoid malformed URLs like `/v1/v1/messages`, we normalize the provider host
    // by stripping any trailing API version (e.g. `/v1`).
    // For Azure OpenAI providers, the Anthropic endpoint lives under /anthropic.
    const resolveAnthropicBaseUrl = (): string => {
      if (isAzureOpenAI) {
        const host = withoutTrailingApiVersion(provider.apiHost).replace(/\/openai$/, '')
        return `${host}/anthropic`
      }
      return withoutTrailingApiVersion(provider.anthropicApiHost?.trim() || provider.apiHost)
    }
    const anthropicBaseUrl = resolveAnthropicBaseUrl()

    const env = {
      ...loginShellEnv,
      ...getProxyEnvironment(process.env),
      // prevent claude agent sdk using bedrock api
      CLAUDE_CODE_USE_BEDROCK: '0',
      // TODO: fix the proxy api server
      // ANTHROPIC_API_KEY: apiConfig.apiKey,
      // ANTHROPIC_AUTH_TOKEN: apiConfig.apiKey,
      // ANTHROPIC_BASE_URL: `http://${apiConfig.host}:${apiConfig.port}/${modelInfo.provider.id}`,
      ANTHROPIC_API_KEY: provider.apiKey,
      ANTHROPIC_AUTH_TOKEN: provider.apiKey,
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
      CHERRY_STUDIO_BUN_PATH: bunPath,
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
        'CHERRY_STUDIO_NODE_PROXY_RULES',
        'CHERRY_STUDIO_NODE_PROXY_BYPASS_RULES',
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
      const pluginsDir = path.join(cwd, '.claude', 'plugins')
      const entries = await fs.promises.readdir(pluginsDir, { withFileTypes: true }).catch(() => [])
      const pluginPaths: string[] = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const manifestPath = path.join(pluginsDir, entry.name, '.claude-plugin', 'plugin.json')
        try {
          await fs.promises.access(manifestPath, fs.constants.R_OK)
          pluginPaths.push(path.join(pluginsDir, entry.name))
        } catch {
          // No manifest, skip
        }
      }
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

    // Soul Mode: read soul_enabled from agent-level configuration (not session)
    const agent = await agentService.getAgent(session.agent_id)
    const agentConfig = agent?.configuration
    const soulEnabled = agentConfig?.soul_enabled === true
    let soulSystemPrompt: string | undefined

    if (soulEnabled && cwd) {
      soulSystemPrompt = await promptBuilder.buildSystemPrompt(cwd, agentConfig)
      logger.info('Built Soul Mode system prompt', { cwd, promptLength: soulSystemPrompt.length })
    }

    // Inject channel security policy into system prompt when session is from an external channel
    const linkedChannel = await channelService.findBySessionId(session.id)
    const isChannelSession = !!linkedChannel
    const channelSecurityBlock = isChannelSession ? `\n\n${CHANNEL_SECURITY_PROMPT}` : ''

    // Built-in agent mode: check builtin_role in configuration
    const builtinRole = (session.configuration as Record<string, unknown> | undefined)?.builtin_role as
      | string
      | undefined
    const isAssistant = builtinRole === 'assistant'

    // Provision built-in agent workspace (copy skills/plugins to working directory)
    if (builtinRole && cwd && !isProvisioned(cwd)) {
      const agentConfig = await provisionBuiltinAgent(cwd, builtinRole)
      if (agentConfig?.instructions && !session.instructions) {
        session = { ...session, instructions: agentConfig.instructions }
      }
      logger.info('Provisioned builtin agent workspace', { builtinRole, cwd })
    }

    // Build lightweight environment snapshot for Cherry Assistant
    let assistantSystemPrompt: string | undefined
    if (isAssistant) {
      try {
        const context = await buildAssistantContext()
        assistantSystemPrompt = session.instructions ? `${session.instructions}\n\n${context}` : context
      } catch (err) {
        logger.warn('Failed to build assistant context', { error: err })
        assistantSystemPrompt = session.instructions
      }
    }

    // Build SDK options from session configuration
    const options: Options = {
      abortController,
      cwd,
      env,
      // model: modelInfo.modelId,
      pathToClaudeCodeExecutable: this.claudeExecutablePath,
      // 这个是用于生成和管理 Claude Code 子进程的函数。
      // 它会根据当前环境变量和代理配置，通过 Node.js 的 fork 方法启动一个新的进程，
      // 并设置好代理、环境变量、stderr 监听和错误记录等必要参数。
      spawnClaudeCodeProcess: (spawnOptions) => {
        const childEnv = { ...spawnOptions.env } as NodeJS.ProcessEnv
        let execArgv = process.execArgv

        // 检查并注入代理设置（如果有）
        const activeProxyConfig = getNodeProxyConfigFromEnvironment(childEnv)
        if (activeProxyConfig) {
          const proxyProtocol = getProxyProtocol(activeProxyConfig.proxyRules)

          logger.info('Injecting proxy into Claude Code child process', {
            proxyProtocol,
            proxyRules: activeProxyConfig.proxyRules,
            proxyBypassRules: activeProxyConfig.proxyBypassRules,
            proxyBootstrapPath: this.claudeProxyBootstrapPath
          })

          execArgv = [...process.execArgv, '--disable-warning=UNDICI-EHPA', '--require', this.claudeProxyBootstrapPath]
        }

        // 使用 fork 启动子进程，并配置参数
        const child = fork(spawnOptions.args[0], spawnOptions.args.slice(1), {
          cwd: spawnOptions.cwd,
          env: childEnv,
          execArgv,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          signal: spawnOptions.signal
        })

        // 捕获子进程的标准错误输出，记录到日志和错误信息数组
        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString()
          logger.warn('claude stderr', { chunk: text })
          errorChunks.push(text)
        })

        // 返回子进程对象（转为自定义类型）
        return child as unknown as SpawnedProcess
      },
      systemPrompt: assistantSystemPrompt
        ? assistantSystemPrompt
        : soulSystemPrompt
          ? `${soulSystemPrompt}${channelSecurityBlock}\n\n${getLanguageInstruction()}`
          : session.instructions
            ? {
                type: 'preset',
                preset: 'claude_code',
                append: `${session.instructions}${channelSecurityBlock}\n\n${getLanguageInstruction()}`
              }
            : {
                type: 'preset',
                preset: 'claude_code',
                append: `${channelSecurityBlock}\n\n${getLanguageInstruction()}`
              },
      // Built-in agents skip CLAUDE.md loading to save tokens
      settingSources: builtinRole ? [] : ['project', 'local'],
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
      disallowedTools: [
        ...GLOBALLY_DISALLOWED_TOOLS,
        ...(soulEnabled ? SOUL_MODE_DISALLOWED_TOOLS : []),
        // Cherry Assistant is a read-only guide; it should not ask users questions via tool
        ...(isAssistant ? ['AskUserQuestion'] : [])
      ],
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

    // Inject @cherry/browser MCP for all agents (replaces SDK built-in WebSearch/WebFetch)
    if (!options.mcpServers) options.mcpServers = {}
    const browserServer = new BrowserServer()
    options.mcpServers.browser = { type: 'sdk', name: '@cherry/browser', instance: browserServer.mcpServer }

    // Inject Exa MCP for structured web search (free tier, no API key required)
    options.mcpServers.exa = {
      type: 'http',
      url: 'https://mcp.exa.ai/mcp'
    }

    if (soulEnabled) {
      // Find the channel that owns this session (if any) for context-aware cron defaults
      const sourceChannelId = await this.resolveSourceChannel(session.agent_id, session.id)
      const clawServer = new ClawServer(session.agent_id, sourceChannelId)
      options.mcpServers.claw = { type: 'sdk', name: 'claw', instance: clawServer.mcpServer }

      // Ensure claw MCP tools are in allowed_tools whitelist
      if (Array.isArray(options.allowedTools) && options.allowedTools.length > 0) {
        if (!options.allowedTools.includes('mcp__claw__*')) {
          options.allowedTools = [...options.allowedTools, 'mcp__claw__*']
        }
      }

      logger.debug('Soul Mode: injected claw MCP server', {
        agentId: session.agent_id,
        totalMcpServers: Object.keys(options.mcpServers).length
      })
    }

    // Cherry Assistant: inject navigate + diagnose MCP server
    if (isAssistant) {
      const assistantServer = new AssistantServer()
      options.mcpServers.assistant = { type: 'sdk', name: 'assistant', instance: assistantServer.mcpServer }

      // Auto-approve assistant MCP tools
      if (Array.isArray(options.allowedTools) && options.allowedTools.length > 0) {
        if (!options.allowedTools.includes('mcp__assistant__*')) {
          options.allowedTools = [...options.allowedTools, 'mcp__assistant__*']
        }
      } else {
        // When allowed_tools is empty/undefined, set it so assistant MCP tools are auto-approved
        options.allowedTools = ['mcp__assistant__*']
      }

      logger.debug('Cherry Assistant: injected assistant MCP server', {
        agentId: session.agent_id,
        totalMcpServers: Object.keys(options.mcpServers).length
      })
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

    const { stream: userInputStream, close: closeUserStream } = await this.createUserMessageStream(
      prompt,
      abortController.signal,
      images
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

  private async resolveSourceChannel(agentId: string, sessionId: string): Promise<string | undefined> {
    try {
      const { channelService } = await import('../ChannelService')
      const channels = await channelService.listChannels({ agentId })
      return channels.find((ch) => ch.sessionId === sessionId)?.id
    } catch {
      return undefined
    }
  }

  private async createUserMessageStream(
    initialPrompt: string,
    abortSignal: AbortSignal,
    images?: Array<{ data: string; media_type: string }>
  ) {
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

    // Kick off image processing asynchronously; enqueue the first message once ready
    await this.buildMessageContent(initialPrompt, images).then((content) => {
      enqueue({
        type: 'user',
        parent_tool_use_id: null,
        session_id: '',
        message: {
          role: 'user',
          content
        }
      })
    })

    return {
      stream: iterator,
      enqueue,
      close
    }
  }

  private async buildMessageContent(
    prompt: string,
    images?: Array<{ data: string; media_type: string }>
  ): Promise<string | ContentBlockParam[]> {
    if (!images || images.length === 0) {
      return prompt
    }

    const blocks: ContentBlockParam[] = [{ type: 'text', text: prompt }]

    const resizedImages = await Promise.all(images.map((img) => this.resizeImageIfNeeded(img.data, img.media_type)))

    for (const resized of resizedImages) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: resized.media_type as Base64ImageSource['media_type'],
          data: resized.data
        }
      })
    }

    return blocks
  }

  /**
   * Resize base64 image if it exceeds the Claude API's dimension limit.
   * Uses sharp which handles JPEG/PNG/WebP/GIF/AVIF/TIFF.
   */
  private async resizeImageIfNeeded(
    base64Data: string,
    mediaType: string
  ): Promise<{ data: string; media_type: string }> {
    try {
      const { default: sharp } = await import('sharp')
      let buffer: Buffer = Buffer.from(base64Data, 'base64')
      const metadata = await sharp(buffer).metadata()

      let width = metadata.width ?? 0
      let height = metadata.height ?? 0

      const needsResize = width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION
      const needsShrink = buffer.length > IMAGE_MAX_BYTES
      const needsConvert = mediaType !== 'image/png'

      if (!needsResize && !needsShrink && !needsConvert) {
        return { data: base64Data, media_type: mediaType }
      }

      // Step 1: Resize if dimensions exceed limit
      if (needsResize) {
        const scale = Math.min(IMAGE_MAX_DIMENSION / width, IMAGE_MAX_DIMENSION / height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
        buffer = await sharp(buffer).resize(width, height, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
        logger.info('Resized oversized image for Claude API', {
          original: `${metadata.width}x${metadata.height}`,
          resized: `${width}x${height}`
        })
      } else if (needsConvert || needsShrink) {
        // Convert to PNG first (may reduce size for some formats)
        buffer = await sharp(buffer).png().toBuffer()
      }

      // Step 2: If still over 5MB, progressively scale down
      let attempt = 0
      while (buffer.length > IMAGE_MAX_BYTES && attempt < 5) {
        attempt++
        const shrinkFactor = 0.7
        width = Math.round(width * shrinkFactor)
        height = Math.round(height * shrinkFactor)
        buffer = await sharp(buffer).resize(width, height, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
        logger.info('Shrinking image to fit 5MB API limit', {
          attempt,
          size: `${(buffer.length / 1024 / 1024).toFixed(1)}MB`,
          dimensions: `${width}x${height}`
        })
      }

      if (buffer.length > IMAGE_MAX_BYTES) {
        logger.warn('Image still exceeds 5MB after shrinking, passing through', {
          size: `${(buffer.length / 1024 / 1024).toFixed(1)}MB`
        })
      }

      return {
        data: buffer.toString('base64'),
        media_type: 'image/png'
      }
    } catch (error) {
      logger.warn('Image resize failed, passing through as-is', {
        error: error instanceof Error ? error.message : String(error)
      })
      return { data: base64Data, media_type: mediaType }
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
          if (message.session_id) {
            stream.sdkSessionId = message.session_id
            logger.info('Captured SDK session_id from init message', {
              sdkSessionId: message.session_id,
              sessionId
            })
          }

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

/**
 * Build a lightweight environment snapshot (~200 tokens) for Cherry Assistant.
 * Injected into system prompt so the agent knows the user's setup immediately.
 */
async function buildAssistantContext(): Promise<string> {
  const appVersion = app.getVersion()
  const platform = `${os.platform()} ${os.release()}`
  const language = configManager.getLanguage()
  const theme = configManager.getTheme()
  const proxy = configManager.get<string>('proxy', '')

  // Provider summary (no apiKey exposed)
  const providers = configManager.get<Record<string, unknown>[]>('providers', [])
  const configuredProviders = providers
    .filter((p) => p.apiKey || p.enabled)
    .map((p) => `${p.name || p.id}(${(p.models as unknown[])?.length || 0} models)`)

  // MCP summary
  const mcpServers = configManager.get<Record<string, unknown>[]>('mcpServers', [])
  const activeMcp = mcpServers.filter((s) => s.isActive)

  // Network probe (parallel, 2s timeout each)
  const probeResults = await Promise.allSettled([
    probeHost('github.com'),
    probeHost('google.com'),
    probeHost('docs.cherry-ai.com')
  ])
  const networkLines = probeResults.map((r) => {
    const v = r.status === 'fulfilled' ? r.value : { host: '?', ok: false, ms: 0 }
    return `- ${v.host}: ${v.ok ? `reachable (${v.ms}ms)` : 'unreachable'}`
  })

  return [
    '## Current Environment',
    `- App: Cherry Studio v${appVersion}`,
    `- OS: ${platform}`,
    `- Language: ${language}, Theme: ${theme}`,
    proxy ? `- Proxy: ${proxy}` : '- Proxy: none',
    `- Providers (${configuredProviders.length}): ${configuredProviders.join(', ') || 'none configured'}`,
    `- MCP Servers: ${activeMcp.length} active / ${mcpServers.length} total`,
    '',
    '## Network',
    ...networkLines
  ].join('\n')
}

async function probeHost(host: string): Promise<{ host: string; ok: boolean; ms: number }> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    await fetch(`https://${host}`, { method: 'HEAD', signal: controller.signal })
    clearTimeout(timeout)
    return { host, ok: true, ms: Date.now() - start }
  } catch {
    return { host, ok: false, ms: Date.now() - start }
  }
}

export default ClaudeCodeService
