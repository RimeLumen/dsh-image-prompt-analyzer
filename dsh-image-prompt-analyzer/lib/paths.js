
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** 跨升级保留的用户数据目录名。 */
export const APP_DIR_NAME = 'dsh-image-prompt-analyzer'

function isWithin(base, child) {
  const rel = relative(base, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function resolveWithin(base, value, fallback) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const candidate = raw.trim()
  if (isAbsolute(candidate)) return null
  const abs = resolve(base, candidate)
  if (!isWithin(base, abs)) return null
  return abs
}

/**
 * 用户数据该放哪。
 *
 * 插件包会被 npm 整包替换，放在包里的数据升级一次就没了。所以知识库、用户配置
 * 这些"导入一次就该一直在"的东西必须落在包外的系统目录里：
 * Windows 用 `%LOCALAPPDATA%`，macOS 用 `Application Support`，其余按 XDG。
 */
export function defaultUserDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), 'AppData', 'Local')
    return join(base, APP_DIR_NAME)
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_DIR_NAME)
  }
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(base, APP_DIR_NAME)
}

/**
 * 解析数据目录。
 *
 * 三种写法都认：留空走系统目录（默认）、写绝对路径就用它（数据本来就在包外，
 * 没有越界一说）、写相对路径仍按老规则落在包内（兼容既有安装）。
 */
export function resolveDataDir(value) {
  const declared = typeof value === 'string' ? value.trim() : ''
  if (declared === '') return { path: defaultUserDataDir(), source: 'user' }
  if (isAbsolute(declared)) return { path: resolve(declared), source: 'configured' }
  const inside = resolveWithin(PACKAGE_DIR, declared)
  if (inside === null) return { path: defaultUserDataDir(), source: 'user' }
  return { path: inside, source: 'package' }
}

/**
 * 把配置里的相对路径落到数据目录下；绝对路径原样用。
 *
 * 与 resolveWithin 的区别：不要求落在插件包里——数据本来就该在包外。
 */
export function resolveDataPath(value, dataDir) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return null
  if (isAbsolute(raw)) return resolve(raw)
  return resolve(dataDir, raw)
}

/** 命令行脚本共用的数据目录：环境变量优先，其次系统默认。 */
export const DATA_DIR_ENV = 'DSH_IMAGE_PROMPT_ANALYZER_DATA_DIR'

export function scriptDataDir(env = process.env) {
  return resolveDataDir(env?.[DATA_DIR_ENV] ?? null).path
}

export function resolvePluginDirs(config = {}) {
  const errors = []
  const pick = (key, fallback) => {
    const value = resolveWithin(PACKAGE_DIR, config?.[key], fallback)
    if (value === null) errors.push(key)
    return value
  }
  const data = resolveDataDir(config?.dataDir)
  if (data.source === 'user' && typeof config?.dataDir === 'string' && config.dataDir.trim() !== '') {
    // 写了相对路径但解析不出来，说明越界或写错；按默认目录处理并记一条。
    errors.push('dataDir')
  }
  return {
    configDir: pick('configDir', './configs'),
    dataDir: data.path,
    dataDirSource: data.source,
    logDir: pick('logDir', './logs'),
    errors,
  }
}

/**
 * 把老版本留在包内的数据搬到新目录。
 *
 * 只在数据目录就是系统目录时做一次：用户自己指定了目录，说明他知道东西放哪，
 * 不该被我们悄悄塞一份进去。搬的是知识库与用户配置——词表导入的结果就在前者里。
 */
export function migrateLegacyDataDir(dataDir, { logger = null } = {}) {
  const legacy = join(PACKAGE_DIR, 'data')
  if (resolve(legacy) === resolve(dataDir)) return { migrated: [], errors: [] }
  if (!existsSync(legacy)) return { migrated: [], errors: [] }

  const migrated = []
  const errors = []
  const targets = ['knowledge.sqlite3', 'knowledge.sqlite3-wal', 'knowledge.sqlite3-shm', 'user-configs']
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    return { migrated, errors: [String(error?.message ?? error)] }
  }
  for (const name of targets) {
    const from = join(legacy, name)
    if (!existsSync(from)) continue
    const to = join(dataDir, name)
    if (existsSync(to)) continue
    try {
      cpSync(from, to, { recursive: true })
      migrated.push(name)
    } catch (error) {
      errors.push(`${name}: ${error?.message ?? error}`)
      logger?.warn?.(`迁移旧数据 ${name} 失败`, error)
    }
  }
  return { migrated, errors }
}
