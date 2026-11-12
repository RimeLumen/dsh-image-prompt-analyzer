
import { diagnostic, SEVERITY } from '../../diagnostics.js'

export function unsafeRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return '路径为空'
  const raw = value.trim()
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return '不允许 URL，只能是相对路径'
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return '不允许盘符绝对路径'
  if (raw.startsWith('/') || raw.startsWith('\\')) return '不允许绝对路径'
  const normalized = raw.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..')) return '不允许包含 .. 段（会逃出插件目录）'
  if (/^~\//.test(normalized)) return '不允许 ~ 家目录写法'
  return null
}

const PATH_FIELDS = Object.freeze([
  '/storage/database_path',
  '/storage/experience_export_path',
  '/sources/*/path',
])

/**
 * 外部源库的路径校验。
 *
 * 插件自己的库必须待在插件目录里（storage.database_path 走 unsafeRelativePath）。
 * 但 studio_sqlite 指向的是**别人的**数据文件，它本来就在插件目录之外——
 * 工作室装在 G 盘、插件装在 D 盘是常态。所以这里只拦真正危险的写法：
 * URL、盘符相对路径、以及任何带 `..` 段的路径。
 */
export function unsafeSourcePath(value, { allowAbsolute = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') return '路径为空'
  const raw = value.trim()
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return '不允许 URL，只能是文件路径'
  const normalized = raw.replace(/\\/g, '/')
  if (normalized.split('/').some((segment) => segment === '..')) return '不允许包含 .. 段'
  if (allowAbsolute) {
    const absolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/') || /^\/\/[^/]/.test(normalized)
    if (absolute) return null
    if (/^~\//.test(normalized)) return '不允许 ~ 家目录写法'
    return null
  }
  return unsafeRelativePath(value)
}

export function forEachPathField(document, visit) {
  for (const template of PATH_FIELDS) {
    const parts = template.split('/').slice(1)
    let nodes = [document]
    for (const part of parts) {
      const next = []
      for (const node of nodes) {
        if (node === null || typeof node !== 'object') continue
        if (part === '*') {
          if (Array.isArray(node)) next.push(...node)
        } else if (Object.prototype.hasOwnProperty.call(node, part)) {
          next.push(node[part])
        }
      }
      nodes = next
    }
    nodes.forEach((value, index) => {
      if (value === undefined) return
      const pointer = template.replace('*', String(index))
      visit({ pointer, value })
    })
  }
}

export function findDuplicates(list) {
  const seen = new Set()
  const duplicates = []
  for (const item of list) {
    if (seen.has(item)) duplicates.push(item)
    seen.add(item)
  }
  return duplicates
}

export function makeCollectors(out, config_file) {
  const record = (severity) => (error_code, field_path, message, suggested_fix) =>
    out.push(diagnostic({ error_code, severity, config_file, field_path, message, suggested_fix }))
  return { err: record(SEVERITY.ERROR), warn: record(SEVERITY.WARNING) }
}
