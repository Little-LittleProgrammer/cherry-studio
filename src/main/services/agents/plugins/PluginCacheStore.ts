/**
 * 维护「代理工作目录」下 `.claude/plugins.json` 的缓存：记录已安装的 agent/command/skill/包内组件。
 * 列表优先读缓存以提速；缓存缺失或损坏时扫描 `.claude/agents|commands|skills` 与 `.claude/plugins/*` 重建。
 * 路径解析通过构造函数注入的 deps 完成，便于测试或与 {@link PluginService} 的目录约定对齐。
 */
import { loggerService } from '@logger'
import { directoryExists, fileExists, isPathInside, pathExists, writeWithLock } from '@main/utils/file'
import {
  findAllSkillDirectories,
  findSkillMdPath,
  parsePluginMetadata,
  parseSkillMetadata
} from '@main/utils/markdownParser'
import type { CachedPluginsData, InstalledPlugin, PluginManifest, PluginType } from '@types'
import { CachedPluginsDataSchema, PluginManifestSchema } from '@types'
import * as fs from 'fs'
import * as path from 'path'

const logger = loggerService.withContext('PluginCacheStore')

/** 由外部注入：扩展名白名单、各类型子目录名、`.claude` 根路径解析 */
interface PluginCacheStoreDeps {
  allowedExtensions: string[]
  getPluginDirectoryName: (type: PluginType) => 'agents' | 'commands' | 'skills'
  getClaudeBasePath: (workdir: string) => string
  getClaudePluginDirectory: (workdir: string, type: PluginType) => string
}

export class PluginCacheStore {
  constructor(private readonly deps: PluginCacheStoreDeps) {}

  /** 读缓存；失败则 `rebuild` 全量扫描文件系统并写回 plugins.json */
  async listInstalled(workdir: string): Promise<InstalledPlugin[]> {
    const claudePath = this.deps.getClaudeBasePath(workdir)
    const cacheData = await this.readCacheFile(claudePath)

    if (cacheData) {
      logger.debug(`Loaded ${cacheData.plugins.length} plugins from cache`, { workdir })
      return cacheData.plugins
    }

    logger.info('Cache read failed, rebuilding from filesystem', { workdir })
    return await this.rebuild(workdir)
  }

  /** 保证内存侧有可用缓存结构；无文件时先 rebuild 再包装为 CachedPluginsData */
  private async ensureCacheData(workdir: string): Promise<{ cacheData: CachedPluginsData; claudePath: string }> {
    const claudePath = this.deps.getClaudeBasePath(workdir)
    const existingCache = await this.readCacheFile(claudePath)

    if (existingCache) {
      return { cacheData: existingCache, claudePath }
    }

    const plugins = await this.rebuild(workdir)
    return {
      cacheData: { version: 1, lastUpdated: Date.now(), plugins },
      claudePath
    }
  }

  /** 按 filename+type 更新或追加一条，并原子写入 plugins.json */
  async upsert(workdir: string, plugin: InstalledPlugin): Promise<void> {
    const { cacheData, claudePath } = await this.ensureCacheData(workdir)
    const plugins = cacheData.plugins

    const updatedPlugin: InstalledPlugin = {
      ...plugin,
      metadata: {
        ...plugin.metadata,
        installedAt: plugin.metadata.installedAt ?? Date.now()
      }
    }

    const index = plugins.findIndex((p) => p.filename === updatedPlugin.filename && p.type === updatedPlugin.type)
    if (index >= 0) {
      plugins[index] = updatedPlugin
    } else {
      plugins.push(updatedPlugin)
    }

    const data: CachedPluginsData = {
      version: cacheData.version,
      lastUpdated: Date.now(),
      plugins
    }

    await fs.promises.mkdir(claudePath, { recursive: true })
    await this.writeCacheFile(claudePath, data)
  }

  /** 从缓存数组中移除匹配项并重写文件 */
  async remove(workdir: string, filename: string, type: PluginType): Promise<void> {
    const { cacheData, claudePath } = await this.ensureCacheData(workdir)
    const filtered = cacheData.plugins.filter((p) => !(p.filename === filename && p.type === type))

    const data: CachedPluginsData = {
      version: cacheData.version,
      lastUpdated: Date.now(),
      plugins: filtered
    }

    await fs.promises.mkdir(claudePath, { recursive: true })
    await this.writeCacheFile(claudePath, data)
  }

