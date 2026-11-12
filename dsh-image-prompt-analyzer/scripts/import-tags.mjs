#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openKnowledgeDatabase } from '../lib/kb/db.js'
import { DATA_DIR_ENV, resolveDataPath, scriptDataDir } from '../lib/paths.js'
import { SEVERITY } from '../lib/diagnostics.js'
import { IMPORT_FORMATS, rebuildLocalSource } from '../lib/kb/import.js'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const STUDIO_EXTENSIONS = Object.freeze(['sqlite', 'sqlite3', 'db'])

const USAGE = [
  '用法：',
  '  node scripts/import-tags.mjs [--dry-run] [--limit N] [--db PATH] [--config PATH]',
  '  node scripts/import-tags.mjs --file PATH [--source ID] [--format FORMAT] [--header auto|true|false]',
  '                              [--delimiter CHAR] [--limit N] [--dry-run] [--db PATH] [--config PATH]',
  '  node scripts/import-tags.mjs --file PATH/TO/tags.sqlite --source studio-tags --type studio_sqlite',
  '',
  `支持的格式：${IMPORT_FORMATS.join(' / ')}（留空时按扩展名判断）。`,
  '--limit 只处理前 N 行，并且**不会清空旧行**；不带 --limit 才是全量重建（先清空该 source 再写入）。',
  '--type studio_sqlite 表示导入绘画工作室的 SQLite 词库：源库只读打开，按 sha256 指纹幂等，--file 给 .sqlite/.sqlite3/.db 时自动识别。',
  `知识库默认放在用户数据目录；要换位置用 --db 或环境变量 ${DATA_DIR_ENV}。`,
].join('\n')

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq > 0) {
      args[token.slice(2, eq).replace(/-/g, '_')] = token.slice(eq + 1)
      continue
    }
    const key = token.slice(2).replace(/-/g, '_')
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function resolveFromPackage(value) {
  return isAbsolute(value) ? value : resolve(PACKAGE_DIR, value)
}

function log(message) {
  process.stdout.write(`${message}\n`)
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  return 2
}

function parseLimit(raw) {
  if (raw === undefined || raw === true) return { limit: null }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) return { error: `--limit 需要正整数，收到 ${raw}` }
  return { limit: value }
}

function parseBoolean(raw, name) {
  if (raw === undefined) return { value: undefined }
  if (raw === true) return { value: true }
  const text = String(raw).toLowerCase()
  if (['true', '1', 'yes'].includes(text)) return { value: true }
  if (['false', '0', 'no'].includes(text)) return { value: false }
  if (text === 'auto') return { value: 'auto' }
  return { error: `${name} 只接受 auto / true / false，收到 ${raw}` }
}

