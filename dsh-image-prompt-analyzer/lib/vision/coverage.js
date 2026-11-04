import { DIMENSIONS, DIMENSION_STATUSES, animateSubjectState, dimensionsForKey, requiredCategoryApplicable } from './dimensions.js'

/**
 * 覆盖度引擎：把"维度契约"从提示词里的一句要求，变成可被程序核对的事实。
 *
 * 为什么需要它：八维拆图模板最容易失效的方式不是模型漏掉某一维，
 * 而是模型在 dimension_coverage 里声称"已观察"，features 里却没有对应证据。
 * 自检字段一旦只靠模型自觉，就会退化成走过场；所以这里做两件事：
 *   1. 用 IR 里的真实 feature 重算每个维度的状态；
 *   2. 把模型的自检声明与重算结果对照，冲突时报出来。
 */

const OBSERVED_CONFIDENCE = 0.7
const SHARED_CATEGORY_NOTE = '同一分类被多个维度共享，但没有属于本维度的 key'

/** 维度状态的高低：用来判断自检声明是"虚报"还是"过谦"。 */
const STATUS_RANK = Object.freeze({ missing: 0, partial: 1, observed: 2 })

export const COVERAGE_CODES = Object.freeze({
  DIMENSION_MISSING: 'VISION_DIMENSION_MISSING',
  COVERAGE_MISMATCH: 'VISION_DIMENSION_COVERAGE_MISMATCH',
  REQUIRED_CATEGORY_MISSING: 'VISION_DIMENSION_REQUIRED_CATEGORY_MISSING',
})

export function collectIRFeatures(ir) {
  const out = []
  const push = (feature) => {
    if (feature && typeof feature === 'object') out.push(feature)
  }

  for (const section of ['composition', 'camera']) {
    const node = ir?.[section]
    if (!node || typeof node !== 'object') continue
    for (const [key, feature] of Object.entries(node)) {
      if (feature && typeof feature === 'object' && 'value' in feature) {
        push({ category: section, key, ...feature })
      }
    }
  }

  if (Array.isArray(ir?.features)) ir.features.forEach(push)

  if (Array.isArray(ir?.entities)) {
    for (const entity of ir.entities) {
      if (!Array.isArray(entity?.features)) continue
      for (const feature of entity.features) push({ entity_id: entity.entity_id, ...feature })
    }
  }

  return out
}

function isConfirmed(feature, observedConfidence) {
  return feature?.status === 'confirmed' && Number(feature?.confidence ?? 0) >= observedConfidence
}

function uncertaintySubjects(ir) {
  return (Array.isArray(ir?.uncertainties) ? ir.uncertainties : [])
    .map((item) => String(item?.subject ?? '').trim().toLowerCase())
    .filter(Boolean)
}

function isAcknowledged(dimension, subjects) {
  return subjects.some((subject) =>
    dimension.categories.some((category) => subject === category || subject.startsWith(`${category}.`)),
  )
}

/**
 * @param {object} ir 已完成 finalize 的 IR
 * @param {{ claimed?: Array<{dimension:string,status:string,note?:string}>, observedConfidence?: number }} options
 */
export function computeDimensionCoverage(ir, { claimed = [], observedConfidence = OBSERVED_CONFIDENCE } = {}) {
  const features = collectIRFeatures(ir)
  const subjects = uncertaintySubjects(ir)
  const subjectState = animateSubjectState(ir)
  const claims = new Map(
    (Array.isArray(claimed) ? claimed : [])
      .filter((item) => item && typeof item.dimension === 'string')
      .map((item) => [String(item.dimension).trim().toUpperCase(), item]),
  )

  const dimensions = DIMENSIONS.map((dimension) => {
    const inCategory = features.filter((feature) => dimension.categories.includes(feature.category))
    const specific = inCategory.filter((feature) =>
      dimensionsForKey(feature.category, feature.key).some((item) => item.id === dimension.id),
    )
    const confirmed = specific.filter((feature) => isConfirmed(feature, observedConfidence))
    const scored = specific.length > 0 ? specific : inCategory
    const acknowledged = isAcknowledged(dimension, subjects)

    // 必看分类（例如 D1 的 pose_action）：光有"主体是个人"不算看过这一维。
    // 但画面里没有能动的主体时（静物 / 风景 / 空镜），要求动作等于要求编一个不存在的动作，
    // 所以这类分类按"不适用"处理：既不判缺，也不建议去做动作复核。
    const requiredAll = dimension.requires_categories ?? []
    const requiredApplicable = requiredAll.filter((category) =>
      requiredCategoryApplicable(dimension, category, subjectState),
    )
    const requiredNotApplicable = requiredAll.filter((category) => !requiredApplicable.includes(category))
    const requiredMissing = requiredApplicable.filter(
      (category) => !confirmed.some((feature) => feature.category === category),
    )
    const requiredAcknowledged = requiredMissing.every((category) =>
      subjects.some((subject) => subject === category || subject.startsWith(`${category}.`)),
    )

    let status = 'missing'
    if (confirmed.length > 0) status = 'observed'
    else if (scored.length > 0) status = 'partial'
    if (status === 'observed' && requiredMissing.length > 0) status = 'partial'

    const claim = claims.get(dimension.id) ?? null
    const noteParts = []
    if (specific.length === 0 && inCategory.length > 0) noteParts.push(SHARED_CATEGORY_NOTE)
    if (acknowledged) noteParts.push('已用 uncertainty 标注为看不到')
    if (requiredMissing.length > 0) {
      noteParts.push(`缺必看分类：${requiredMissing.join(', ')}${requiredAcknowledged ? '（已承认看不到）' : ''}`)
    }
    if (requiredNotApplicable.length > 0) {
      noteParts.push(`画面里没有能动的主体，${requiredNotApplicable.join(', ')} 不适用（依据：${subjectState.evidence}）`)
    }
    if (claim?.note) noteParts.push(String(claim.note).slice(0, 120))

    return {
      dimension: dimension.id,
      name: dimension.name,
      status,
      claimed_status: DIMENSION_STATUSES.includes(claim?.status) ? claim.status : null,
      acknowledged,
      feature_count: scored.length,
      confirmed_count: confirmed.length,
      required_categories: [...requiredApplicable],
      required_not_applicable: [...requiredNotApplicable],
      required_missing: requiredMissing,
      keys: [...new Set(scored.map((feature) => String(feature.key ?? '')).filter(Boolean))].slice(0, 8),
      categories: [...new Set(scored.map((feature) => String(feature.category ?? '')))].slice(0, 4),
      note: noteParts.join('；'),
    }
  })

  const byStatus = (status) => dimensions.filter((item) => item.status === status).map((item) => item.dimension)
  const mismatches = dimensions
    .filter((item) => item.claimed_status && item.claimed_status !== item.status)
    .map((item) => ({ dimension: item.dimension, name: item.name, claimed: item.claimed_status, computed: item.status }))

  return {
    schema_version: '1.0',
    subject_state: subjectState,
    dimensions,
    observed: byStatus('observed'),
    partial: byStatus('partial'),
    missing: byStatus('missing'),
    unacknowledged_missing: dimensions.filter((item) => item.status === 'missing' && !item.acknowledged).map((item) => item.dimension),
    mismatches,
    score: Number((byStatus('observed').length / dimensions.length).toFixed(4)),
  }
}

