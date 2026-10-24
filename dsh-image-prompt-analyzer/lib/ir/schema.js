
import { INTERNAL_CATEGORIES, CATEGORY_IDS } from '../config/categories.js'

export const IR_SCHEMA_VERSION = '1.0'

export const FEATURE_SOURCES = Object.freeze({
  GLOBAL: 'global_analysis',
  LOCAL: 'local_review',
  USER: 'user_correction',
})

export const FEATURE_SOURCE_IDS = Object.freeze(Object.values(FEATURE_SOURCES))

export const FEATURE_STATUSES = Object.freeze({
  CONFIRMED: 'confirmed',
  TENTATIVE: 'tentative',
  UNKNOWN: 'unknown',
})

export const FEATURE_STATUS_IDS = Object.freeze(Object.values(FEATURE_STATUSES))

export const ENTITY_KINDS = Object.freeze([
  'person',
  'animal',
  'creature',
  'object',
  'prop',
  'vehicle',
  'furniture',
  'plant',
  'structure',
  'environment',
  'text',
  'effect',
  'other',
])

export const RELATION_TYPES = Object.freeze([
  'position',
  'occlusion',
  'holding',
  'wearing',
  'accessory',
  'depth_front',
  'depth_behind',
  'gaze',
  'contact',
  'interaction',
])

export const UNCERTAINTY_CODES = Object.freeze([
  'action_inferred',
  'emotion_inferred',
  'occluded_region',
  'focal_length_unknown',
  'lens_effect_ambiguous',
  'entity_ambiguous',
  'out_of_frame',
  'insufficient_detail',
  'unsupported_observation',
])

export const ANALYSIS_PRIORITY = Object.freeze({
  composition: Object.freeze({ weight: 0.3, tier: 'P0', label: '构图与画面组织', default_importance: 1.0 }),
  camera: Object.freeze({ weight: 0.25, tier: 'P0', label: '镜头与视角', default_importance: 0.8333 }),
  subject: Object.freeze({ weight: 0.15, tier: 'P1', label: '主体数量与空间关系', default_importance: 0.5 }),
  pose_action: Object.freeze({ weight: 0.1, tier: 'P1', label: '动作与姿态', default_importance: 0.3333 }),
  clothing_appearance: Object.freeze({ weight: 0.08, tier: 'P1', label: '服装与外观', default_importance: 0.2667 }),
  background: Object.freeze({ weight: 0.05, tier: 'P2', label: '背景与场景', default_importance: 0.1667 }),
  lighting_color: Object.freeze({ weight: 0.04, tier: 'P2', label: '光影与色彩', default_importance: 0.1333 }),
  expression: Object.freeze({ weight: 0.03, tier: 'P2', label: '表情与细节', default_importance: 0.1 }),
})

export const CATEGORY_PRIORITY_KEY = Object.freeze({
  composition: 'composition',
  camera: 'camera',
  subject: 'subject',
  pose_action: 'pose_action',
  clothing: 'clothing_appearance',
  appearance: 'clothing_appearance',
  background: 'background',
  lighting_color: 'lighting_color',
  expression: 'expression',
  quality_style: null,
  suppression: null,
  control: null,
  unsorted: null,
})

export const UNWEIGHTED_DEFAULT_IMPORTANCE = 0.1

export const ANALYSIS_WEIGHT_KEYS = Object.freeze(Object.keys(ANALYSIS_PRIORITY))

export const ANALYSIS_WEIGHT_SUM_TOLERANCE = 0.001

export function importanceOverridesFromWeights(weights) {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) return {}
  const usable = {}
  for (const key of ANALYSIS_WEIGHT_KEYS) {
    const value = weights[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) usable[key] = value
  }
  const values = Object.values(usable)
  if (values.length === 0) return {}
  const max = Math.max(...values)

  const out = {}
  for (const [category, key] of Object.entries(CATEGORY_PRIORITY_KEY)) {
    if (!key || usable[key] === undefined) continue
    out[category] = Math.round((usable[key] / max) * 10000) / 10000
  }
  return out
}

export function isNormalizedBox(value) {
  if (!Array.isArray(value) || value.length !== 4) return false
  if (!value.every((n) => typeof n === 'number' && Number.isFinite(n))) return false
  const [x0, y0, x1, y1] = value
  if (x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1) return false
  return x1 > x0 && y1 > y0
}

export function clamp01(value) {
  let n = null
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value)
  if (n === null || !Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n))
}

export function defaultImportanceForCategory(categoryId) {
  const key = CATEGORY_PRIORITY_KEY[categoryId]
  if (!key) return UNWEIGHTED_DEFAULT_IMPORTANCE
  return ANALYSIS_PRIORITY[key].default_importance
}

