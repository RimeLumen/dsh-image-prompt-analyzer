
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { validateAgainstSchema } from './schema-validator.js'
import { crossValidateKnowledgeBase, crossValidatePreset, classifySchemaError } from './validate.js'
import { normalizeProfile } from '../model-profile/defaults.js'
import { MODEL_PROFILE_CODES, validateModelProfile } from '../model-profile/validate.js'
import { migrateConfigDocument, backupFile } from './migrate.js'
import { DEFAULT_POSITIVE_ORDER, CATEGORY_IDS } from './categories.js'
import { diagnostic, SEVERITY } from '../diagnostics.js'

const LOADER_CODES = Object.freeze({
  FILE_UNREADABLE: 'CONFIG_FILE_UNREADABLE',
  JSON_SYNTAX_ERROR: 'CONFIG_JSON_SYNTAX_ERROR',
  MIGRATION_BACKUP_WRITTEN: 'CONFIG_MIGRATION_BACKUP_WRITTEN',
  MIGRATION_BACKUP_FAILED: 'CONFIG_MIGRATION_BACKUP_FAILED',
  ID_MISSING: 'CONFIG_ID_MISSING',
  REJECTED: 'CONFIG_REJECTED',
  ID_DUPLICATE: 'CONFIG_ID_DUPLICATE',
  KIND_EMPTY: 'CONFIG_KIND_EMPTY',
  MODEL_PROFILE_UNKNOWN_VARIANT: 'MODEL_PROFILE_UNKNOWN_VARIANT',
  MODEL_PROFILE_NOT_SELECTED: 'MODEL_PROFILE_NOT_SELECTED',
  MODEL_PROFILE_NOT_FOUND: 'MODEL_PROFILE_NOT_FOUND',
  MODEL_PROFILE_ALIAS_AMBIGUOUS: 'MODEL_PROFILE_ALIAS_AMBIGUOUS',
  KNOWLEDGE_BASE_CONFIG_MISSING: 'KNOWLEDGE_BASE_CONFIG_MISSING',
})

export const CONFIG_KINDS = Object.freeze({
  'knowledge-base': {
    schemaFile: 'knowledge-base.schema.json',
    defaultDir: null,
    defaultFile: 'knowledge-base.default.json',
    userDir: 'knowledge-base',
    validate: crossValidateKnowledgeBase,
  },
  'model-profile': {
    schemaFile: null,
    defaultDir: 'model-profiles',
    defaultFile: null,
    userDir: 'model-profiles',
    validate: null,
  },
  preset: {
    schemaFile: 'preset.schema.json',
    defaultDir: 'presets',
    defaultFile: null,
    userDir: 'presets',
    validate: crossValidatePreset,
  },
})

export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

async function readJsonFile(file, { kind, relative }) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    return {
      error: diagnostic({
        error_code: LOADER_CODES.FILE_UNREADABLE,
        severity: SEVERITY.ERROR,
        config_file: relative,
        message: `无法读取配置文件：${error?.message ?? String(error)}`,
        suggested_fix: '确认文件存在、编码为 UTF-8，且当前进程对该路径有读权限。',
      }),
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return { value: JSON.parse(text) }
  } catch (error) {
    return {
      error: diagnostic({
        error_code: LOADER_CODES.JSON_SYNTAX_ERROR,
        severity: SEVERITY.ERROR,
        config_file: relative,
        message: `JSON 解析失败：${error?.message ?? String(error)}`,
        suggested_fix: '修掉 JSON 语法错误。本插件只接受 UTF-8 的标准 JSON，不接受注释与尾随逗号。',
      }),
    }
  }
}

async function listJsonFiles(dir) {
  if (!existsSync(dir)) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
}

function rejectedEntry({ kind, candidate, document, diagnostics }) {
  const configId = typeof document?.config_id === 'string' && document.config_id.trim() !== '' ? document.config_id : null
  return {
    kind,
    config_id: configId,
    schema_version: typeof document?.schema_version === 'string' ? document.schema_version : null,
    source: candidate.source,
    file: candidate.file,
    relative_file: candidate.relative,
    diagnostics,
  }
}

