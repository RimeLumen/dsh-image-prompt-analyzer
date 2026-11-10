
import { isNormalizedBox, makeEntity, makeFeature, makeRelation, makeUncertainty, validateIR, IR_SCHEMA_VERSION, FEATURE_SOURCES } from './schema.js'

const NAMED_SECTIONS = new Set(['composition', 'camera'])

/**
 * 阶段 B 的观察里，"这里没有 / 这里看不到"这一类**缺席断言**。
 *
 * 阶段 B 只看到一块裁图。它说"这里看不到剑"，能成立的只有"这块裁图里看不到"；
 * 说"这里没有剑"，也只能说明它看的那块没有。任务清单第 84 行要的正是这条：
 * 局部"没看到"不能解释成全图不存在。
 *
 * 但下游没有任何地方能分辨这两种说法——`value` 到了合并层就只是一段字符串。
 * 所以只能在这里认出来，并且**一律不写进 ir.features / entity.features**：
 * 写进去之后，`not visible in this crop` 会把整图已经确认的 `sword sheathed at hip`
 * 覆盖掉（局部被裁掉 ≠ 全图没有），`no sword at the waist` 会凭空造出一条"不存在"。
 */
const ABSENCE_PATTERNS = [
  /\bnot visible\b/,
  /\bnot present\b/,
  /\babsent\b/,
  /\bmissing\b/,
  /\b(?:can ?not|can't|could ?not|couldn't) see\b/,
  /\b(?:is|are|was|were|isn't|aren't|wasn't|weren't)\s+not (?:there|visible|present)\b/,
  /\bnot (?:there|shown|included)\b/,
  /\bnothing (?:visible|present)\b/,
  // "no sword at the waist" / "no visible structures" / "no background elements"
  /\bno\s+[a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3}\s+(?:at|on|in|near|around|behind|under|above|across|over)\b/,
  /\bno\s+(?:[a-z-]+\s+){0,2}(?:visible|present)\b/,
  /\bno\s+[a-z-]+\s*$/,
  /\bcut off\b/,
  /\bcropped out\b/,
  /\bout of (?:the )?(?:frame|crop|view|shot)\b/,
  /\boff[ -]?frame\b/,
  /\boutside (?:the )?(?:crop|frame|view|shot)\b/,
  /\bhidden by (?:the )?(?:crop|frame|edge)\b/,
]

/**
 * 中文的缺席断言。与 `terms.js` 里的 `NEGATION_PATTERNS_ZH` 分开：那边管"这句话是
 * 否定式、不该进正向词"，这边管"这句话是局部裁图推出来的、不能当全图事实"。
 * 判定顺序也不同——`localAbsenceScope` 返回的 `crop` / `frame` 决定合并策略。
 */
const ABSENCE_PATTERNS_ZH = [
  /(?:看不到|看不见|未见|没有|不存在|缺少|不包含)/,
  /(?:被|给)?(?:裁掉|切掉|裁出画面|挡在画面外|在画外|不在画面内)/,
  /(?:不可见|无法看清|辨认不出)/,
]

/** 这句话自己就限定了"在裁图 / 画幅范围内"。 */
const CROP_SCOPE_PATTERN = /\b(?:(?:in|within|from) (?:this|the) (?:crop|frame|view|shot)|(?:by|at|near) the (?:crop|frame) edge|(?:crop|frame) edge|cropped out|out of (?:the )?(?:frame|crop|view|shot)|off[ -]?frame|outside (?:the )?(?:crop|frame|view|shot))\b/

/** 中文的裁图范围限定。 */
const CROP_SCOPE_PATTERN_ZH = /(?:这块|这块裁图|裁图里|裁图内|局部|画面边缘|画框外|画外|画面外|超出画面|被裁掉|被切掉)/

/**
 * 判定一条阶段 B 观察是不是缺席断言。
 * - `null`  不是缺席断言，是普通外观描述，照常合并。
 * - `'crop'` 是缺席断言，而且这句话自己说了只看得到裁图——它本来就只对裁图成立。
 * - `'frame'` 是缺席断言，但没有限定范围：它是从一个局部推出的一句话。
 */
