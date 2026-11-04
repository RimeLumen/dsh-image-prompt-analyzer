
import { createHash } from 'node:crypto'

import { errorGroupFor } from '../diagnostics.js'
import { normalizeTagName } from '../kb/index.js'
import { findTag } from '../kb/store.js'

export const EXPERIENCE_ROLES = Object.freeze({
  POSITIVE: 'positive',
  NEGATIVE: 'negative',
  LOW_CONFIDENCE: 'low_confidence',
})

export const EXPERIENCE_ROLE_IDS = Object.freeze(Object.values(EXPERIENCE_ROLES))

export const EFFECT_RATING_MIN = 1
export const EFFECT_RATING_MAX = 5

export const EXPERIENCE_CODES = Object.freeze({
  INVALID_RECORD: 'EXPERIENCE_INVALID_RECORD',
  DUPLICATE_TASK: 'EXPERIENCE_DUPLICATE_TASK',
  NOT_FOUND: 'EXPERIENCE_NOT_FOUND',
  SAVE_FAILED: 'EXPERIENCE_SAVE_FAILED',
  DELETE_FAILED: 'EXPERIENCE_DELETE_FAILED',
  RATING_INVALID: 'EXPERIENCE_RATING_INVALID',
  JSONL_SYNTAX: 'EXPERIENCE_JSONL_SYNTAX',
  IMPORT_SHAPE: 'EXPERIENCE_IMPORT_SHAPE',
  IMPORT_EMPTY: 'EXPERIENCE_IMPORT_EMPTY',
  IMAGE_HASH_MISSING: 'EXPERIENCE_IMAGE_HASH_MISSING',
  EXPORT_PATH_UNSAFE: 'EXPERIENCE_EXPORT_PATH_UNSAFE',
  UNKNOWN_ACTION: 'EXPERIENCE_UNKNOWN_ACTION',
})

const SUGGESTED_FIX = Object.freeze({
  [EXPERIENCE_CODES.INVALID_RECORD]: '检查传入的经验记录是否带 task_id、target_model 与 config_version。',
  [EXPERIENCE_CODES.DUPLICATE_TASK]: '同一个 task_id 的经验会被覆盖而不是重复插入；如果要保留两份，请换一个 task_id。',
  [EXPERIENCE_CODES.NOT_FOUND]: '先用 list 或 search 确认经验编号存在。',
  [EXPERIENCE_CODES.SAVE_FAILED]: '检查知识库文件是否可写（diagnose_knowledge_base 的存储段会报告）。',
  [EXPERIENCE_CODES.DELETE_FAILED]: '检查知识库文件是否可写。',
  [EXPERIENCE_CODES.RATING_INVALID]: `效果评分只能是 ${EFFECT_RATING_MIN} 到 ${EFFECT_RATING_MAX} 的整数；不想评分就不要写这一项，留空比编一个数字好。`,
  [EXPERIENCE_CODES.JSONL_SYNTAX]: '导出文件按每行一个 JSON 对象存放；损坏的行会带上行号。',
  [EXPERIENCE_CODES.IMPORT_SHAPE]: '每一行必须是一个对象，且带 task_id。',
  [EXPERIENCE_CODES.IMPORT_EMPTY]: '文件里没有任何可用记录。',
  [EXPERIENCE_CODES.IMAGE_HASH_MISSING]: '确认原图仍然存在于原路径且可读。',
  [EXPERIENCE_CODES.EXPORT_PATH_UNSAFE]: '导出路径必须是相对插件包目录的相对路径，例如 data/experiences/experiences.jsonl。',
  [EXPERIENCE_CODES.UNKNOWN_ACTION]: 'action 只能是 list、search、get、stats、rate、delete、export、import 之一。',
})

export class ExperienceError extends Error {
  constructor(code, message, { detail = null, suggestedFix = null, configFile = null, fieldPath = null } = {}) {
    super(message)
    this.name = 'ExperienceError'
    this.code = code
    this.detail = detail
    this.suggested_fix = suggestedFix ?? SUGGESTED_FIX[code] ?? null
    this.config_file = configFile
    this.field_path = fieldPath
  }