/**
 * 把覆盖度结果翻译成可直接交给 diagnostic() 的问题清单。
 * 严重度刻意分级：模型已用 uncertainty 承认看不到的维度只报 INFO，
 * 沉默漏掉的维度才报 WARNING——前者是诚实的缺口，后者是分析盲区。
 */
export function coverageProblems(coverage) {
  const problems = []
  for (const item of coverage.dimensions) {
    const requiredMissing = Array.isArray(item.required_missing) ? item.required_missing : []
    if (requiredMissing.length > 0) {
      // 建议要跟着分类走：缺动作就去看躯干朝向，缺表情就去看眼睑口型。
      // 一条万能的"动作看躯干朝向"在缺的是别的分类时是错的指路。
      const wantsPose = requiredMissing.includes('pose_action')
      const wantsExpression = requiredMissing.includes('expression')
      const tips = []
      if (wantsPose) tips.push('动作看躯干朝向、双手位置、脚与支撑面')
      if (wantsExpression) tips.push('表情看眼睑与口型')
      if (tips.length === 0) tips.push('对该维度做一次定向复核')
      problems.push({
        error_code: COVERAGE_CODES.REQUIRED_CATEGORY_MISSING,
        severity: item.note.includes('已承认看不到') ? 'info' : 'warning',
        dimension: item.dimension,
        message: `维度 ${item.dimension} ${item.name} 缺少必看分类 ${requiredMissing.join(', ')}：只观察到了主体/场景，但没有对应的观察条目。`,
        suggested_fix: `${tips.join('；')}，或确认这一项确实被遮挡后写进 uncertainties。`,
      })
    }
    if (item.status !== 'missing') continue
    problems.push({
      error_code: COVERAGE_CODES.DIMENSION_MISSING,
      severity: item.acknowledged ? 'info' : 'warning',
      dimension: item.dimension,
      message: item.acknowledged
        ? `维度 ${item.dimension} ${item.name} 没有观察，但已用 uncertainty 标注（可接受的缺口）。`
        : `维度 ${item.dimension} ${item.name} 完全没有观察，属于分析盲区。`,
      suggested_fix: item.acknowledged
        ? '这一维在提示词里不会被硬造，编译时会自然缺失。若这张图里其实看得到，给局部复核一个更小的框再试。'
        : '换更大的图或更近的裁切重跑；也可以把这一维的关键区域框出来做局部复核。',
    })
  }

  for (const mismatch of coverage.mismatches) {
    // 方向很重要：模型自称"看过了"但 IR 里没东西，是虚报，要查；
    // 反过来模型自称 partial 而证据够 observed，只是它写得保守，
    // 拿同一句"声称分析过、IR 里没有观察"去报，等于给出自相矛盾的诊断。
    const overclaimed = (STATUS_RANK[mismatch.claimed] ?? 0) > (STATUS_RANK[mismatch.computed] ?? 0)
    problems.push({
      error_code: COVERAGE_CODES.COVERAGE_MISMATCH,
      severity: overclaimed ? 'warning' : 'info',
      dimension: mismatch.dimension,
      message: overclaimed
        ? `维度 ${mismatch.dimension} ${mismatch.name} 的自检声明是「${mismatch.claimed}」，但证据只支持「${mismatch.computed}」：模型声称分析过，IR 里没有对应的观察。`
        : `维度 ${mismatch.dimension} ${mismatch.name} 的自检声明是「${mismatch.claimed}」，证据其实达到「${mismatch.computed}」：模型比实际更保守，以证据为准。`,
      suggested_fix: overclaimed
        ? '以证据为准，本维度的声明已被忽略；若反复出现，说明该视觉模型不遵守自检格式，可换模型或调低 vision.temperature。'
        : '无需处理。若这一维的观察本身偏薄，可以补一条更具体的观察，让成品里这一层更结实。',
    })
  }

  return problems
}

export { OBSERVED_CONFIDENCE }