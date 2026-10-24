
import { SEVERITY, diagnostic } from '../diagnostics.js'
import { SELECT_CODES } from './codes.js'

function round3(value) {
  return Math.round(value * 1000) / 1000
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

export function normalizeSignals(input) {
  let list = []
  if (input instanceof Set) list = [...input]
  else if (Array.isArray(input)) list = input
  else if (typeof input === 'string') list = input.split(/[,，、\s]+/)
  else list = []

  const out = []
  for (const item of list) {
    const raw = typeof item === 'string' ? item : (item?.id ?? item?.signal ?? item?.code ?? '')
    let id = String(raw).trim().toUpperCase()
    id = id.replace(/^\[/, '').replace(/\]$/, '')
    const match = id.match(/^T[0-6]-[SX][0-9]{1,2}/)
    if (!match) continue
    if (!out.includes(match[0])) out.push(match[0])
  }
  return out
}

export function scoreType(rule, signals, selection = {}) {
  const observed = signals instanceof Set ? signals : new Set(normalizeSignals(signals))
  const positives = Array.isArray(rule?.identification?.signals) ? rule.identification.signals : []
  const antis = Array.isArray(rule?.identification?.anti_signals) ? rule.identification.anti_signals : []

  const hits = positives.filter((signal) => observed.has(signal?.id))
  const antiHits = antis.filter((signal) => observed.has(signal?.id))
  const vetoedBy = [...positives, ...antis]
    .filter((signal) => signal?.veto === true && observed.has(signal?.id))
    .map((signal) => signal.id)

  const totalWeight = positives.reduce((sum, signal) => sum + (Number(signal?.weight) || 0), 0)
  const hitWeight = hits.reduce((sum, signal) => sum + (Number(signal?.weight) || 0), 0)
  const coverage = totalWeight > 0 ? hitWeight / totalWeight : 0
  const penalty = antiHits
    .filter((signal) => signal?.veto !== true)
    .reduce((sum, signal) => sum + (Number(signal?.weight) || 0), 0)

  const score = vetoedBy.length > 0 ? 0 : round3(clamp01(coverage - penalty))
  const minScore = Number.isFinite(rule?.min_score) ? rule.min_score : (Number.isFinite(selection.min_score) ? selection.min_score : 0.45)
  const minSignals = Number.isFinite(rule?.min_signals) ? rule.min_signals : (Number.isFinite(selection.min_signals) ? selection.min_signals : 2)

  const blockedBy = []
  if (vetoedBy.length > 0) blockedBy.push('veto')
  if (hits.length < minSignals) blockedBy.push('min_signals')
  if (score < minScore) blockedBy.push('min_score')

  const role = rule?.role ?? 'primary'
  const passed = role !== 'fallback' && blockedBy.length === 0

  return {
    config_id: String(rule?.config_id ?? ''),
    code: String(rule?.code ?? ''),
    marker: String(rule?.marker ?? ''),
    display_name: String(rule?.display_name ?? ''),
    role,
    priority: Number.isFinite(rule?.priority) ? rule.priority : 0,
    summary: String(rule?.summary ?? ''),
    score,
    coverage: round3(coverage),
    penalty: round3(penalty),
    hits: hits.map((signal) => signal.id),
    anti_hits: antiHits.map((signal) => signal.id),
    vetoed_by: vetoedBy,
    signal_hits: hits.length,
    min_score: minScore,
    min_signals: minSignals,
    blocked_by: blockedBy,
    passed,
  }
}

export function compareScores(a, b) {
  if (b.score !== a.score) return b.score - a.score
  if (b.priority !== a.priority) return b.priority - a.priority
  if (b.min_score !== a.min_score) return b.min_score - a.min_score
  return a.config_id < b.config_id ? -1 : a.config_id > b.config_id ? 1 : 0
}

function findPair(conflictPairs, idA, idB) {
  return (conflictPairs ?? []).find(
    (pair) => (pair?.a === idA && pair?.b === idB) || (pair?.a === idB && pair?.b === idA),
  ) ?? null
}

function enforcePrecedence(primary, passed, conflictPairs) {
  let current = primary
  for (const pair of conflictPairs ?? []) {
    if (pair?.rule !== 'poster_wins' || !current) continue
    if (pair.b === current.config_id) {
      const winner = passed.find((item) => item.config_id === pair.a)
      if (winner) current = winner
    }
  }
  return current
}

function pickView(score) {
  return {
    config_id: score.config_id,
    code: score.code,
    marker: score.marker,
    display_name: score.display_name,
    role: score.role,
    priority: score.priority,
    summary: score.summary,
    score: score.score,
    hits: score.hits,
  }
}

export function selectTypes({ rules, signals = [], modelConfidence = null } = {}) {
  const diagnostics = []
  const selection = rules?.selection ?? {}
  const conflictPairs = rules?.conflict_pairs ?? []
  const secondaryThreshold = Number.isFinite(selection.secondary_threshold) ? selection.secondary_threshold : 0.6
  const maxSecondary = Number.isInteger(selection.max_secondary) ? selection.max_secondary : 2
  const confidenceFloor = Number.isFinite(selection.confidence_floor) ? selection.confidence_floor : 0.3

  const observed = normalizeSignals(signals)
  const scores = (rules?.types ?? []).map((rule) => scoreType(rule, observed, selection))
  const ranked = scores.filter((score) => score.role !== 'fallback').sort(compareScores)
  const passed = ranked.filter((score) => score.passed)

  const known = new Set(scores.flatMap((score) => [...score.hits, ...score.anti_hits]))
  const unknownSignals = observed.filter((id) => !known.has(id))
  if (unknownSignals.length > 0) {
    diagnostics.push(
      diagnostic({
        error_code: SELECT_CODES.UNKNOWN_SIGNAL,
        severity: SEVERITY.WARNING,
        message: `类型判定回填了不存在的标识编号：${unknownSignals.join('、')}。`,
        suggested_fix: '这些编号不参与打分。若频繁出现，说明视觉模型没按规则库的编号回答，可换模型或调低 temperature。',
      }),
    )
  }

  let primary = passed[0] ?? null
  let usedFallback = primary === null
  let reason = ''
  let conflicts = []

  if (primary) {
    for (const pair of conflictPairs) {
      if (pair?.rule !== 'exclusive') continue
      const a = passed.find((item) => item.config_id === pair.a)
      const b = passed.find((item) => item.config_id === pair.b)
      if (a && b && Math.min(a.score, b.score) >= secondaryThreshold) {
        conflicts.push({ a: a.config_id, b: b.config_id, scores: [a.score, b.score] })
      }
    }
    if (conflicts.length > 0) {
      diagnostics.push(
        diagnostic({
          error_code: SELECT_CODES.EXCLUSIVE_CONFLICT,
          severity: SEVERITY.WARNING,
          message: `主类型候选互斥：${conflicts.map((item) => `${item.a}(${item.scores[0]}) vs ${item.b}(${item.scores[1]})`).join('；')}。已降级到兜底类型。`,
          suggested_fix: '这是"模型在猜"的信号。可以要求用户补充更清晰的图，或调高 min_score 让判定更保守。',
        }),
      )
      primary = null
      usedFallback = true
      reason = `互斥冲突 ${conflicts[0].a}/${conflicts[0].b}，降级兜底`
    }
  }

  if (primary) {
    const promoted = enforcePrecedence(primary, passed, conflictPairs)
    if (promoted.config_id !== primary.config_id) {
      reason = `${promoted.marker} 优先级压过 ${primary.marker}`
    }
    primary = promoted
  }

  if (primary && modelConfidence !== null && Number.isFinite(modelConfidence) && modelConfidence < confidenceFloor) {
    diagnostics.push(
      diagnostic({
        error_code: SELECT_CODES.LOW_MODEL_CONFIDENCE,
        severity: SEVERITY.WARNING,
        message: `模型自报类型置信度 ${round3(modelConfidence)} 低于阈值 ${confidenceFloor}，判定不被采用。`,
        suggested_fix: '按兜底类型解析。若频繁发生，说明图像类型特征不明显，这是正常的保守行为。',
      }),
    )
    reason = `模型置信度 ${round3(modelConfidence)} < ${confidenceFloor}，降级兜底`
    primary = null
    usedFallback = true
  }

  if (!primary && !usedFallback) usedFallback = true

  const secondary = primary
    ? passed
        .filter((score) => score.config_id !== primary.config_id)
        .filter((score) => {
          const pair = findPair(conflictPairs, primary.config_id, score.config_id)
          if (!pair) return true
          if (pair.rule === 'exclusive') return false
          if (pair.rule === 'poster_wins') return pair.a === primary.config_id
          return true
        })
        .filter((score) => score.score >= secondaryThreshold)
        .slice(0, maxSecondary)
    : []

  if (usedFallback && !reason) {
    const best = ranked[0] ?? null
    reason = best ? `最高分 ${best.marker} ${best.score} 未达阈值` : '没有任何类型命中标识'
    diagnostics.push(
      diagnostic({
        error_code: SELECT_CODES.FALLBACK_USED,
        severity: SEVERITY.INFO,
        message: `图像类型判定落到兜底类型${best ? `（最高分 ${best.marker} ${best.score}）` : ''}。`,
        suggested_fix: '兜底类型会保留全部八个维度，解析照常进行，不需要处理。',
      }),
    )
  }

  const fallbackRule = rules?.fallback ?? null
  const primaryView = primary
    ? pickView(primary)
    : fallbackRule
      ? {
          config_id: fallbackRule.config_id,
          code: fallbackRule.code,
          marker: fallbackRule.marker,
          display_name: fallbackRule.display_name,
          role: 'fallback',
          priority: fallbackRule.priority ?? 0,
          summary: fallbackRule.summary ?? '',
          score: 0,
          hits: [],
        }
      : null

  if (!primaryView) {
    diagnostics.push(
      diagnostic({
        error_code: SELECT_CODES.NO_RULE_SET,
        severity: SEVERITY.ERROR,
        message: '规则库里没有可用的兜底类型，无法产出任何类型判定。',
        suggested_fix: '确认 configs/image-types/_router.json 的 selection.fallback_type 指向一份已加载的规则文件。',
      }),
    )
  }

  return {
    primary: primaryView,
    secondary: secondary.map(pickView),
    confidence: primary ? primary.score : 0,
    model_confidence: modelConfidence,
    signals: observed,
    used_fallback: usedFallback,
    reason,
    conflicts,
    scores: ranked,
    diagnostics,
  }
}

export function fallbackSelection(rules, why = '类型判定未执行', errorCode = SELECT_CODES.DETECT_FAILED) {
  const result = selectTypes({ rules, signals: [] })
  return {
    ...result,
    reason: why,
    diagnostics: [
      diagnostic({
        error_code: errorCode,
        severity: SEVERITY.WARNING,
        message: `${why}，按兜底类型继续分析。`,
        suggested_fix: '兜底类型会保留全部维度，结果仍然可用；若频繁发生请检查视觉后端。',
      }),
      ...result.diagnostics,
    ],
  }
}
