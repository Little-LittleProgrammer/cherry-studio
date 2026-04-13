import crypto from 'node:crypto'
import { Worker } from 'node:worker_threads'

import { loggerService } from '@logger'

import { abortMcpTool, callMcpTool } from './mcp-bridge'
import type {
  ExecOutput,
  HubWorkerCallToolMessage,
  HubWorkerExecMessage,
  HubWorkerMessage,
  HubWorkerResultMessage
} from './types'
import { hubWorkerSource } from './worker'

const logger = loggerService.withContext('MCPServer:Hub:Runtime')

const MAX_LOGS = 1000
const EXECUTION_TIMEOUT = 60000

// 如何执行其他的 mcp 的 —— 主要是通过 callMcpTool 函数来调用其他 mcp 工具。
// 下面是一个简化注释说明的版本，并在代码关键位置详细注释了“如何执行其他的 mcp 的”：

export class Runtime {
  /**
   * 执行一段用户代码，并在运行过程中支持调用其他 mcp 工具。
   * @param code 需要执行的代码
   */
  async execute(code: string): Promise<ExecOutput> {
    return await new Promise<ExecOutput>((resolve) => {
      const logs: string[] = []
      // 用于跟踪活跃的 mcp 工具调用
      const activeCallIds = new Map<string, string>()
      let finished = false
      let timedOut = false
      let timeoutId: NodeJS.Timeout | null = null

      // 在 Worker 线程中执行用户代码
      const worker = new Worker(hubWorkerSource, { eval: true })

      // 日志记录
      const addLog = (entry: string) => {
        if (logs.length >= MAX_LOGS) return
        logs.push(entry)
      }

      // 执行完成后收尾，包括终止 worker
      const finalize = async (output: ExecOutput, terminateWorker = true) => {
        if (finished) return
        finished = true
        if (timeoutId) clearTimeout(timeoutId)
        worker.removeAllListeners()
        if (terminateWorker) {
          try {
            await worker.terminate()
          } catch (error) {
            logger.warn('Failed to terminate exec worker', error as Error)
          }
        }
        resolve(output)
      }

      // 取消所有正在进行的 mcp 工具调用（用于超时或异常情况）
      const abortActiveTools = async () => {
        const callIds = Array.from(activeCallIds.values())
        activeCallIds.clear()
        if (callIds.length === 0) return
        await Promise.allSettled(callIds.map((callId) => abortMcpTool(callId)))
      }

      /**
       * 关键部分：如何执行其他的 mcp 的
       * 处理 worker 线程中发出的 callTool 请求，通过 callMcpTool 去调用其他 mcp 服务
       */
      const handleToolCall = async (message: HubWorkerCallToolMessage) => {
        if (finished || timedOut) return
        const callId = crypto.randomUUID()
        activeCallIds.set(message.requestId, callId)

        try {
          // 执行 mcp 的调用
          // 这是“如何执行其他的 mcp 的”——通过 callMcpTool
          const result = await callMcpTool(message.name, message.params, callId)
          if (finished || timedOut) return
          // 返回执行结果给 worker
          worker.postMessage({ type: 'toolResult', requestId: message.requestId, result })
        } catch (error) {
          if (finished || timedOut) return
          const errorMessage = error instanceof Error ? error.message : String(error)
          worker.postMessage({ type: 'toolError', requestId: message.requestId, error: errorMessage })
        } finally {
          activeCallIds.delete(message.requestId)
        }
      }

      // 处理 worker 返回的最终结果
      const handleResult = (message: HubWorkerResultMessage) => {
        const resolvedLogs = message.logs && message.logs.length > 0 ? message.logs : logs
        void finalize({
          result: message.result,
          logs: resolvedLogs.length > 0 ? resolvedLogs : undefined
        })
      }

      // 处理 worker 返回的错误
      const handleError = (errorMessage: string, messageLogs?: string[], terminateWorker = true) => {
        const resolvedLogs = messageLogs && messageLogs.length > 0 ? messageLogs : logs
        void finalize(
          {
            result: undefined,
            logs: resolvedLogs.length > 0 ? resolvedLogs : undefined,
            error: errorMessage,
            isError: true
          },
          terminateWorker
        )
      }

      // 处理来自 worker 的所有消息，包括日志、调用工具、结果、错误等
      const handleMessage = (message: HubWorkerMessage) => {
        if (!message || typeof message !== 'object') return
        switch (message.type) {
          case 'log':
            addLog(message.entry)
            break
          case 'callTool':
            // 调用其他的 mcp 的，整个链路是：worker -> handleToolCall -> callMcpTool
            void handleToolCall(message)
            break
          case 'result':
            handleResult(message)
            break
          case 'error':
            handleError(message.error, message.logs)
            break
          default:
            break
        }
      }

      // 超时逻辑，超时后终止执行并取消所有活跃的 mcp 工具调用
      timeoutId = setTimeout(() => {
        timedOut = true
        void (async () => {
          await abortActiveTools()
          try {
            await worker.terminate()
          } catch (error) {
            logger.warn('Failed to terminate exec worker after timeout', error as Error)
          }
          handleError(`Execution timed out after ${EXECUTION_TIMEOUT}ms`, undefined, false)
        })()
      }, EXECUTION_TIMEOUT)

      worker.on('message', handleMessage)
      worker.on('error', (error) => {
        logger.error('Worker execution error', error)
        handleError(error instanceof Error ? error.message : String(error))
      })
      worker.on('exit', (code) => {
        if (finished || timedOut) return
        const message = code === 0 ? 'Exec worker exited unexpectedly' : `Exec worker exited with code ${code}`
        logger.error(message)
        handleError(message, undefined, false)
      })

      // 启动代码执行
      const execMessage: HubWorkerExecMessage = {
        type: 'exec',
        code
      }
      worker.postMessage(execMessage)
    })
  }
}