export function makeFeature(input, { category, key, source = FEATURE_SOURCES.GLOBAL, priorityOverrides = null } = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const confidence = clamp01(raw.confidence) ?? 0

  let importance = clamp01(raw.importance)
  if (importance === null) {
    const override = priorityOverrides && typeof priorityOverrides === 'object' ? priorityOverrides[category] : undefined
    importance = clamp01(override) ?? defaultImportanceForCategory(category)
  }

  const status =
    typeof raw.status === 'string' && FEATURE_STATUS_IDS.includes(raw.status)
      ? raw.status
      : confidence >= 0.75
        ? FEATURE_STATUSES.CONFIRMED
        : FEATURE_STATUSES.TENTATIVE

  const featureSource =
    typeof raw.source === 'string' && FEATURE_SOURCE_IDS.includes(raw.source) ? raw.source : source

  const feature = {
    category: CATEGORY_IDS.has(category) ? category : 'unsorted',
    key: String(key ?? '').trim() || 'unnamed',
    value: normalizeValue(raw.value),
    confidence,
    importance,
    source: featureSource,
    status,
  }

  if (isNormalizedBox(raw.region)) {
    feature.region = raw.region.map((n) => Math.round(n * 10000) / 10000)
  }

  return feature
}

export function normalizeValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.map((s) => s.trim())
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function makeRelation(input, { index = 0 } = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const type = RELATION_TYPES.includes(raw.type) ? raw.type : 'position'
  const relation = {
    relation_id: String(raw.relation_id ?? '').trim() || `rel_${index + 1}`,
    type,
    from: String(raw.from ?? '').trim(),
    to: String(raw.to ?? '').trim(),
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    confidence: clamp01(raw.confidence) ?? 0,
    importance: clamp01(raw.importance) ?? defaultImportanceForCategory('subject'),
    source: FEATURE_SOURCE_IDS.includes(raw.source) ? raw.source : FEATURE_SOURCES.GLOBAL,
    status:
      typeof raw.status === 'string' && FEATURE_STATUS_IDS.includes(raw.status)
        ? raw.status
        : FEATURE_STATUSES.TENTATIVE,
  }
  if (isNormalizedBox(raw.region)) {
    relation.region = raw.region.map((n) => Math.round(n * 10000) / 10000)
  }
  return relation
}

export function makeUncertainty(input, { index = 0 } = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const code = UNCERTAINTY_CODES.includes(raw.code) ? raw.code : 'unsupported_observation'
  const uncertainty = {
    uncertainty_id: String(raw.uncertainty_id ?? '').trim() || `unc_${index + 1}`,
    code,
    subject: typeof raw.subject === 'string' ? raw.subject.trim() : '',
    question: typeof raw.question === 'string' ? raw.question.trim() : '',
    severity: ['low', 'medium', 'high'].includes(raw.severity) ? raw.severity : 'medium',
  }
  if (isNormalizedBox(raw.region)) {
    uncertainty.region = raw.region.map((n) => Math.round(n * 10000) / 10000)
  }
  return uncertainty
}

export function makeEntity(input, { index = 0 } = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const entity = {
    entity_id: String(raw.entity_id ?? '').trim() || `ent_${index + 1}`,
    kind: ENTITY_KINDS.includes(raw.kind) ? raw.kind : 'other',
    label: typeof raw.label === 'string' ? raw.label.trim() : '',
    count: Number.isInteger(raw.count) && raw.count > 0 ? raw.count : 1,
    confidence: clamp01(raw.confidence),
    importance: clamp01(raw.importance) ?? defaultImportanceForCategory('subject'),
    features: [],
  }
  if (isNormalizedBox(raw.region)) {
    entity.region = raw.region.map((n) => Math.round(n * 10000) / 10000)
  }
  if (raw.attributes && typeof raw.attributes === 'object' && !Array.isArray(raw.attributes)) {
    entity.attributes = { ...raw.attributes }
  }
  return entity
}

export function collectFeatures(ir) {
  const out = []
  const push = (feature) => {
    if (feature && typeof feature === 'object') out.push(feature)
  }

  if (Array.isArray(ir?.features)) ir.features.forEach(push)

  for (const section of ['composition', 'camera']) {
    const node = ir?.[section]
    if (!node || typeof node !== 'object') continue
    for (const [key, feature] of Object.entries(node)) {
      if (feature && typeof feature === 'object' && typeof feature.value !== 'undefined') {
        push({ category: section, key, ...feature })
      }
    }
  }

  if (Array.isArray(ir?.entities)) {
    for (const entity of ir.entities) {
      if (!Array.isArray(entity?.features)) continue
      for (const feature of entity.features) {
        push({ entity_id: entity.entity_id, ...feature })
      }
    }
  }

  return out
}

