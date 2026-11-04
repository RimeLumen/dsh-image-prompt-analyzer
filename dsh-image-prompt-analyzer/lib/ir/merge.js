import { CATEGORY_IDS } from '../config/categories.js'
import { FEATURE_SOURCES, FEATURE_STATUSES, makeFeature } from './schema.js'

/** 归一化框的 IoU。这里自带一份，避免 ir 层反向依赖 vision 层。 */
function boxIoU(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return 0
  const [ax0, ay0, ax1, ay1] = a
  const [bx0, by0, bx1, by1] = b
  const w = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0))
  const h = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0))
  const inter = w * h
  const areaA = Math.max(0, ax1 - ax0) * Math.max(0, ay1 - ay0)
  const areaB = Math.max(0, bx1 - bx0) * Math.max(0, by1 - by0)
  const union = areaA + areaB - inter
  return union <= 0 ? 0 : inter / union
}

/** 二次观察的结果落回既有 IR 时的四种结局。 */
export const MERGE_OUTCOMES = Object.freeze({
  REPLACED: 'replaced',
  ADDED: 'added',
  KEPT: 'kept',
  UNCHANGED: 'unchanged',
})

const NAMED_CATEGORIES = new Set(['composition', 'camera'])

/** 挂到实体身上的分类：这类观察属于某个主体，不该塞进全局 features。 */
const ENTITY_SCOPED = new Set(['appearance', 'clothing', 'pose_action', 'expression'])