async function loadKind({ kind, configDir, dataDir, logger, knownPresetIds = null }) {
  const spec = CONFIG_KINDS[kind]
  const diagnostics = []
  const rejected = []

  let schema = null
  if (spec.schemaFile !== null) {
    const schemaRelative = `configs/${spec.schemaFile}`
    const schemaRead = await readJsonFile(join(configDir, spec.schemaFile), { kind, relative: schemaRelative })
    if (schemaRead.error) {
      diagnostics.push(schemaRead.error)
      return { entries: [], diagnostics, rejected, schema: null }
    }
    schema = schemaRead.value
  }

  const candidates = []

  if (spec.defaultDir === null) {
    candidates.push({
      file: join(configDir, spec.defaultFile),
      relative: `configs/${spec.defaultFile}`,
      source: 'default',
    })
  } else {
    for (const name of await listJsonFiles(join(configDir, spec.defaultDir))) {
      candidates.push({
        file: join(configDir, spec.defaultDir, name),
        relative: `configs/${spec.defaultDir}/${name}`,
        source: 'default',
      })
    }
  }

  const userRoot = join(dataDir, 'user-configs', spec.userDir)
  if (spec.defaultDir === null) {
    for (const name of await listJsonFiles(join(dataDir, 'user-configs'))) {
      candidates.push({
        file: join(dataDir, 'user-configs', name),
        relative: `user-configs/${name}`,
        source: 'user',
      })
    }
  } else {
    for (const name of await listJsonFiles(userRoot)) {
      candidates.push({
        file: join(userRoot, name),
        relative: `user-configs/${spec.userDir}/${name}`,
        source: 'user',
      })
    }
  }

  const byId = new Map()
  for (const candidate of candidates) {
    const read = await readJsonFile(candidate.file, { kind, relative: candidate.relative })
    if (read.error) {
      diagnostics.push(read.error)
      continue
    }

    const isProfileV2 = kind === 'model-profile' && read.value?.schema_version === '2.0'

    if (kind === 'model-profile' && !isProfileV2) {
      const unsupported = diagnostic({
        error_code: MODEL_PROFILE_CODES.SCHEMA_VERSION_UNSUPPORTED,
        severity: SEVERITY.ERROR,
        config_file: candidate.relative,
        field_path: '/schema_version',
        message: '这份模型档案是 schema 1.0 结构，已不再支持；当前版本的标签标准是 2.0（tag_standard）。',
        suggested_fix: '把档案改写成 2.0 结构；新档案可直接参考 pony-v6 / noobai-xl / illustrious / animagine-xl-4.0。',
      })
      diagnostics.push(unsupported)
      rejected.push(rejectedEntry({ kind, candidate, document: read.value, diagnostics: [unsupported] }))
      continue
    }

    let document
    let structural = []
    let migration = { migrated: false }
    if (isProfileV2) {
      document = normalizeProfile(read.value)
      structural = validateModelProfile(document, { configFile: candidate.relative }).diagnostics
    } else {
      migration = migrateConfigDocument(read.value, { kind, config_file: candidate.relative })
      for (const item of migration.diagnostics) diagnostics.push(item)
      document = migration.document
      const strictMode = document?.strict_mode === true
      structural = validateAgainstSchema(document, schema).map((item) =>
        classifySchemaError(item, { config_file: candidate.relative, strict_mode: strictMode }),
      )
    }
    for (const item of structural) diagnostics.push(item)

    if (migration.migrated) {
      try {
        const backup = await backupFile(candidate.file)
        diagnostics.push(
          diagnostic({
            error_code: LOADER_CODES.MIGRATION_BACKUP_WRITTEN,
            severity: SEVERITY.INFO,
            config_file: candidate.relative,
            field_path: '/schema_version',
            message: `迁移前已备份原文件到 ${backup}。迁移结果只在内存中生效，原文件未被改写。`,
            suggested_fix: '确认迁移结果无误后，把迁移后的内容写回配置文件；写回前请保留这份备份。',
          }),
        )
      } catch (error) {
        diagnostics.push(
          diagnostic({
            error_code: LOADER_CODES.MIGRATION_BACKUP_FAILED,
            severity: SEVERITY.WARNING,
            config_file: candidate.relative,
            field_path: '/schema_version',
            message: `迁移前备份失败：${error?.message ?? String(error)}`,
            suggested_fix: '手工复制一份该配置文件后再继续；原文件未被改写。',
          }),
        )
      }
    }

    const configId = typeof document?.config_id === 'string' ? document.config_id : null
    if (configId === null) {
      diagnostics.push(
        diagnostic({
          error_code: LOADER_CODES.ID_MISSING,
          severity: SEVERITY.ERROR,
          config_file: candidate.relative,
          field_path: '/config_id',
          message: '配置缺少可用的 config_id，无法登记。',
          suggested_fix: '补一个同类内唯一的小写 config_id。',
        }),
      )
      continue
    }

    const semantic = isProfileV2 || spec.validate === null
      ? []
      : spec.validate(document, { config_file: candidate.relative, schema, known_preset_ids: knownPresetIds })
    for (const item of semantic) diagnostics.push(item)

    const blocking = [...structural, ...semantic].some((item) => item.severity === SEVERITY.ERROR)
    if (blocking) {
      rejected.push(rejectedEntry({ kind, candidate, document, diagnostics: [...structural, ...semantic] }))
      diagnostics.push(
        diagnostic({
          error_code: LOADER_CODES.REJECTED,
          severity: SEVERITY.WARNING,
          config_file: candidate.relative,
          field_path: '/config_id',
          message: `配置 ${configId} 因上面的错误未生效。`,
          suggested_fix: '修掉 error 级别的诊断后重新加载。',
        }),
      )
      continue
    }

    const existing = byId.get(configId)
    if (existing) {
      diagnostics.push(
        diagnostic({
          error_code: LOADER_CODES.ID_DUPLICATE,
          severity: existing.source === 'user' ? SEVERITY.INFO : SEVERITY.WARNING,
          config_file: candidate.relative,
          field_path: '/config_id',
          message:
            existing.source === 'user'
              ? `config_id ${configId} 被用户配置 ${candidate.relative} 覆盖（默认配置 ${existing.relative} 不再参与本次加载）。`
              : `config_id ${configId} 重复，后加载的 ${candidate.relative} 覆盖了 ${existing.relative}。`,
          suggested_fix: '同类配置的 config_id 必须唯一；覆盖默认配置是有意行为时无需处理。',
        }),
      )
    }

    byId.set(configId, {
      kind,
      config_id: configId,
      schema_version: typeof document.schema_version === 'string' ? document.schema_version : null,
      source: candidate.source,
      file: candidate.file,
      relative_file: candidate.relative,
      config: deepFreeze(document),
      diagnostics: [...structural, ...semantic],
    })
  }

  if (byId.size === 0) {
    diagnostics.push(
      diagnostic({
        error_code: LOADER_CODES.KIND_EMPTY,
        severity: SEVERITY.WARNING,
        config_file: `configs/${spec.schemaFile}`,
        message: `没有加载到任何可用的 ${kind} 配置。`,
        suggested_fix: '确认 configs/ 下的默认配置存在且通过校验。',
      }),
    )
  }

  logger?.debug?.(`配置加载完成：${kind} 共 ${byId.size} 份`)
  return { entries: [...byId.values()], diagnostics, rejected, schema }
}

