
import { addEntity, addEntityFeature, addFeature, addRelation, addUncertainty, applyLocalReview, createIR, finalizeIR, setNamedFeature, shortId } from '../ir/build.js'
import { isNormalizedBox } from '../ir/schema.js'
import { SEVERITY, diagnostic } from '../diagnostics.js'
import { VisionError, VISION_CODES } from './backend.js'
import { STAGE_A_SYSTEM, STAGE_B_SYSTEM, buildStageAPrompt, buildStageBPrompt } from './prompt.js'
import { computeDimensionCoverage, coverageProblems } from './coverage.js'
import { dimensionById } from './dimensions.js'
import { EVIDENCE_CODES, checkAtmosphere, checkEquipmentHandling, checkPoseAxes, enforceBackground, enforceDiffusion, enforceFaceLuminance, enforceFaceOcclusion, enforceMonochrome, enforceRenderMedium, enforceTorsoOrientation, tidyObservationFragments } from './evidence.js'
import { normalizeStageA, normalizeStageB, parseModelJson } from './parse.js'
import { classifyColorMode, colorModeLabel } from './preflight.js'
import { snapshotIR } from '../trace/stages.js'

const ANALYZE_CODES = Object.freeze({
  OUTPUT_REPAIRED: 'VISION_OUTPUT_REPAIRED',
  LOCAL_REVIEW_CROP_FAILED: 'LOCAL_REVIEW_CROP_FAILED',
  LOCAL_REVIEW_UNPARSEABLE: 'LOCAL_REVIEW_UNPARSEABLE',
  LOCAL_REVIEW_FAILED: 'LOCAL_REVIEW_FAILED',
  LOCAL_REVIEW_LIMIT_REACHED: 'LOCAL_REVIEW_LIMIT_REACHED',
  LOCAL_REVIEW_CROP_TOO_SMALL: 'LOCAL_REVIEW_CROP_TOO_SMALL',
  IR_VALIDATION_PROBLEMS: 'IR_VALIDATION_PROBLEMS',
  DIMENSION_RESCUE_FAILED: 'VISION_DIMENSION_RESCUE_FAILED',
  MONOCHROME_ENFORCED: 'VISION_MONOCHROME_ENFORCED',
  COLOR_MODE_MISMATCH: 'VISION_COLOR_MODE_MISMATCH',
  OUTPUT_TRUNCATED: 'VISION_OUTPUT_TRUNCATED',
})

/** 阶段 A 输出被长度上限截断时的重试预算：翻倍，但不超过 32k。 */
const STAGE_A_ESCALATION_CAP = 32768
const STAGE_A_MIN_RETRY_BUDGET = 8192
const STAGE_A_TRUNCATION_NUDGE =
  '注意：上一次输出超出了长度上限被截断。请把措辞压到最短——note 不超过 20 字、scene.summary 不超过 60 字，features 只写必要字段，务必让整个 JSON 完整闭合。'

/** finish_reason 因网关而异，可能是 {kind}、字符串或 {type}，统一按小写文本判断。 */
export function stageALooksTruncated(result) {
  const reason = result?.finish_reason ?? result?.finishReason ?? null
  const raw =
    typeof reason === 'string'
      ? reason
      : String(reason?.kind ?? reason?.reason ?? reason?.type ?? '')
  const lowered = raw.toLowerCase()
  if (!lowered) return false
  return lowered.includes('length') || lowered.includes('max_token') || lowered.includes('truncat')
}

/**
 * 网关不回报 finish_reason 时，"被砍断"只剩一个可观测信号：输出把 token 预算用满。
 *
 * 很多网关把截断也报成 stop（或者干脆不报 finish_reason），此时只看 finish_reason 会漏判：
 * 输出正好写满 8192、JSON 尾巴被砍、靠解析器抢救回前半份——而插件却当成正常收工，
 * 用户看到的是"观察莫名其妙少了一半，却没有任何警告"。所以把"预算打满"也算截断，
 * 走同一条升预算重试。
 */
export function stageABudgetSaturated(result, budget) {
  const used = Number(result?.usage?.outputTokens ?? result?.usage?.output_tokens)
  if (!Number.isFinite(used) || used <= 0) return false
  const cap = Number(budget)
  if (!Number.isFinite(cap) || cap <= 0) return false
  return used >= cap
}

/** 整维空白的补漏优先级：只救这几类，别把每次分析都变成五轮调用。
 * D1 加进来是因为动作（pose_action）挂在它名下：人物姿态看不出来时，
 * 整张提示词会退化成"一个人站着"，比缺光影后果严重得多。
 */
const RESCUE_DIMENSIONS = Object.freeze(['D1', 'D3', 'D4', 'D5'])
const RESCUE_LIMIT = 2

/** 局部复核裁图的下限：短边小于这个像素数，视觉模型给的结论基本是编的。 */
const MIN_REVIEW_CROP_PX = 96

/** 首次分析的复核框只有两档：4 或 9。中间值/非法值一律落到更省的那档。 */
export const REVIEW_BOX_DEFAULT = 4
export const REVIEW_BOX_MAX = 9

export function reviewBoxBudget(visionConfig) {
  const raw = Number(visionConfig?.max_local_reviews)
  if (!Number.isFinite(raw)) return REVIEW_BOX_DEFAULT
  return raw >= 7 ? REVIEW_BOX_MAX : REVIEW_BOX_DEFAULT
}

const NAMED_SECTIONS = new Set(['composition', 'camera'])

