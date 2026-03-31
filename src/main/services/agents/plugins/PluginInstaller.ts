/**
 * Agent 工作区内插件文件的**磁盘级**安装/卸载：单文件（agent/command）与技能目录。
 * 使用「先备份再写入、失败则回滚」模式，减轻 Windows 同步盘等场景下的 EPERM 问题。
 * 上层业务逻辑与缓存同步由 {@link PluginService} 负责。
 */
import { loggerService } from '@logger'
import { pathExists } from '@main/utils/file'
import { copyDirectoryRecursive, deleteDirectoryRecursive } from '@main/utils/fileOperations'
import type { PluginError } from '@types'
import * as crypto from 'crypto'
import * as fs from 'fs'

const logger = loggerService.withContext('PluginInstaller')

/** 封装 copy/rename/unlink 等原子性安装语义，抛出统一的 {@link PluginError} */
export class PluginInstaller {
  async installFilePlugin(agentId: string, sourceAbsolutePath: string, destPath: string): Promise<void> {
    await this.installWithBackup({
      destPath,
      copy: () => fs.promises.copyFile(sourceAbsolutePath, destPath),
      cleanup: (p, l) => this.safeUnlink(p, l),
      operation: 'install',
      label: 'plugin file',
      agentId
    })
  }

  async uninstallFilePlugin(
    agentId: string,
    filename: string,
    type: 'agent' | 'command',
    filePath: string
  ): Promise<void> {
    try {
      await fs.promises.unlink(filePath)
      logger.debug('Plugin file deleted', { agentId, filename, type, filePath })
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException
      if (nodeError.code !== 'ENOENT') {
        throw this.toPluginError('uninstall', error)
      }
      logger.warn('Plugin file already deleted', { agentId, filename, type, filePath })
    }
  }

  async updateFilePluginContent(agentId: string, filePath: string, content: string): Promise<string> {
    try {
      await fs.promises.access(filePath, fs.constants.W_OK)
    } catch {
      throw {
        type: 'FILE_NOT_FOUND',
        path: filePath
      } as PluginError
    }

    try {
      await fs.promises.writeFile(filePath, content, 'utf8')
      logger.debug('Plugin content written successfully', {
        agentId,
        filePath,
        size: Buffer.byteLength(content, 'utf8')
      })
    } catch (error) {
      throw {
        type: 'WRITE_FAILED',
        path: filePath,
        reason: error instanceof Error ? error.message : String(error)
      } as PluginError
    }

    return crypto.createHash('sha256').update(content).digest('hex')
  }

  async installSkill(agentId: string, sourceAbsolutePath: string, destPath: string): Promise<void> {
    await this.installWithBackup({
      destPath,
      copy: () => copyDirectoryRecursive(sourceAbsolutePath, destPath),
      cleanup: (p, l) => this.safeRemoveDirectory(p, l),
      operation: 'install-skill',
      label: 'skill folder',
      agentId
    })
  }

  async uninstallSkill(agentId: string, folderName: string, skillPath: string): Promise<void> {
    const logContext = logger.withContext('uninstallSkill')

    try {
      await deleteDirectoryRecursive(skillPath)
      logContext.info('Skill folder deleted', { agentId, folderName, skillPath })
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException
      if (nodeError.code !== 'ENOENT') {
        throw this.toPluginError('uninstall-skill', error)
      }
      logContext.warn('Skill folder already deleted', { agentId, folderName, skillPath })
    }
  }

  /**
   * 文件与目录安装共用的备份-复制-恢复流程：
   * 1. 若目标已存在：rename 为 `.bak`（减少 Windows 同步目录上直接覆盖的 EPERM）
   * 2. 执行 copy
   * 3. 成功则删除 `.bak`
   * 4. 失败则删掉不完整目标并把 `.bak` 改回原路径
   */
  private async installWithBackup(opts: {
    destPath: string
    copy: () => Promise<void>
    cleanup: (targetPath: string, label: string) => Promise<void>
    operation: string
    label: string
    agentId: string
  }): Promise<void> {
    const { destPath, copy, cleanup, operation, label, agentId } = opts
    const backupPath = `${destPath}.bak`
    let hasBackup = false

    try {
      if (await pathExists(destPath)) {
        await cleanup(backupPath, 'stale backup')
        await fs.promises.rename(destPath, backupPath)
        hasBackup = true
        logger.debug(`Backed up existing ${label}`, { agentId, backupPath })
      }

      await copy()
      logger.debug(`${label} copied to destination`, { agentId, destPath })

      if (hasBackup) {
        await cleanup(backupPath, `backup ${label}`)
      }
    } catch (error) {
      if (hasBackup) {
        await cleanup(destPath, `partial ${label}`)
        await this.safeRename(backupPath, destPath, `${label} backup`)
      }
      throw this.toPluginError(operation, error)
    }
  }

  private toPluginError(operation: string, error: unknown): PluginError {
    return {
      type: 'TRANSACTION_FAILED',
      operation,
      reason: error instanceof Error ? error.message : String(error)
    }
  }

  private async safeRename(from: string, to: string, label: string): Promise<void> {
    try {
      await fs.promises.rename(from, to)
      logger.debug(`Restored ${label}`, { from, to })
    } catch (error) {
      logger.error(`Failed to restore ${label}`, {
        from,
        to,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async safeUnlink(targetPath: string, label: string): Promise<void> {
    try {
      await fs.promises.unlink(targetPath)
      logger.debug(`Rolled back ${label}`, { targetPath })
    } catch (unlinkError) {
      logger.error(`Failed to rollback ${label}`, {
        targetPath,
        error: unlinkError instanceof Error ? unlinkError.message : String(unlinkError)
      })
    }
  }

  private async safeRemoveDirectory(targetPath: string, label: string): Promise<void> {
    try {
      await deleteDirectoryRecursive(targetPath)
      logger.info(`Rolled back ${label}`, { targetPath })
    } catch (unlinkError) {
      logger.error(`Failed to rollback ${label}`, {
        targetPath,
        error: unlinkError instanceof Error ? unlinkError.message : String(unlinkError)
      })
    }
  }
}
