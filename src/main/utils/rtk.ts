import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { loggerService } from '@logger'
import { HOME_CHERRY_DIR } from '@shared/config/constant'
import { gte as semverGte } from 'semver'

import { isWin } from '../constant'
import { getResourcePath, toAsarUnpackedPath } from '.'

const execFileAsync = promisify(execFile)
const logger = loggerService.withContext('Utils:Rtk')

const RTK_BINARY = isWin ? 'rtk.exe' : 'rtk'
const RTK_VERSION_FILE = '.rtk-version'
const RTK_MIN_VERSION = '0.23.0'
const REWRITE_TIMEOUT_MS = 3000

// rtk is not available for these platforms
const UNSUPPORTED_PLATFORMS = new Set(['win32-arm64'])

let rtkPath: string | null = null
let rtkAvailable: boolean | null = null

function getPlatformKey(): string {
  return `${process.platform}-${process.arch}`
}

function isPlatformSupported(): boolean {
  return !UNSUPPORTED_PLATFORMS.has(getPlatformKey())
}

function getBundledBinariesDir(): string {
  const dir = path.join(getResourcePath(), 'binaries', getPlatformKey())
  return toAsarUnpackedPath(dir)
}

function getUserBinDir(): string {
  return path.join(os.homedir(), HOME_CHERRY_DIR, 'bin')
}

/**
 * Extract bundled rtk binary to ~/.cherrystudio/bin/ if not already present or outdated.
 * Called once at app startup.
 */
export async function extractRtkBinaries(): Promise<void> {
  if (!isPlatformSupported()) {
    logger.debug('rtk not supported on this platform', { platform: getPlatformKey() })
    return
  }

  const bundledDir = getBundledBinariesDir()
  if (!fs.existsSync(bundledDir)) {
    logger.debug('No bundled rtk binaries found for this platform', { dir: bundledDir })
    return
  }

  const userBinDir = getUserBinDir()
  fs.mkdirSync(userBinDir, { recursive: true })

  const src = path.join(bundledDir, RTK_BINARY)
  const dest = path.join(userBinDir, RTK_BINARY)

  if (!fs.existsSync(src)) {
    return
  }

  // Use a version file to detect upgrades instead of comparing file sizes
  const bundledVersionFile = path.join(bundledDir, RTK_VERSION_FILE)
  const installedVersionFile = path.join(userBinDir, RTK_VERSION_FILE)
  const bundledVersion = fs.existsSync(bundledVersionFile) ? fs.readFileSync(bundledVersionFile, 'utf8').trim() : ''
  const installedVersion = fs.existsSync(installedVersionFile)
    ? fs.readFileSync(installedVersionFile, 'utf8').trim()
    : ''

  const shouldCopy = !fs.existsSync(dest) || (bundledVersion && bundledVersion !== installedVersion)

  if (shouldCopy) {
    fs.copyFileSync(src, dest)
    if (!isWin) {
      fs.chmodSync(dest, 0o755)
    }
    if (bundledVersion) {
      fs.writeFileSync(installedVersionFile, bundledVersion, 'utf8')
    }
    logger.info('Extracted rtk binary to user bin dir', { dest, version: bundledVersion || 'unknown' })
  }
}

function resolveRtkPath(): string | null {
  const userBinPath = path.join(getUserBinDir(), RTK_BINARY)
  if (fs.existsSync(userBinPath)) {
    return userBinPath
  }

  const bundledPath = path.join(getBundledBinariesDir(), RTK_BINARY)
  if (fs.existsSync(bundledPath)) {
    return bundledPath
  }

  return null
}

async function checkRtkAvailable(): Promise<boolean> {
  if (rtkAvailable !== null) return rtkAvailable

  if (!isPlatformSupported()) {
    rtkAvailable = false
    return false
  }

  rtkPath = resolveRtkPath()
  if (!rtkPath) {
    rtkAvailable = false
    logger.debug('rtk binary not found')
    return false
  }

  try {
    const { stdout } = await execFileAsync(rtkPath, ['--version'], {
      timeout: REWRITE_TIMEOUT_MS
    })
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    if (match) {
      const version = match[1]
      if (!semverGte(version, RTK_MIN_VERSION)) {
        logger.warn(`rtk version too old (need >= ${RTK_MIN_VERSION})`, { version })
        rtkAvailable = false
        return false
      }
      logger.info('rtk available', { version, path: rtkPath })
    }
    rtkAvailable = true
  } catch (error) {
    logger.warn('Failed to check rtk version', {
      error: error instanceof Error ? error.message : String(error)
    })
    rtkAvailable = false
  }

  return rtkAvailable
}

/**
 * 使用 rtk 对 shell 命令进行改写，以获得更优的 token 化输出。
 * 如果可用，将返回被改写后的命令，否则返回 null。
 *
 * 详细解释如下：
 * 1. 首先，函数会通过 checkRtkAvailable 判断 rtk 工具是否可用（包括二进制存在和版本合格），以及 rtkPath 是否已解析可用。
 *    - 如果 rtk 不可用或路径无效，则直接返回 null，表示无法重写命令。
 * 2. 如果 rtk 可用，使用 execFileAsync 以异步方式运行 rtk 可执行文件，
 *    传入 'rewrite' 以及目标命令字符串，并设定超时时间（REWRITE_TIMEOUT_MS）。
 *    它会尝试让 rtk 对输入的命令进行改写。
 * 3. 将 rtk 的标准输出（stdout）去除前后空白字符后，赋值给 rewritten。
 * 4. 如果 rewritten 为空，或改写后的命令与原始命令完全一致，说明 rtk 并未进行有效改写，返回 null。
 * 5. 若确实有改写，返回重写后的命令字符串。
 * 6. 当 rtk 写作失败抛出异常（包含 rtk 工具返回 1，代表不可改写的正常情形），catch 子句将捕获该异常并返回 null。
 */
export async function rtkRewrite(command: string): Promise<string | null> {
  // 步骤 1：检查 rtk 工具是否可用，以及 rtkPath 是否有效
  if (!(await checkRtkAvailable()) || !rtkPath) {
    return null
  }

  try {
    // 步骤 2：用 rtk 工具尝试将命令进行改写
    const { stdout } = await execFileAsync(rtkPath, ['rewrite', command], {
      timeout: REWRITE_TIMEOUT_MS
    })
    // 步骤 3：处理输出，去除前后多余空白
    const rewritten = stdout.trim()

    // 步骤 4：如果没有改写，或者改写结果和原始命令一致，返回 null
    if (!rewritten || rewritten === command) {
      return null
    }

    // 步骤 5：返回重写后的命令
    return rewritten
  } catch {
    // 步骤 6：捕获异常（包括正常的无可改写）
    return null
  }
}