  toDiagnostic({ configFile = null, fieldPath = null } = {}) {
    return {
      error_code: this.code,
      error_group: errorGroupFor(this.code),
      severity: 'error',
      config_file: this.config_file ?? configFile,
      field_path: this.field_path ?? fieldPath,
      message: this.detail ? `${this.message}（${this.detail}）` : this.message,
      suggested_fix: this.suggested_fix,
    }
  }
}

export function imageContentHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function asText(value, fallback = null) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

function safeJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback
  try {
    return JSON.stringify(value)
  } catch {
    return fallback
  }
}

function parseSlotsSnapshot(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return { slots: value, quality_block: [] }
  if (typeof value === 'string') {
    if (value.length === 0) return null
    try {
      return parseSlotsSnapshot(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (typeof value === 'object') {
    return {
      slots: Array.isArray(value.slots) ? value.slots : null,
      quality_block: Array.isArray(value.quality_block) ? value.quality_block : null,
    }
  }
  return null
}

function serializeSlotsSnapshot(slotsSnapshot, qualityBlock = null) {
  const parsed = parseSlotsSnapshot(slotsSnapshot)
  const quality = Array.isArray(qualityBlock) ? qualityBlock : (parsed?.quality_block ?? null)
  if (parsed === null && quality === null) return null
  return JSON.stringify({ slots: parsed?.slots ?? [], quality_block: quality ?? [] })
}

export function buildExperienceRecord({
  taskId,
  imageHash = null,
  imageMeta = null,
  targetModel,
  targetProfile = null,
  detailLevel = 'standard',
  positivePrompt = '',
  negativePrompt = null,
  controlSuggestions = null,
  slotsSnapshot = null,
  qualityBlock = null,
  irSnapshot = null,
  configVersion,
  createdAt = null,
  allowLegacy = false,
}) {
  const id = asText(taskId)
  if (!id) {
    throw new ExperienceError(EXPERIENCE_CODES.INVALID_RECORD, '经验记录缺少 task_id。')
  }
  const profile = asText(targetProfile)
  if (!profile && !allowLegacy) {
    throw new ExperienceError(
      EXPERIENCE_CODES.INVALID_RECORD,
      '经验记录缺少 target_profile：不知道这条经验是给哪个档案编译的，就没法按档案隔离检索。',
    )
  }
  const model = asText(targetModel) ?? profile
  if (!model) {
    throw new ExperienceError(EXPERIENCE_CODES.INVALID_RECORD, '经验记录缺少 target_model：不知道这条经验是给哪个模型编译的，就没法复用。')
  }
  const version = asText(configVersion)
  if (!version) {
    throw new ExperienceError(EXPERIENCE_CODES.INVALID_RECORD, '经验记录缺少 config_version：配置变了以后旧结果没法解释。')
  }

  return {
    task_id: id,
    image_hash: asText(imageHash),
    image_meta: imageMeta === null ? null : safeJson(imageMeta),
    target_model: model,
    target_profile: profile,
    detail_level: asText(detailLevel, 'standard'),
    positive_prompt: typeof positivePrompt === 'string' ? positivePrompt : '',
    negative_prompt: asText(negativePrompt),
    control_suggestions: controlSuggestions === null ? null : safeJson(controlSuggestions),
    slots_snapshot: serializeSlotsSnapshot(slotsSnapshot, qualityBlock),
    ir_snapshot: irSnapshot === null ? null : safeJson(irSnapshot),
    config_version: version,
    effect_rating: null,
    created_at: asText(createdAt) ?? new Date().toISOString(),
  }
}

export function collectExperienceTags({ positiveTerms = [], negativeTerms = [], lowConfidenceTerms = [] } = {}) {
  const out = []
  const seen = new Set()

  const push = (role, term) => {
    const raw = typeof term === 'string' ? term : (term?.display ?? term?.text ?? '')
    const text = asText(raw)
    if (!text) return
    const key = `${role}\u0000${normalizeTagName(text)}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      role,
      tag_text: text,
      importance: typeof term?.importance === 'number' ? term.importance : null,
    })
  }

  for (const term of positiveTerms) push(EXPERIENCE_ROLES.POSITIVE, term)
  for (const term of negativeTerms) push(EXPERIENCE_ROLES.NEGATIVE, term)
  for (const term of lowConfidenceTerms) push(EXPERIENCE_ROLES.LOW_CONFIDENCE, term)

  return out
}

export function saveExperience(handle, input, { tags = [], allowLegacy = false } = {}) {
  const normalized = buildExperienceRecord({
    taskId: input?.task_id,
    imageHash: input?.image_hash ?? null,
    imageMeta: input?.image_meta ?? null,
    targetModel: input?.target_model,
    targetProfile: input?.target_profile ?? null,
    detailLevel: input?.detail_level ?? 'standard',
    positivePrompt: input?.positive_prompt ?? '',
    negativePrompt: input?.negative_prompt ?? null,
    controlSuggestions: input?.control_suggestions ?? null,
    slotsSnapshot: input?.slots_snapshot ?? null,
    qualityBlock: input?.quality_block ?? null,
    irSnapshot: input?.ir_snapshot ?? null,
    configVersion: input?.config_version,
    createdAt: input?.created_at ?? null,
    allowLegacy,
  })

  return handle.transaction(() => {
    const row = handle.get(
      `INSERT INTO prompt_experiences
         (task_id, image_hash, image_meta, target_model, target_profile, detail_level,
          positive_prompt, negative_prompt, control_suggestions, slots_snapshot, ir_snapshot,
          config_version, effect_rating, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id) DO UPDATE SET
         image_hash          = excluded.image_hash,
         image_meta          = excluded.image_meta,
         target_model        = excluded.target_model,
         target_profile      = excluded.target_profile,
         detail_level        = excluded.detail_level,
         positive_prompt     = excluded.positive_prompt,
         negative_prompt     = excluded.negative_prompt,
         control_suggestions = excluded.control_suggestions,
         slots_snapshot      = excluded.slots_snapshot,
         ir_snapshot         = COALESCE(excluded.ir_snapshot, prompt_experiences.ir_snapshot),
         config_version      = excluded.config_version,
         created_at          = excluded.created_at
       RETURNING id`,
      normalized.task_id,
      normalized.image_hash,
      normalized.image_meta,
      normalized.target_model,
      normalized.target_profile,
      normalized.detail_level,
      normalized.positive_prompt,
      normalized.negative_prompt,
      normalized.control_suggestions,
      normalized.slots_snapshot,
      normalized.ir_snapshot,
      normalized.config_version,
      normalized.effect_rating,
      normalized.created_at,
    )
    const experienceId = Number(row?.id)
    if (!Number.isInteger(experienceId) || experienceId <= 0) {
      throw new ExperienceError(EXPERIENCE_CODES.SAVE_FAILED, '写入经验记录后没有拿到编号。')
    }

    handle.run('DELETE FROM experience_tags WHERE experience_id = ?', experienceId)

    let linked = 0
    for (const tag of tags) {
      if (!EXPERIENCE_ROLE_IDS.includes(tag.role)) continue
      const text = asText(tag.tag_text)
      if (!text) continue
      const existing = findTag(handle, text)
      handle.run(
        `INSERT INTO experience_tags (experience_id, tag_id, tag_text, role, importance)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (experience_id, role, tag_text) DO UPDATE SET
           tag_id = excluded.tag_id,
           importance = excluded.importance`,
        experienceId,
        existing?.id ?? null,
        text,
        tag.role,
        typeof tag.importance === 'number' ? tag.importance : null,
      )
      if (existing?.id) linked += 1
    }

    return { id: experienceId, task_id: normalized.task_id, tags: tags.length, linked_tags: linked }
  })
}

function hydrateExperience(row, tags = []) {
  const parse = (value) => {
    if (typeof value !== 'string' || value.length === 0) return null
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  const slotsSnapshot = parseSlotsSnapshot(row.slots_snapshot)
  return {
    id: row.id,
    task_id: row.task_id,
    image_hash: row.image_hash,
    image_meta: parse(row.image_meta),
    target_model: row.target_model,
    target_profile: row.target_profile ?? null,
    detail_level: row.detail_level,
    positive_prompt: row.positive_prompt,
    negative_prompt: row.negative_prompt,
    control_suggestions: parse(row.control_suggestions),
    slots: slotsSnapshot?.slots ?? null,
    quality_block: slotsSnapshot?.quality_block ?? null,
    ir_snapshot: parse(row.ir_snapshot),
    config_version: row.config_version,
    effect_rating: row.effect_rating,
    created_at: row.created_at,
    tags,
  }
}

function tagsFor(handle, experienceIds) {
  if (experienceIds.length === 0) return new Map()
  const placeholders = experienceIds.map(() => '?').join(', ')
  const rows = handle.all(
    `SELECT experience_id, tag_id, tag_text, role, importance
       FROM experience_tags
      WHERE experience_id IN (${placeholders})
      ORDER BY role, tag_text`,
    ...experienceIds,
  )
  const map = new Map()
  for (const row of rows) {
    const list = map.get(row.experience_id) ?? []
    list.push({ tag_id: row.tag_id, tag_text: row.tag_text, role: row.role, importance: row.importance })
    map.set(row.experience_id, list)
  }
  return map
}

export function getExperience(handle, id, { withTags = true } = {}) {
  const row = handle.get('SELECT * FROM prompt_experiences WHERE id = ?', Number(id))
  if (!row) return null
  return hydrateExperience(row, withTags ? (tagsFor(handle, [row.id]).get(row.id) ?? []) : [])
}

export function findByTaskId(handle, taskId) {
  const row = handle.get('SELECT * FROM prompt_experiences WHERE task_id = ?', String(taskId))
  if (!row) return null
  return hydrateExperience(row, tagsFor(handle, [row.id]).get(row.id) ?? [])
}

export function listExperiences(handle, { limit = 20, targetModel = null, targetProfile = null, imageHash = null } = {}) {
  const clauses = []
  const params = []
  if (targetModel) {
    clauses.push('target_model = ?')
    params.push(targetModel)
  }
  if (targetProfile) {
    clauses.push('target_profile = ?')
    params.push(targetProfile)
  }
  if (imageHash) {
    clauses.push('image_hash = ?')
    params.push(imageHash)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = handle.all(
    `SELECT * FROM prompt_experiences ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...params,
    Math.max(1, Math.min(200, Number(limit) || 20)),
  )
  const map = tagsFor(handle, rows.map((row) => row.id))
  return rows.map((row) => hydrateExperience(row, map.get(row.id) ?? []))
}

export function searchExperiences(
  handle,
  { tags = [], targetModel = null, targetProfile = null, limit = 10, requireAll = false } = {},
) {
  const wanted = []
  const seen = new Set()
  for (const raw of tags) {
    const text = asText(typeof raw === 'string' ? raw : (raw?.tag_text ?? raw?.text))
    if (!text) continue
    const key = normalizeTagName(text)
    if (seen.has(key)) continue
    seen.add(key)
    wanted.push(text)
  }
  if (wanted.length === 0) return []

  const placeholders = wanted.map(() => '?').join(', ')
  const params = wanted.map((text) => normalizeTagName(text))
  const modelClause = targetModel ? 'AND e.target_model = ?' : ''
  const profileClause = targetProfile ? 'AND e.target_profile = ?' : ''
  if (targetModel) params.push(targetModel)
  if (targetProfile) params.push(targetProfile)

  const having = requireAll ? 'HAVING matched = ?' : ''
  if (requireAll) params.push(wanted.length)
  params.push(Math.max(1, Math.min(200, Number(limit) || 10)))

  const rows = handle.all(
    `SELECT e.*, COUNT(DISTINCT t.tag_text) AS matched
       FROM prompt_experiences e
       JOIN experience_tags t ON t.experience_id = e.id
      WHERE REPLACE(LOWER(t.tag_text), ' ', '_') IN (${placeholders})
        ${modelClause}
        ${profileClause}
      GROUP BY e.id
      ${having}
      ORDER BY matched DESC, e.created_at DESC
      LIMIT ?`,
    ...params,
  )

  const map = tagsFor(handle, rows.map((row) => row.id))
  return rows.map((row) => {
    const record = hydrateExperience(row, map.get(row.id) ?? [])
    return {
      ...record,
      source: 'experience',
      matched_tags: Number(row.matched),
      match_score: Number((Number(row.matched) / wanted.length).toFixed(4)),
    }
  })
}

export function deleteExperience(handle, id) {
  const numeric = Number(id)
  const row = handle.get('SELECT id FROM prompt_experiences WHERE id = ?', numeric)
  if (!row) return { deleted: false, id: numeric }
  handle.transaction(() => {
    handle.run('DELETE FROM experience_tags WHERE experience_id = ?', numeric)
    handle.run('DELETE FROM prompt_experiences WHERE id = ?', numeric)
  })
  return { deleted: true, id: numeric }
}

export function deleteExperienceByTaskId(handle, taskId) {
  const row = handle.get('SELECT id FROM prompt_experiences WHERE task_id = ?', String(taskId))
  if (!row) return { deleted: false, task_id: String(taskId) }
  return { ...deleteExperience(handle, row.id), task_id: String(taskId) }
}

export function setEffectRating(handle, id, { rating, note = null } = {}) {
  const numeric = Number(rating)
  if (!Number.isInteger(numeric) || numeric < EFFECT_RATING_MIN || numeric > EFFECT_RATING_MAX) {
    throw new ExperienceError(
      EXPERIENCE_CODES.RATING_INVALID,
      `效果评分必须是 ${EFFECT_RATING_MIN} 到 ${EFFECT_RATING_MAX} 的整数，收到 ${JSON.stringify(rating)}。`,
    )
  }
  const row = handle.get('SELECT id, ir_snapshot FROM prompt_experiences WHERE id = ?', Number(id))
  if (!row) {
    throw new ExperienceError(EXPERIENCE_CODES.NOT_FOUND, `找不到编号为 ${id} 的经验。`)
  }
  const comment = asText(note)
  if (comment) {
    let snapshot = null
    try {
      snapshot = row.ir_snapshot ? JSON.parse(row.ir_snapshot) : {}
    } catch {
      snapshot = {}
    }
    if (snapshot === null || typeof snapshot !== 'object') snapshot = {}
    snapshot.user_evaluation = { rating: numeric, note: comment, at: new Date().toISOString() }
    handle.run('UPDATE prompt_experiences SET ir_snapshot = ? WHERE id = ?', JSON.stringify(snapshot), row.id)
  }
  handle.run('UPDATE prompt_experiences SET effect_rating = ? WHERE id = ?', numeric, row.id)
  return { id: Number(id), effect_rating: numeric }
}

export function experienceStats(handle, { targetProfile = null } = {}) {
  const filter = targetProfile ? 'WHERE target_profile = ?' : ''
  const params = targetProfile ? [targetProfile] : []
  const total = Number(handle.get(`SELECT COUNT(*) AS n FROM prompt_experiences ${filter}`, ...params)?.n ?? 0)
  const tags = Number(
    targetProfile
      ? handle.get(
          'SELECT COUNT(*) AS n FROM experience_tags t JOIN prompt_experiences e ON e.id = t.experience_id WHERE e.target_profile = ?',
          targetProfile,
        )?.n
      : handle.get('SELECT COUNT(*) AS n FROM experience_tags')?.n ?? 0,
  )
  const rated = Number(
    handle.get(
      `SELECT COUNT(*) AS n FROM prompt_experiences ${targetProfile ? 'WHERE target_profile = ? AND' : 'WHERE'} effect_rating IS NOT NULL`,
      ...params,
    )?.n ?? 0,
  )
  const byModel = handle.all(
    `SELECT target_model, COUNT(*) AS n FROM prompt_experiences ${filter} GROUP BY target_model ORDER BY n DESC`,
    ...params,
  )
  const byProfile = handle.all(
    `SELECT COALESCE(target_profile, 'legacy') AS target_profile, COUNT(*) AS n
       FROM prompt_experiences
      GROUP BY COALESCE(target_profile, 'legacy')
      ORDER BY n DESC`,
  )
  return { total, tags, rated, unrated: total - rated, by_model: byModel, by_profile: byProfile }
}

export function statsByProfile(handle) {
  return experienceStats(handle).by_profile
}
export const EXPERIENCE_EXPORT_SCHEMA_VERSION = '2.0'

export function toLine(record) {
  return JSON.stringify({
    schema_version: EXPERIENCE_EXPORT_SCHEMA_VERSION,
    task_id: record.task_id,
    target_profile: record.target_profile ?? null,
    target_model: record.target_model,
    image_hash: record.image_hash ?? null,
    image_meta: record.image_meta ?? null,
    detail_level: record.detail_level,
    positive_prompt: record.positive_prompt,
    negative_prompt: record.negative_prompt ?? null,
    slots: record.slots ?? null,
    quality_block: record.quality_block ?? null,
    ir_snapshot: record.ir_snapshot ?? null,
    config_version: record.config_version,
    effect_rating: record.effect_rating ?? null,
    created_at: record.created_at,
    tags: (record.tags ?? []).map((tag) => ({
      role: tag.role,
      tag_text: tag.tag_text,
      importance: tag.importance ?? null,
    })),
  })
}

export function toJsonl(records) {
  return records
    .map((record) => toLine(record))
    .join('\n')
    .concat(records.length > 0 ? '\n' : '')
}

export function parseJsonl(text, { tolerant = true } = {}) {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
  const records = []
  const skipped = []
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let parsed = null
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      if (!tolerant) {
        throw new ExperienceError(EXPERIENCE_CODES.JSONL_SYNTAX, `第 ${index + 1} 行不是合法 JSON。`, {
          detail: error.message,
        })
      }
      skipped.push({ line: index + 1, message: error.message })
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (!tolerant) {
        throw new ExperienceError(EXPERIENCE_CODES.IMPORT_SHAPE, `第 ${index + 1} 行不是一个对象。`)
      }
      skipped.push({ line: index + 1, message: '不是一个对象' })
      return
    }
    records.push(parsed)
  })
  if (records.length === 0 && skipped.length === 0) {
    throw new ExperienceError(EXPERIENCE_CODES.IMPORT_EMPTY, '这份 JSONL 里没有任何可用记录。')
  }
  return { records, skipped }
}

