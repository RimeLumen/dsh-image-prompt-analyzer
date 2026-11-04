
import { SEVERITY, diagnostic } from '../diagnostics.js'
import { normalizeTagName } from '../kb/index.js'

export const REWRITE_CODES = Object.freeze({
  UNVERIFIED_SKIPPED: 'COMPILE_TAG_REWRITE_UNVERIFIED',
  APPLIED: 'COMPILE_TAG_REWRITE_APPLIED',
  DUPLICATE_SOURCE: 'COMPILE_TAG_REWRITE_DUPLICATE',
})

export const ACTIVE_REWRITE_SOURCES = Object.freeze(['official', 'manual'])

export function applyRewrites(terms, profile = {}) {
  const diagnostics = []
  const stats = { declared: 0, applied: 0, skipped_unverified: 0, duplicate_from: 0 }

  const declared = profile?.tag_standard?.tag_rewrites ?? profile?.tag_rewrites
  const rewrites = Array.isArray(declared) ? declared : []
  stats.declared = rewrites.length

  const table = new Map()
  for (const rule of rewrites) {
    const from = normalizeTagName(rule?.from)
    const to = String(rule?.to ?? '').trim()
    if (!from || !to) continue
    const source = String(rule?.source ?? 'unverified')
    if (!ACTIVE_REWRITE_SOURCES.includes(source)) {
      stats.skipped_unverified += 1
      diagnostics.push(
        diagnostic({
          error_code: REWRITE_CODES.UNVERIFIED_SKIPPED,
          severity: SEVERITY.WARNING,
          message: `改写规则 ${from} → ${to} 的来源是 unverified，未生效。`,
          suggested_fix: '在真实生成上验证这条改写后把 source 改成 manual，或从官方文档确认后标 official。',
        }),
      )
      continue
    }
    if (table.has(from)) {
      stats.duplicate_from += 1
      diagnostics.push(
        diagnostic({
          error_code: REWRITE_CODES.DUPLICATE_SOURCE,
          severity: SEVERITY.WARNING,
          message: `改写规则里 ${from} 出现了多次，只有第一条生效。`,
          suggested_fix: '删掉重复的改写条目。',
        }),
      )
      continue
    }
    table.set(from, { to, source, note: rule?.note ?? null })
  }

  if (table.size === 0) return { terms, diagnostics, stats }

  for (const term of terms) {
    if (!term.text) continue
    const rule = table.get(term.text)
    if (!rule) continue
    const next = normalizeTagName(rule.to)
    if (!next || next === term.text) continue
    term.notes.push(`按 ${rule.source} 改写：${term.text} → ${next}${rule.note ? `（${rule.note}）` : ''}`)
    term.text = next
    stats.applied += 1
  }

  if (stats.applied > 0) {
    diagnostics.push(
      diagnostic({
        error_code: REWRITE_CODES.APPLIED,
        severity: SEVERITY.INFO,
        message: `模型特定改写层改写了 ${stats.applied} 个标签（profile ${profile?.config_id ?? '?'}）。`,
      }),
    )
  }

  return { terms, diagnostics, stats }
}
