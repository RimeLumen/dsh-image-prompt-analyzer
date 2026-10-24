
import { addEntity, addEntityFeature, addFeature, addRelation, addUncertainty, applyLocalReview, createIR, finalizeIR, setNamedFeature, shortId } from '../ir/build.js'
import { isNormalizedBox } from '../ir/schema.js'
import { SEVERITY, diagnostic } from '../diagnostics.js'
import { VisionError, VISION_CODES } from './backend.js'
import { STAGE_A_SYSTEM, STAGE_B_SYSTEM, buildStageAPrompt, buildStageBPrompt } from './prompt.js'
import { normalizeStageA, normalizeStageB, parseModelJson } from './parse.js'

const ANALYZE_CODES = Object.freeze({
  OUTPUT_REPAIRED: 'VISION_OUTPUT_REPAIRED',
  LOCAL_REVIEW_CROP_FAILED: 'LOCAL_REVIEW_CROP_FAILED',
  LOCAL_REVIEW_UNPARSEABLE: 'LOCAL_REVIEW_UNPARSEABLE',
  LOCAL_REVIEW_FAILED: 'LOCAL_REVIEW_FAILED',
  LOCAL_REVIEW_LIMIT_REACHED: 'LOCAL_REVIEW_LIMIT_REACHED',
  IR_VALIDATION_PROBLEMS: 'IR_VALIDATION_PROBLEMS',
})

const NAMED_SECTIONS = new Set(['composition', 'camera'])

export function planLocalReviews({
  reviewRequests = [],
  features = [],
  maxReviews = 3,
  minCropSide = 0.08,
  reviewConfidenceThreshold = 0.5,
  importantThreshold = 0.5,
} = {}) {
  const crops = []
  const dropped = []

  const consider = (box, reason, targets, origin) => {
    if (!isNormalizedBox(box)) {
      dropped.push({ origin, reason: 'invalid_box', box: box ?? null })
      return
    }
    const side = Math.max(box[2] - box[0], box[3] - box[1])
    if (side < minCropSide) {
      dropped.push({ origin, reason: 'crop_too_small', box, side })
      return
    }
    if (crops.some((crop) => intersectionOverUnion(crop.box, box) > 0.5)) {
      dropped.push({ origin, reason: 'duplicate_region', box })
      return
    }
    if (crops.length >= maxReviews) {
      dropped.push({ origin, reason: 'over_limit', box })
      return
    }
    crops.push({
      id: `${origin}_${crops.length + 1}`,
      box: [...box],
      reason: String(reason ?? '').slice(0, 200),
      targets: Array.isArray(targets) ? targets.map(String).slice(0, 8) : [],
      origin,
    })
  }

  for (const request of reviewRequests) {
    consider(request?.box, request?.reason, request?.targets, 'model_request')
  }

  const candidates = features
    .filter((feature) => feature && isNormalizedBox(feature.region))
    .filter((feature) => (feature.confidence ?? 0) < reviewConfidenceThreshold)
    .filter((feature) => (feature.importance ?? 0) >= importantThreshold)
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))

  for (const feature of candidates) {
    consider(padBox(feature.region, 0.06), `低置信度：${feature.category}.${feature.key}`, [`${feature.category}.${feature.key}`], 'low_confidence')
  }

  return { crops, dropped }
}

export function intersectionOverUnion(a, b) {
  const x0 = Math.max(a[0], b[0])
  const y0 = Math.max(a[1], b[1])
  const x1 = Math.min(a[2], b[2])
  const y1 = Math.min(a[3], b[3])
  if (x1 <= x0 || y1 <= y0) return 0
  const intersection = (x1 - x0) * (y1 - y0)
  const areaA = (a[2] - a[0]) * (a[3] - a[1])
  const areaB = (b[2] - b[0]) * (b[3] - b[1])
  const union = areaA + areaB - intersection
  return union <= 0 ? 0 : intersection / union
}

export function padBox(box, pad) {
  return [
    Math.max(0, box[0] - pad),
    Math.max(0, box[1] - pad),
    Math.min(1, box[2] + pad),
    Math.min(1, box[3] + pad),
  ]
}

export function applyStageA(ir, findings) {
  if (typeof findings.scene?.summary === 'string' && findings.scene.summary.trim()) {
    ir.scene.summary = findings.scene.summary.trim()
  }

  for (const raw of findings.features) {
    const category = String(raw?.category ?? '').trim()
    const key = String(raw?.key ?? '').trim()
    if (!category || !key) continue
    if (NAMED_SECTIONS.has(category)) setNamedFeature(ir, category, key, raw)
    else addFeature(ir, category, key, raw)
  }

  const idMap = new Map()
  for (const raw of findings.entities) {
    const entity = addEntity(ir, raw)
    idMap.set(String(raw?.entity_id ?? '').trim(), entity.entity_id)

    for (const feature of Array.isArray(raw?.features) ? raw.features : []) {
      const category = String(feature?.category ?? '').trim()
      const key = String(feature?.key ?? '').trim()
      if (!category || !key) continue
      addEntityFeature(ir, entity.entity_id, category, key, feature)
    }
  }

  for (const raw of findings.relations) {
    const from = idMap.get(String(raw?.from ?? '').trim())
    const to = idMap.get(String(raw?.to ?? '').trim())
    if (!from || !to) continue
    addRelation(ir, { ...raw, from, to })
  }

  for (const raw of findings.uncertainties) {
    addUncertainty(ir, raw)
  }

  return { entityIdMap: idMap }
}