/** 小写、下划线转空格、压空白、去尾部标点——只用于比较，不写回 IR。 */
export function normalizeForCompare(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/[.,;!?、，。；！？]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cloneIR(ir) {
  return JSON.parse(JSON.stringify(ir))
}

function findGlobalFeature(ir, category, key) {
  return ir.features.find((feature) => feature.category === category && feature.key === key) ?? null
}

function findNamedFeature(ir, category, key) {
  return ir[category]?.[key] ?? null
}

function pickEntityForBox(ir, box) {
  let best = null
  let bestIoU = 0
  for (const entity of ir.entities ?? []) {
    if (!Array.isArray(entity?.region)) continue
    const iou = boxIoU(entity.region, box)
    if (iou > bestIoU) {
      bestIoU = iou
      best = entity
    }
  }
  // 0.15 是宽松阈值：二次观察的框常常比主体大一圈，压太严会把观察挂到空气里。
  return bestIoU >= 0.15 ? best : null
}

function applyOne(ir, observation, { box, mode }) {
  const category = CATEGORY_IDS.has(observation.category) ? observation.category : 'unsorted'
  const key = String(observation.key ?? '').trim()
  if (!key) return { outcome: MERGE_OUTCOMES.UNCHANGED, reason: 'no_key' }

  const incoming = makeFeature(
    { ...observation, region: observation.region ?? box ?? null },
    { category, key, source: FEATURE_SOURCES.LOCAL },
  )
  if (incoming.value === null || incoming.value === '') {
    return { outcome: MERGE_OUTCOMES.UNCHANGED, reason: 'empty_value' }
  }

  const entity = ENTITY_SCOPED.has(category) && box ? pickEntityForBox(ir, box) : null

  if (entity) {
    const existing =
      (entity.features ?? []).find((feature) => feature.category === category && feature.key === key) ?? null
    if (!existing) {
      const stored = { ...incoming, source: FEATURE_SOURCES.LOCAL }
      entity.features = [...(entity.features ?? []), stored]
      return { outcome: MERGE_OUTCOMES.ADDED, entity_id: entity.entity_id, feature: stored }
    }
    return resolveConflict(existing, incoming, { category, key, entity_id: entity.entity_id })
  }

  const existing = NAMED_CATEGORIES.has(category)
    ? findNamedFeature(ir, category, key)
    : findGlobalFeature(ir, category, key)

  if (!existing) {
    const stored = { ...incoming, source: FEATURE_SOURCES.LOCAL }
    if (NAMED_CATEGORIES.has(category)) {
      delete stored.category
      delete stored.key
      ir[category][key] = stored
    } else {
      ir.features.push(stored)
    }
    return { outcome: MERGE_OUTCOMES.ADDED, feature: stored }
  }

  return resolveConflict(existing, incoming, { category, key })
}

function resolveConflict(existing, incoming, { category, key, entity_id = null }) {
  const before = normalizeForCompare(existing.value)
  const after = normalizeForCompare(incoming.value)

  if (before === after) {
    // 同一个事实被第二次看到：提高置信度，别的都不动。
    existing.confidence = Math.max(Number(existing.confidence) || 0, Number(incoming.confidence) || 0)
    if (existing.status !== FEATURE_STATUSES.CONFIRMED && incoming.status === FEATURE_STATUSES.CONFIRMED) {
      existing.status = FEATURE_STATUSES.CONFIRMED
    }
    return { outcome: MERGE_OUTCOMES.UNCHANGED, feature: existing }
  }

  const oldConfidence = Number(existing.confidence) || 0
  const newConfidence = Number(incoming.confidence) || 0
  if (newConfidence + 0.05 < oldConfidence) {
    // 更模糊的观察不能推翻更确定的观察，只记录下来供审计。
    return {
      outcome: MERGE_OUTCOMES.KEPT,
      reason: 'lower_confidence',
      category,
      key,
      entity_id,
      kept: existing.value,
      rejected: incoming.value,
      confidence_gap: Math.round((oldConfidence - newConfidence) * 1000) / 1000,
    }
  }

  const from = existing.value
  existing.value = incoming.value
  existing.confidence = Math.max(oldConfidence, newConfidence)
  existing.status = incoming.status ?? existing.status
  if (incoming.region) existing.region = incoming.region
  existing.source = FEATURE_SOURCES.LOCAL
  return { outcome: MERGE_OUTCOMES.REPLACED, category, key, entity_id, from, to: existing.value }
}

/**
 * 把二次观察合并进一份 IR。rules：
 * 1. 事实不同且新观察置信度不低于旧的 → 替换；
 * 2. 更模糊的观察不推翻更确定的 → 保留旧值，记一条 kept 供审计；
 * 3. 旧 IR 里没有的 key → 补齐；
 * 4. 只认允许的分类；实体类观察优先挂到框重叠最多的实体上。
 */
export function mergeRevisitIR(ir, observations, { boxes = [], mode = 'grid' } = {}) {
  const merged = cloneIR(ir)
  const diff = {
    mode,
    boxes: boxes.map((box) => box.map((n) => Math.round(n * 10000) / 10000)),
    replaced: [],
    added: [],
    kept: [],
    unchanged: 0,
    ignored: 0,
  }

  const list = Array.isArray(observations) ? observations : []
  for (const observation of list) {
    const category = CATEGORY_IDS.has(observation?.category) ? observation.category : null
    // 观察必须落在一个被复核过的框里，否则说明模型在描述框外，整条丢弃。
    const box =
      Array.isArray(observation?.region) && observation.region.length === 4
        ? observation.region
        : Array.isArray(observation?.box) && observation.box.length === 4
          ? observation.box
          : null
    if (!category) {
      diff.ignored += 1
      continue
    }
    const result = applyOne(merged, { ...observation, category }, { box, mode })
    if (result.outcome === MERGE_OUTCOMES.REPLACED) diff.replaced.push(result)
    else if (result.outcome === MERGE_OUTCOMES.ADDED) diff.added.push(result)
    else if (result.outcome === MERGE_OUTCOMES.KEPT) diff.kept.push(result)
    else diff.unchanged += 1
  }

  diff.summary = {
    replaced: diff.replaced.length,
    added: diff.added.length,
    kept: diff.kept.length,
    unchanged: diff.unchanged,
    ignored: diff.ignored,
  }
  return { ir: merged, diff }
}

/** 词级差异：给面板显示"这条提示词到底变了什么"。 */
export function diffPromptTerms(beforeTerms, afterTerms) {
  const key = (term) => {
    const text = typeof term === 'string' ? term : (term?.text ?? term?.value ?? '')
    return normalizeForCompare(text)
  }
  const before = new Map()
  for (const term of beforeTerms ?? []) {
    const name = key(term)
    if (name) before.set(name, term)
  }
  const after = new Map()
  for (const term of afterTerms ?? []) {
    const name = key(term)
    if (name) after.set(name, term)
  }
  const added = [...after.keys()].filter((name) => !before.has(name))
  const removed = [...before.keys()].filter((name) => !after.has(name))
  return { added, removed, kept: [...after.keys()].filter((name) => before.has(name)).length }
}

export { NAMED_CATEGORIES, ENTITY_SCOPED }