export function featuresByCategory(ir, categoryId) {
  return collectFeatures(ir).filter((feature) => feature.category === categoryId)
}

export function validateIR(ir) {
  const problems = []
  const add = (field_path, message) => problems.push({ field_path, message })

  if (!ir || typeof ir !== 'object') {
    add('', 'IR 必须是对象。')
    return problems
  }
  if (ir.schema_version !== IR_SCHEMA_VERSION) {
    add('schema_version', `期望 ${IR_SCHEMA_VERSION}，实际 ${String(ir.schema_version)}。`)
  }
  for (const field of ['task_id', 'image', 'entities', 'relations', 'features', 'uncertainties']) {
    if (!(field in ir)) add(field, `缺少必需字段 ${field}。`)
  }
  const image = ir.image
  if (!image || typeof image !== 'object') {
    add('image', 'image 必须是对象。')
  } else {
    if (!Number.isInteger(image.width) || image.width <= 0) add('image.width', 'width 必须是正整数。')
    if (!Number.isInteger(image.height) || image.height <= 0) add('image.height', 'height 必须是正整数。')
    if (typeof image.aspect_ratio !== 'string' || image.aspect_ratio.length === 0) {
      add('image.aspect_ratio', 'aspect_ratio 必须是非空字符串。')
    }
    if (typeof image.has_alpha !== 'boolean') add('image.has_alpha', 'has_alpha 必须是布尔值。')
  }
  for (const listField of ['entities', 'relations', 'features', 'uncertainties']) {
    if (listField in ir && !Array.isArray(ir[listField])) add(listField, `${listField} 必须是数组。`)
  }
  if (Array.isArray(ir.entities)) {
    ir.entities.forEach((entity, index) => {
      if (!entity?.entity_id) add(`entities[${index}].entity_id`, 'entity_id 不能为空。')
      if (!ENTITY_KINDS.includes(entity?.kind)) {
        add(`entities[${index}].kind`, `kind 必须是 ${ENTITY_KINDS.join('/')} 之一。`)
      }
    })
  }
  if (Array.isArray(ir.relations)) {
    const ids = new Set((ir.entities ?? []).map((entity) => entity?.entity_id))
    ir.relations.forEach((relation, index) => {
      if (!RELATION_TYPES.includes(relation?.type)) {
        add(`relations[${index}].type`, `type 必须是 ${RELATION_TYPES.join('/')} 之一。`)
      }
      for (const side of ['from', 'to']) {
        if (!relation?.[side]) add(`relations[${index}].${side}`, `${side} 不能为空。`)
        else if (ids.size > 0 && !ids.has(relation[side])) {
          add(`relations[${index}].${side}`, `${side} 指向不存在的实体 ${relation[side]}。`)
        }
      }
    })
  }
  const checkFeatures = (list, base) => {
    if (!Array.isArray(list)) return
    list.forEach((feature, index) => {
      const at = `${base}[${index}]`
      if (!CATEGORY_IDS.has(feature?.category)) {
        add(`${at}.category`, `category 必须是已知的内部分类。`)
      }
      if (typeof feature?.value === 'undefined' || feature?.value === null) {
        add(`${at}.value`, 'value 不能为空。')
      }
      for (const field of ['confidence', 'importance']) {
        const v = feature?.[field]
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
          add(`${at}.${field}`, `${field} 必须是 [0,1] 内的数字。`)
        }
      }
      if (!FEATURE_SOURCE_IDS.includes(feature?.source)) {
        add(`${at}.source`, `source 必须是 ${FEATURE_SOURCE_IDS.join('/')} 之一。`)
      }
      if (!FEATURE_STATUS_IDS.includes(feature?.status)) {
        add(`${at}.status`, `status 必须是 ${FEATURE_STATUS_IDS.join('/')} 之一。`)
      }
      if ('region' in (feature ?? {}) && !isNormalizedBox(feature.region)) {
        add(`${at}.region`, 'region 必须是 [x0,y0,x1,y1] 形式的归一化坐标。')
      }
    })
  }
  checkFeatures(ir.features, 'features')
  if (Array.isArray(ir.entities)) {
    ir.entities.forEach((entity, entityIndex) => {
      checkFeatures(entity?.features, `entities[${entityIndex}].features`)
    })
  }
  if (Array.isArray(ir.uncertainties)) {
    ir.uncertainties.forEach((item, index) => {
      if (!UNCERTAINTY_CODES.includes(item?.code)) {
        add(`uncertainties[${index}].code`, `code 必须是已知的不确定项代码。`)
      }
    })
  }
  return problems
}

export const IR_CATEGORY_ORDER = Object.freeze(INTERNAL_CATEGORIES.map((category) => category.category_id))
