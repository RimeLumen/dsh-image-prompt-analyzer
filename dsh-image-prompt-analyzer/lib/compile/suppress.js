
import { SEVERITY, diagnostic } from '../diagnostics.js'
import { normalizeTagName } from '../kb/index.js'

export const SUPPRESS_CODES = Object.freeze({
  REQUIRED_BUT_EMPTY: 'COMPILE_NEGATIVE_REQUIRED_BUT_EMPTY',
  SCENE_RULE_FIRED: 'COMPILE_SCENE_SUPPRESSION_APPLIED',
  CONTRADICTION_REMOVED: 'COMPILE_NEGATIVE_CONTRADICTION_REMOVED',
})

export const STRUCTURAL_ERROR_TERMS = Object.freeze([
  'bad anatomy',
  'bad hands',
  'bad proportions',
  'extra digits',
  'fewer digits',
  'missing fingers',
  'fused fingers',
  'extra limbs',
  'mutated hands',
])

export const SCENE_SUPPRESSION_RULES = Object.freeze([
  {
    id: 'single_subject_multiplicity',
    when: ({ personCount }) => personCount === 1,
    tag: 'multiple girls',
    reason: 'IR 里恰好只有 1 个人物主体，抑制多人标签有助于避免生成多余的人。',
  },
  {
    id: 'transparent_background',
    when: ({ hasAlpha }) => hasAlpha === true,
    tag: 'white background',
    reason: '原图带透明区域，透明区不是白底；抑制白底可以避免把透明当成白色背景生成。',
  },
])

export function countPersons(ir) {
  const entities = Array.isArray(ir?.entities) ? ir.entities : []
  let count = 0
  for (const entity of entities) {
    if (entity?.kind !== 'person') continue
    const label = String(entity?.label ?? '').trim().toLowerCase()
    const encoded = /^(\d+)\s*(girls?|boys?|others?|people|persons?)$/.exec(label)
    if (encoded) {
      count += Number(encoded[1])
      continue
    }
    count += Number.isInteger(entity?.count) && entity.count > 0 ? entity.count : 1
  }
  return count
}

function termKey(text) {
  return normalizeTagName(text).replace(/ /g, '_')
}

export function buildSuppression({ ir, profile, positiveTerms = [] }) {
  const tagStandard = profile?.tag_standard ?? {}
  const negative = tagStandard.negative ?? {}
  const required = negative.required === true
  const diagnostics = []
  const stats = { base: 0, structural: 0, scene: 0, removed_contradictions: 0, truncated: 0 }

  const terms = []
  const seen = new Set()
  const push = (text, source, reason = undefined) => {
    const value = String(text ?? '').trim()
    if (!value) return false
    const key = termKey(value)
    if (seen.has(key)) return false
    seen.add(key)
    terms.push({ text: value, source, ...(reason ? { reason } : {}) })
    return true
  }

  for (const text of Array.isArray(negative.terms) ? negative.terms : []) {
    if (push(text, 'profile')) stats.base += 1
  }

  if (required) {
    for (const text of STRUCTURAL_ERROR_TERMS) {
      if (push(text, 'structural')) stats.structural += 1
    }
    const context = { personCount: countPersons(ir), hasAlpha: ir?.image?.has_alpha === true }
    for (const rule of SCENE_SUPPRESSION_RULES) {
      if (!rule.when(context)) continue
      if (!push(rule.tag, 'scene', rule.reason)) continue
      stats.scene += 1
      diagnostics.push(
        diagnostic({
          error_code: SUPPRESS_CODES.SCENE_RULE_FIRED,
          severity: SEVERITY.INFO,
          message: `场景抑制 ${rule.id} 触发：${rule.tag}。${rule.reason}`,
        }),
      )
    }
  }

  const positives = new Set(
    (Array.isArray(positiveTerms) ? positiveTerms : [])
      .map((term) => (typeof term === 'string' ? term : term?.display ?? term?.text ?? ''))
      .map((text) => termKey(text))
      .filter((key) => key.length > 0),
  )
  if (positives.size > 0) {
    const kept = []
    for (const term of terms) {
      if (positives.has(termKey(term.text))) {
        stats.removed_contradictions += 1
        diagnostics.push(
          diagnostic({
            error_code: SUPPRESS_CODES.CONTRADICTION_REMOVED,
            severity: SEVERITY.INFO,
            message: `正向里已经有「${term.text}」，负向里的同名词已删掉。`,
          }),
        )
        continue
      }
      kept.push(term)
    }
    terms.length = 0
    terms.push(...kept)
  }

  const declaredMax = Number(negative.max_terms)
  const maxTerms = Number.isFinite(declaredMax) && declaredMax > 0 ? declaredMax : 30
  if (terms.length > maxTerms) {
    stats.truncated = terms.length - maxTerms
    terms.length = maxTerms
  }

  if (required && terms.length === 0) {
    diagnostics.push(
      diagnostic({
        error_code: SUPPRESS_CODES.REQUIRED_BUT_EMPTY,
        severity: SEVERITY.WARNING,
        message: '档案要求负向提示词，但最终负向是空的：档案没有声明 negative.terms，且没有触发任何抑制规则。',
        suggested_fix: '在该档案的 negative.terms 里补一条基线负向。',
      }),
    )
  }

  return { terms, diagnostics, stats }
}
