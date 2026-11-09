import { formatTag } from './style.js'

export const RENDER_CODES = Object.freeze({
  EMPTY: 'COMPILE_NO_TERMS',
})

// 只有标签式槽位能带权重；句子里插 (x:1.1) 会把语法弄坏。
const WEIGHTED_SLOTS = new Set([
  'general',
  'subject',
  'character',
  'clothing',
  'appearance',
  'pose_action',
  'expression',
  'background',
  'lighting',
])

function withWeight(text, weight, { wordStyle, slot }) {
  const factor = Number(weight)
  if (!Number.isFinite(factor) || factor <= 1) return text
  if (wordStyle === 'prose' || wordStyle === 'caption') return text
  if (!WEIGHTED_SLOTS.has(slot)) return text
  if (text.startsWith('(') && text.endsWith(')')) return text
  return `(${text}:${Number(factor.toFixed(2))})`
}

export function renderPrompt({ slots, profile }) {
  const segments = []
  const wordStyle = profile?.tag_standard?.word_style

  for (const [slot, terms] of slots ?? []) {
    if (!Array.isArray(terms) || terms.length === 0) continue
    const rendered = []
    // refs 与 terms 一一对应：渲染把 term 对象压成字符串，身份就丢了。
    // 台账要回答"这条观察进没进标签版"，只能靠身份，不能靠拿最终文本做词重合反推，
    // 所以这里把身份平行记一份。它不参与拼串，对输出零影响。
    const refs = []
    for (const term of terms) {
      // profile 带进来的标签与用户明写的角色名已经是终稿写法，不再过格式模板：
      // 模板会拿 `{series}` 去拼 `dorothy (nikke)` 这种本来就完整的标签。
      const passthrough = term?.source === 'profile' || term?.source === 'user'
      const text = passthrough ? String(term.text ?? '') : formatTag(term?.text, profile, { slot })
      if (text.length === 0) continue
      rendered.push(withWeight(text, term?.weight, { wordStyle, slot }))
      refs.push({
        origin: term?.origin ?? null,
        category: String(term?.category ?? ''),
        key: term?.key ?? null,
        entity_id: term?.entity_id ?? null,
        // 同一 category.key 的第几条。不记它，三条 background.backdrop 里
        // 只有第 0 条会被记成"进了标签版"，另外两条看上去从没进过。
        occurrence: Number.isInteger(term?.occurrence) && term.occurrence > 0 ? term.occurrence : 0,
        source: term?.source ?? null,
      })
    }
    if (rendered.length > 0) segments.push({ slot, terms: rendered, refs })
  }

  const positive = segments.flatMap((segment) => segment.terms).join(', ')
  return { positive, segments }
}