export function importExperiences(handle, records) {
  let imported = 0
  let skipped = 0
  let legacy = 0
  for (const record of records) {
    const taskId = asText(record?.task_id)
    if (!taskId) {
      skipped += 1
      continue
    }
    const targetProfile = asText(record?.target_profile)
    const isLegacy = !targetProfile
    if (isLegacy) legacy += 1
    const existing = findByTaskId(handle, taskId)
    saveExperience(
      handle,
      {
        task_id: taskId,
        image_hash: record.image_hash ?? null,
        image_meta: record.image_meta ?? null,
        target_model: record.target_model ?? targetProfile ?? 'unknown',
        target_profile: targetProfile,
        detail_level: record.detail_level ?? 'standard',
        positive_prompt: record.positive_prompt ?? '',
        negative_prompt: record.negative_prompt ?? null,
        control_suggestions: record.control_suggestions ?? null,
        slots_snapshot:
          record.slots != null || record.quality_block != null
            ? { slots: record.slots ?? null, quality_block: record.quality_block ?? null }
            : null,
        ir_snapshot: record.ir_snapshot ?? null,
        config_version: record.config_version ?? 'unknown',
        created_at: record.created_at ?? null,
      },
      { tags: Array.isArray(record.tags) ? record.tags : [], allowLegacy: true },
    )
    if (existing?.effect_rating != null) {
      handle.run('UPDATE prompt_experiences SET effect_rating = ? WHERE task_id = ?', existing.effect_rating, taskId)
    }
    imported += 1
  }
  return { imported, skipped, legacy }
}