export function resolveEffectiveProfile(entry, { variant } = {}) {
  const diagnostics = []
  const base = entry?.config
  if (!base) {
    return { profile: null, variant: 'none', diagnostics }
  }

  const declared = typeof base.variant === 'string' && base.variant !== '' ? base.variant : 'none'
  const active = typeof variant === 'string' && variant !== '' ? variant : declared
  const configFile = entry.relative_file

  if (active === 'none') {
    return { profile: deepFreeze(structuredClone(base)), variant: 'none', diagnostics }
  }

  const overrides = base.variants?.[active]
  if (!overrides) {
    diagnostics.push(
      diagnostic({
        error_code: LOADER_CODES.MODEL_PROFILE_UNKNOWN_VARIANT,
        severity: SEVERITY.ERROR,
        config_file: configFile,
        field_path: '/variant',
        message: `variant ${active} 在 variants 里不存在。`,
        suggested_fix: `把 variant 改成 ${Object.keys(base.variants ?? {}).join(' / ') || 'none'} 之一，或补上该变体的定义。`,
      }),
    )
    return { profile: null, variant: active, diagnostics }
  }

  const merged = structuredClone(base)
  const syntax = { ...(merged.syntax ?? {}) }
  if (Array.isArray(overrides.quality_prefix)) syntax.quality_prefix = [...overrides.quality_prefix]
  if (Array.isArray(overrides.negative_default)) syntax.negative_default = [...overrides.negative_default]
  if (typeof overrides.score_tags_allowed === 'boolean') syntax.score_tags_allowed = overrides.score_tags_allowed
  if (typeof overrides.negative_required === 'boolean') syntax.negative_required = overrides.negative_required
  merged.syntax = syntax
  if (overrides.generation) merged.generation = structuredClone(overrides.generation)

  merged.variant = active

  return { profile: deepFreeze(merged), variant: active, diagnostics }
}

