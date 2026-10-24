
import { makeEntity, makeFeature, makeRelation, makeUncertainty, validateIR, IR_SCHEMA_VERSION, FEATURE_SOURCES } from './schema.js'

const NAMED_SECTIONS = new Set(['composition', 'camera'])

export function shortId(prefix = 'id') {
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 7)
  return `${prefix}_${stamp}${rand}`
}

export function createIR({ taskId, image, provenance = {} } = {}) {
  const width = Number(image?.width) || 0
  const height = Number(image?.height) || 0
  return {
    schema_version: IR_SCHEMA_VERSION,
    task_id: String(taskId ?? '').trim() || shortId('task'),
    created_at: new Date().toISOString(),
    image: {
      width,
      height,
      aspect_ratio: String(image?.aspect_ratio ?? ''),
      has_alpha: image?.has_alpha === true,
      src_format: String(image?.src_format ?? ''),
      decoded_via: String(image?.decoded_via ?? ''),
      source_width: Number(image?.source_width) || width,
      source_height: Number(image?.source_height) || height,
      scale: typeof image?.scale === 'number' ? image.scale : 1,
      orientation_applied: Number(image?.orientation_applied) || 1,
      transparent_ratio: typeof image?.transparent_ratio === 'number' ? image.transparent_ratio : null,
    },
    scene: { summary: null },
    composition: {},
    camera: {},
    entities: [],
    relations: [],
    features: [],
    uncertainties: [],
    provenance: { ...provenance },
  }
}

export function setNamedFeature(ir, category, key, input, options = {}) {
  if (!NAMED_SECTIONS.has(category)) {
    throw new Error(`setNamedFeature 只接受 composition / camera，收到 ${category}`)
  }
  const feature = makeFeature(input, { category, key, ...options })
  delete feature.category
  delete feature.key
  ir[category][String(key)] = feature
  return feature
}

export function addFeature(ir, category, key, input, options = {}) {
  const feature = makeFeature(input, { category, key, ...options })
  ir.features.push(feature)
  return feature
}

export function addEntity(ir, input) {
  const entity = makeEntity(input, { index: ir.entities.length })
  ir.entities.push(entity)
  return entity
}

export function addEntityFeature(ir, entityId, category, key, input, options = {}) {
  const entity = ir.entities.find((item) => item.entity_id === entityId)
  if (!entity) throw new Error(`实体不存在：${entityId}`)
  const feature = makeFeature(input, { category, key, ...options })
  entity.features.push(feature)
  return feature
}

export function addRelation(ir, input) {
  const relation = makeRelation(input, { index: ir.relations.length })
  ir.relations.push(relation)
  return relation
}

export function addUncertainty(ir, input) {
  const uncertainty = makeUncertainty(input, { index: ir.uncertainties.length })
  ir.uncertainties.push(uncertainty)
  return uncertainty
}

export function applyLocalReview(ir, findings, { cropId = null } = {}) {
  const applied = []
  const features = Array.isArray(findings?.features) ? findings.features : []
  for (const raw of features) {
    const category = raw?.category
    const key = String(raw?.key ?? '').trim()
    if (!category || !key) continue

    if (NAMED_SECTIONS.has(category)) {
      const existing = ir[category][key]
      const incoming = makeFeature(raw, { category, key, source: FEATURE_SOURCES.LOCAL })
      if (!existing || incoming.confidence >= existing.confidence) {
        ir[category][key] = (() => {
          const copy = { ...incoming }
          delete copy.category
          delete copy.key
          return copy
        })()
        applied.push({ category, key, action: 'replaced' })
      } else {
        addUncertainty(ir, {
          code: 'insufficient_detail',
          subject: `${category}.${key}`,
          question: `局部复核（${cropId ?? '未命名裁剪'}）给出了更低置信度的不同结论：${String(incoming.value)}`,
          severity: 'low',
          region: incoming.region,
        })
        applied.push({ category, key, action: 'kept_global' })
      }
      continue
    }

    const index = ir.features.findIndex((item) => item.category === category && item.key === key)
    const incoming = makeFeature(raw, { category, key, source: FEATURE_SOURCES.LOCAL })

    const owner = findEntityFeatureOwner(ir, category, key)
    if (owner) {
      if (incoming.confidence >= (owner.feature.confidence ?? 0)) {
        owner.entity.features[owner.index] = incoming
        applied.push({ category, key, action: 'replaced', entity_id: owner.entity.entity_id })
      } else {
        applied.push({ category, key, action: 'kept_global', entity_id: owner.entity.entity_id })
      }
      continue
    }

    if (index === -1) {
      ir.features.push(incoming)
      applied.push({ category, key, action: 'added' })
    } else if (incoming.confidence >= ir.features[index].confidence) {
      ir.features[index] = incoming
      applied.push({ category, key, action: 'replaced' })
    } else {
      applied.push({ category, key, action: 'kept_global' })
    }
  }

  const entityFindings = Array.isArray(findings?.entities) ? findings.entities : []
  for (const raw of entityFindings) {
    const entity = ir.entities.find((item) => item.entity_id === raw?.entity_id)
    if (!entity) continue
    for (const feature of Array.isArray(raw?.features) ? raw.features : []) {
      const category = feature?.category
      const key = String(feature?.key ?? '').trim()
      if (!category || !key) continue
      const existing = entity.features.find((item) => item.category === category && item.key === key)
      const incoming = makeFeature(feature, { category, key, source: FEATURE_SOURCES.LOCAL })
      if (existing && existing.confidence > incoming.confidence) continue
      if (existing) Object.assign(existing, incoming)
      else entity.features.push(incoming)
      applied.push({ category, key, action: existing ? 'replaced' : 'added', entity_id: entity.entity_id })
    }
  }

  return applied
}

function findEntityFeatureOwner(ir, category, key) {
  const matches = []
  for (const entity of ir.entities ?? []) {
    const index = entity.features.findIndex((item) => item.category === category && item.key === key)
    if (index !== -1) matches.push({ entity, index, feature: entity.features[index] })
  }
  return matches.length === 1 ? matches[0] : null
}

export function finalizeIR(ir) {
  const problems = validateIR(ir)
  ir.validation = { ok: problems.length === 0, problems }
  return ir
}

export function summarizeIR(ir, { maxFeatures = 24 } = {}) {
  const features = []
  const push = (category, key, feature) => {
    if (!feature) return
    features.push({ category, key, value: feature.value, confidence: feature.confidence, importance: feature.importance, status: feature.status })
  }
  for (const [key, feature] of Object.entries(ir.composition ?? {})) push('composition', key, feature)
  for (const [key, feature] of Object.entries(ir.camera ?? {})) push('camera', key, feature)
  for (const feature of ir.features ?? []) push(feature.category, feature.key, feature)

  features.sort((a, b) => b.importance - a.importance || b.confidence - a.confidence)

  return {
    task_id: ir.task_id,
    image: ir.image,
    scene_summary: ir.scene?.summary ?? null,
    entities: (ir.entities ?? []).map((entity) => ({
      entity_id: entity.entity_id,
      kind: entity.kind,
      label: entity.label,
      count: entity.count,
      region: entity.region ?? null,
    })),
    relations: (ir.relations ?? []).map((relation) => ({
      type: relation.type,
      from: relation.from,
      to: relation.to,
      description: relation.description,
      status: relation.status,
    })),
    features: features.slice(0, maxFeatures),
    feature_count: features.length,
    uncertainties: ir.uncertainties ?? [],
    validation: ir.validation ?? null,
  }
}