export async function analyzeVision({
  backend,
  preparer,
  prepared,
  visionConfig = {},
  provenance = {},
  locale = 'zh',
  signal,
  logger,
  onDelta = null,
} = {}) {
  const diagnostics = []
  const taskId = provenance.task_id ?? shortId('task')
  const ir = createIR({ taskId, image: prepared.image, provenance })

  const maxTokens = visionConfig.max_tokens
  const temperature = visionConfig.temperature

  const normalizedPath =
    typeof prepared?.normalizedPath === 'string' && prepared.normalizedPath.trim() !== ''
      ? prepared.normalizedPath
      : typeof prepared?.image?.normalized_path === 'string'
        ? prepared.image.normalized_path
        : null
  if (!normalizedPath) {
    throw new VisionError(
      VISION_CODES.IMAGE_UNREADABLE,
      '图像已经解码成功，但拿不到归一化后的文件路径（preparer 没有返回 normalizedPath），无法把图片送给视觉模型。',
      '这是解码器输出与调用方约定不一致，不是配置问题；请把这条 message 报给插件维护者。',
    )
  }

  const visionOverride = {}
  if (typeof visionConfig?.provider === 'string' && visionConfig.provider.trim()) {
    visionOverride.provider = visionConfig.provider
  }
  if (typeof visionConfig?.model === 'string' && visionConfig.model.trim()) {
    visionOverride.model = visionConfig.model
  }

  const stageAResult = await backend.complete({
    prompt: buildStageAPrompt({ image: prepared.image, locale }),
    system: STAGE_A_SYSTEM,
    images: [{ path: normalizedPath, mediaType: 'image/png', name: 'image.png' }],
    signal,
    maxTokens,
    temperature,
    ...(Object.keys(visionOverride).length > 0 ? { visionOverride } : {}),
    ...(onDelta ? { onDelta } : {}),
  })

  if (Array.isArray(stageAResult.diagnostics)) diagnostics.push(...stageAResult.diagnostics)

  const parsedA = parseModelJson(stageAResult.text, { expected: 'object' })
  if (!parsedA.ok) {
    throw new VisionError(
      VISION_CODES.EMPTY_RESPONSE,
      `阶段 A 的输出无法解析成 JSON：${parsedA.error}`,
    )
  }
  if (parsedA.repairs.length) {
    diagnostics.push(
      diagnostic({
        error_code: ANALYZE_CODES.OUTPUT_REPAIRED,
        severity: SEVERITY.WARNING,
        message: `阶段 A 的模型输出被解析器修正后才可用：${parsedA.repairs.join(', ')}。`,
        suggested_fix: '这是模型输出格式不稳定的信号，不影响本次结果；若频繁出现可考虑换视觉模型。',
      }),
    )
  }

  const findingsA = normalizeStageA(parsedA.data)
  const { entityIdMap } = applyStageA(ir, findingsA)
  ir.provenance = {
    ...ir.provenance,
    vision_backend: stageAResult.backend,
    provider: stageAResult.provider ?? null,
    model: stageAResult.model ?? null,
    stage_a_repairs: parsedA.repairs,
  }

  const plan = planLocalReviews({
    reviewRequests: findingsA.review_requests,
    features: collectIRFeatures(ir),
    maxReviews: visionConfig.max_local_reviews ?? 3,
    minCropSide: visionConfig.min_crop_side ?? 0.08,
    reviewConfidenceThreshold: visionConfig.review_confidence_threshold ?? 0.5,
    importantThreshold: visionConfig.important_threshold ?? 0.5,
  })

  const reviews = []
  let cropsDone = 0
  if (plan.crops.length > 0) {
    let cropResult = null
    try {
      cropResult = await preparer.prepare({
        imagePath: prepared.sourcePath,
        outDir: prepared.tempDir,
        crops: plan.crops.map((crop) => ({ id: crop.id, box: crop.box })),
      })
    } catch (error) {
      diagnostics.push(
        diagnostic({
          error_code: ANALYZE_CODES.LOCAL_REVIEW_CROP_FAILED,
          severity: SEVERITY.WARNING,
          message: `局部裁剪失败，已跳过阶段 B：${error?.message ?? error}`,
          suggested_fix: '阶段 A 的结果仍然有效。若反复失败，检查解码器与 image.max_edge 设置。',
        }),
      )
    }

    const cropEntries = []
    for (const crop of plan.crops) {
      const decoded = cropResult?.crops?.find((item) => item.id === crop.id)
      if (!decoded) continue
      cropEntries.push({ crop, decoded })
    }

    const batchResults = await Promise.allSettled(
      cropEntries.map(({ crop, decoded }) =>
        backend.complete({
          prompt: buildStageBPrompt({ cropId: crop.id, targets: crop.targets, reason: crop.reason }),
          system: STAGE_B_SYSTEM,
          images: [{ path: decoded.path, mediaType: 'image/png', name: `${crop.id}.png` }],
          signal,
          maxTokens,
          temperature,
          ...(Object.keys(visionOverride).length > 0 ? { visionOverride } : {}),
          ...(onDelta ? { onDelta } : {}),
        }),
      ),
    )

    for (let index = 0; index < cropEntries.length; index += 1) {
      const { crop } = cropEntries[index]
      const settled = batchResults[index]
      if (settled.status === 'rejected') {
        diagnostics.push(
          diagnostic({
            error_code: ANALYZE_CODES.LOCAL_REVIEW_FAILED,
            severity: SEVERITY.WARNING,
            message: `局部复核「${crop.id}」失败：${settled.reason?.message ?? settled.reason}`,
            suggested_fix: '阶段 A 的结论不受影响。若反复失败，减小 vision.max_local_reviews。',
          }),
        )
        continue
      }
      try {
        const stageBResult = settled.value
        if (Array.isArray(stageBResult.diagnostics)) diagnostics.push(...stageBResult.diagnostics)

        const parsedB = parseModelJson(stageBResult.text, { expected: 'object' })
        if (!parsedB.ok) {
          diagnostics.push(
            diagnostic({
              error_code: ANALYZE_CODES.LOCAL_REVIEW_UNPARSEABLE,
              severity: SEVERITY.WARNING,
              message: `局部复核「${crop.id}」的输出无法解析：${parsedB.error}`,
              suggested_fix: '阶段 A 的结论不受影响。这块区域会保留在 uncertainties 里。',
            }),
          )
          continue
        }
        const findingsB = normalizeStageB(parsedB.data)
        const applied = applyLocalReview(ir, findingsB, { cropId: crop.id })
        cropsDone += 1
        reviews.push({ crop_id: crop.id, reason: crop.reason, targets: crop.targets, applied, repairs: parsedB.repairs })
      } catch (error) {
        diagnostics.push(
          diagnostic({
            error_code: ANALYZE_CODES.LOCAL_REVIEW_FAILED,
            severity: SEVERITY.WARNING,
            message: `局部复核「${crop.id}」失败：${error?.message ?? error}`,
            suggested_fix: '阶段 A 的结论不受影响。若反复失败，减小 vision.max_local_reviews。',
          }),
        )
      }
    }
  }

  for (const drop of plan.dropped) {
    logger?.debug?.('局部复核候选被丢弃：%s (%s)', drop.origin, drop.reason)
  }

  if (plan.dropped.some((drop) => drop.reason === 'over_limit')) {
    diagnostics.push(
      diagnostic({
        error_code: ANALYZE_CODES.LOCAL_REVIEW_LIMIT_REACHED,
        severity: SEVERITY.INFO,
        message: `局部复核候选超过上限 ${visionConfig.max_local_reviews ?? 3} 个，多余区域未复核。`,
        suggested_fix: '这是文档 §1.2「不做无限裁剪」的刻意限制。确实需要更多复核时调大 vision.max_local_reviews。',
      }),
    )
  }

  const finalized = finalizeIR(ir)
  if (!finalized.validation.ok) {
    diagnostics.push(
      diagnostic({
        error_code: ANALYZE_CODES.IR_VALIDATION_PROBLEMS,
        severity: SEVERITY.WARNING,
        message: `IR 校验发现 ${finalized.validation.problems.length} 处问题（多为模型给了越界数值，已夹取）。`,
        suggested_fix: '查看 ir.validation.problems 定位；这些通常不影响下游编译。',
      }),
    )
  }

  return {
    ir: finalized,
    diagnostics,
    stats: {
      stage_a_features: findingsA.features.length,
      entities: finalized.entities.length,
      relations: finalized.relations.length,
      uncertainties: finalized.uncertainties.length,
      review_candidates: plan.crops.length + plan.dropped.filter((drop) => drop.reason === 'over_limit').length,
      reviews_run: cropsDone,
      reviews,
      entity_id_map: Object.fromEntries(entityIdMap),
      usage: stageAResult.usage ?? null,
    },
  }
}

function collectIRFeatures(ir) {
  const out = []
  for (const [key, feature] of Object.entries(ir.composition ?? {})) {
    out.push({ category: 'composition', key, ...feature })
  }
  for (const [key, feature] of Object.entries(ir.camera ?? {})) {
    out.push({ category: 'camera', key, ...feature })
  }
  for (const feature of ir.features ?? []) out.push(feature)
  return out
}
