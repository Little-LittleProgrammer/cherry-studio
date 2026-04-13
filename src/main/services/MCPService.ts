import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'
import { getMCPServersFromRedux } from '@main/apiServer/utils/mcp'
import { createInMemoryMCPServer } from '@main/mcpServers/factory'
import { makeSureDirExists, removeEnvProxy } from '@main/utils'
import { findCommandInShellEnv, getBinaryName, getBinaryPath, isBinaryExists } from '@main/utils/process'
import getLoginShellEnvironment from '@main/utils/shell-env'
import { TraceMethod, withSpanFunc } from '@mcp-trace/trace-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions
} from '@modelcontextprotocol/sdk/client/streamableHttp'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpError, type Tool as SDKTool } from '@modelcontextprotocol/sdk/types'
// Import notification schemas from MCP SDK
import {
  CancelledNotificationSchema,
  type GetPromptResult,
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js'
import { nanoid } from '@reduxjs/toolkit'
import { HOME_CHERRY_DIR } from '@shared/config/constant'
import type { MCPProgressEvent } from '@shared/config/types'
import type { MCPServerLogEntry } from '@shared/config/types'
import { IpcChannel } from '@shared/IpcChannel'
import { buildFunctionCallToolName } from '@shared/mcp'
import { defaultAppHeaders } from '@shared/utils'
import { safeSerialize } from '@shared/utils/serialize'
import {
  BuiltinMCPServerNames,
  type GetResourceResponse,
  isBuiltinMCPServer,
  type MCPCallToolResponse,
  type MCPPrompt,
  type MCPResource,
  type MCPServer,
  type MCPTool,
  MCPToolInputSchema,
  MCPToolOutputSchema
} from '@types'
import { app, net } from 'electron'
import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'

import { CacheService } from './CacheService'
import DxtService from './DxtService'
import { CallBackServer } from './mcp/oauth/callback'
import { McpOAuthClientProvider } from './mcp/oauth/provider'
import { ServerLogBuffer } from './mcp/ServerLogBuffer'
import { windowService } from './WindowService'

// Generic type for caching wrapped functions
type CachedFunction<T extends unknown[], R> = (...args: T) => Promise<R>

type CallToolArgs = { server: MCPServer; name: string; args: any; callId?: string }

const logger = loggerService.withContext('MCPService')

/** Timeout for MCP server connection (transport init + client connect), in milliseconds. */
const MCP_CONNECTION_TIMEOUT_MS = 60_000

// Redact potentially sensitive fields in objects (headers, tokens, api keys)
function redactSensitive(input: any): any {
  const SENSITIVE_KEYS = ['authorization', 'Authorization', 'apiKey', 'api_key', 'apikey', 'token', 'access_token']
  const MAX_STRING = 300

  const redact = (val: any): any => {
    if (val == null) return val
    if (typeof val === 'string') {
      return val.length > MAX_STRING ? `${val.slice(0, MAX_STRING)}…<${val.length - MAX_STRING} more>` : val
    }
    if (Array.isArray(val)) return val.map((v) => redact(v))
    if (typeof val === 'object') {
      const out: Record<string, any> = {}
      for (const [k, v] of Object.entries(val)) {
        if (SENSITIVE_KEYS.includes(k)) {
          out[k] = '<redacted>'
        } else {
          out[k] = redact(v)
        }
      }
      return out
    }
    return val
  }

  return redact(input)
}

// Create a context-aware logger for a server
function getServerLogger(server: MCPServer, extra?: Record<string, any>) {
  const base = {
    serverName: server?.name,
    serverId: server?.id,
    baseUrl: server?.baseUrl,
    type: server?.type || (server?.command ? 'stdio' : server?.baseUrl ? 'http' : 'inmemory')
  }
  return loggerService.withContext('MCPService', { ...base, ...extra })
}

/**
 * Higher-order function to add caching capability to any async function
 * @param fn The original function to be wrapped with caching
 * @param getCacheKey Function to generate a cache key from the function arguments
 * @param ttl Time to live for the cache entry in milliseconds
 * @param logPrefix Prefix for log messages
 * @returns The wrapped function with caching capability
 */
function withCache<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
  getCacheKey: (...args: T) => string,
  ttl: number,
  logPrefix: string
): CachedFunction<T, R> {
  return async (...args: T): Promise<R> => {
    const cacheKey = getCacheKey(...args)

    if (CacheService.has(cacheKey)) {
      logger.debug(`${logPrefix} loaded from cache`, { cacheKey })
      const cachedData = CacheService.get<R>(cacheKey)
      if (cachedData) {
        return cachedData
      }
    }

    const start = Date.now()
    const result = await fn(...args)
    CacheService.set(cacheKey, result, ttl)
    logger.debug(`${logPrefix} cached`, { cacheKey, ttlMs: ttl, durationMs: Date.now() - start })
    return result
  }
}

class McpService {
  private clients: Map<string, Client> = new Map()
  private pendingClients: Map<string, Promise<Client>> = new Map()
  private dxtService = new DxtService()
  private activeToolCalls: Map<string, AbortController> = new Map()
  private serverLogs = new ServerLogBuffer(200)

