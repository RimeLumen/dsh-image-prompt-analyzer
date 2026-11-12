
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { SEVERITY, diagnostic } from '../../../diagnostics.js'
import { inspectStudioDatabase, STUDIO_SOURCE_TYPE } from '../../../kb/adapters/studio-sqlite.js'
import { IMPORT_FORMATS, SOURCE_TYPES } from '../../../kb/import.js'
import { readSourceMeta, countStudioCategories } from '../../../kb/store.js'
import { resolveTreeSeedPaths } from '../../../kb/tree.js'
import { PACKAGE_DIR, resolveWithin } from '../../../paths.js'
import { DIAGNOSE_CODES } from './codes.js'

function resolveDeclaredPath(path) {
  if (typeof path !== 'string' || path.trim() === '') return null
  const trimmed = path.trim()
  if (isAbsolute(trimmed)) return trimmed
  return resolveWithin(PACKAGE_DIR, trimmed, null)
}

function isStudio(source) {
  return String(source?.type ?? '') === STUDIO_SOURCE_TYPE
}

// studio_sqlite 的体检比 local_file 深一层：不只看文件在不在，
// 还要读它的表结构、行数、以及和上次导入的指纹差。
async function inspectStudioSource({ source, entry, handle, logger }) {
  const diagnostics = []
  const absolute = resolveDeclaredPath(source.path)
  if (absolute === null) {
    entry.status = 'path_escapes'
    entry.detail = '路径无法解析：既不是绝对路径，也跳不出插件目录。'
    diagnostics.push(
      diagnostic({
        error_code: DIAGNOSE_CODES.SOURCE_MISSING_FIELD,
        severity: SEVERITY.ERROR,
        config_file: 'knowledge-base',
        field_path: `/sources/${source.source_id}/path`,
        message: `数据源 ${source.source_id} 的路径无法解析：${source.path}`,
        suggested_fix: '填本机上的真实文件路径，例如 G:/绘画工作室/绘画工作室-公开版/data/tags.sqlite。',
      }),
    )
    return diagnostics
  }

  entry.absolute_path = absolute
  entry.exists = existsSync(absolute)
  if (!entry.exists) {
    entry.status = 'file_missing'
    entry.detail = '源库文件不存在。'
    diagnostics.push(
      diagnostic({
        error_code: DIAGNOSE_CODES.SOURCE_MISSING_FIELD,
        severity: SEVERITY.WARNING,
        config_file: 'knowledge-base',
        field_path: `/sources/${source.source_id}/path`,
        message: `数据源 ${source.source_id} 指向的工作室词库不存在：${absolute}`,
        suggested_fix: '把路径改成你本机工作室的实际位置；这条源不参与导入时其余功能照常可用。',
      }),
    )
    return diagnostics
  }

  let inspection
  try {
    inspection = await inspectStudioDatabase({ path: absolute, logger })
  } catch (error) {
    entry.status = 'schema_invalid'
    entry.detail = error?.message ?? String(error)
    diagnostics.push(
      diagnostic({
        error_code: error?.code ?? DIAGNOSE_CODES.SOURCE_MISSING_FIELD,
        severity: SEVERITY.ERROR,
        config_file: 'knowledge-base',
        field_path: `/sources/${source.source_id}/path`,
        message: `数据源 ${source.source_id} 无法作为工作室词库读取：${error?.message ?? error}`,
        suggested_fix: error?.suggested_fix ?? '确认 path 指向工作室公开版里的 data/tags.sqlite，且该文件的 tags 表含 en / category / post_count 三列。',
      }),
    )
    return diagnostics
  }

  entry.status = 'declared'
  entry.bytes = inspection.bytes
  entry.fingerprint = inspection.fingerprint
  entry.schema_hash = inspection.schema_hash
  entry.rows = inspection.row_count
  entry.active_rows = inspection.active_count
  entry.deprecated_rows = inspection.deprecated_count
  entry.reviewed_translations = inspection.reviewed_translation_count
  entry.user_categories = inspection.user_category_count
  entry.user_category_links = inspection.user_category_link_count
  entry.has_fts = inspection.fts_index === true
  entry.updated_at_range = inspection.updated_at_range
  entry.missing_optional_columns = inspection.missing_optional

  // 分类树：种子文件在包外，库里只留导入时读到的那份快照，所以两边都要说一句。
  const seedPaths = resolveTreeSeedPaths(absolute)
  entry.tree_seed = {
    visual_index: seedPaths?.visual_index && existsSync(seedPaths.visual_index) ? seedPaths.visual_index : null,
    wiki_section: seedPaths?.wiki_section && existsSync(seedPaths.wiki_section) ? seedPaths.wiki_section : null,
  }
  const stored = handle ? countStudioCategories(handle, String(source.source_id)) : { categories: 0, links: 0 }
  entry.studio_categories = stored.categories
  entry.studio_category_links = stored.links

  // 和上次导入的指纹对比：源库变了但没重建，用户看到的仍是旧数据。
  const previous = handle ? readSourceMeta(handle, String(source.source_id)) : null
  entry.imported = previous === null
    ? null
    : {
        imported_at: previous.imported_at ?? null,
        rows: previous.imported_row_count ?? null,
        fingerprint: previous.fingerprint ?? null,
      }

  if (previous === null) {
    entry.stale = true
    diagnostics.push(
      diagnostic({
        error_code: 'KB_STUDIO_NOT_IMPORTED',
        severity: SEVERITY.WARNING,
        config_file: 'knowledge-base',
        field_path: `/sources/${source.source_id}`,
        message: `数据源 ${source.source_id} 还没导入过：源库有 ${inspection.row_count} 条标签，插件库里还没有它的数据。`,
        suggested_fix: '调用 rebuild_knowledge_base 并指定 sources: ["' + source.source_id + '"]，或让 enabled: true 后全量重建。',
      }),
    )
  } else if (previous.fingerprint !== inspection.fingerprint) {
    entry.stale = true
    diagnostics.push(
      diagnostic({
        error_code: 'KB_STUDIO_STALE',
        severity: SEVERITY.WARNING,
        config_file: 'knowledge-base',
        field_path: `/sources/${source.source_id}`,
        message: `数据源 ${source.source_id} 的源库已变化（指纹与上次导入不同），插件库里仍是旧快照。`,
        suggested_fix: '重新导入即可：重复导入是幂等的，会按新指纹整份替换这一源的行。',
      }),
    )
  } else {
    entry.stale = false
  }

  return diagnostics
}

export async function inspectSources({ config, onlySource, handle = null, logger = null }) {
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
          suggested_fix: isStudio(source)
            ? '填工作室数据文件的位置，例如 G:/绘画工作室/绘画工作室-公开版/data/tags.sqlite。'
            : '填上文件的相对路径，例如 res/danbooru_all.csv。',
        }),
      )
    } else if (entry.enabled && isStudio(source)) {
      diagnostics.push(...(await inspectStudioSource({ source, entry, handle, logger })))
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