function formatFromPath(path) {
  const ext = extname(path).replace(/^\./, '').toLowerCase()
  return IMPORT_FORMATS.includes(ext) ? ext : null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    log(USAGE)
    return 0
  }

  const { limit, error: limitError } = parseLimit(args.limit)
  if (limitError) return fail(limitError)
  const header = parseBoolean(args.header, '--header')
  if (header.error) return fail(header.error)

  const configPath = resolveFromPackage(args.config ?? 'configs/knowledge-base.default.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  // 知识库现在放在用户数据目录（跨升级保留），不再在插件包里。
  // --db 显式指定时按包目录/绝对路径解析；否则按数据目录解析配置里的相对路径。
  const dbPath = args.db
    ? resolveFromPackage(String(args.db))
    : resolveDataPath(config.storage?.database_path ?? 'knowledge.sqlite3', scriptDataDir())

  log(`知识库：${dbPath}`)
  log(args.dry_run ? '模式：dry-run（只统计，不写库）' : limit === null ? '模式：全量导入（幂等，先清空对应 source 旧行）' : `模式：试跑前 ${limit} 行（只 upsert，不清空旧行）`)
  const handle = await openKnowledgeDatabase({ path: dbPath, createIfMissing: true })

  try {
    let ok = true
    if (args.file) {
      const filePath = resolveFromPackage(String(args.file))
      const ext = extname(filePath).replace(/^\./, '').toLowerCase()
      const forcedType = args.type && args.type !== true ? String(args.type).toLowerCase() : null
      // .sqlite / .db 不可能是本地词表文件，直接按工作室词库处理；
      // 也可以用 --type 显式指定，避免把别的 SQLite 误当 CSV 去读。
      const isStudio = forcedType === 'studio_sqlite' || (forcedType === null && STUDIO_EXTENSIONS.includes(ext))

      if (isStudio) {
        const sourceConfig = {
          source_id: String(args.source ?? 'studio-tags'),
          type: 'studio_sqlite',
          path: filePath,
        }
        try {
          const result = await rebuildLocalSource({
            handle,
            sourceConfig,
            limit,
            dryRun: args.dry_run === true,
            force: args.force === true,
            categories: config.categories ?? null,
          })
          if (result.unchanged === true) {
            log(`导入 ${sourceConfig.source_id}（studio_sqlite）：源库指纹与上次一致，跳过；需要重导加 --force。`)
          } else {
            const rows = args.dry_run ? result.would_import : result.imported
            log(
              `导入 ${sourceConfig.source_id}（studio_sqlite）：标签 ${rows} 条，别名 ${result.aliases ?? 0} 条，跳过 ${result.skipped} 行，` +
                `用户分类 ${result.user_categories ?? 0} 个，分类树 ${result.studio_categories ?? 0} 个节点 / ${result.studio_category_links ?? 0} 条归属，耗时 ${result.duration_ms ?? 0} ms。`,
            )
          }
          const errors = result.diagnostics.filter((item) => item.severity === SEVERITY.ERROR)
          for (const item of errors) {
            ok = false
            log(`  [error] ${item.error_code}：${item.message}`)
          }
        } catch (error) {
          ok = false
          log(`导入 ${sourceConfig.source_id} 失败：${error?.message ?? error}`)
        }
        return ok ? 0 : 1
      }

      const format = args.format && args.format !== true ? String(args.format).toLowerCase() : formatFromPath(filePath)
      if (!format) {
        return fail(`--file ${filePath} 的扩展名不在支持列表里（${IMPORT_FORMATS.join(', ')}），请用 --format 显式指定。`)
      }
      const sourceConfig = {
        source_id: String(args.source ?? 'local-import'),
        type: 'local_file',
        format,
        path: filePath,
        has_header: header.value ?? 'auto',
        delimiter: args.delimiter && args.delimiter !== true ? String(args.delimiter) : ',',
      }
      try {
        const result = await rebuildLocalSource({
          handle,
          sourceConfig,
          limit,
          dryRun: args.dry_run === true,
          categories: config.categories ?? null,
        })
        const rows = args.dry_run ? result.would_import : result.imported
        log(`导入 ${sourceConfig.source_id}（${format}）：标签 ${rows} 条，别名 ${result.aliases ?? 0} 条，跳过 ${result.skipped} 行，耗时 ${result.duration_ms ?? 0} ms。`)
      } catch (error) {
        ok = false
        log(`导入 ${sourceConfig.source_id} 失败：${error?.message ?? error}`)
      }
    } else {
      const enabled = (Array.isArray(config.sources) ? config.sources : []).filter((source) => source.enabled !== false)
      const sources = enabled.filter((source) => String(source.type) === 'local_file' || String(source.type) === 'studio_sqlite')
      if (sources.length === 0) {
        log('配置里没有启用的 local_file 或 studio_sqlite 数据源。用 --file 直接导一个文件，或先在 configs/knowledge-base.default.json 的 sources[] 里加一条。')
        return 0
      }
      for (const sourceConfig of sources) {
        try {
          const result = await rebuildLocalSource({
            handle,
            sourceConfig,
            limit,
            dryRun: args.dry_run === true,
            force: args.force === true || sourceConfig.force === true,
            categories: config.categories ?? null,
          })
          if (result.unchanged === true) {
            log(`- ${result.source_id}（studio_sqlite）：源库指纹与上次一致，跳过。`)
          } else {
            const rows = args.dry_run ? result.would_import : result.imported
            const extra = result.adapter
              ? `，用户分类 ${result.user_categories ?? 0}，分类树 ${result.studio_categories ?? 0} 个节点 / ${result.studio_category_links ?? 0} 条归属`
              : ''
            log(`- ${result.source_id}（${result.adapter ?? result.format ?? sourceConfig.format}）：标签 ${rows}，别名 ${result.aliases ?? 0}，跳过 ${result.skipped}${extra}。`)
          }
          const errors = result.diagnostics.filter((item) => item.severity === SEVERITY.ERROR)
          if (errors.length > 0) {
            ok = false
            for (const item of errors) log(`  [error] ${item.error_code}：${item.message}`)
          }
        } catch (error) {
          ok = false
          log(`- ${sourceConfig.source_id} 失败：${error?.message ?? error}`)
        }
      }
    }
    return ok ? 0 : 1
  } finally {
    handle.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`导入失败：${error?.stack ?? error}\n`)
      process.exitCode = 1
    })
}
