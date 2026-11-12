import { CATEGORY_IDS } from '../config/index.js'
import { FEATURE_SOURCES, createIR, addFeature } from '../ir/index.js'

export const BASKET_SCHEMA_VERSION = '1.0'

export const BASKET_CODES = Object.freeze({
  EMPTY: 'COMPILE_BASKET_EMPTY',
  TOO_MANY: 'COMPILE_BASKET_TOO_MANY',
  DROPPED: 'COMPILE_BASKET_DROPPED',
})

/**
 * 词篮上限。
 *
 * 80 是"人一次真的会挑这么多"与"再多就不是挑词而是倒词库"之间的分界；
 * 超过就明说截断了，不静默吞掉剩下的。
 */
export const BASKET_MAX_TERMS = 80

/** 词篮来源。写进 IR 时标成用户亲手给的，与视觉观察区分开。 */
export const BASKET_ORIGIN = FEATURE_SOURCES.USER

export const DEFAULT_BASKET_CATEGORY = 'general'

/**
 * 把用户给的词整理成 {text, category} 列表。
 *
 * 接受两种写法：裸字符串（`"maid"`）或带分类的对象（`{tag: "maid", category: "clothing"}`）。
 * 分类不在合法集合里就退回 general —— 用户写错分类时，宁可按普通标签处理，
 * 也不要整条丢掉：词是他挑的，分类只是提示。
 */
export function normalizeBasket(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? [input] : []
  const entries = []
  const dropped = []
  const seen = new Set()

  for (const item of list) {
    const raw = item && typeof item === 'object' && !Array.isArray(item) ? item : { tag: item }
    const text = String(raw.tag ?? raw.text ?? raw.value ?? '').trim()
    if (text.length === 0) {
      dropped.push({ text: '', reason: 'empty' })
      continue
    }
    const key = text.toLowerCase()
    if (seen.has(key)) {
      dropped.push({ text, reason: 'duplicate' })
      continue
    }
    seen.add(key)
    const declared = typeof raw.category === 'string' ? raw.category.trim() : ''
    const category = CATEGORY_IDS.has(declared) ? declared : DEFAULT_BASKET_CATEGORY
    entries.push({ text, category, category_adjusted: declared !== '' && declared !== category })
  }

  const truncated = entries.length > BASKET_MAX_TERMS
  return {
    entries: truncated ? entries.slice(0, BASKET_MAX_TERMS) : entries,
    dropped,
    truncated,
  }
}

/**
 * 词篮转 IR。
 *
 * 每条词一条 feature，confidence / importance 都给满：用户亲手挑的词不该被预算按
 * "模型不太确定"的理由挤掉。IR 里没有图片信息，字段留空而不是编一个尺寸出来。
 */
export function basketToIr(entries, { observationLanguage = 'en' } = {}) {
  const ir = createIR({
    taskId: 'basket',
    image: { width: 0, height: 0, aspect_ratio: '', has_alpha: false },
    provenance: { source: 'tag_basket', schema_version: BASKET_SCHEMA_VERSION },
    observationLanguage,
  })
  for (const entry of entries) {
    addFeature(
      ir,
      entry.category,
      'term',
      { value: entry.text, confidence: 1, importance: 1, source: BASKET_ORIGIN, status: 'confirmed' },
      { source: BASKET_ORIGIN },
    )
  }
  return ir
}
