/**
 * 核心关键词提炼。
 *
 * 对应「万能拆图模板」里的第 ③ 项产出。它与正向提示词不是一回事：
 * 正向提示词是"送给模型的完整句子"，关键词是"人用来检索与复用的标签摘要"。
 * 所以这里不做槽位裁剪，只做去重与排序：重要度优先，其次置信度，最后按原出现顺序。
 *
 * 输入是 `renderPrompt` 的 segments，那里的 terms 已经是**字符串**（渲染后的标签），
 * 原始 term 元数据要用 `termIndex` 传进来；没有元数据也能工作，只是排序退化为出现顺序。
 * 注意两边的写法差异：渲染后是 `rule_of_thirds`，term.text 是 `rule of thirds`，
 * 查表时统一把下划线换成空格再比较。
 */

export const KEYWORDS_SCHEMA_VERSION = '1.0'
export const DEFAULT_KEYWORD_LIMIT = 24

function normalizeKey(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
}

function textOf(term) {
  if (typeof term === 'string') return term.trim()
  return String(term?.display ?? term?.text ?? '').trim()
}

export function extractKeywords(segments, { limit = DEFAULT_KEYWORD_LIMIT, termIndex = null } = {}) {
  const seen = new Set()
  const rows = []
  const lookup = termIndex instanceof Map ? termIndex : null

  for (const segment of Array.isArray(segments) ? segments : []) {
    const slot = segment?.slot ?? null
    for (const term of Array.isArray(segment?.terms) ? segment.terms : []) {
      const rendered = textOf(term)
      if (!rendered) continue
      const key = normalizeKey(rendered)
      if (!key || seen.has(key)) continue
      seen.add(key)

      const meta = lookup?.get(key) ?? (typeof term === 'object' ? term : null)
      rows.push({
        text: typeof meta?.text === 'string' && meta.text.trim() ? meta.text.trim() : rendered,
        slot,
        category: meta?.category ?? null,
        source: meta?.source ?? null,
        importance: typeof meta?.importance === 'number' ? meta.importance : 0,
        confidence: typeof meta?.confidence === 'number' ? meta.confidence : 0,
      })
    }
  }

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (b.row.importance !== a.row.importance) return b.row.importance - a.row.importance
      if (b.row.confidence !== a.row.confidence) return b.row.confidence - a.row.confidence
      return a.index - b.index
    })
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.row)
}