export function resolveProfileRequest(store, { profile_id, variant } = {}) {
  const diagnostics = []
  const available = store.listModelProfileIds()
  const hint = available.map((p) => (p.aliases.length > 0 ? `${p.config_id}（别名 ${p.aliases.join(' / ')}）` : p.config_id)).join('，')

  if (typeof profile_id !== 'string' || profile_id.trim() === '') {
    diagnostics.push(
      diagnostic({
        error_code: LOADER_CODES.MODEL_PROFILE_NOT_SELECTED,
        severity: SEVERITY.ERROR,
        field_path: '/model_profile_id',
        message: '没有指定 model profile，无法确定输出的模型语法。',
        suggested_fix: available.length > 0 ? `指定一个：${hint}。` : 'configs/model-profiles/ 下没有可用配置，先恢复默认配置。',
      }),
    )
    return { entry: null, profile: null, variant: 'none', diagnostics }
  }

  const entry = store.getModelProfile(profile_id)
  if (!entry) {
    diagnostics.push(
      diagnostic({
        error_code: LOADER_CODES.MODEL_PROFILE_NOT_FOUND,
        severity: SEVERITY.ERROR,
        field_path: '/model_profile_id',
        message: `找不到 model profile：${profile_id}。`,
        suggested_fix: available.length > 0 ? `可用取值：${hint}。` : 'configs/model-profiles/ 下没有可用配置，先恢复默认配置。',
      }),
    )
    return { entry: null, profile: null, variant: 'none', diagnostics }
  }

  if (entry.schema_version === '2.0') {
    if (typeof variant === 'string' && variant !== '' && variant !== 'none') {
      diagnostics.push(
        diagnostic({
          error_code: LOADER_CODES.MODEL_PROFILE_UNKNOWN_VARIANT,
          severity: SEVERITY.WARNING,
          config_file: entry.relative_file,
          field_path: '/variant',
          message: `档案 ${entry.config_id} 是 schema 2.0，没有 variant 概念，已忽略 variant=${variant}。`,
          suggested_fix: '想切换顺序请用档案里的 slot_order_presets（例如 illustrious 的 count_first / quality_first），而不是 variant。',
        }),
      )
    }
    return { entry, profile: entry.config, variant: 'none', diagnostics }
  }

  const resolved = resolveEffectiveProfile(entry, { variant })
  diagnostics.push(...resolved.diagnostics)
  return { entry, profile: resolved.profile, variant: resolved.variant, diagnostics }
}

