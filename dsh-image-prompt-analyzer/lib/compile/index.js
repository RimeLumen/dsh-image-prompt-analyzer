
import { SEVERITY, diagnostic } from '../diagnostics.js'
import { importanceOverridesFromWeights } from '../ir/index.js'
import { collectTerms } from './terms.js'
import { applyRewrites } from './rewrite.js'
import { resolveTerms } from './resolve.js'
import { assignSlots } from './slots.js'
import { applyBudget } from './budget.js'
import { renderPrompt } from './render.js'
import { buildSuppression } from './suppress.js'

export { collectTerms, looksLikeTag, toDescriptionText, makeTerm, TERM_ORIGINS, MAX_TAG_WORDS, isScoreTag } from './terms.js'
export { applyRewrites, ACTIVE_REWRITE_SOURCES, REWRITE_CODES } from './rewrite.js'
export { resolveTerms, RESOLVE_CODES } from './resolve.js'
export { assignSlots, effectiveSlotOrder, SLOT_CODES } from './slots.js'
export { applyBudget, BUDGET_CODES } from './budget.js'
export { renderPrompt, RENDER_CODES } from './render.js'
export {
  buildSuppression,
  countPersons,
  SCENE_SUPPRESSION_RULES,
  STRUCTURAL_ERROR_TERMS,
  SUPPRESS_CODES,
} from './suppress.js'
export { formatTag, applyWordStyle } from './style.js'

export const COMPILE_CODES = Object.freeze({
  NO_TERMS: 'COMPILE_NO_TERMS',
})

export const COMPILE_SCHEMA_VERSION = '2.0'

function termText(term) {
  return String(term?.display ?? term?.text ?? term?.description ?? '').trim()
}

function specReason(reason) {
  if (reason === 'budget') return 'budget'
  if (reason === 'forbidden' || reason === 'excluded_category') return 'forbidden'
  return 'conflict'
}

export async function compilePrompt({
  ir,
  profile = {},
  preset = {},
  kb = null,
  includeNegative = true,
  detailLevel = null,
  signal = null,
} = {}) {
  const diagnostics = []

  const priorityOverrides = importanceOverridesFromWeights(preset?.analysis_weights)
  const collected = collectTerms(ir, { priorityOverrides })

  const rewritten = applyRewrites(collected.terms, profile)
  diagnostics.push(...rewritten.diagnostics)

  const resolved = await resolveTerms(rewritten.terms, { kb, profile, signal })
  diagnostics.push(...resolved.diagnostics)

  const dropped = []
  const candidates = []
  for (const term of resolved.terms) {
    if (term.dropped) {
      dropped.push({ term: termText(term), reason: specReason(term.dropped) })
      continue
    }
    candidates.push(term)
  }

  const assigned = assignSlots(candidates, profile)
  diagnostics.push(...assigned.diagnostics)
  for (const entry of assigned.dropped) dropped.push({ term: termText(entry.term), reason: specReason(entry.reason) })

  const budgeted = applyBudget({ slots: assigned.slots, profile, preset })
  diagnostics.push(...budgeted.diagnostics)
  for (const entry of budgeted.dropped) dropped.push({ term: termText(entry.term), reason: specReason(entry.reason) })

  const rendered = renderPrompt({ slots: budgeted.slots, profile })
  diagnostics.push(...(rendered.diagnostics ?? []))

  const allPositiveTerms = rendered.segments.flatMap((segment) => segment.terms)
  const suppression = includeNegative
    ? buildSuppression({ ir, profile, positiveTerms: allPositiveTerms })
    : { terms: [], diagnostics: [], stats: {} }
  diagnostics.push(...suppression.diagnostics)
  const negativePrompt = suppression.terms.map((term) => term.text).join(', ')

  if (rendered.positive === '') {
    diagnostics.push(
      diagnostic({
        error_code: COMPILE_CODES.NO_TERMS,
        severity: SEVERITY.WARNING,
        message: '正向提示词是空的：IR 里没有可用的观察，或者全部被裁掉了。',
        suggested_fix: '检查视觉分析结果与档案的槽位/预算配置。',
      }),
    )
  }

  const qualitySegment = rendered.segments.find((segment) => segment.slot === 'quality')

  return {
    schema_version: COMPILE_SCHEMA_VERSION,
    target_profile: profile?.config_id ?? null,
    detail_level: detailLevel ?? preset?.config_id ?? null,
    prompts: { positive: rendered.positive, negative: negativePrompt },
    slots: rendered.segments,
    quality_block: qualitySegment ? qualitySegment.terms.slice() : [],
    dropped,
    diagnostics,
    stats: {
      terms: rendered.segments.reduce((sum, segment) => sum + segment.terms.length, 0),
      slots: rendered.segments.length,
      truncated: budgeted.truncated,
    },
  }
}
