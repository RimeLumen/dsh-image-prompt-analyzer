
import { lookupType } from './loader.js'

export const ROUTER_BLOCK_HEADER = '## 第 0 步：判定图像类型（只判定，不分析内容）'

export const ROUTER_SYSTEM = [
  '你是一个图像类型判定器。你的唯一任务是判断这张图属于哪一类视觉产物。',
  '',
  '硬性要求：',
  '1. 只输出一个 JSON 对象，不要任何解释、前言、Markdown 代码围栏。',
  '2. 只依据你在图里**看得到**的证据判定，不要根据文件名、尺寸或常识猜测。',
  '3. signals 里只能填规则库给出的标识编号（形如 T1-S01 / T1-X01），不要自创编号。',
  '4. 不确定就选兜底类型，并把 confidence 写低。宁可兜底，也不要硬套一个类型。',
].join('\n')

export function fitLines(lines, maxLines) {
  const list = (Array.isArray(lines) ? lines : []).filter((line) => typeof line === 'string' && line !== '')
  if (!Number.isFinite(maxLines) || maxLines <= 0 || list.length <= maxLines) return list
  const keep = Math.max(1, maxLines - 1)
  return [...list.slice(0, keep), `…（本块已按 prompt_policy 截断到 ${maxLines} 行）`]
}

function typeLine(rule) {
  const signals = (rule?.identification?.signals ?? [])
    .map((signal) => `${signal.id} ${signal.label}`)
    .join('、')
  const summary = rule?.summary || rule?.identification?.summary || ''
  return `- ${rule.marker} ${rule.display_name}｜${signals || '（无标识）'}｜${summary}`
}

export function buildRouterBlock({ rules } = {}) {
  const maxLines = Number.isFinite(rules?.prompt_policy?.router_block_max_lines)
    ? rules.prompt_policy.router_block_max_lines
    : 14
  const types = [...(rules?.types ?? [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  const fallbackMarker = rules?.fallback?.marker ?? '[T0-GEN]'

  const lines = [
    ROUTER_BLOCK_HEADER,
    `逐条比对下面的类型，把**看得见的证据**对应的标识编号写进 signals；证据不足或都不像，选 ${fallbackMarker}。`,
    ...types.map(typeLine),
    '编号以 X 结尾的是反向标识（例如 T1-X1）：命中也要写进 signals，程序会据此排除该类型。',
    '输出：{"primary":"<类型编号>","secondary":["<编号>"],"confidence":0.0,"signals":["<标识编号>"],"reason":"不超过 40 字，且必须引用至少一个标识编号"}',
  ]
  return fitLines(lines, maxLines)
}

export function buildRouterPrompt({ rules, image, locale = 'zh' } = {}) {
  const aspect = image?.aspect_ratio ? `，画幅比例 ${image.aspect_ratio}` : ''
  return [
    '先判断这张图属于哪个图像类型。**不要**分析内容、不要写提示词。',
    '',
    `图片尺寸 ${image?.width ?? '?'}×${image?.height ?? '?'}${aspect}。`,
    '',
    ...buildRouterBlock({ rules }),
    '',
    `reason 用${locale === 'zh' ? '中文' : '英文'}写。`,
  ].join('\n')
}

export function buildTypeDetailBlock({ rule, rules } = {}) {
  const maxLines = Number.isFinite(rules?.prompt_policy?.detail_block_max_lines)
    ? rules.prompt_policy.detail_block_max_lines
    : 20
  const resolved = Array.isArray(rule?.dimensions)
    ? rule
    : (lookupType(rules, rule?.code ?? rule?.config_id ?? '') ?? rule)
  const dims = Array.isArray(resolved?.dimensions) ? resolved.dimensions : []
  if (dims.length === 0) return []
  const lexiconBudget = Number.isFinite(resolved?.compile?.budget_hint?.lexicon_terms)
    ? resolved.compile.budget_hint.lexicon_terms
    : 8
  const terms = (Array.isArray(resolved?.lexicon) ? resolved.lexicon : [])
    .slice(0, lexiconBudget)
    .map((item) => item.term_en)
    .filter(Boolean)

  const lines = [
    `## 本图类型 ${resolved?.marker ?? ''} ${resolved?.display_name ?? ''}：按下面 ${dims.length} 个维度逐项回答`,
    '括号里是 features[].category 与 key，必须照抄；question 是给你判断用的，不要把问题原文写进 value。',
    ...dims.map((dim) => {
      const required = dim?.required === true ? '【必答】' : ''
      const fallback = dim?.fallback_uncertainty ? `；看不出时写 ${dim.fallback_uncertainty}` : ''
      return `- ${dim.id} ${dim.name}${required}（${dim.slot}）：${dim.question}${fallback}`
    }),
  ]
  if (terms.length > 0) {
    lines.push(`术语可选（最多用 ${lexiconBudget} 个，图上没有就不要硬写）：${terms.join('、')}`)
  }
  return fitLines(lines, maxLines)
}

export function buildTypeSection({ selection, rules } = {}) {
  const primary = selection?.primary ?? null
  if (!primary) return []
  const rule = rules?.byCode?.[primary.code] ?? rules?.byConfigId?.[primary.config_id] ?? null
  if (!rule) return []

  const confidence = typeof selection?.confidence === 'number' ? selection.confidence.toFixed(2) : '0.00'
  const secondary = (selection?.secondary ?? [])
    .map((item) => item.marker)
    .filter(Boolean)
  const head = [
    `本图已判定为 ${primary.marker} ${primary.display_name}（程序判定分 ${confidence}）${selection?.used_fallback ? '，属于兜底类型' : ''}。`,
    secondary.length > 0
      ? `次要类型 ${secondary.join('、')} 只用于补充主类型没有的维度，不改变必答项。`
      : '',
  ].filter(Boolean)

  return [...head, ...buildTypeDetailBlock({ rule, rules })]
}

export function describeRuleSet(rules) {
  return {
    config_id: rules?.config_id ?? null,
    version: rules?.version ?? null,
    ok: rules?.ok === true,
    types: (rules?.types ?? []).map((rule) => ({
      config_id: rule.config_id,
      code: rule.code,
      marker: rule.marker,
      display_name: rule.display_name,
      role: rule.role,
      priority: rule.priority,
      signals: (rule?.identification?.signals ?? []).length,
      anti_signals: (rule?.identification?.anti_signals ?? []).length,
      dimensions: (rule?.dimensions ?? []).length,
      lexicon: (rule?.lexicon ?? []).length,
    })),
  }
}