export function createConfigStore({ configDir, dataDir, logger }) {
  let loaded = null

  async function ensureUserConfigDirs() {
    for (const spec of Object.values(CONFIG_KINDS)) {
      const dir = join(dataDir, 'user-configs', spec.userDir)
      try {
        await mkdir(dir, { recursive: true })
      } catch {
      }
    }
  }

  async function load() {
    await ensureUserConfigDirs()

    const diagnostics = []
    const kb = await loadKind({ kind: 'knowledge-base', configDir, dataDir, logger })
    const presets = await loadKind({ kind: 'preset', configDir, dataDir, logger })
    const profiles = await loadKind({
      kind: 'model-profile',
      configDir,
      dataDir,
      logger,
      knownPresetIds: presets.entries.map((entry) => entry.config_id),
    })
    diagnostics.push(...kb.diagnostics, ...profiles.diagnostics, ...presets.diagnostics)
    const rejected = [...kb.rejected, ...profiles.rejected, ...presets.rejected]

    const knowledgeBase = kb.entries[0] ?? null
    const modelProfiles = new Map(profiles.entries.map((entry) => [entry.config_id, entry]))
    const presetMap = new Map(presets.entries.map((entry) => [entry.config_id, entry]))

    const modelAliasIndex = new Map()
    for (const entry of modelProfiles.values()) {
      for (const alias of Array.isArray(entry.config?.aliases) ? entry.config.aliases : []) {
        if (typeof alias !== 'string' || alias.trim() === '') continue
        const key = alias.trim().toLowerCase()
        if (modelProfiles.has(key) || modelAliasIndex.has(key)) {
          diagnostics.push(
            diagnostic({
              error_code: LOADER_CODES.MODEL_PROFILE_ALIAS_AMBIGUOUS,
              severity: SEVERITY.WARNING,
              config_file: entry.relative_file,
              field_path: '/aliases',
              message: `别名 ${key} 与已有的 config_id 或别名冲突，按别名查找时不会解析到这份 profile。`,
              suggested_fix: '换一个不冲突的别名。',
            }),
          )
          continue
        }
        modelAliasIndex.set(key, entry.config_id)
      }
    }

    if (knowledgeBase === null) {
      diagnostics.push(
        diagnostic({
          error_code: LOADER_CODES.KNOWLEDGE_BASE_CONFIG_MISSING,
          severity: SEVERITY.ERROR,
          config_file: 'configs/knowledge-base.default.json',
          message: '没有任何可用的知识库配置，标签查询与经验库都无法工作。',
          suggested_fix: '恢复 configs/knowledge-base.default.json，或放一份通过校验的用户覆盖。',
        }),
      )
    }

    loaded = {
      knowledgeBase,
      modelProfiles,
      presets: presetMap,
      modelAliasIndex,
      rejected,
      schemas: { 'knowledge-base': kb.schema, 'model-profile': profiles.schema, preset: presets.schema },
      diagnostics,
      activeConfigs: {
        knowledge_base: knowledgeBase
          ? { config_id: knowledgeBase.config_id, schema_version: knowledgeBase.schema_version, source: knowledgeBase.source }
          : null,
        model_profiles: [...modelProfiles.values()].map((entry) => ({
          config_id: entry.config_id,
          schema_version: entry.schema_version,
          family: entry.config?.tag_standard?.family ?? null,
          source: entry.source,
        })),
        presets: [...presetMap.values()].map((entry) => ({
          config_id: entry.config_id,
          schema_version: entry.schema_version,
          source: entry.source,
        })),
      },
    }
    return loaded
  }

  function assertLoaded() {
    if (!loaded) {
      const error = new Error('配置仓库尚未加载：请先 await store.get() 或 await store.inspect() 再使用同步读取接口。')
      error.code = 'CONFIG_STORE_NOT_LOADED'
      error.suggested_fix = '这是调用顺序问题，不是配置问题。'
      throw error
    }
    return loaded
  }

  return {
    async get() {
      return loaded ?? (await load())
    },
    snapshot() {
      return loaded
    },
    async reload() {
      loaded = null
      return load()
    },
    async inspect() {
      return load()
    },
    getModelProfile(idOrAlias) {
      if (typeof idOrAlias !== 'string' || idOrAlias === '') return null
      const direct = assertLoaded().modelProfiles.get(idOrAlias)
      if (direct) return direct
      const resolved = loaded.modelAliasIndex.get(idOrAlias.trim().toLowerCase())
      return resolved ? (loaded.modelProfiles.get(resolved) ?? null) : null
    },
    listModelProfileIds() {
      const data = assertLoaded()
      return [...data.modelProfiles.values()].map((entry) => ({
        config_id: entry.config_id,
        aliases: Array.isArray(entry.config?.aliases) ? [...entry.config.aliases] : [],
        family: entry.config?.tag_standard?.family ?? null,
        variant: entry.config?.variant ?? 'none',
        source: entry.source,
      }))
    },
    getPreset(id) {
      return assertLoaded().presets.get(id) ?? null
    },
    listPresets() {
      const data = assertLoaded()
      return [...data.presets.values()].map((entry) => ({
        config_id: entry.config_id,
        detail_density: entry.config?.detail_density ?? null,
        schema_version: entry.schema_version,
        source: entry.source,
      }))
    },
    getKnowledgeBase() {
      return assertLoaded().knowledgeBase
    },
    getKnowledgeBaseDocument() {
      return assertLoaded().knowledgeBase?.config ?? null
    },
    async writeUserConfig({ kind, fileName, document }) {
      const spec = CONFIG_KINDS[kind]
      if (!spec) throw new Error(`未知配置类型：${kind}`)
      const dir = join(dataDir, 'user-configs', spec.userDir)
      await mkdir(dir, { recursive: true })
      const target = join(dir, fileName)
      await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      return target
    },
  }
}

export function orderedCategories(order) {
  const seen = new Set()
  const result = []
  for (const id of Array.isArray(order) ? order : []) {
    if (CATEGORY_IDS.has(id) && !seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  for (const id of DEFAULT_POSITIVE_ORDER) {
    if (!seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  return result
}
