
import { copyFile } from 'node:fs/promises'

import { diagnostic, SEVERITY } from '../diagnostics.js'
import { SUPPORTED_SCHEMA_VERSIONS } from './validate.js'

export const MIGRATE_CODES = Object.freeze({
  LEGACY_VALUE_REWRITTEN: 'CONFIG_LEGACY_VALUE_REWRITTEN',
  SCHEMA_VERSION_UNSUPPORTED: 'CONFIG_SCHEMA_VERSION_UNSUPPORTED',
  SCHEMA_VERSION_MIGRATED: 'CONFIG_SCHEMA_VERSION_MIGRATED',
})

export const MIGRATIONS = Object.freeze({
  'knowledge-base': Object.freeze({}),
  'model-profile': Object.freeze({}),
  preset: Object.freeze({}),
})

export function parseSchemaVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d+)\.(\d+)$/.exec(value.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), text: `${match[1]}.${match[2]}` }
}

export function compareVersions(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  return 0
}

const LEGACY_VALUE_REWRITES = Object.freeze([
  {
    pointer: '/lookup/mode',
    from: 'online_with_local_fallback',
    to: 'local_first_then_online',
    note: '文档 §6.4 的 online_with_local_fallback 在实现里改名为 local_first_then_online（语义相同：本地命中即返回，本地查不到才联网）。',
  },
  {
    pointer: '/target/family',
    from: 'anime26',
    to: 'anima',
    note: '文档 §6.5 的槽位名 anime26 改为官方模型族名 anima（Δ11，原名保留在 aliases 里）。',
  },
  {
    pointer: '/target/family',
    from: 'guanghui',
    to: 'illustrious',
    note: '文档 §6.5 的槽位名 guanghui 改为官方模型族名 illustrious（Δ11，原名保留在 aliases 里）。',
  },
])

function readPointer(document, pointer) {
  const parts = pointer.split('/').slice(1)
  let node = document
  for (const part of parts) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[part]
  }
  return node
}

function writePointer(document, pointer, value) {
  const parts = pointer.split('/').slice(1)
  let node = document
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]
    if (node[part] === null || typeof node[part] !== 'object') return
    node = node[part]
  }
  node[parts[parts.length - 1]] = value
}

function applyLegacyValueRewrites(document, config_file) {
  const out = []
  for (const rewrite of LEGACY_VALUE_REWRITES) {
    if (readPointer(document, rewrite.pointer) !== rewrite.from) continue
    writePointer(document, rewrite.pointer, rewrite.to)
    out.push(
      diagnostic({
        error_code: MIGRATE_CODES.LEGACY_VALUE_REWRITTEN,
        severity: SEVERITY.INFO,
        config_file,
        field_path: rewrite.pointer,
        message: `${rewrite.pointer} 的旧写法 ${rewrite.from} 已改写为 ${rewrite.to}。${rewrite.note}`,
        suggested_fix: `把配置文件里的 ${rewrite.from} 直接改成 ${rewrite.to}，这条提示就会消失。`,
      }),
    )
  }
  return out
}

