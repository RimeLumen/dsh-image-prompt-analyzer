
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { SEVERITY, diagnostic } from '../../../diagnostics.js'
import { IMPORT_FORMATS, SOURCE_TYPES } from '../../../kb/import.js'
import { PACKAGE_DIR, resolveWithin } from '../../../paths.js'
import { DIAGNOSE_CODES } from './codes.js'

function resolveDeclaredPath(path) {
  if (typeof path !== 'string' || path.trim() === '') return null
  const trimmed = path.trim()
  if (isAbsolute(trimmed)) return trimmed
  return resolveWithin(PACKAGE_DIR, trimmed, null)
}

export function inspectSources({ config, onlySource }) {
  const diagnostics = []
  const all = config.sources ?? []
  const sources = all.filter((source) => !onlySource || String(source.source_id) === onlySource)

  if (sources.length === 0) {
    diagnostics.push(
      diagnostic({
        error_code: DIAGNOSE_CODES.SOURCE_NOT_FOUND,
        severity: SEVERITY.ERROR,
        message: onlySource ? `配置里没有 source_id 为 ${onlySource} 的数据源。` : '配置里没有声明任何数据源。',
        suggested_fix: '检查 knowledge-base 配置的 sources[]；至少需要一条 local_file 源。',
      }),
    )
  }

  const report = []
  for (const source of sources) {
    const entry = {
      source_id: String(source.source_id),
      type: String(source.type),
      enabled: source.enabled !== false,
      format: source.format ?? null,
      path: source.path ?? null,
      status: 'unknown',
      detail: null,
    }

    if (!SOURCE_TYPES.includes(source.type)) {
      entry.status = 'unknown_type'
      entry.detail = `未知的数据源类型：${source.type}`
      diagnostics.push(
        diagnostic({
          error_code: DIAGNOSE_CODES.SOURCE_MISSING_FIELD,
          severity: SEVERITY.ERROR,
          config_file: 'knowledge-base',
          field_path: `/sources/${source.source_id}/type`,
          message: `数据源 ${source.source_id} 的类型 ${source.type} 不受支持。`,
          suggested_fix: `可用类型：${SOURCE_TYPES.join(' / ')}。`,
        }),
      )
      report.push(entry)
      continue
    }

    const formatText = source.format === undefined || source.format === null ? null : String(source.format).toLowerCase()
    if (source.type === 'local_file' && formatText !== null && !IMPORT_FORMATS.includes(formatText)) {
      entry.status = 'unknown_format'
      entry.detail = `未知的文件格式：${source.format}`
      diagnostics.push(
        diagnostic({
          error_code: DIAGNOSE_CODES.SOURCE_MISSING_FIELD,
          severity: SEVERITY.ERROR,
          config_file: 'knowledge-base',
          field_path: `/sources/${source.source_id}/format`,
          message: `数据源 ${source.source_id} 的格式 ${source.format} 不受支持。`,
          suggested_fix: `可用格式：${IMPORT_FORMATS.join(' / ')}。`,
        }),
      )
    } else if (entry.enabled && !source.path) {
      entry.status = 'missing_path'
      entry.detail = '这类数据源必须有 path。'
      diagnostics.push(
        diagnostic({
          error_code: DIAGNOSE_CODES.SOURCE_MISSING_FIELD,
          severity: SEVERITY.ERROR,
          config_file: 'knowledge-base',
          field_path: `/sources/${source.source_id}/path`,
          message: `数据源 ${source.source_id} 没有配置 path。`,
          suggested_fix: '填上文件的相对路径，例如 res/danbooru_all.csv。',
        }),
      )
    } else if (entry.enabled) {
      const absolute = resolveDeclaredPath(source.path)
      if (absolute === null) {
        entry.status = 'path_escapes'
        entry.detail = '路径无法解析到插件目录内。'
        diagnostics.push(
          diagnostic({
            error_code: DIAGNOSE_CODES.SOURCE_MISSING_FIELD,
            severity: SEVERITY.ERROR,
            config_file: 'knowledge-base',
            field_path: `/sources/${source.source_id}/path`,
            message: `数据源 ${source.source_id} 的路径不在插件目录内：${source.path}`,
            suggested_fix: '改成插件目录内的相对路径：`../` 不能跳出插件目录。',
          }),
        )
      } else {
        entry.absolute_path = absolute
        entry.exists = existsSync(absolute)
        entry.status = entry.exists ? 'declared' : 'file_missing'
        if (!entry.exists) {
          entry.detail = '文件不存在。'
          diagnostics.push(
            diagnostic({
              error_code: DIAGNOSE_CODES.SOURCE_MISSING_FIELD,
              severity: SEVERITY.WARNING,
              config_file: 'knowledge-base',
              field_path: `/sources/${source.source_id}/path`,
              message: `数据源 ${source.source_id} 指向的文件不存在：${absolute}`,
              suggested_fix: '把标签文件放到这个路径，或修改 sources[].path；rebuild_knowledge_base 会跳过它。',
            }),
          )
        }
      }
    } else {
      entry.status = 'disabled'
    }

    report.push(entry)
  }

  return { sources: report, diagnostics }
}