export function localAbsenceScope(value) {
  const text = String(value ?? '').toLowerCase()
  if (!text.trim()) return null
  const zh = ABSENCE_PATTERNS_ZH.some((pattern) => pattern.test(text))
  if (!zh && !ABSENCE_PATTERNS.some((pattern) => pattern.test(text))) return null
  if (zh) return CROP_SCOPE_PATTERN_ZH.test(text) ? 'crop' : 'frame'
  return CROP_SCOPE_PATTERN.test(text) ? 'crop' : 'frame'
}

export function shortId(prefix = 'id') {
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 7)
  return `${prefix}_${stamp}${rand}`
}

export function createIR({ taskId, image, provenance = {}, observationLanguage = 'en' } = {}) {
  const width = Number(image?.width) || 0
  const height = Number(image?.height) || 0
  return {
    schema_version: IR_SCHEMA_VERSION,
    task_id: String(taskId ?? '').trim() || shortId('task'),
    created_at: new Date().toISOString(),
    // 观察值是用哪种语言写下来的。Caption 编译要靠它判断"这份 IR 能不能出中文"，
    // 而不是靠猜：一份英语 IR 硬要出中文，只可能是翻译，而这里不做翻译。
    observation_language: String(observationLanguage ?? 'en') === 'zh-CN' ? 'zh-CN' : 'en',
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

/**
 * 裁图局部坐标 → 原图坐标。
 *
 * 阶段 B 看到的是从原图裁出来的一小块，它报的 `region` 是**这块裁图里**的相对位置。
 * 原样塞进 IR 会被下游当成"整图里的位置"——同一个 `[0.1, 0.05, 0.4, 0.3]`，
 * 在整图里是左上角，在这块裁图里可能是画面右侧人物的脸。两者不能混。
 */
export function mapCropBoxToImage(box, cropBox) {
  if (!isNormalizedBox(box)) return null
  if (!isNormalizedBox(cropBox)) return null
  const [cx0, cy0, cx1, cy1] = cropBox
  const width = cx1 - cx0
  const height = cy1 - cy0
  const round4 = (n) => Math.round(n * 10000) / 10000
  const clamp = (n) => Math.min(1, Math.max(0, n))
  return [
    round4(clamp(cx0 + box[0] * width)),
    round4(clamp(cy0 + box[1] * height)),
    round4(clamp(cx0 + box[2] * width)),
    round4(clamp(cy0 + box[3] * height)),
  ]
}

/** 交集占较小那个框的比例。用较小框做分母，是因为"裁图整个落在人物身上"也算重叠。 */
function boxOverlap(a, b) {
  if (!isNormalizedBox(a) || !isNormalizedBox(b)) return 0
  const x0 = Math.max(a[0], b[0])
  const y0 = Math.max(a[1], b[1])
  const x1 = Math.min(a[2], b[2])
  const y1 = Math.min(a[3], b[3])
  if (x1 <= x0 || y1 <= y0) return 0
  const intersection = (x1 - x0) * (y1 - y0)
  const areaA = (a[2] - a[0]) * (a[3] - a[1])
  const areaB = (b[2] - b[0]) * (b[3] - b[1])
  const smaller = Math.min(areaA, areaB)
  return smaller <= 0 ? 0 : intersection / smaller
}

/**
 * 这条观察该挂到哪个人物身上。
 *
 * 优先级：明确写了的 entity_id > 只有一家带同名 key > 裁图与哪个人物真的重叠 > 待裁决。
 * **较高的自报 confidence 不能单独决定覆盖谁**——它只说明"我看得清楚"，
 * 不说明"我看的是这个人"。两家都有 `clothing.accessory` 时，
 * 谁置信度高就盖掉谁，是拿置信度冒充归属证据。
 */
function resolveEntityBinding(ir, category, key, raw, cropBox) {
  const declared = String(raw?.entity_id ?? '').trim()
  if (declared) {
    const hit = (ir.entities ?? []).find((item) => item.entity_id === declared)
    return hit ? { kind: 'explicit', entity: hit } : { kind: 'unknown_id', entity_id: declared }
  }

  const matches = []
  for (const entity of ir.entities ?? []) {
    if (!Array.isArray(entity?.features)) continue
    if (entity.features.some((item) => item.category === category && item.key === key)) matches.push(entity)
  }
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length === 1) return { kind: 'unique', entity: matches[0] }

  if (isNormalizedBox(cropBox)) {
    const overlapped = matches.filter((entity) => boxOverlap(cropBox, entity.region) >= 0.5)
    if (overlapped.length === 1) return { kind: 'spatial', entity: overlapped[0] }
    if (overlapped.length > 1) return { kind: 'ambiguous', candidates: overlapped.map((item) => item.entity_id) }
  }
  return { kind: 'ambiguous', candidates: matches.map((item) => item.entity_id) }
}

/**
 * 局部复核（阶段 B）的合并契约。
 *
 * 四条通道都必须有着落：features / entities / relations / uncertainties。
 * 每一条要么进了 IR，要么在返回值里写明**为什么没进**——静默 `continue` 是不允许的，
 * 那会让"阶段 B 看过但结论丢了"和"阶段 B 什么都没说"看起来完全一样。
 *
 * 返回 `{ applied, rejected, pending, unmapped, crop_id, crop_box }`：
 * - `applied`  进了 IR 的，带 action（added / replaced / kept_global / matched）
 * - `rejected` 明确拒收的，带 reason（端点不存在、缺 category/key、空实体声明…）
 * - `pending`  看到了但判不出归属的，同时落一条 entity_ambiguous 的 uncertainty
 * - `unmapped` 没能回映到原图坐标的，带原始 crop-local 值与原因
 */
export function applyLocalReview(ir, findings, { cropId = null, cropBox = null } = {}) {
  const applied = []
  const rejected = []
  const pending = []
  const unmapped = []
  const label = cropId ?? '未命名裁剪'

  // 局部缺席断言：记在这里，不写进 IR。
  // 记下来的目的不是丢掉它——是让它保留"只在裁图里成立"这个前提，
  // 同时**不改动**整图已有的那条观察。scope 为 'frame' 的还要落一条 uncertainty，
  // 因为它是一个从局部推出来的全图结论，需要看整图才能确认。
  const cropLocal = []
  const recordAbsence = (category, key, raw, scope, entityId = null) => {
    const mapped = mapRegion(raw?.region, `absence:${category}.${key}`)
    const pool = entityId
      ? ((ir.entities ?? []).find((item) => item.entity_id === entityId)?.features ?? [])
      : ir.features
    const existing = NAMED_SECTIONS.has(category)
      ? (ir[category]?.[key] ?? null)
      : (pool.find((item) => item.category === category && item.key === key) ?? null)
    const kept = existing ? String(existing.value ?? '') : null
    const value = String(raw?.value ?? '')
    cropLocal.push({
      category,
      key,
      entity_id: entityId,
      value,
      scope,
      kept_global: kept,
      crop_id: cropId,
      region: mapped.region ?? null,
      region_space: mapped.space ?? null,
    })
    if (scope !== 'frame') return
    // 同一条观察会被好几块裁图分别复核（`model_request_*`、`pose_axes_*`、
    // 每个维度的整维补漏……）。每块都各写一条待裁决事实，结果就是同一句质疑
    // 在 IR 里堆成四条，除了裁图编号以外一字不差——看的人以为发现了四个问题。
    // 按「哪条观察 + 它想断言什么」合并：同一件事只留一条，把提过它的裁图
    // 全部记在 `crop_ids` 里。合并的是重复，不是信息。
    const subject = `${category}.${key}`
    const needle = `「${value}」`
    const same = (ir.uncertainties ?? []).find(
      (item) => item?.code === 'unsupported_observation' && item?.subject === subject && String(item?.question ?? '').includes(needle),
    )
    if (same) {
      same.crop_ids = [...new Set([...(same.crop_ids ?? []), cropId].filter(Boolean))]
      return
    }
    addUncertainty(ir, {
      code: 'unsupported_observation',
      subject,
      question: kept
        ? `局部复核从裁图里得出「${value}」，但整图已有「${kept}」。局部看不到不能说明全图不存在，原观察没有被覆盖，需要看整图确认。`
        : `局部复核从裁图里得出「${value}」，但这只是裁图范围内的结论，没有写进整图观察。局部看不到不能说明全图不存在，需要看整图确认。`,
      severity: 'medium',
      region: mapped.region ?? null,
      crop_ids: [cropId],
    })
  }

  const reject = (kind, reason, extra = {}) => {
    rejected.push({ kind, reason, crop_id: cropId, ...extra })
  }

  // 坐标：能回映就回映成原图坐标；回映不了就**标明**这是裁图内的坐标，
  // 而不是假装它已经是原图坐标。
  const mapRegion = (region, where) => {
    if (!isNormalizedBox(region)) return { region: null, space: null }
    if (isNormalizedBox(cropBox)) return { region: mapCropBoxToImage(region, cropBox), space: 'image_global' }
    unmapped.push({ where, region: [...region], reason: 'crop_box_unknown', crop_id: cropId })
    return { region: [...region], space: 'crop_local' }
  }

  const attach = (target, mapped) => {
    if (mapped.region) target.region = mapped.region
    if (mapped.space) target.region_space = mapped.space
    if (cropId) target.review_crop_id = cropId
    return target
  }

  const mergeEntityFeature = (entity, category, key, raw) => {
    const incoming = makeFeature(raw, { category, key, source: FEATURE_SOURCES.LOCAL })
    attach(incoming, mapRegion(raw?.region, `entity:${entity.entity_id}:${category}.${key}`))
    const existing = entity.features.find((item) => item.category === category && item.key === key)
    if (!existing) {
      entity.features.push(incoming)
      applied.push({ kind: 'feature', entity_id: entity.entity_id, category, key, action: 'added' })
      return
    }
    if (incoming.confidence < (existing.confidence ?? 0)) {
      // 不覆盖，但记下来：这条不是"没看到"，是"看到了但原来的更可信"。
      applied.push({
        kind: 'feature',
        entity_id: entity.entity_id,
        category,
        key,
        action: 'kept_global',
        incoming_confidence: incoming.confidence,
        existing_confidence: existing.confidence ?? null,
      })
      return
    }
    Object.assign(existing, incoming)
    applied.push({ kind: 'feature', entity_id: entity.entity_id, category, key, action: 'replaced' })
  }

  // ── entities：先建实体，relations 才有端点可用 ──────────────────
  const localIds = new Map()
  const entityFindings = Array.isArray(findings?.entities) ? findings.entities : []
  for (const [index, raw] of entityFindings.entries()) {
    const declared = String(raw?.entity_id ?? '').trim()
    const existing = declared ? (ir.entities ?? []).find((item) => item.entity_id === declared) : null
    const rawFeatures = Array.isArray(raw?.features) ? raw.features : []

    if (existing) {
      localIds.set(declared, existing.entity_id)
      applied.push({ kind: 'entity', entity_id: existing.entity_id, action: 'matched' })
      for (const feature of rawFeatures) {
        const category = String(feature?.category ?? '').trim()
        const key = String(feature?.key ?? '').trim()
        if (!category || !key) {
          reject('feature', 'feature_missing_category_or_key', { entity_id: existing.entity_id, value: feature?.value ?? null })
          continue
        }
        const scope = localAbsenceScope(feature?.value)
        if (scope) {
          recordAbsence(category, key, feature, scope, existing.entity_id)
          continue
        }
        mergeEntityFeature(existing, category, key, feature)
      }
      continue
    }

    const hasLabel = typeof raw?.label === 'string' && raw.label.trim() !== ''
    const hasRegion = isNormalizedBox(raw?.region)
    if (!hasLabel && rawFeatures.length === 0 && !hasRegion) {
      reject('entity', 'entity_empty', {
        entity_id: declared || null,
        detail: '既没有 label，也没有 features 和 region，无法作为实体接纳',
      })
      continue
    }

    const fallbackId = `local_${String(cropId ?? 'crop').replace(/[^A-Za-z0-9_]/g, '_')}_${index + 1}`
    const entity = makeEntity({ ...raw, entity_id: declared || fallbackId }, { index: ir.entities.length })
    attach(entity, mapRegion(raw?.region, `entity:${declared || fallbackId}`))
    ir.entities.push(entity)
    if (declared) localIds.set(declared, entity.entity_id)
    applied.push({ kind: 'entity', entity_id: entity.entity_id, action: 'added', generated_id: declared === '', label: entity.label })

    for (const feature of rawFeatures) {
      const category = String(feature?.category ?? '').trim()
      const key = String(feature?.key ?? '').trim()
      if (!category || !key) {
        reject('feature', 'feature_missing_category_or_key', { entity_id: entity.entity_id, value: feature?.value ?? null })
        continue
      }
      const scope = localAbsenceScope(feature?.value)
      if (scope) {
        recordAbsence(category, key, feature, scope, entity.entity_id)
        continue
      }
      mergeEntityFeature(entity, category, key, feature)
    }
  }

  // ── features：命名段 / 实体绑定 / 全局 ──────────────────────────
  const features = Array.isArray(findings?.features) ? findings.features : []
  for (const raw of features) {
    const category = String(raw?.category ?? '').trim()
    const key = String(raw?.key ?? '').trim()
    if (!category || !key) {
      reject('feature', 'feature_missing_category_or_key', { value: raw?.value ?? null })
      continue
    }

    // 局部缺席断言：不写进 IR，改记 crop_local（理由见 localAbsenceScope 上方）。
    // 顺手把归属也算出来，只为了在记录里写清"它本来会挂到谁身上"。
    const absenceScope = localAbsenceScope(raw?.value)
    if (absenceScope) {
      const owner = resolveEntityBinding(ir, category, key, raw, cropBox)
      const ownerId = (owner.kind === 'explicit' || owner.kind === 'unique' || owner.kind === 'spatial')
        ? owner.entity.entity_id
        : null
      recordAbsence(category, key, raw, absenceScope, ownerId)
      continue
    }

    if (NAMED_SECTIONS.has(category)) {
      const existing = ir[category][key]
      const incoming = makeFeature(raw, { category, key, source: FEATURE_SOURCES.LOCAL })
      attach(incoming, mapRegion(raw?.region, `feature:${category}.${key}`))
      if (!existing || incoming.confidence >= existing.confidence) {
        const copy = { ...incoming }
        delete copy.category
        delete copy.key
        ir[category][key] = copy
        applied.push({ kind: 'feature', category, key, action: 'replaced' })
      } else {
        addUncertainty(ir, {
          code: 'insufficient_detail',
          subject: `${category}.${key}`,
          question: `局部复核（${label}）给出了更低置信度的不同结论：${String(incoming.value)}`,
          severity: 'low',
          region: incoming.region,
        })
        applied.push({ kind: 'feature', category, key, action: 'kept_global' })
      }
      continue
    }

    const binding = resolveEntityBinding(ir, category, key, raw, cropBox)
    if (binding.kind === 'explicit' || binding.kind === 'unique' || binding.kind === 'spatial') {
      mergeEntityFeature(binding.entity, category, key, raw)
      continue
    }
    if (binding.kind === 'unknown_id') {
      reject('feature', 'entity_id_unknown', { category, key, entity_id: binding.entity_id, value: raw?.value ?? null })
      continue
    }
    if (binding.kind === 'ambiguous') {
      const incoming = makeFeature(raw, { category, key, source: FEATURE_SOURCES.LOCAL })
      const mapped = mapRegion(raw?.region, `feature:${category}.${key}`)
      attach(incoming, mapped)
      pending.push({
        category,
        key,
        value: incoming.value,
        candidates: binding.candidates,
        crop_id: cropId,
        region: incoming.region ?? null,
        region_space: mapped.space,
      })
      addUncertainty(ir, {
        code: 'entity_ambiguous',
        subject: `${category}.${key}`,
        question: `局部复核（${label}）看到「${String(incoming.value)}」，但画面里有 ${binding.candidates.length} 个人物都带着 ${category}.${key}（${binding.candidates.join(' / ')}），裁图范围不足以判定属于哪一个。这条观察没有写进任何一个人物，需要指认归属。`,
        severity: 'medium',
        region: incoming.region,
      })
      continue
    }

    // 没有任何人物带这个 key：作为全局观察，照旧按置信度决定新增还是覆盖。
    const incoming = makeFeature(raw, { category, key, source: FEATURE_SOURCES.LOCAL })
    attach(incoming, mapRegion(raw?.region, `feature:${category}.${key}`))
    const index = ir.features.findIndex((item) => item.category === category && item.key === key)
    if (index === -1) {
      ir.features.push(incoming)
      applied.push({ kind: 'feature', category, key, action: 'added' })
    } else if (incoming.confidence >= ir.features[index].confidence) {
      ir.features[index] = incoming
      applied.push({ kind: 'feature', category, key, action: 'replaced' })
    } else {
      applied.push({
        kind: 'feature',
        category,
        key,
        action: 'kept_global',
        incoming_confidence: incoming.confidence,
        existing_confidence: ir.features[index].confidence ?? null,
      })
    }
  }

  // ── relations：端点必须能解析，否则记下缺的是哪个 id ────────────
  const relations = Array.isArray(findings?.relations) ? findings.relations : []
  const knownIds = new Set((ir.entities ?? []).map((item) => item.entity_id))
  for (const raw of relations) {
    const fromRaw = String(raw?.from ?? '').trim()
    const toRaw = String(raw?.to ?? '').trim()
    const from = localIds.get(fromRaw) ?? (knownIds.has(fromRaw) ? fromRaw : null)
    const to = localIds.get(toRaw) ?? (knownIds.has(toRaw) ? toRaw : null)
    if (!from || !to) {
      reject('relation', 'relation_endpoint_unknown', {
        type: String(raw?.type ?? ''),
        from: fromRaw || null,
        to: toRaw || null,
        missing: [!from ? fromRaw || null : null, !to ? toRaw || null : null].filter(Boolean),
      })
      continue
    }
    const relation = makeRelation({ ...raw, from, to, source: FEATURE_SOURCES.LOCAL }, { index: ir.relations.length })
    const duplicate = ir.relations.find((item) => item.type === relation.type && item.from === relation.from && item.to === relation.to)
    if (duplicate) {
      applied.push({ kind: 'relation', relation_id: duplicate.relation_id, action: 'kept_global' })
      continue
    }
    attach(relation, mapRegion(raw?.region, `relation:${from}->${to}`))
    ir.relations.push(relation)
    applied.push({ kind: 'relation', relation_id: relation.relation_id, action: 'added', type: relation.type })
  }

  // ── uncertainties：全收，重复的不重复记 ────────────────────────
  const uncertainties = Array.isArray(findings?.uncertainties) ? findings.uncertainties : []
  for (const raw of uncertainties) {
    const subject = typeof raw?.subject === 'string' ? raw.subject.trim() : ''
    const question = typeof raw?.question === 'string' ? raw.question.trim() : ''
    if (!subject && !question) {
      reject('uncertainty', 'uncertainty_empty', { detail: 'subject 与 question 都是空的' })
      continue
    }
    const duplicate = ir.uncertainties.find((item) => item.subject === subject && item.question === question)
    if (duplicate) {
      applied.push({ kind: 'uncertainty', uncertainty_id: duplicate.uncertainty_id, action: 'kept_global' })
      continue
    }
    const uncertainty = makeUncertainty(raw, { index: ir.uncertainties.length })
    attach(uncertainty, mapRegion(raw?.region, `uncertainty:${subject || '(无 subject)'}`))
    ir.uncertainties.push(uncertainty)
    applied.push({ kind: 'uncertainty', uncertainty_id: uncertainty.uncertainty_id, action: 'added', code: uncertainty.code })
  }

  return { applied, rejected, pending, unmapped, crop_local: cropLocal, crop_id: cropId, crop_box: cropBox ? [...cropBox] : null }
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