export function migrateConfigDocument(document, { kind, config_file }) {
  const diagnostics = []
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { document, diagnostics, migrated: false, from: null, to: null }
  }

  const copy = structuredClone(document)
  diagnostics.push(...applyLegacyValueRewrites(copy, config_file))

  const supported = SUPPORTED_SCHEMA_VERSIONS[kind] ?? []
  const raw = copy.schema_version

  const parsed = parseSchemaVersion(raw)
  if (parsed === null) {
    return { document: copy, diagnostics, migrated: false, from: null, to: null }
  }

  if (supported.includes(parsed.text)) {
    return { document: copy, diagnostics, migrated: false, from: parsed.text, to: parsed.text }
  }

  const supportedParsed = supported.map(parseSchemaVersion).filter(Boolean).sort(compareVersions)
  const newest = supportedParsed[supportedParsed.length - 1] ?? null
  const oldest = supportedParsed[0] ?? null

  if (newest !== null && compareVersions(parsed, newest) > 0) {
    diagnostics.push(
      diagnostic({
        error_code: MIGRATE_CODES.SCHEMA_VERSION_UNSUPPORTED,
        severity: SEVERITY.ERROR,
        config_file,
        field_path: '/schema_version',
        message: `配置的 schema_version 是 ${parsed.text}，高于本插件支持的 ${supported.join(' / ')}：这份配置可能用了本版本还不认识的字段。`,
        suggested_fix: '升级插件，或把配置降到受支持的 schema_version 并按新版 schema 调整字段。本插件不会去猜新版结构。',
      }),
    )
    return { document: copy, diagnostics, migrated: false, from: parsed.text, to: null }
  }

  if (oldest !== null && compareVersions(parsed, oldest) < 0) {
    const steps = MIGRATIONS[kind] ?? {}
    let current = parsed
    let working = copy
    let migrated = false
    for (let guard = 0; guard <= supportedParsed.length + 1; guard += 1) {
      const step = steps[current.text]
      if (typeof step !== 'function') break
      working = step(working)
      migrated = true
      const next = parseSchemaVersion(working.schema_version)
      if (next === null || compareVersions(next, current) <= 0) break
      current = next
      if (supported.includes(current.text)) break
    }

    if (!migrated) {
      diagnostics.push(
        diagnostic({
          error_code: MIGRATE_CODES.SCHEMA_VERSION_UNSUPPORTED,
          severity: SEVERITY.ERROR,
          config_file,
          field_path: '/schema_version',
          message: `配置的 schema_version 是 ${parsed.text}，低于本插件支持的 ${supported.join(' / ')}，且没有登记从 ${parsed.text} 出发的迁移路径。`,
          suggested_fix: '按新版 schema 手工调整配置；本插件不会猜测旧版本的结构含义。',
        }),
      )
      return { document: copy, diagnostics, migrated: false, from: parsed.text, to: null }
    }

    if (!supported.includes(current.text)) {
      diagnostics.push(
        diagnostic({
          error_code: MIGRATE_CODES.SCHEMA_VERSION_UNSUPPORTED,
          severity: SEVERITY.ERROR,
          config_file,
          field_path: '/schema_version',
          message: `从 ${parsed.text} 出发的迁移只走到了 ${current.text}，仍未到达受支持版本 ${supported.join(' / ')}。`,
          suggested_fix: '补齐缺失的迁移步骤，或手工把配置升到受支持版本。',
        }),
      )
      return { document: working, diagnostics, migrated: false, from: parsed.text, to: current.text }
    }

    diagnostics.push(
      diagnostic({
        error_code: MIGRATE_CODES.SCHEMA_VERSION_MIGRATED,
        severity: SEVERITY.INFO,
        config_file,
        field_path: '/schema_version',
        message: `配置已从 schema_version ${parsed.text} 迁移到 ${current.text}（内存中生效，尚未写回磁盘）。`,
        suggested_fix: '确认迁移结果无误后，把迁移后的内容写回配置文件；写回前本插件会先备份原文件。',
      }),
    )
    return { document: working, diagnostics, migrated: true, from: parsed.text, to: current.text }
  }

  diagnostics.push(
    diagnostic({
      error_code: MIGRATE_CODES.SCHEMA_VERSION_UNSUPPORTED,
      severity: SEVERITY.ERROR,
      config_file,
      field_path: '/schema_version',
      message: `配置的 schema_version 是 ${parsed.text}，不在受支持列表 ${supported.join(' / ')} 内。`,
      suggested_fix: '改成受支持的版本号，并确认字段结构与那个版本一致。',
    }),
  )
  return { document: copy, diagnostics, migrated: false, from: parsed.text, to: null }
}

export async function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.bak-${stamp}`
  await copyFile(file, target)
  return target
}