export function planLocalReviews({
  reviewRequests = [],
  targeted = [],
  features = [],
  maxReviews = REVIEW_BOX_DEFAULT,
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

  // 覆盖缺口优先于"低置信度"：两者抢名额时，结构维度的缺口更值得再看一眼。
  // 顺序刻意放在 model_request 之后——模型自己点名要看的区域仍然最高优先。
  for (const review of targeted) {
    consider(review?.box, review?.reason, review?.targets, review?.origin ?? 'coverage_gap')
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

/**
 * 局部复核时要报给模型的实体清单。
 *
 * 不报这份清单，模型想指认"这个局部里的是哪个人"、想挂一条关系，
 * 手上没有任何可用的 id——只能自己编一个，编出来的对不上任何已有实体。
 * 只报 id / kind / label / 位置：这些都是阶段 A 已经写进 IR 的事实，
 * 不是提示，也不替模型判断。
 */
export function reviewEntityLines(ir) {
  return (ir?.entities ?? []).map((entity) => ({
    entity_id: entity.entity_id,
    kind: entity.kind ?? null,
    label: entity.label ?? null,
    region: Array.isArray(entity.region) ? entity.region : null,
  }))
}

/**
 * 局部复核要核的原有说法。
 *
 * 复核是"对着一条已有说法去核对"，只给目标名（`expression.eye_light`）不给原话，
 * 等于让它重新猜一遍，核出来的东西也就对不上原来那条。
 * 按 `category.key` 精确匹配 targets；命名段（composition / camera）也一起摊出来。
 */
export function reviewFactsFor(ir, targets = []) {
  const wanted = new Set(
    (Array.isArray(targets) ? targets : [])
      .map((target) => String(target ?? '').trim())
      .filter(Boolean),
  )
  if (wanted.size === 0) return []
  const out = []
  const push = (category, key, feature) => {
    if (!feature) return
    if (!wanted.has(`${category}.${key}`)) return
    out.push({
      category,
      key,
      value: feature.value,
      confidence: feature.confidence ?? 0,
      importance: feature.importance ?? 0,
    })
  }
  for (const section of ['composition', 'camera']) {
    for (const [key, feature] of Object.entries(ir?.[section] ?? {})) push(section, key, feature)
  }
  for (const feature of ir?.features ?? []) push(feature.category, feature.key, feature)
  for (const entity of ir?.entities ?? []) {
    for (const feature of entity?.features ?? []) push(feature.category, feature.key, feature)
  }
  return out
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

  // 色彩制式先判：它决定提示词里的观察契约（单色图不许写色相），也决定编译层压不压颜色。
  const colorPreflight = classifyColorMode(prepared.image?.metrics ?? null)
  const stageAPrompt = buildStageAPrompt({
    image: prepared.image,
    metrics: prepared.image?.metrics ?? null,
    locale,
    colorPreflight,
  })
  const stageAImages = [{ path: normalizedPath, mediaType: 'image/png', name: 'image.png' }]
  const firstBudget = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : null

  let stageAResult = null
  let parsedA = null
  let attemptBudget = firstBudget
  // 原始模型响应必须留下来，否则整条链路没法重放：被截断、被抢救、被解析器修正过的输出
  // 一旦丢掉，事后只能猜"当时模型到底写了什么"。逐次记录，并标明哪一次真的被采用。
  const rawResponses = []
  let usedStageAAttemptIndex = -1
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // 第二次是升预算重试：万一网关不认这么大的 max_tokens 而报错，
    // 不能把第一次已经拿到的（哪怕是抢救出来的）结果丢掉。
    let result
    try {
      result = await backend.complete({
        prompt: attempt === 1 ? stageAPrompt : `${stageAPrompt}\n\n${STAGE_A_TRUNCATION_NUDGE}`,
        system: STAGE_A_SYSTEM,
        images: stageAImages,
        signal,
        maxTokens: attemptBudget ?? undefined,
        temperature,
        ...(Object.keys(visionOverride).length > 0 ? { visionOverride } : {}),
      })
    } catch (error) {
      if (attempt === 1) throw error
      diagnostics.push(
        diagnostic({
          error_code: ANALYZE_CODES.OUTPUT_TRUNCATED,
          severity: SEVERITY.WARNING,
          message: `按 ${attemptBudget} token 重试时网关报错，已退回第一次的结果：${error?.message ?? error}`,
          suggested_fix: '说明这个网关不接受更大的输出预算；把 max_tokens 调回 8192 以内，或换输出更紧凑的视觉模型。',
        }),
      )
      break
    }
    stageAResult = result

    rawResponses.push({
      stage: 'A',
      attempt,
      used: false,
      max_tokens: attemptBudget ?? null,
      backend: stageAResult.backend ?? null,
      provider: stageAResult.provider ?? null,
      model: stageAResult.model ?? null,
      finish_reason: stageAResult.finish_reason ?? null,
      usage: stageAResult.usage ?? null,
      text: String(stageAResult.text ?? ''),
    })
    usedStageAAttemptIndex = rawResponses.length - 1

    if (Array.isArray(stageAResult.diagnostics)) diagnostics.push(...stageAResult.diagnostics)

    parsedA = parseModelJson(stageAResult.text, { expected: 'object' })
    const salvaged = parsedA.repairs.includes('salvaged_truncated_json')
    const saturated = stageABudgetSaturated(stageAResult, attemptBudget)
    if (!stageALooksTruncated(stageAResult) && !salvaged && !saturated) break

    // 输出被长度上限砍断：翻倍预算再问一次，别让整次分析作废。
    const nextBudget = Math.min(
      STAGE_A_ESCALATION_CAP,
      Math.max(STAGE_A_MIN_RETRY_BUDGET, (attemptBudget ?? 4096) * 2),
    )
    const why =
      salvaged || stageALooksTruncated(stageAResult)
        ? '被截断'
        : '把 token 预算用满（网关没有报告截断原因）'
    diagnostics.push(
      diagnostic({
        error_code: ANALYZE_CODES.OUTPUT_TRUNCATED,
        severity: SEVERITY.WARNING,
        message:
          attempt === 1
            ? `阶段 A 的输出在第 ${attemptBudget ?? '默认'} token 预算处${why}，已按 ${nextBudget} 重试一次。`
            : `阶段 A 的输出在 ${attemptBudget} token 预算处仍${why}；${salvaged ? '已用截断抢救保留前半份观察。' : '这次无法从截断内容里救回 JSON。'}`,
        suggested_fix:
          '把插件配置里的 max_tokens 调到 16000 以上，或换一个输出更紧凑的视觉模型；WARNING 不影响已解析出的部分结果。',
      }),
    )

    if (attempt === 2) break
    attemptBudget = nextBudget
  }

  if (usedStageAAttemptIndex >= 0 && rawResponses[usedStageAAttemptIndex]) {
    rawResponses[usedStageAAttemptIndex].used = true
  }

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
    // 像素判定要跟着 IR 走：编译层靠它决定负向要不要压颜色。
    // 只留在 stats 里的话，compile 阶段根本不知道原图是单色的。
    pixel_verdict: prepared.image?.metrics?.verdict ?? null,
    pixel_metrics: summarizePixelMetrics(prepared.image?.metrics ?? null),
    // 色彩制式是编译层的硬前提：program 判得出就信 program，判不出才退到模型的自我判断。
    color_mode: colorPreflight.color_mode ?? findingsA.color_mode ?? null,
    color_mode_source: colorPreflight.color_mode ? 'pixel_preflight' : findingsA.color_mode ? 'model' : null,
    color_tint: colorPreflight.tint ?? 'neutral',
    color_mode_confidence: colorPreflight.color_mode ? colorPreflight.confidence : null,
  }

  // 覆盖缺口 → 定向复核框。必须在 planLocalReviews 之前算：这一步决定"该再看哪里"，
  // 而低置信度候选只是"哪里没看准"，两者优先级不同。
  const preCoverage = computeDimensionCoverage(ir, { claimed: findingsA.dimension_coverage })
  const targeted = buildTargetedReviews(ir, preCoverage)

  // 动作轴线复查：机位词被当成躯干朝向（straight-on 冒充正身）、只写 standing 不写肩髋关系，
  // 这些都属于"覆盖度看不出、但还原一定错"的问题，必须单独要一个框重看人物。
  const poseCheck = checkPoseAxes(ir)
  if (poseCheck.report.gaps.length > 0) {
    const box = subjectBox(ir)
    if (box) {
      // 转体只写了"斜转"却没给肩线时，这一框必须把问题问死：复核模型上一轮就是
      // 拿"轻微转向"交差的，泛泛地问"补姿势"它还会再写一遍同样的糊话。
      const shoulderAsk = poseCheck.report.rotation_understated
        ? '。转体已经写了但没说哪侧肩更近——这一项必须答：两肩的可见宽度比是多少（正面约 1:1、斜四分之三约 1:0.6、接近侧身约 1:0.2），因此哪侧肩更宽更靠前（left / right），远侧肩是否被躯干挡住'
        : ''
      targeted.unshift({
        box,
        origin: 'pose_axes',
        reason: `D1 主体内容与场景设定 · 动作轴线缺 ${poseCheck.report.gaps.join(' / ')}${poseCheck.report.camera_as_pose ? '（动作里写的机位词不算朝向）' : ''}：只补人物姿势——躯干轴线怎么转、肩线与髋线是否平行、重心在哪条腿、左右手各伸向哪里、手指张开还是并拢${shoulderAsk}`,
        targets: [
          'pose_action.torso_orientation',
          'pose_action.twist',
          'pose_action.stance',
          'pose_action.hands',
        ],
      })
    }
  }

  const boxBudget = reviewBoxBudget(visionConfig)
  const plan = planLocalReviews({
    reviewRequests: findingsA.review_requests,
    targeted,
    features: collectIRFeatures(ir),
    maxReviews: boxBudget,
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

    const usable = []
    for (const entry of cropEntries) {
      const width = Number(entry.decoded?.width ?? 0)
      const height = Number(entry.decoded?.height ?? 0)
      // 裁剪框在归一化空间里"够大"，落到像素上可能只有 40×60：
      // 这种裁图投给视觉模型只会得到幻觉，不如不做，把不确定性留给 evidence 层。
      if (width > 0 && height > 0 && Math.min(width, height) < MIN_REVIEW_CROP_PX) {
        diagnostics.push(
          diagnostic({
            error_code: ANALYZE_CODES.LOCAL_REVIEW_CROP_TOO_SMALL,
            severity: SEVERITY.INFO,
            message: `局部复核「${entry.crop.id}」的裁图只有 ${width}×${height} 像素，已跳过。`,
            suggested_fix: '放大原图、或对更大的主体区域发起复核。这张图在这个尺寸下就是看不清。',
            field_path: `/reviews/${entry.crop.id}`,
          }),
        )
        continue
      }
      usable.push(entry)
    }
    cropEntries.length = 0
    cropEntries.push(...usable)

    const batchResults = await Promise.allSettled(
      cropEntries.map(({ crop, decoded }) =>
        backend.complete({
          prompt: buildStageBPrompt({
            cropId: crop.id,
            targets: crop.targets,
            reason: crop.reason,
            colorMode: ir?.provenance?.color_mode ?? null,
            entities: reviewEntityLines(ir),
            facts: reviewFactsFor(ir, crop.targets),
          }),
          system: STAGE_B_SYSTEM,
          images: [{ path: decoded.path, mediaType: 'image/png', name: `${crop.id}.png` }],
          signal,
          maxTokens,
          temperature,
          ...(Object.keys(visionOverride).length > 0 ? { visionOverride } : {}),
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

        rawResponses.push({
          stage: 'B',
          attempt: 1,
          crop_id: crop.id,
          used: true,
          backend: stageBResult.backend ?? null,
          provider: stageBResult.provider ?? null,
          model: stageBResult.model ?? null,
          finish_reason: stageBResult.finish_reason ?? null,
          usage: stageBResult.usage ?? null,
          text: String(stageBResult.text ?? ''),
        })

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
        // crop.box 一定要传下去：阶段 B 报的 region 是**这块裁图里**的坐标，
        // 不回映就当成原图坐标存进 IR，等于把画面右上角的东西记到左上角。
        const review = applyLocalReview(ir, findingsB, { cropId: crop.id, cropBox: crop.box })
        cropsDone += 1
        reviews.push({
          crop_id: crop.id,
          reason: crop.reason,
          targets: crop.targets,
          applied: review.applied,
          rejected: review.rejected,
          pending: review.pending,
          unmapped: review.unmapped,
          crop_local: review.crop_local,
          repairs: parsedB.repairs,
        })
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
        message: `局部复核候选超过上限 ${boxBudget} 个，多余区域未复核。`,
        suggested_fix: `把 vision.max_local_reviews 改成 ${REVIEW_BOX_MAX}（默认 ${REVIEW_BOX_DEFAULT}）能多看几块，但每次都是一个独立调用。`,
      }),
    )
  }

  // 整维补漏：D1/D3/D4/D5 在首次观察里整维空白（或必看分类缺席）时，
  // 带着维度问题把整张图再问一次。这比在阶段 A 里反复强调"要看仔细"有效：
  // 定向追问会逼它回答具体问题，而重写一遍描述只会产生更多同义重复。
  const rescueIds = []
  if (visionConfig.dimension_rescue !== false && normalizedPath) {
    // 复核之后的覆盖度：局部裁图可能已经补上了某一维，别重复问。
    const rescueCoverage = computeDimensionCoverage(ir, { claimed: findingsA.dimension_coverage })
    for (const dimensionId of RESCUE_DIMENSIONS) {
      const entry = rescueCoverage.dimensions.find((item) => item.dimension === dimensionId)
      if (!entry) continue
      const lacksStructure = entry.status === 'missing'
      const lacksRequired = (entry.required_missing ?? []).length > 0 && !entry.acknowledged
      if (lacksStructure || lacksRequired) rescueIds.push(dimensionId)
    }
  }
  for (const dimensionId of rescueIds.slice(0, RESCUE_LIMIT)) {
    const dimension = dimensionById(dimensionId)
    if (!dimension) continue
    const slotKey = dimension.primary_slot.split('.').slice(1).join('.')
    const target = `${dimension.primary_category}.${slotKey}`
    try {
      const rescued = await backend.complete({
        prompt: buildStageBPrompt({
          cropId: `full_${dimensionId}`,
          targets: [target],
          reason: `整维没有结论：${dimension.name}。请就整张图补上这一维。`,
          colorMode: ir?.provenance?.color_mode ?? null,
          entities: reviewEntityLines(ir),
          facts: reviewFactsFor(ir, [target]),
        }),
        system: STAGE_B_SYSTEM,
        images: [{ path: normalizedPath, mediaType: 'image/png', name: 'image.png' }],
        signal,
        maxTokens,
        temperature,
        ...(Object.keys(visionOverride).length > 0 ? { visionOverride } : {}),
      })
      const parsedRescue = parseModelJson(rescued.text, { expected: 'object' })
      // 整维补漏也是一次真实的阶段 B 响应，而且它确实改了 IR。
      // 不记下来就会出现「复核跑过了，但产物里一条原始响应都找不到」——
      // 那正是留痕要消灭的情况。
      rawResponses.push({
        stage: 'B',
        attempt: 1,
        crop_id: `full_${dimensionId}`,
        rescue_dimension: dimensionId,
        used: parsedRescue.ok,
        backend: rescued.backend ?? null,
        provider: rescued.provider ?? null,
        model: rescued.model ?? null,
        finish_reason: rescued.finish_reason ?? null,
        usage: rescued.usage ?? null,
        text: String(rescued.text ?? ''),
      })
      if (!parsedRescue.ok) throw new Error(parsedRescue.error)
      const review = applyLocalReview(ir, normalizeStageB(parsedRescue.data), {
        cropId: `full_${dimensionId}`,
        // 整维补漏看的是整张图，不是裁图。传整框而不是 null：
        // 这样它报的坐标本来就是原图坐标，映射是恒等的，
        // 也不会被记进 unmapped 冒充"坐标不明"。
        cropBox: [0, 0, 1, 1],
      })
      reviews.push({
        crop_id: `full_${dimensionId}`,
        reason: 'dimension_rescue',
        targets: [target],
        applied: review.applied,
        rejected: review.rejected,
        pending: review.pending,
        unmapped: review.unmapped,
        crop_local: review.crop_local,
        repairs: parsedRescue.repairs,
      })
      cropsDone += 1
    } catch (error) {
      diagnostics.push(
        diagnostic({
          error_code: ANALYZE_CODES.DIMENSION_RESCUE_FAILED,
          severity: SEVERITY.INFO,
          message: `维度补漏（${dimensionId}）失败：${error?.message ?? error}`,
          suggested_fix: '首次观察的结论仍然有效，只是该维度会留在覆盖度缺口里。',
        }),
      )
    }
  }

  // 模型如果自己报了跟像素相反的制式，说明它没把预检当回事（或者根本没看）。
  // 不改判定，但必须让用户看到：这类分歧往往就是"灰阶图反推出彩色"的源头。
  if (colorPreflight.color_mode && findingsA.color_mode && findingsA.color_mode !== colorPreflight.color_mode) {
    diagnostics.push(
      diagnostic({
        error_code: ANALYZE_CODES.COLOR_MODE_MISMATCH,
        severity: SEVERITY.WARNING,
        field_path: '/color_mode',
        message: `像素预检判定为 ${colorPreflight.color_mode}（${colorModeLabel(colorPreflight.color_mode)}），模型自报 ${findingsA.color_mode}（${colorModeLabel(findingsA.color_mode)}）。已按像素判定继续。`,
        suggested_fix: '像素统计是确定性证据，优先采信；若两者长期不一致，检查解码是否把图转成了彩色。',
      }),
    )
  }

  // 证据层会原地改写 feature.value，改完就再也看不到改之前长什么样。
  // 先拷一份：这是"这条观察在证据层被改写了吗"唯一可靠的事实来源，
  // 事后拿最终文本反推只会得到猜测。
  const irBeforeEvidence = snapshotIR(ir)

  // 像素证据兜底：黑白图上凡是色相观察一律删掉，并补上单色结论。
  // 这一步不能省：提示词只是"劝"，模型照样可能在灰阶人像上写 blue eyes。
  const monochrome = enforceMonochrome(ir, prepared.image?.metrics ?? null)
  if (monochrome.trimmed.length > 0) {
    const sample = monochrome.trimmed
      .slice(0, 3)
      .map((item) => `${item.from} → ${item.to}`)
      .join(' / ')
    diagnostics.push(
      diagnostic({
        error_code: ANALYZE_CODES.MONOCHROME_ENFORCED,
        severity: SEVERITY.INFO,
        message: `像素预检判定为单色图，已从 ${monochrome.trimmed.length} 条复合观察里摘掉色相词，材质与结构信息保留（${sample}）。`,
        suggested_fix:
          '这是期望行为：颜色不可判，但"绒面""蕾丝领口""刺绣"这类跟颜色无关的信息照样看得见，不该跟着一起删。',
      }),
    )
  }
  if (monochrome.dropped.length > 0) {
    const sample = monochrome.dropped.slice(0, 3).map((item) => item.value).join(' / ')
    diagnostics.push(
      diagnostic({
        error_code: ANALYZE_CODES.MONOCHROME_ENFORCED,
        severity: SEVERITY.WARNING,
        message: `像素预检判定为单色图，已删除 ${monochrome.dropped.length} 条无依据的颜色观察（${sample}）。`,
        suggested_fix:
          '这是期望行为：黑白图里的色相无法从像素判断。若原图确实是彩色，先确认解码没有走错路径。',
      }),
    )
  }

  // 朦胧感兜底：像素证明"黑场抬高 + 对比压低 + 边缘发软"时，把 high contrast /
  // hard light / silhouette / sharp focus 这类硬朗词删掉，并补上散射描述。
  const diffusion = enforceDiffusion(ir, prepared.image?.metrics ?? null)
  if (diffusion.dropped.length > 0 || diffusion.trimmed.length > 0) {
    const parts = []
    if (diffusion.trimmed.length > 0) {
      parts.push(
        `剔除 ${diffusion.trimmed.length} 条冲突词（${diffusion.trimmed
          .slice(0, 3)
          .map((item) => `${item.from} → ${item.to}`)
          .join(' / ')}）`,
      )
    }
    if (diffusion.dropped.length > 0) {
      parts.push(
        `删除 ${diffusion.dropped.length} 条（${diffusion.dropped
          .slice(0, 3)
          .map((item) => item.value)
          .join(' / ')}）`,
      )
    }
    diagnostics.push(
      diagnostic({
        error_code: EVIDENCE_CODES.CONTRAST_DROPPED,
        severity: SEVERITY.WARNING,
        message: `像素预检判定画面为低对比散射（黑场抬高、边缘发软），已清理与证据冲突的硬朗描述：${parts.join('；')}。`,
        suggested_fix: '这是期望行为：这类图不能用 high contrast / silhouette 描述，否则重建会变回硬光。',
      }),
    )
  }

  // 渲染介质兜底：像素已经量出"柔"（散射、黑场抬高），但观察里还写着
  // anime digital illustration / cel shading 这类平涂词时，质感会被重新压回硬边平涂。
  // 与上面的 enforceDiffusion 分工：那一层管光影冲突词，这一层管渲染介质冲突词。
  const renderMedium = enforceRenderMedium(ir, prepared.image?.metrics ?? null)
  if (
    renderMedium.dropped.length > 0 ||
    renderMedium.trimmed.length > 0 ||
    renderMedium.injected.length > 0 ||
    renderMedium.topic_dropped.length > 0
  ) {
    const parts = []
    if (renderMedium.trimmed.length > 0) {
      parts.push(
        `摘掉平涂词 ${renderMedium.trimmed.length} 条（${renderMedium.trimmed
          .slice(0, 3)
          .map((item) => item.from)
          .join(' / ')}）`,
      )
    }
    if (renderMedium.dropped.length > 0) {
      parts.push(
        `删除 ${renderMedium.dropped.length} 条只剩平涂词的观察（${renderMedium.dropped
          .slice(0, 3)
          .map((item) => item.value)
          .join(' / ')}）`,
      )
    }
    if (renderMedium.topic_dropped.length > 0) {
      const words = [...new Set(renderMedium.topic_dropped.flatMap((item) => item.words))]
      parts.push(`摘掉冒充媒介结论的题材词（${words.join(', ')}）`)
    }
    if (renderMedium.injected.length > 0) parts.push(`补入 ${renderMedium.injected.join(' / ')}`)
    diagnostics.push(
      diagnostic({
        error_code: EVIDENCE_CODES.RENDER_MEDIUM_FLATTENED,
        severity: SEVERITY.WARNING,
        message: `像素预检判定画面是柔和散射介质，已清理会把质感压成硬边平涂的渲染词：${parts.join('；')}。`,
        suggested_fix: '这是期望行为：柔和厚涂与平涂线稿是两种介质，不能靠题材词混用。',
      }),
    )
  }

  // 背景兜底：把程序量出来的背景结论变成必须出现的控制型背景标签。
  // 环境跑偏的根因不是"模型没看"，而是它只写了形容词（bright background），
  // 生成端压不住，四周就自己长出房间和树林。
  const background = enforceBackground(ir, prepared.image?.metrics ?? null)
  if (background.injected.length > 0 || background.trimmed.length > 0) {
    const parts = []
    if (background.injected.length > 0) parts.push(`补入 ${background.injected.join(' / ')}`)
    if (background.trimmed.length > 0) {
      parts.push(`删除与背景实测冲突的 ${background.trimmed.length} 条（${background.trimmed.map((item) => item.from).join(' / ')}）`)
    }
    diagnostics.push(
      diagnostic({
        error_code: EVIDENCE_CODES.BACKGROUND_INJECTED,
        severity: SEVERITY.INFO,
        message: `像素预检判定背景类型为 ${background.kind}，已按实测结果修正环境描述：${parts.join('；')}。`,
        suggested_fix: '这是期望行为：背景由取样像素决定，不由模型印象决定。',
      }),
    )
  }

  // 躯干朝向兜底：写了 `facing viewer` 又写了"某侧肩更近"时，两句不可能同时成立。
  // 肩线一近一远，躯干就已经转过去了；而 `facing viewer` 作为领起词会被生成端直接
  // 当成交代，把侧身摆正。这里按肩线证据改判成转体，并摘掉"轻微"类糊弄修饰。
  const torsoOrientation = enforceTorsoOrientation(ir)
  if (torsoOrientation.rewritten.length > 0 || torsoOrientation.injected.length > 0) {
    const parts = []
    if (torsoOrientation.rewritten.length > 0) {
      parts.push(
        `改判 ${torsoOrientation.rewritten.length} 条（${torsoOrientation.rewritten
          .slice(0, 3)
          .map((item) => `「${item.from}」→「${item.to}」`)
          .join(' / ')}）`,
      )
    }
    if (torsoOrientation.injected.length > 0) parts.push(`补入 ${torsoOrientation.injected.join(' / ')}`)
    if (torsoOrientation.deduped?.length > 0) {
      parts.push(
        `删掉重复的转体描述 ${torsoOrientation.deduped.length} 条（${torsoOrientation.deduped
          .slice(0, 3)
          .map((item) => item.from)
          .join(' / ')}）`,
      )
    }
    if (torsoOrientation.camera_cleaned.length > 0) {
      parts.push(
        `摘掉正面机位词 ${torsoOrientation.camera_cleaned.length} 条（${torsoOrientation.camera_cleaned
          .slice(0, 3)
          .map((item) => item.from)
          .join(' / ')}）`,
      )
    }
    // 只有确实存在正面/背对断言时才说"改判"；观察本来就写对了、只是没写成领起句时，
    // 三种来源的措辞要分开：说成"改判"会让人以为模型把朝向读错了，其实是措辞规范化。
    const mode = torsoOrientation.rewritten.some((item) => item.reason_kind === 'rotation_conflict')
      ? 'rotation_conflict'
      : torsoOrientation.rewritten.some((item) => item.reason_kind === 'shoulder_evidence' && (item.front_claim || item.back_claim))
        ? 'claim_conflict'
        : torsoOrientation.rewritten.some((item) => item.reason_kind === 'shoulder_evidence')
          ? 'restatement'
          : torsoOrientation.rewritten.some((item) => item.front_claim || item.back_claim)
            ? 'derived_shoulder_conflict'
            : 'derived_shoulder_restatement'
    diagnostics.push(
      diagnostic({
        error_code: EVIDENCE_CODES.TORSO_FRONT_CLAIM_CONFLICT,
        severity: SEVERITY.WARNING,
        message: `${
          {
            rotation_conflict: '观察同时写了正面朝向与转体，两者不能并存，按转体统一',
            claim_conflict: '观察同时写了正面朝向与两侧肩的远近',
            restatement: '观察写了转体但没写成领起句',
            derived_shoulder_conflict: '观察写了正面朝向，转体方向是从原文读出来的，肩线远近按朝向推得',
            derived_shoulder_restatement: '观察写了转体但没写成领起句，肩线远近按朝向推得',
          }[mode]
        }为转体朝向：${parts.join('；')}。`,
        suggested_fix:
          mode === 'rotation_conflict' || mode === 'derived_shoulder_conflict'
            ? '无需处理。想写得更准，就在写 three-quarter 的同时交代哪侧肩离镜头更近；没有肩线依据时不要先断言 front-facing。'
            : '这是期望行为：肩线是转体的硬证据，正面断言会让生成端把身体摆正。',
      }),
    )
  }
  // 只写了"朝观众某侧转"、没交代肩线远近时，肩线是按身体朝向推出来的。
  // 这一步单独报，因为它改变了观察的内容（补进去的是推出来的，不是看出来的），
  // 混在"改判朝向"里会让人以为模型看见了肩线。
  const derivedShoulder = torsoOrientation.rewritten.filter((item) => item.reason_kind === 'derived_shoulder')
  if (derivedShoulder.length > 0) {
    diagnostics.push(
      diagnostic({
        error_code: EVIDENCE_CODES.TORSO_SHOULDER_DEPTH_DERIVED,
        severity: SEVERITY.INFO,
        message: `观察只写了朝向、没交代两侧肩的远近，已按身体朝向补出肩线证据 ${derivedShoulder.length} 条（${derivedShoulder
          .slice(0, 3)
          .map((item) => item.to)
          .join(' / ')}）。`,
        suggested_fix:
          '无需处理。想少一次推导，就在写转体的同一句里交代哪侧肩更宽更靠前、远侧肩是否被躯干挡住。',
      }),
    )
  }

  // 脸部明度兜底：头部暗部核心量出来不是纯黑时，把"脸在阴影里/看不清/剪影"这类
  // 断言摘掉，补一条"暗但五官可辨"。逆光图的脸被压成黑板，根因就在这一步没人管。
  const faceLuminance = enforceFaceLuminance(ir, prepared.image?.metrics ?? null)
  if (faceLuminance.dropped.length > 0 || faceLuminance.injected.length > 0) {
    const parts = []
    if (faceLuminance.dropped.length > 0) {
      parts.push(
        `摘掉 ${faceLuminance.dropped.length} 条纯黑断言（${faceLuminance.dropped
          .slice(0, 3)
          .map((item) => item.from)
          .join(' / ')}）`,
      )
    }
    if (faceLuminance.injected.length > 0) parts.push(`补入 ${faceLuminance.injected.join(' / ')}`)
    diagnostics.push(
      diagnostic({
        error_code: EVIDENCE_CODES.FACE_SHADOW_INJECTED,
        severity: SEVERITY.WARNING,
        message: `头部暗部核心亮度 ${Number(faceLuminance.dark_core_luma ?? 0).toFixed(2)}（${faceLuminance.band}），脸没有被压成纯黑，已按实测修正：${parts.join('；')}。`,
        suggested_fix: '这是期望行为：脸的暗度由头部框的暗部核心决定，不由"看起来很暗"决定。',
      }),
    )
  }

  // 遮挡式观察兜底：`eyes not visible` 这类否定式会被编译层整条剔除（正向词里写
  // "没有 X" 会召唤 X），但脸这一块剔掉之后没有肯定式说法顶上来，生成端就把脸画清楚。
  // 知识库里本来就有 `eyes in shadow` / `face in shadow`，这里把否定换成它们。
  const faceOcclusion = enforceFaceOcclusion(ir)
  if (faceOcclusion.injected.length > 0) {
    diagnostics.push(
      diagnostic({
        error_code: EVIDENCE_CODES.FACE_OCCLUSION_INJECTED,
        severity: SEVERITY.INFO,
        message: `观察写了眼睛在阴影里看不清，已换成肯定式标签：${faceOcclusion.injected.join(' / ')}。`,
        suggested_fix: '这是期望行为：否定式观察会被编译层剔除，遮挡要写成肯定式。',
      }),
    )
  }

  // 装备与手：`holding` 关系必须说得出哪只手。佩在腰上的剑、两只手都已另有去处的
  // "握着"，都要在进编译层之前降级成 accessory，否则正向词会多一个 holding_sword。
  const equipment = checkEquipmentHandling(ir)
  for (const item of equipment.reclassified) {
    diagnostics.push(
      diagnostic({
        error_code: EVIDENCE_CODES.HOLDING_RECLASSIFIED,
        severity: SEVERITY.WARNING,
        message:
          item.reason === 'carried_not_held'
            ? `实体 ${item.to} 被写成 ${item.from}，但描述里出现"${item.word}"：它是佩在身上的，不是握在手里，已改为 accessory。`
            : `实体 ${item.to} 被写成 ${item.from}，但没有点明哪只手，且双手在姿态里已有别的去处：已改为 accessory。`,
        suggested_fix: '这是期望行为：佩挂装备写 accessory + 位置，手持装备写 holding 并点明 left hand / right hand。',
      }),
    )
  }
  for (const item of equipment.withoutHand) {
    diagnostics.push(
      diagnostic({
        error_code: EVIDENCE_CODES.HOLDING_WITHOUT_HAND,
        severity: SEVERITY.WARNING,
        message: `holding 关系 ${item.to} 没有点明哪只手在握（${String(item.description ?? '').slice(0, 40)}）。`,
        suggested_fix: '补 left hand / right hand；若两只手都已另有动作，这条关系应改成 accessory。',
      }),
    )
  }

  // 观察值以悬空连接词结尾（`edges glowing where`）时截成整句。这不是改判观察内容，
  // 只是把被别的规则摘掉尾词之后留下的半句话收干净——半句话会原样进描述版。
  const fragments = tidyObservationFragments(ir)
  if (fragments.applied) {
    const sample = [...fragments.trimmed, ...fragments.dropped][0]?.before ?? ''
    diagnostics.push(
      diagnostic({
        error_code: EVIDENCE_CODES.OBSERVATION_FRAGMENT_TRIMMED,
        severity: SEVERITY.INFO,
        field_path: '/features',
        message:
          `观察里有 ${fragments.trimmed.length} 条以连接词结句的残句已截断` +
          (fragments.dropped.length > 0 ? `，${fragments.dropped.length} 条只剩连接词的整条丢掉` : '') +
          (sample ? `（例：「${sample}」）。` : '。'),
        suggested_fix: '无需处理；想让观察更完整，回 D6 把「哪件东西、什么结构、什么材质」一次写全。',
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

  // 覆盖度必须在局部复核之后算：阶段 B 补回来的观察也算数。
  const coverage = computeDimensionCoverage(finalized, {
    claimed: findingsA.dimension_coverage,
  })
  for (const problem of coverageProblems(coverage)) {
    diagnostics.push(
      diagnostic({
        error_code: problem.error_code,
        severity: problem.severity === 'info' ? SEVERITY.INFO : SEVERITY.WARNING,
        field_path: `/coverage/${problem.dimension}`,
        message: problem.message,
        suggested_fix: problem.suggested_fix,
      }),
    )
  }

  // 动作轴线缺口：与覆盖度分开报，因为它不是"哪一维没写"，而是"姿势的三个轴没拆开"。
  // 必须重算：第 367 行那次是在局部复核之前跑的，当时缺的轴可能已经被阶段 B 补回来了，
  // 拿旧结论报诊断会让用户看到"缺少躯干朝向"，而最终提示词里明明写着 turned three-quarter。
  for (const problem of checkPoseAxes(finalized).problems) {
    diagnostics.push(
      diagnostic({
        error_code: problem.error_code,
        severity: problem.severity === 'info' ? SEVERITY.INFO : SEVERITY.WARNING,
        field_path: '/pose_action',
        message: problem.message,
        suggested_fix: problem.suggested_fix,
      }),
    )
  }

  // 雾、蒸汽、烟、水下这类介质，全靠模型自觉；像素已经测出低对比 + 抬黑 + 去饱和时，
  // 如果整份 IR 里连一个介质词都没有，就明确告诉用户"这层没看到"，而不是让它静默丢掉。
  const atmosphere = checkAtmosphere(finalized, prepared.image?.metrics ?? null)
  if (atmosphere) {
    diagnostics.push(
      diagnostic({
        error_code: atmosphere.error_code,
        severity: atmosphere.severity === 'info' ? SEVERITY.INFO : SEVERITY.WARNING,
        field_path: '/coverage/D4',
        message: atmosphere.message,
        suggested_fix: atmosphere.suggested_fix,
      }),
    )
  }

  return {
    ir: finalized,
    coverage,
    metrics: prepared.image?.metrics ?? null,
    diagnostics,
    // 证据层之前的 IR。台账要回答"这条观察是在证据层被改写的吗"，只能靠它，
    // 事后拿最终文本反推是猜测。没有它就如实记 unavailable，不假装完整。
    ir_before_evidence: irBeforeEvidence,
    // 原始 Stage A/B 响应。以前这些文本解析完就丢，导致任何一次分析都无法重放。
    raw_responses: rawResponses,
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
      dimensions_observed: coverage.observed.length,
      dimensions_missing: coverage.missing.length,
      coverage_score: coverage.score,
      pixel_verdict: prepared.image?.metrics?.verdict ?? null,
      monochrome_dropped: monochrome.dropped.length,
      color_mode: colorPreflight.color_mode ?? null,
      color_mode_source: colorPreflight.color_mode ? 'pixel_preflight' : 'model',
      color_tint: colorPreflight.tint ?? null,
      color_mode_confidence: colorPreflight.confidence ?? null,
      rescue_dimensions: rescueIds.slice(0, RESCUE_LIMIT),
    },
  }
}

/** 只留编译层用得上的几个数，别把整个 palette 塞进 IR。 */
function summarizePixelMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return null
  const pick = ['mono_ratio', 'colorfulness', 'sat_mean', 'luma_mean', 'luma_std', 'edge_energy', 'haze_score']
  const out = {}
  for (const key of pick) {
    const value = metrics[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  const background = metrics.background
  if (background && typeof background === 'object' && typeof background.kind === 'string') {
    out.background_kind = background.kind
    if (Array.isArray(background.tags)) out.background_tags = background.tags.slice(0, 4)
  }
  return Object.keys(out).length > 0 ? out : null
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

/** 结构维度：覆盖缺口优先复核的对象，别把力气花在次要维度上。 */
const TARGETED_DIMENSIONS = Object.freeze(['D1', 'D3', 'D4', 'D5'])

/**
 * 把"覆盖度缺口"翻译成定向复核框。
 *
 * 旧策略只看 confidence 与 importance：pose_action 的默认重要度是 0.33、
 * lighting_color 0.13、background 0.17，永远进不了候选——于是动作和介质这两类
 * 恰恰**最需要再看一眼**的观察，反而一次复核都拿不到。
 * 这里改成按维度缺口选：某维 partial / missing，或必看分类没观察，就给它一个框。
 */
export function buildTargetedReviews(ir, coverage, { pad = 0.08 } = {}) {
  const reviews = []
  const entities = Array.isArray(ir?.entities) ? ir.entities : []
  const features = collectIRFeatures(ir)

  const biggestSubjectBox = () => {
    const candidates = entities.filter((entity) => isNormalizedBox(entity?.region))
    if (candidates.length === 0) {
      const subjectFeature = features.filter(
        (feature) => feature?.category === 'subject' && isNormalizedBox(feature?.region),
      )
      if (subjectFeature.length === 0) return null
      return padBox(subjectFeature[0].region, pad + 0.04)
    }
    const pick = candidates.sort((a, b) => boxArea(b.region) - boxArea(a.region))[0]
    return padBox(pick.region, pad + 0.04)
  }

  for (const item of coverage?.dimensions ?? []) {
    if (!TARGETED_DIMENSIONS.includes(item.dimension)) continue
    const requiredMissing = Array.isArray(item.required_missing) ? item.required_missing : []
    const gap = item.status !== 'observed' || requiredMissing.length > 0
    if (!gap) continue

    const dimension = dimensionById(item.dimension)
    if (!dimension) continue

    let box = null
    if (requiredMissing.length > 0) {
      // 主体类必看分类（动作/表情）需要人物框，而不是某条零碎观察的框。
      box = biggestSubjectBox()
    }
    if (!box) {
      const inDim = features
        .filter((feature) => dimension.categories.includes(feature?.category))
        .filter((feature) => isNormalizedBox(feature?.region))
        .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
      if (inDim.length > 0) box = padBox(inDim[0].region, pad)
    }
    if (!box) continue

    const targets = [`${dimension.primary_category}.${dimension.primary_slot.split('.').slice(1).join('.')}`]
    for (const category of requiredMissing) targets.push(`${category}.${category === 'pose_action' ? 'posture' : 'observation'}`)

    const what = requiredMissing.length > 0 ? `缺少 ${requiredMissing.join(' / ')} 观察` : `只有 ${item.status} 的证据`
    reviews.push({
      box,
      origin: 'coverage_gap',
      reason: `${item.dimension} ${item.name}：${what}，请只补这一维，别重述已写过的内容`,
      targets,
    })
  }

  return reviews
}

/** 人物框：动作复查永远针对人，不针对某条零碎观察。 */
function subjectBox(ir) {
  const entities = Array.isArray(ir?.entities) ? ir.entities : []
  const boxes = entities
    .filter((entity) => isNormalizedBox(entity?.region))
    .sort((a, b) => boxArea(b.region) - boxArea(a.region))
  if (boxes.length > 0) return padBox(boxes[0].region, 0.08)
  const feature = (ir?.features ?? [])
    .filter((item) => item?.category === 'subject' && isNormalizedBox(item?.region))
    .sort((a, b) => boxArea(b.region) - boxArea(a.region))[0]
  return feature ? padBox(feature.region, 0.1) : null
}

function boxArea(box) {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1])
}