  constructor() {
    this.initClient = this.initClient.bind(this)
    this.listTools = this.listTools.bind(this)
    this.callTool = this.callTool.bind(this)
    this.listPrompts = this.listPrompts.bind(this)
    this.getPrompt = this.getPrompt.bind(this)
    this.listResources = this.listResources.bind(this)
    this.getResource = this.getResource.bind(this)
    this.closeClient = this.closeClient.bind(this)
    this.removeServer = this.removeServer.bind(this)
    this.restartServer = this.restartServer.bind(this)
    this.stopServer = this.stopServer.bind(this)
    this.abortTool = this.abortTool.bind(this)
    this.cleanup = this.cleanup.bind(this)
    this.checkMcpConnectivity = this.checkMcpConnectivity.bind(this)
    this.getServerVersion = this.getServerVersion.bind(this)
    this.getServerLogs = this.getServerLogs.bind(this)
  }

  /**
   * List all tools from all active MCP servers (excluding hub).
   * Used by Hub server's tool registry.
   */
  public async listAllActiveServerTools(): Promise<MCPTool[]> {
    const servers = await getMCPServersFromRedux()
    const activeServers = servers.filter((server) => server.isActive)

    const results = await Promise.allSettled(
      activeServers.map(async (server) => {
        const tools = await this.listToolsImpl(server)
        const disabledTools = new Set(server.disabledTools ?? [])
        return disabledTools.size > 0 ? tools.filter((tool) => !disabledTools.has(tool.name)) : tools
      })
    )

    const allTools: MCPTool[] = []
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allTools.push(...result.value)
      } else {
        logger.error(
          `[listAllActiveServerTools] Failed to list tools from ${activeServers[index].name}:`,
          result.reason as Error
        )
      }
    })

    return allTools
  }

  /**
   * Call a tool by its full ID (serverId__toolName format).
   * Used by Hub server's runtime.
   */
  public async callToolById(toolId: string, params: unknown, callId?: string): Promise<MCPCallToolResponse> {
    const parts = toolId.split('__')
    if (parts.length < 2) {
      throw new Error(`Invalid tool ID format: ${toolId}`)
    }

    const serverId = parts[0]
    const toolName = parts.slice(1).join('__')

    const servers = await getMCPServersFromRedux()
    const server = servers.find((s) => s.id === serverId)

    if (!server) {
      throw new Error(`Server not found: ${serverId}`)
    }

    logger.debug(`[callToolById] Calling tool ${toolName} on server ${server.name}`)

    return this.callTool(null as unknown as Electron.IpcMainInvokeEvent, {
      server,
      name: toolName,
      args: params,
      callId
    })
  }

  private getServerKey(server: MCPServer): string {
    return JSON.stringify({
      baseUrl: server.baseUrl,
      command: server.command,
      args: Array.isArray(server.args) ? server.args : [],
      registryUrl: server.registryUrl,
      env: server.env,
      id: server.id
    })
  }

  private emitServerLog(server: MCPServer, entry: MCPServerLogEntry) {
    const serverKey = this.getServerKey(server)
    this.serverLogs.append(serverKey, entry)
    const mainWindow = windowService.getMainWindow()
    if (mainWindow) {
      mainWindow.webContents.send(IpcChannel.Mcp_ServerLog, { ...entry, serverId: server.id })
    }
  }

  public getServerLogs(_: Electron.IpcMainInvokeEvent, server: MCPServer): MCPServerLogEntry[] {
    return this.serverLogs.get(this.getServerKey(server))
  }

  /**
   * 初始化并返回给定 MCPServer 的 Client 实例。
   *
   * 此函数的主要作用是为指定的 server 配置初始化客户端连接，支持内存、本地进程以及 HTTP 等多种不同 transport。
   * 它还会确保同一配置的 server 只会对应一个活跃的客户端实例（通过缓存和 pending promise）。
   *
   * 详细步骤说明：
   * 1. 生成 serverKey，作为此 server 配置的全局唯一标识。
   * 2. 检查是否有正在初始化的 client（pendingClients），如果有，直接等待该 promise 返回，避免重复创建。
   * 3. 查看当前是否已存在并可用的 client（clients 缓存）。有则发起 ping 校验其可用性，ping 失败则废弃该 client。
   * 4. 准备 headers 工具函数，用于后续 HTTP 请求头拼接。
   * 5. 真正进入初始化流程，组装初始化 promise，期间：
   *    - 创建新的 Client 实例。
   *    - 复制 server.args，以便后面可能会有变更。
   *    - 配置 OAuth 的授权客户端 provider（McpOAuthClientProvider 实例）。
   *    - 核心：调用 initTransport() 决定并初始化本次 client 的通信方式（process/stdio、in-memory、HTTP 等）。
   *      - a. 若是内置 memory-server 且 server 名称特殊（nowledgeMem, flomo），则以 HTTP transport 连接（StreamableHTTPClientTransport）。
   *      - b. 若是内置 server（非 mcpAutoInstall），用内存 client+server 对，即 InMemoryTransport。
   *      - c. 已配置 baseUrl，根据 server.type 分别用 HTTP 长连接或 SSE 事件源等。
   *      - d. 若 server 提供命令行(command)，说明需要本地起进程（StdioClientTransport）。此时可能还要做 DXT 路径解析、npx/bun/uv 等特殊处理。
   *    - 若为进程型（command），会判断 npx、bun、uvx、uv 和注册表等细节：如优先寻找系统命令，找不到再回退到捆绑二进制，必要时改写启动参数与环境变量。
   *    - 最终，构建好合适的 transport 并返回。
   * 6. 客户端初次连接可能会遇到需要授权的情况（UnauthorizedError）。
   *    - 遇到时，会走 handleAuth() 方法，启动本地 OAuth 回调服务，等待用户完成授权后，用获得的 code 调用传参给 transport 完成授权，再自动重连。
   * 7. 连接时加 Promise.race 超时控制，确保连接时长有限，避免挂死。
   * 8. 连接建立后，写入客户端缓存、通知日志、挂载各类通知处理器，并清理老缓存（确保数据新鲜）。
   * 9. 若出错，记录 error 日志并携带脱敏后的详细信息，便于定位问题。
   * 10. 不论成功失败，最终都会移除 pendingClients 状态。
   *
   * 使用举例：
   * const client = await mcpService.initClient(myServer);
   */
  async initClient(server: MCPServer): Promise<Client> {
    // 1. 生成唯一 server key 用于识别不同 server 配置
    const serverKey = this.getServerKey(server)

    // 2. 检查是否正在初始化 client，避免重复请求
    const pendingClient = this.pendingClients.get(serverKey)
    if (pendingClient) {
      getServerLogger(server).silly('等待已有的 client 初始化完成')
      return pendingClient
    }

    // 3. 检查缓存 client 是否可用（通过 ping 验证）
    const existingClient = this.clients.get(serverKey)
    if (existingClient) {
      try {
        // 发送 ping 检查连接
        const pingResult = await existingClient.ping({ timeout: 1000 })
        getServerLogger(server).debug('ping 结果', { ok: !!pingResult })
        // ping 不通即删缓存，否者复用
        if (!pingResult) {
          this.clients.delete(serverKey)
        } else {
          return existingClient
        }
      } catch (error: any) {
        getServerLogger(server).error(`ping 检查 server 失败: ${server.name}`, error as Error)
        this.clients.delete(serverKey)
      }
    }

    // 4. 工具函数：合成 HTTP 请求头（基础头+server 配置头）
    const prepareHeaders = () => ({
      ...defaultAppHeaders(),
      ...server.headers
    })

    // 5. 用 promise 包装初始化流程，实际仅在必要时走一次
    const initPromise = (async () => {
      try {
        // 创建新的 RPC 客户端（与 MCP server 通信）
        const client = new Client({ name: 'Cherry Studio', version: app.getVersion() }, { capabilities: {} })

        // 防御性地克隆 server.args，后续可能变化
        let args = [...(server.args || [])]

        // 准备 OAuth 授权流程 provider（如需要登录认证）
        const authProvider = new McpOAuthClientProvider({
          serverUrlHash: crypto
            .createHash('md5')
            .update(server.baseUrl || '')
            .digest('hex')
        })

        /**
         * 具体初始化 transport 的函数。
         * 按 server 配置实际类型分支（内存、二进制进程、http/sse）。
         */
        const initTransport = async (): Promise<
          StdioClientTransport | SSEClientTransport | InMemoryTransport | StreamableHTTPClientTransport
        > => {
          // 内置 nowledgeMem 和 flomo 特殊处理走 HTTP
          if (
            isBuiltinMCPServer(server) &&
            (server.name === BuiltinMCPServerNames.nowledgeMem || server.name === BuiltinMCPServerNames.flomo)
          ) {
            const httpUrlMap: Record<string, string> = {
              [BuiltinMCPServerNames.nowledgeMem]: 'http://127.0.0.1:14242/mcp',
              [BuiltinMCPServerNames.flomo]: 'https://flomoapp.com/mcp'
            }
            const httpUrl = httpUrlMap[server.name]
            const options: StreamableHTTPClientTransportOptions = {
              fetch: async (url, init) => net.fetch(typeof url === 'string' ? url : url.toString(), init),
              requestInit: {
                headers: {
                  ...defaultAppHeaders(),
                  APP: 'Cherry Studio'
                }
              },
              authProvider
            }
            getServerLogger(server).debug(`使用 StreamableHTTPClientTransport 连接 ${server.name}`)
            return new StreamableHTTPClientTransport(new URL(httpUrl), options)
          }

          // 内存型 server（如 mcp 内置插件）
          if (isBuiltinMCPServer(server) && server.name !== BuiltinMCPServerNames.mcpAutoInstall) {
            getServerLogger(server).debug('使用 InMemoryTransport 内存通道')
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
            // 启动内存 server（支持插件能力）
            const inMemoryServer = createInMemoryMCPServer(server.name, args, server.env || {})
            try {
              await inMemoryServer.connect(serverTransport)
              getServerLogger(server).debug('内存 server 启动完成')
            } catch (error: any) {
              getServerLogger(server).error('启动内存 server 失败', error as Error)
              throw new Error(`启动内存 server 失败: ${error.message}`)
            }
            return clientTransport
          } else if (server.baseUrl) {
            // HTTP 直连型 server
            if (server.type === 'streamableHttp') {
              const options: StreamableHTTPClientTransportOptions = {
                fetch: async (url, init) => net.fetch(typeof url === 'string' ? url : url.toString(), init),
                requestInit: {
                  headers: prepareHeaders()
                },
                authProvider
              }
              getServerLogger(server).debug('StreamableHTTPClientTransport 配置', {
                options: redactSensitive(options)
              })
              return new StreamableHTTPClientTransport(new URL(server.baseUrl), options)
            } else if (server.type === 'sse') {
              const options: SSEClientTransportOptions = {
                eventSourceInit: {
                  fetch: async (url, init) => net.fetch(typeof url === 'string' ? url : url.toString(), init)
                },
                requestInit: {
                  headers: prepareHeaders()
                },
                authProvider
              }
              return new SSEClientTransport(new URL(server.baseUrl), options)
            } else {
              throw new Error('未知的 server.type')
            }
          } else if (server.command) {
            /**
             * 本地可执行命令型 server 启动逻辑
             * 可能采用 npx、bun、uvx、uv 或 manifest 配置等
             */
            let cmd = server.command

            // 确认 shell 环境变量（用于后续查找命令、拼接执行环境）
            const loginShellEnv = await getLoginShellEnvironment()

            // DXT 路径支持，优先尝试 manifest 中解析后的配置
            if (server.dxtPath) {
              const resolvedConfig = this.dxtService.getResolvedMcpConfig(server.dxtPath)
              if (resolvedConfig) {
                cmd = resolvedConfig.command
                args = resolvedConfig.args
                server.env = {
                  ...server.env,
                  ...resolvedConfig.env
                }
                getServerLogger(server).debug('使用 DXT 解析后的命令及参数', { command: cmd, args })
              } else {
                getServerLogger(server).warn('DXT config 解析失败，回退到 manifest 配置')
              }
            }

            // 特殊命令 npx 的处理（涉及 fallback 到 bun）
            if (server.command === 'npx') {
              const npxPath = await findCommandInShellEnv('npx', loginShellEnv)
              if (npxPath) {
                // 优先使用系统 npx
                cmd = npxPath
                getServerLogger(server).debug('使用本地 npx', { command: cmd })
              } else {
                // 没有 npx，尝试用捆绑的 bun
                getServerLogger(server).debug('系统未找到 npx，尝试 fallback 到 bun')
                if (await isBinaryExists('bun')) {
                  cmd = await getBinaryPath('bun')
                  getServerLogger(server).info('npx 不在 PATH，使用捆绑的 bun 作为 x', { command: cmd })
                  // bun x 需要前置参数
                  if (args && args.length > 0) {
                    if (!args.includes('-y')) args.unshift('-y')
                    if (!args.includes('x')) args.unshift('x')
                  }
                } else {
                  throw new Error('系统未装 npx 且未检测到 bun。安装 nodejs 或使用设置里的依赖安装器修复。')
                }
              }
              if (server.registryUrl) {
                server.env = {
                  ...server.env,
                  NPM_CONFIG_REGISTRY: server.registryUrl
                }
                // mcp-auto-install 特殊注册表文件
                if (server.name.includes('mcp-auto-install')) {
                  const binPath = await getBinaryPath()
                  makeSureDirExists(binPath)
                  server.env.MCP_REGISTRY_PATH = path.join(binPath, '..', 'config', 'mcp-registry.json')
                }
              }
            } else if (server.command === 'uvx' || server.command === 'uv') {
              // uvx/uv 命令的查找与回退
              const uvPath = await findCommandInShellEnv(server.command, loginShellEnv)
              if (uvPath) {
                cmd = uvPath
                getServerLogger(server).debug(`优先使用系统 ${server.command}`, { command: cmd })
              } else {
                getServerLogger(server).debug(`系统未找到 ${server.command}，尝试使用捆绑二进制`)
                if (await isBinaryExists(server.command)) {
                  cmd = await getBinaryPath(server.command)
                  getServerLogger(server).info(`PATH 中未找到，使用捆绑的 ${server.command}`, { command: cmd })
                } else {
                  throw new Error(
                    `${server.command} 未安装且无捆绑二进制。请安装 uv：https://github.com/astral-sh/uv 或用依赖管理器修复。`
                  )
                }
              }
              // registry 配置同步给 uv
              if (server.registryUrl) {
                server.env = {
                  ...server.env,
                  UV_DEFAULT_INDEX: server.registryUrl,
                  PIP_INDEX_URL: server.registryUrl
                }
              }
            }

            getServerLogger(server).debug('准备启动本地进程 server', { command: cmd, args })

            // bun 缺失 proxy 环境变量兼容，提前处理
            if (cmd.includes('bun')) {
              removeEnvProxy(loginShellEnv)
            }

            const transportOptions: StdioServerParameters = {
              command: cmd,
              args,
              env: { ...loginShellEnv, ...server.env },
              stderr: 'pipe' as const
            }

            // DXT 配置优先 cwd
            if (server.dxtPath) {
              transportOptions.cwd = server.dxtPath
              getServerLogger(server).debug('为 DXT server 指定 working directory', {
                cwd: server.dxtPath
              })
            }

            const stdioTransport = new StdioClientTransport(transportOptions)
            stdioTransport.stderr?.on('data', (data) => {
              const msg = data.toString()
              getServerLogger(server).debug('Stdio stderr', { data: msg })
              this.emitServerLog(server, {
                timestamp: Date.now(),
                level: 'stderr',
                message: msg.trim(),
                source: 'stdio'
              })
            })
            // stdout 为专用 JSON-RPC，未开放日志订阅
            return stdioTransport
          } else {
            throw new Error('必须提供 baseUrl 或 command 才能初始化 client')
          }
        }

        /**
         * 处理 OAuth 授权，需要本地开启回调 server，
         * 获取 code 后调用 transport 完成认证并重新连接。
         */
        const handleAuth = async (client: Client, transport: SSEClientTransport | StreamableHTTPClientTransport) => {
          getServerLogger(server).debug('OAuth 流程启动')
          const events = new EventEmitter()
          const callbackServer = new CallBackServer({
            port: authProvider.config.callbackPort,
            path: authProvider.config.callbackPath || '/oauth/callback',
            events
          })
          const timeoutId = setTimeout(() => {
            getServerLogger(server).warn('OAuth 超时，回收本地回调服务')
            void callbackServer.close()
          }, 300000) // 5 分钟超时
          try {
            // 等待 code
            const authCode = await callbackServer.waitForAuthCode()
            getServerLogger(server).debug('收到认证 code')
            // 完成 OAuth 流程
            await transport.finishAuth(authCode)
            getServerLogger(server).debug('OAuth 完成，重连')
            const newTransport = await initTransport()
            await client.connect(newTransport)
            getServerLogger(server).debug('认证后成功建立连接')
          } catch (oauthError) {
            getServerLogger(server).error('OAuth 认证失败', oauthError as Error)
            throw new Error(`OAuth 认证失败: ${oauthError instanceof Error ? oauthError.message : String(oauthError)}`)
          } finally {
            clearTimeout(timeoutId)
            void callbackServer.close()
          }
        }

        /**
         * 总流程控制，包括连接和异常处理，以及超时保护
         */
        try {
          // 包一层 timeout 连接
          const connectWithTimeout = async () => {
            const transport = await initTransport()
            try {
              await client.connect(transport)
            } catch (error: any) {
              // 检测是否需要授权
              if (
                error instanceof Error &&
                (error.name === 'UnauthorizedError' || error.message.includes('Unauthorized'))
              ) {
                logger.debug(`检测到 ${server.name} 需要认证，进入认证流程`)
                await handleAuth(client, transport as SSEClientTransport | StreamableHTTPClientTransport)
              } else {
                throw error
              }
            }
          }

          await Promise.race([
            connectWithTimeout(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`连接超时：${MCP_CONNECTION_TIMEOUT_MS / 1000}秒`)),
                MCP_CONNECTION_TIMEOUT_MS
              )
            )
          ])

          this.emitServerLog(server, {
            timestamp: Date.now(),
            level: 'info',
            message: 'server 已连接',
            source: 'client'
          })

          // 存入 client 缓存，下次如未失效直接复用
          this.clients.set(serverKey, client)

          // 挂载通知/推送处理回调
          this.setupNotificationHandlers(client, server)

          // 清理相关缓存，让 caller 总是能拿到最新 server 数据
          this.clearServerCache(serverKey)

          logger.debug(`server 激活完成: ${server.name}`)
          this.emitServerLog(server, {
            timestamp: Date.now(),
            level: 'info',
            message: 'server 已激活',
            source: 'client'
          })
          return client
        } catch (error) {
          getServerLogger(server).error(`server ${server.name} 激活异常`, error as Error)
          this.emitServerLog(server, {
            timestamp: Date.now(),
            level: 'error',
            message: `server 激活异常: ${(error as Error)?.message}`,
            data: redactSensitive(error),
            source: 'client'
          })
          throw error
        }
      } finally {
        // 不论成功失败都确保清理 pending 状态
        this.pendingClients.delete(serverKey)
      }
    })()

    // 标记当前已有正在初始化的 client promise，防重复
    this.pendingClients.set(serverKey, initPromise)

    // 返回 client（如果并发，后续直接 await pendingPromise）
    return initPromise
  }

  /**
   * Set up notification handlers for MCP client
   */
  private setupNotificationHandlers(client: Client, server: MCPServer) {
    const serverKey = this.getServerKey(server)

    try {
      // Set up tools list changed notification handler
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        logger.debug(`Tools list changed for server: ${server.name}`)
        // Clear tools cache
        CacheService.remove(`mcp:list_tool:${serverKey}`)
      })

      // Set up resources list changed notification handler
      client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        logger.debug(`Resources list changed for server: ${server.name}`)
        // Clear resources cache
        CacheService.remove(`mcp:list_resources:${serverKey}`)
      })

      // Set up prompts list changed notification handler
      client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        logger.debug(`Prompts list changed for server: ${server.name}`)
        // Clear prompts cache
        CacheService.remove(`mcp:list_prompts:${serverKey}`)
      })

      // Set up resource updated notification handler
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, async () => {
        logger.debug(`Resource updated for server: ${server.name}`)
        // Clear resource-specific caches
        this.clearResourceCaches(serverKey)
      })

      // Set up cancelled notification handler
      client.setNotificationHandler(CancelledNotificationSchema, async (notification) => {
        logger.debug(`Operation cancelled for server: ${server.name}`, notification.params)
      })

      // Set up logging message notification handler
      client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
        const data = notification.params?.data
        const message = safeSerialize(notification.params.data) ?? 'No data'
        logger.debug(`Message from server ${server.name}: ${message}`)
        if (data) {
          this.emitServerLog(server, {
            timestamp: Date.now(),
            // FIXME: as MCPServerLogEntry['level'] not type safe
            level: (notification.params?.level as MCPServerLogEntry['level']) || 'info',
            message,
            data: redactSensitive(notification.params?.data),
            source: notification.params?.logger || 'server'
          })
        }
      })

      getServerLogger(server).debug(`Set up notification handlers`)
    } catch (error) {
      getServerLogger(server).error(`Failed to set up notification handlers`, error as Error)
    }
  }

  /**
   * Clear resource-specific caches for a server
   */
  private clearResourceCaches(serverKey: string) {
    CacheService.remove(`mcp:list_resources:${serverKey}`)
  }

  /**
   * Clear all caches for a specific server
   */
  private clearServerCache(serverKey: string) {
    CacheService.remove(`mcp:list_tool:${serverKey}`)
    CacheService.remove(`mcp:list_prompts:${serverKey}`)
    CacheService.remove(`mcp:list_resources:${serverKey}`)
    logger.debug(`Cleared all caches for server`, { serverKey })
  }

  async closeClient(serverKey: string) {
    const client = this.clients.get(serverKey)
    if (client) {
      // Remove the client from the cache
      await client.close()
      logger.debug(`Closed server`, { serverKey })
      this.clients.delete(serverKey)
      // Clear all caches for this server
      this.clearServerCache(serverKey)
      this.serverLogs.remove(serverKey)
    } else {
      logger.warn(`No client found for server`, { serverKey })
    }
  }

  async stopServer(_: Electron.IpcMainInvokeEvent, server: MCPServer) {
    const serverKey = this.getServerKey(server)
    getServerLogger(server).debug(`Stopping server`)
    this.emitServerLog(server, {
      timestamp: Date.now(),
      level: 'info',
      message: 'Stopping server',
      source: 'client'
    })
    await this.closeClient(serverKey)
  }

  async removeServer(_: Electron.IpcMainInvokeEvent, server: MCPServer) {
    const serverKey = this.getServerKey(server)
    const existingClient = this.clients.get(serverKey)
    if (existingClient) {
      await this.closeClient(serverKey)
    }

    // If this is a DXT server, cleanup its directory
    if (server.dxtPath) {
      try {
        const cleaned = this.dxtService.cleanupDxtServer(server.name)
        if (cleaned) {
          getServerLogger(server).debug(`Cleaned up DXT server directory`)
        }
      } catch (error) {
        getServerLogger(server).error(`Failed to cleanup DXT server`, error as Error)
      }
    }
  }

  async restartServer(_: Electron.IpcMainInvokeEvent, server: MCPServer) {
    getServerLogger(server).debug(`Restarting server`)
    const serverKey = this.getServerKey(server)
    this.emitServerLog(server, {
      timestamp: Date.now(),
      level: 'info',
      message: 'Restarting server',
      source: 'client'
    })
    await this.closeClient(serverKey)
    // Clear cache before restarting to ensure fresh data
    this.clearServerCache(serverKey)
    await this.initClient(server)
  }

  async cleanup() {
    for (const [key] of this.clients) {
      try {
        await this.closeClient(key)
      } catch (error: any) {
        logger.error(`Failed to close client`, error as Error)
      }
    }
  }

  /**
   * Check connectivity for an MCP server
   */
  public async checkMcpConnectivity(_: Electron.IpcMainInvokeEvent, server: MCPServer): Promise<boolean> {
    getServerLogger(server).debug(`Checking connectivity`)
    try {
      getServerLogger(server).debug(`About to call initClient`, { hasInitClient: !!this.initClient })

      if (!this.initClient) {
        throw new Error('initClient method is not available')
      }

      const client = await this.initClient(server)
      // Attempt to list tools as a way to check connectivity
      await client.listTools()
      getServerLogger(server).debug(`Connectivity check successful`)
      this.emitServerLog(server, {
        timestamp: Date.now(),
        level: 'info',
        message: 'Connectivity check successful',
        source: 'connectivity'
      })
      return true
    } catch (error) {
      getServerLogger(server).error(`Connectivity check failed`, error as Error)
      this.emitServerLog(server, {
        timestamp: Date.now(),
        level: 'error',
        message: `Connectivity check failed: ${(error as Error).message}`,
        data: redactSensitive(error),
        source: 'connectivity'
      })
      // Close the client if connectivity check fails to ensure a clean state for the next attempt
      const serverKey = this.getServerKey(server)
      await this.closeClient(serverKey)
      return false
    }
  }

  private async listToolsImpl(server: MCPServer): Promise<MCPTool[]> {
    const client = await this.initClient(server)
    try {
      const { tools } = await client.listTools()
      const serverTools: MCPTool[] = []
      tools.map((tool: SDKTool) => {
        const serverTool: MCPTool = {
          ...tool,
          inputSchema: MCPToolInputSchema.parse(tool.inputSchema),
          outputSchema: tool.outputSchema ? MCPToolOutputSchema.parse(tool.outputSchema) : undefined,
          id: buildFunctionCallToolName(server.name, tool.name),
          serverId: server.id,
          serverName: server.name,
          type: 'mcp'
        }
        serverTools.push(serverTool)
        getServerLogger(server).debug(`Listing tools`, { tool: serverTool })
      })
      return serverTools
    } catch (error: unknown) {
      getServerLogger(server).error(`Failed to list tools`, error as Error)
      throw error
    }
  }

  async listTools(_: Electron.IpcMainInvokeEvent, server: MCPServer) {
    const listFunc = (server: MCPServer) => {
      const cachedListTools = withCache<[MCPServer], MCPTool[]>(
        this.listToolsImpl.bind(this),
        (server) => {
          const serverKey = this.getServerKey(server)
          return `mcp:list_tool:${serverKey}`
        },
        5 * 60 * 1000, // 5 minutes TTL
        `[MCP] Tools from ${server.name}`
      )

      const result = cachedListTools(server)
      return result
    }

    return withSpanFunc(`${server.name}.ListTool`, 'MCP', listFunc, [server])
  }

  /**
   * 调用 MCP 服务器上的工具（详细解释版）
   *
   * 该方法用于在指定的 MCP 服务器上调用一个工具。它处理了参数预处理、进度跟踪、超时、异常日志和清理等操作，保证调用过程既健壮又有详细日志。
   *
   * @param _ - Electron 的 IPC 事件，占位参数，这里未使用
   * @param param1 - 调用参数，包括 server（服务器信息）、name（工具名）、args（工具参数）、callId（调用ID，可选）
   * @returns Promise<MCPCallToolResponse> 工具调用的响应结果
   */
  public async callTool(
    _: Electron.IpcMainInvokeEvent,
    { server, name, args, callId }: CallToolArgs
  ): Promise<MCPCallToolResponse> {
    // 1. 确定本次调用的唯一 callId，如果没有传入则用 uuid 自动生成
    const toolCallId = callId || uuidv4()

    // 2. 为本次调用创建一个 AbortController，实现取消的能力，并注册到 activeToolCalls
    const abortController = new AbortController()
    this.activeToolCalls.set(toolCallId, abortController)

    // 3. 定义实际的工具调用逻辑的函数
    const callToolFunc = async ({ server, name, args }: CallToolArgs) => {
      try {
        // a. 记录调试日志，展示调用信息，对敏感数据做脱敏
        getServerLogger(server, { tool: name, callId: toolCallId }).debug('Calling tool', {
          args: redactSensitive(args)
        })

        // b. 参数解析：
        // 如果参数 args 是字符串，则尝试将其解析为对象。如果解析失败，记录解析错误日志。
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args)
          } catch (e) {
            getServerLogger(server, { tool: name, callId: toolCallId }).error('args parse error', e as Error, {
              args
            })
          }
          // 空字符串处理，转为 {}
          if (args === '') {
            args = {}
          }
        }

        // c. 初始化 MCP 客户端（如未初始化会自动连接）
        const client = await this.initClient(server)

        // d. 调用 MCP 工具的实际方法
        const result = await client.callTool({ name, arguments: args }, undefined, {
          // e. 进度回调
          onprogress: (process) => {
            const ratio = process.progress / (process.total || 1)
            getServerLogger(server, { tool: name, callId: toolCallId }).debug('Progress', { ratio })

            // 推送进度信息到前端窗口
            const mainWindow = windowService.getMainWindow()
            if (mainWindow) {
              mainWindow.webContents.send(IpcChannel.Mcp_Progress, {
                callId: toolCallId,
                progress: ratio
              } as MCPProgressEvent)
            }
          },
          // f. 超时相关配置
          timeout: server.timeout ? server.timeout * 1000 : 60000, // 单次调用超时时间（默认1分钟）
          // 详细说明：
          // - 该超时需要服务端与客户端都支持才能生效
          // - Lifecyle详见：https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#timeouts
          resetTimeoutOnProgress: server.longRunning, // 支持长时间运行的任务在进度有变化时重置超时
          maxTotalTimeout: server.longRunning ? 10 * 60 * 1000 : undefined, // 长任务最大 10 分钟
          signal: this.activeToolCalls.get(toolCallId)?.signal // 关联的信号用于支持取消
        })

        // g. 返回调用结果
        return result as MCPCallToolResponse
      } catch (error) {
        // h. 错误处理和日志
        getServerLogger(server, { tool: name, callId: toolCallId }).error('Error calling tool', error as Error)
        throw error
      } finally {
        // i. 调用完成（无论成功/失败），清理本次调用的中止控制器，防止泄漏
        this.activeToolCalls.delete(toolCallId)
      }
    }

    // 4. 封装到链路跟踪（withSpanFunc），实现性能与调用链追踪，方便观察、排查
    return await withSpanFunc(`${server.name}.${name}`, 'MCP', callToolFunc, [{ server, name, args }])
  }

  public async getInstallInfo() {
    const dir = path.join(os.homedir(), HOME_CHERRY_DIR, 'bin')
    const uvName = await getBinaryName('uv')
    const bunName = await getBinaryName('bun')
    const uvPath = path.join(dir, uvName)
    const bunPath = path.join(dir, bunName)
    return { dir, uvPath, bunPath }
  }

  /**
   * List prompts available on an MCP server
   */
  private async listPromptsImpl(server: MCPServer): Promise<MCPPrompt[]> {
    const client = await this.initClient(server)
    getServerLogger(server).debug(`Listing prompts`)
    try {
      const { prompts } = await client.listPrompts()
      return prompts.map((prompt: any) => ({
        ...prompt,
        id: `p${nanoid()}`,
        serverId: server.id,
        serverName: server.name
      }))
    } catch (error: unknown) {
      // -32601 is the code for the method not found
      if (error instanceof McpError && error.code !== -32601) {
        getServerLogger(server).error(`Failed to list prompts`, error as Error)
      }
      return []
    }
  }

  /**
   * List prompts available on an MCP server with caching
   */
  public async listPrompts(_: Electron.IpcMainInvokeEvent, server: MCPServer): Promise<MCPPrompt[]> {
    const cachedListPrompts = withCache<[MCPServer], MCPPrompt[]>(
      this.listPromptsImpl.bind(this),
      (server) => {
        const serverKey = this.getServerKey(server)
        return `mcp:list_prompts:${serverKey}`
      },
      60 * 60 * 1000, // 60 minutes TTL
      `[MCP] Prompts from ${server.name}`
    )
    return cachedListPrompts(server)
  }

  /**
   * Get a specific prompt from an MCP server (implementation)
   */
  private async getPromptImpl(server: MCPServer, name: string, args?: Record<string, any>): Promise<GetPromptResult> {
    logger.debug(`Getting prompt ${name} from server: ${server.name}`)
    const client = await this.initClient(server)
    return await client.getPrompt({ name, arguments: args })
  }

  /**
   * Get a specific prompt from an MCP server with caching
   */
  @TraceMethod({ spanName: 'getPrompt', tag: 'mcp' })
  public async getPrompt(
    _: Electron.IpcMainInvokeEvent,
    { server, name, args }: { server: MCPServer; name: string; args?: Record<string, any> }
  ): Promise<GetPromptResult> {
    const cachedGetPrompt = withCache<[MCPServer, string, Record<string, any> | undefined], GetPromptResult>(
      this.getPromptImpl.bind(this),
      (server, name, args) => {
        const serverKey = this.getServerKey(server)
        const argsKey = args ? JSON.stringify(args) : 'no-args'
        return `mcp:get_prompt:${serverKey}:${name}:${argsKey}`
      },
      30 * 60 * 1000, // 30 minutes TTL
      `[MCP] Prompt ${name} from ${server.name}`
    )
    return await cachedGetPrompt(server, name, args)
  }

  /**
   * List resources available on an MCP server (implementation)
   */
  private async listResourcesImpl(server: MCPServer): Promise<MCPResource[]> {
    const client = await this.initClient(server)
    logger.debug(`Listing resources for server: ${server.name}`)
    try {
      const result = await client.listResources()
      const resources = result.resources || []
      return (Array.isArray(resources) ? resources : []).map((resource: any) => ({
        ...resource,
        serverId: server.id,
        serverName: server.name
      }))
    } catch (error: any) {
      // -32601 is the code for the method not found
      if (error?.code !== -32601) {
        getServerLogger(server).error(`Failed to list resources`, error as Error)
      }
      return []
    }
  }

  /**
   * List resources available on an MCP server with caching
   */
  public async listResources(_: Electron.IpcMainInvokeEvent, server: MCPServer): Promise<MCPResource[]> {
    const cachedListResources = withCache<[MCPServer], MCPResource[]>(
      this.listResourcesImpl.bind(this),
      (server) => {
        const serverKey = this.getServerKey(server)
        return `mcp:list_resources:${serverKey}`
      },
      60 * 60 * 1000, // 60 minutes TTL
      `[MCP] Resources from ${server.name}`
    )
    return cachedListResources(server)
  }

  /**
   * Get a specific resource from an MCP server (implementation)
   */
  private async getResourceImpl(server: MCPServer, uri: string): Promise<GetResourceResponse> {
    getServerLogger(server, { uri }).debug(`Getting resource`)
    const client = await this.initClient(server)
    try {
      const result = await client.readResource({ uri: uri })
      const contents: MCPResource[] = []
      if (result.contents && result.contents.length > 0) {
        result.contents.forEach((content: any) => {
          contents.push({
            ...content,
            serverId: server.id,
            serverName: server.name
          })
        })
      }
      return {
        contents: contents
      }
    } catch (error: any) {
      getServerLogger(server, { uri }).error(`Failed to get resource`, error as Error)
      throw new Error(`Failed to get resource ${uri} from server: ${server.name}: ${error.message}`)
    }
  }

  /**
   * Get a specific resource from an MCP server with caching
   */
  @TraceMethod({ spanName: 'getResource', tag: 'mcp' })
  public async getResource(
    _: Electron.IpcMainInvokeEvent,
    { server, uri }: { server: MCPServer; uri: string }
  ): Promise<GetResourceResponse> {
    const cachedGetResource = withCache<[MCPServer, string], GetResourceResponse>(
      this.getResourceImpl.bind(this),
      (server, uri) => {
        const serverKey = this.getServerKey(server)
        return `mcp:get_resource:${serverKey}:${uri}`
      },
      30 * 60 * 1000, // 30 minutes TTL
      `[MCP] Resource ${uri} from ${server.name}`
    )
    return await cachedGetResource(server, uri)
  }

  // 实现 abortTool 方法
  public async abortTool(_: Electron.IpcMainInvokeEvent, callId: string) {
    const activeToolCall = this.activeToolCalls.get(callId)
    if (activeToolCall) {
      activeToolCall.abort()
      this.activeToolCalls.delete(callId)
      logger.debug(`Aborted tool call`, { callId })
      return true
    } else {
      logger.warn(`No active tool call found for callId`, { callId })
      return false
    }
  }

  /**
   * Get the server version information
   */
  public async getServerVersion(_: Electron.IpcMainInvokeEvent, server: MCPServer): Promise<string | null> {
    try {
      getServerLogger(server).debug(`Getting server version`)
      const client = await this.initClient(server)

      // Try to get server information which may include version
      const serverInfo = client.getServerVersion()
      getServerLogger(server).debug(`Server info`, redactSensitive(serverInfo))

      if (serverInfo && serverInfo.version) {
        getServerLogger(server).debug(`Server version`, { version: serverInfo.version })
        return serverInfo.version
      }

      getServerLogger(server).warn(`No version information available`)
      return null
    } catch (error: any) {
      getServerLogger(server).error(`Failed to get server version`, error as Error)
      return null
    }
  }
}

export default new McpService()