  /** 并行收集四类来源后写回缓存：散文件 agent/command、技能文件夹、`.claude/plugins` 下的 npm 式包 */
  async rebuild(workdir: string): Promise<InstalledPlugin[]> {
    logger.info('Rebuilding plugin cache from filesystem', { workdir })

    const claudePath = this.deps.getClaudeBasePath(workdir)

    try {
      await fs.promises.access(claudePath, fs.constants.R_OK)
    } catch {
      logger.warn('.claude directory not found, returning empty plugin list', { claudePath })
      return []
    }

    const plugins: InstalledPlugin[] = []

    await Promise.all([
      this.collectFilePlugins(workdir, 'agent', plugins),
      this.collectFilePlugins(workdir, 'command', plugins),
      this.collectSkillPlugins(workdir, plugins),
      this.collectPackagePlugins(workdir, plugins)
    ])

    try {
      const cacheData: CachedPluginsData = {
        version: 1,
        lastUpdated: Date.now(),
        plugins
      }
      await this.writeCacheFile(claudePath, cacheData)
      logger.info(`Rebuilt cache with ${plugins.length} plugins`, { workdir })
    } catch (error) {
      logger.error('Failed to write cache file after rebuild', {
        error: error instanceof Error ? error.message : String(error)
      })
    }

    return plugins
  }

  /** 扫描 `.claude/agents` 或 `commands` 下的单个 .md 插件 */
  private async collectFilePlugins(
    workdir: string,
    type: Exclude<PluginType, 'skill'>,
    plugins: InstalledPlugin[]
  ): Promise<void> {
    const directory = this.deps.getClaudePluginDirectory(workdir, type)

    try {
      await fs.promises.access(directory, fs.constants.R_OK)
    } catch {
      logger.debug(`${type} directory not found or not accessible`, { directory })
      return
    }

    const files = await fs.promises.readdir(directory, { withFileTypes: true })

    for (const file of files) {
      if (!file.isFile()) {
        continue
      }

      const ext = path.extname(file.name).toLowerCase()
      if (!this.deps.allowedExtensions.includes(ext)) {
        continue
      }

      try {
        const filePath = path.join(directory, file.name)
        const sourcePath = path.join(this.deps.getPluginDirectoryName(type), file.name)
        const metadata = await parsePluginMetadata(filePath, sourcePath, this.deps.getPluginDirectoryName(type), type)
        plugins.push({ filename: file.name, type, metadata })
      } catch (error) {
        logger.warn(`Failed to parse ${type} plugin: ${file.name}`, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  /** 扫描 `.claude/skills` 下含 SKILL.md 的目录 */
  private async collectSkillPlugins(workdir: string, plugins: InstalledPlugin[]): Promise<void> {
    const skillsPath = this.deps.getClaudePluginDirectory(workdir, 'skill')
    const claudePath = this.deps.getClaudeBasePath(workdir)

    try {
      await fs.promises.access(skillsPath, fs.constants.R_OK)
    } catch {
      logger.debug('Skills directory not found or not accessible', { skillsPath })
      return
    }

    const skillDirectories = await findAllSkillDirectories(skillsPath, claudePath)

    for (const { folderPath, sourcePath } of skillDirectories) {
      try {
        const metadata = await parseSkillMetadata(folderPath, sourcePath, 'skills')
        plugins.push({ filename: metadata.filename, type: 'skill', metadata })
      } catch (error) {
        logger.warn(`Failed to parse skill plugin: ${sourcePath}`, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  /** 扫描 `.claude/plugins/<包名>`，读取 `.claude-plugin/plugin.json` 并按 manifest 收集 skills/agents/commands */
  private async collectPackagePlugins(workdir: string, plugins: InstalledPlugin[]): Promise<void> {
    const claudePath = this.deps.getClaudeBasePath(workdir)
    const pluginsPath = path.join(claudePath, 'plugins')

    if (!(await directoryExists(pluginsPath))) {
      return
    }

    const entries = await fs.promises.readdir(pluginsPath, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue
      }

      const pluginDir = path.join(pluginsPath, entry.name)
      const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json')

      if (!(await fileExists(manifestPath))) {
        logger.debug('Plugin manifest not found while rebuilding cache', { pluginDir })
        continue
      }

      let manifest: PluginManifest
      try {
        const content = await fs.promises.readFile(manifestPath, 'utf-8')
        const json = JSON.parse(content)
        manifest = PluginManifestSchema.parse(json)
      } catch (error) {
        logger.warn('Failed to parse plugin manifest while rebuilding cache', {
          manifestPath,
          error: error instanceof Error ? error.message : String(error)
        })
        continue
      }

      const packageInfo = { packageName: manifest.name, packageVersion: manifest.version }

      await Promise.all([
        this.collectPackageComponentPaths(pluginDir, 'skills', manifest.skills, 'skill', plugins, packageInfo),
        this.collectPackageComponentPaths(pluginDir, 'agents', manifest.agents, 'agent', plugins, packageInfo),
        this.collectPackageComponentPaths(pluginDir, 'commands', manifest.commands, 'command', plugins, packageInfo)
      ])
    }
  }

  /** 默认子目录 + manifest 自定义路径（校验必须落在包目录内，防路径穿越） */
  private async collectPackageComponentPaths(
    pluginDir: string,
    defaultSubDir: string,
    customPaths: string | string[] | undefined,
    type: PluginType,
    plugins: InstalledPlugin[],
    packageInfo: { packageName: string; packageVersion?: string }
  ): Promise<void> {
    const scannedPaths = new Set<string>()

    const defaultPath = path.join(pluginDir, defaultSubDir)
    if (await directoryExists(defaultPath)) {
      scannedPaths.add(defaultPath)
      await this.scanAndCollectComponents(defaultPath, type, plugins, packageInfo)
    }

    if (customPaths) {
      const pathArray = Array.isArray(customPaths) ? customPaths : [customPaths]
      for (const customPath of pathArray) {
        const fullPath = path.resolve(pluginDir, customPath)
        if (!isPathInside(fullPath, pluginDir)) {
          logger.warn('Skipping custom path with path traversal while rebuilding cache', {
            customPath,
            pluginDir
          })
          continue
        }

        if (!scannedPaths.has(fullPath) && (await pathExists(fullPath))) {
          scannedPaths.add(fullPath)
          await this.scanAndCollectComponents(fullPath, type, plugins, packageInfo)
        }
      }
    }
  }

  /** 在某一目录下枚举条目：技能按子文件夹 + SKILL.md；agent/command 按单文件 .md */
  private async scanAndCollectComponents(
    dirPath: string,
    type: PluginType,
    plugins: InstalledPlugin[],
    packageInfo: { packageName: string; packageVersion?: string }
  ): Promise<void> {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name)

        try {
          if (type === 'skill' && entry.isDirectory()) {
            const skillMdPath = await findSkillMdPath(entryPath)
            if (skillMdPath) {
              const metadata = await parseSkillMetadata(entryPath, entry.name, 'plugins')
              plugins.push({
                filename: metadata.filename,
                type: 'skill',
                metadata: {
                  ...metadata,
                  packageName: packageInfo.packageName,
                  packageVersion: packageInfo.packageVersion
                }
              })
            }
          } else if ((type === 'agent' || type === 'command') && entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (!this.deps.allowedExtensions.includes(ext)) {
              continue
            }
            const metadata = await parsePluginMetadata(entryPath, entry.name, 'plugins', type)
            plugins.push({
              filename: metadata.filename,
              type,
              metadata: {
                ...metadata,
                packageName: packageInfo.packageName,
                packageVersion: packageInfo.packageVersion
              }
            })
          }
        } catch (error) {
          logger.warn('Failed to parse plugin component while rebuilding cache', {
            path: entryPath,
            type,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    } catch (error) {
      logger.warn('Failed to scan plugin package directory while rebuilding cache', {
        dirPath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** 读取并 Zod 校验；任一失败返回 null 触发重建 */
  private async readCacheFile(claudePath: string): Promise<CachedPluginsData | null> {
    const cachePath = path.join(claudePath, 'plugins.json')
    try {
      const content = await fs.promises.readFile(cachePath, 'utf-8')
      const data = JSON.parse(content)
      return CachedPluginsDataSchema.parse(data)
    } catch (err) {
      logger.warn(`Failed to read cache file at ${cachePath}`, {
        error: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  }

  /** 带锁原子写入，避免并发读写到半份 JSON */
  private async writeCacheFile(claudePath: string, data: CachedPluginsData): Promise<void> {
    const cachePath = path.join(claudePath, 'plugins.json')
    const content = JSON.stringify(data, null, 2)
    await writeWithLock(cachePath, content, { atomic: true, encoding: 'utf-8' })
  }
}
