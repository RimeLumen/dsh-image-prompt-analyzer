// 局部修改：拿「原文 + 一句修改要求」，只动被点名的那一小段文字。
//
// 为什么不是「再写一版」：`write_caption` 收的是一段已经写好的成品文本，
// 它没有原文的概念——用户把改好的新稿交给它，它当然只能原样输出。用它来证明
// 「支持局部修改」是循环论证：真正的修改动作发生在用户脑子里，不在插件里。
// 上一版就是这么验的，于是「深蓝色长外套」被改成「酒红色风衣」时，
// 服装类型跟着变了，而「只有一句不同」的断言照样通过。
//
// 这里的做法是定点替换：在原文里定位被点名的那一处，只换掉它的值，
// 其余字符一个都不碰。因此「替换片段之外的文本完全一致」是可以逐字断言的。
//
// 三条硬规矩：
//   1. 目标不唯一就不改。两个人都穿深蓝色外套时，任选一个或全都改都是错的。
//   2. 原文没写这个属性就不改。没写颜色时把「长外套」变成「酒红色长外套」，
//      那是新增设定，不是修改。
//   3. 必须给出当前值（`从 A 改成 B`）。只有目标值时，无法判断原文里哪一处是
//      要改的那一处，也就无法保证别的地方不被顺手改掉。

export const REVISE_SCHEMA_VERSION = '1.0'

export const REVISE_CODES = Object.freeze({
  INPUT_REQUIRED: 'REVISE_INPUT_REQUIRED',
  INSTRUCTION_UNPARSED: 'REVISE_INSTRUCTION_UNPARSED',
  FROM_REQUIRED: 'REVISE_FROM_REQUIRED',
  TARGET_ABSENT: 'REVISE_TARGET_ABSENT',
  VALUE_ABSENT: 'REVISE_VALUE_ABSENT',
  TARGET_AMBIGUOUS: 'REVISE_TARGET_AMBIGUOUS',
  PROFILE_NOT_CAPTION: 'REVISE_PROFILE_NOT_CAPTION',
})

const ZH_MARK = /改(?:成|为)/
const ZH_CLAUSE_SPLIT = /[，。；、,;.!?！？\n]/
const EN_MARK = /\b(?:change|make|turn|set)\b/i

const SELECTOR_TOKENS = [
  '第一', '第二', '第三', '第四', '第五',
  '左边', '右边', '左侧', '右侧', '前面', '后面', '中间',
  '银发', '黑发', '金发', '白发', '棕发', '红发', '灰发', '粉发', '蓝发',
  '长发', '短发', '戴眼镜', '穿白色', '穿黑色',
  'first', 'second', 'third', 'left', 'right', 'front', 'back', 'middle',
  'silver-haired', 'black-haired', 'blonde', 'white-haired',
]

function clauseAt(text, at) {
  let start = at
  while (start > 0 && !ZH_CLAUSE_SPLIT.test(text[start - 1])) start -= 1
  let end = at
  while (end < text.length && !ZH_CLAUSE_SPLIT.test(text[end])) end += 1
  return { start, end, text: text.slice(start, end) }
}

function stripTrailing(value, suffixes) {
  let out = String(value ?? '').trim()
  let changed = true
  while (changed) {
    changed = false
    for (const suffix of suffixes) {
      if (out.length > suffix.length && out.endsWith(suffix)) {
        out = out.slice(0, out.length - suffix.length).trim()
        changed = true
      }
    }
  }
  return out
}

/**
 * 从一句修改要求里读出「改谁、从什么、改成什么」。
 *
 * 只认两类句式，认不出就明确报错，不做猜测：
 *   中文：`只把<目标>（的颜色）从<旧值>改成<新值>`
 *   英文：`change the <target> (color) from <old> to <new>`
 */
export function parseRevisionInstruction(instruction) {
  const raw = String(instruction ?? '').trim()
  if (raw === '') return { ok: false, reason: REVISE_CODES.INPUT_REQUIRED }

  const selector = SELECTOR_TOKENS.find((token) => raw.includes(token)) ?? null

  const zhMark = raw.match(ZH_MARK)
  if (zhMark) {
    const head = raw.slice(0, zhMark.index)
    const tail = raw.slice(zhMark.index + zhMark[0].length)
    const to = stripTrailing(tail.split(ZH_CLAUSE_SPLIT)[0], ['。', '，', ' '])
    const fromAt = head.lastIndexOf('从')
    if (fromAt === -1) {
      return { ok: false, reason: REVISE_CODES.FROM_REQUIRED, to, selector }
    }
    const from = head.slice(fromAt + 1).trim()
    const targetPart = head.slice(0, fromAt)
    const noun = stripTrailing(
      targetPart.replace(/^[请麻烦]*\s*(?:只)?\s*(?:把|将)/, ''),
      ['的', '颜色', '发色', '色调', '色', ' '],
    )
    if (from === '' || to === '' || noun === '') {
      return { ok: false, reason: REVISE_CODES.INSTRUCTION_UNPARSED }
    }
    return { ok: true, language: 'zh-CN', noun, from, to, selector }
  }

  const enMark = raw.match(EN_MARK)
  if (enMark) {
    const lower = raw.toLowerCase()
    const fromAt = lower.indexOf(' from ')
    const toAt = lower.indexOf(' to ')
    if (fromAt === -1 || toAt === -1 || toAt < fromAt) {
      return { ok: false, reason: REVISE_CODES.FROM_REQUIRED, selector }
    }
    const from = raw.slice(fromAt + 6, toAt).trim()
    const to = stripTrailing(raw.slice(toAt + 4), ['.', '。', ' '])
    const targetPart = raw.slice(0, fromAt)
      .replace(/^\s*(?:change|make|turn|set)\s+(?:the\s+)?/i, '')
    const noun = stripTrailing(targetPart, [' color', ' colour', ' '])
    if (from === '' || to === '' || noun === '') {
      return { ok: false, reason: REVISE_CODES.INSTRUCTION_UNPARSED }
    }
    return { ok: true, language: 'en', noun, from, to, selector }
  }

  return { ok: false, reason: REVISE_CODES.INSTRUCTION_UNPARSED }
}

/**
 * 要求里写的目标常常带着限定语（`银发女人外套`），原文里只出现核心名词（`外套`）。
 * 从长到短试一次，取第一个在原文里真的出现的写法。
 */
function resolveNoun(text, noun) {
  const raw = String(noun ?? '').trim()
  const candidates = [raw, raw.slice(-3), raw.slice(-2)]
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
  for (const candidate of candidates) {
    if (text.includes(candidate)) return candidate
  }
  return null
}

function occurrences(text, needle) {
  const hits = []
  if (needle === '') return hits
  let at = text.indexOf(needle)
  while (at !== -1) {
    hits.push(at)
    at = text.indexOf(needle, at + 1)
  }
  return hits
}

/**
 * 旧值要跟目标名词落在同一小句里才算数。
 *
 * 只看前后若干字符会误判：`她穿着深蓝色长外套。身后的天空也是深蓝色。`
 * 第二句的「深蓝」离前一句的「外套」不到十个字，按窗口算就成了候选，
 * 于是本来唯一的目标被当成歧义。按小句切，两句就分开了。
 */
function sameClauseAsNoun(text, at, noun) {
  return clauseAt(text, at).text.includes(noun)
}

/**
 * 对一段原文执行一句修改要求。
 *
 * 返回的 `text` 是改完的全文；`span` 给出被替换的那一段在原文里的位置与长度，
 * 调用方可以据此断言「span 之外逐字未变」。
 */
export function reviseCaption({ original, instruction, profile = null } = {}) {
  const diagnostics = []
  const text = String(original ?? '')
  const push = (code, message, suggested_fix) => diagnostics.push({ code, message, suggested_fix })

  const wordStyle = profile?.tag_standard?.word_style ?? 'caption'
  if (wordStyle !== 'caption') {
    push(REVISE_CODES.PROFILE_NOT_CAPTION, `局部修改只对自然语言档案有意义，当前档案是 ${wordStyle}。`, '把 target_profile 换成 moss 这类 caption 档案。')
    return { ok: false, schema_version: REVISE_SCHEMA_VERSION, text, changed: null, candidates: [], diagnostics }
  }
  if (text.trim() === '') {
    push(REVISE_CODES.INPUT_REQUIRED, '没有原文，无法做局部修改。', '把上一次生成的 Caption 原样传进来。')
    return { ok: false, schema_version: REVISE_SCHEMA_VERSION, text, changed: null, candidates: [], diagnostics }
  }

  const parsed = parseRevisionInstruction(instruction)
  if (!parsed.ok) {
    const message = parsed.reason === REVISE_CODES.FROM_REQUIRED
      ? '这句修改要求没有给出「从什么改成什么」。只有目标值时，无法确定原文里该动哪一处。'
      : '读不出这句修改要求要改谁、改成什么。'
    const fix = parsed.reason === REVISE_CODES.FROM_REQUIRED
      ? '写成「只把<目标>的颜色从<旧值>改成<新值>」。'
      : '写成「只把<目标>的颜色从<旧值>改成<新值>」，或英文 "change the <target> color from <old> to <new>"。'
    push(parsed.reason, message, fix)
    return { ok: false, schema_version: REVISE_SCHEMA_VERSION, text, changed: null, candidates: [], diagnostics }
  }

  const { from, to, selector } = parsed
  const noun = resolveNoun(text, parsed.noun)
  if (!noun) {
    push(
      REVISE_CODES.TARGET_ABSENT,
      `原文里没有「${parsed.noun}」。把不存在的东西改成「${to}」是新增设定，不是修改。`,
      '换一个原文里确实写到的目标，或者先用编写入口把这一段写出来。',
    )
    return { ok: false, schema_version: REVISE_SCHEMA_VERSION, text, changed: null, candidates: [], diagnostics }
  }

  const hits = occurrences(text, from)
  if (hits.length === 0) {
    push(
      REVISE_CODES.VALUE_ABSENT,
      `原文里没有「${from}」，写不出「从 ${from} 改成 ${to}」这一步。原文里这个属性本来就没指定。`,
      '要么先让原文写出这个属性，要么换一个原文里确实存在的值。',
    )
    return { ok: false, schema_version: REVISE_SCHEMA_VERSION, text, changed: null, candidates: [], diagnostics }
  }

  const candidates = hits
    .filter((at) => sameClauseAsNoun(text, at, noun))
    .map((at) => ({ at, clause: clauseAt(text, at).text }))

  if (candidates.length === 0) {
    push(
      REVISE_CODES.VALUE_ABSENT,
      `「${from}」在原文里出现了，但不在「${noun}」旁边——它描述的是别的东西。`,
      '确认要改的是哪一处；如果那一处本来就不是这个属性，改它会把归属写错。',
    )
    return { ok: false, schema_version: REVISE_SCHEMA_VERSION, text, changed: null, candidates: [], diagnostics }
  }

  let target = null
  if (candidates.length === 1) {
    target = candidates[0]
  } else if (selector) {
    const matched = candidates.filter((item) => item.clause.includes(selector))
    if (matched.length === 1) target = matched[0]
  }

  if (!target) {
    push(
      REVISE_CODES.TARGET_AMBIGUOUS,
      `原文里有 ${candidates.length} 处「${from}」紧挨着「${noun}」，这句要求没有指明改哪一个。`,
      `在要求里点明是谁（例如「${candidates[0].clause.slice(0, 8)}…」那位），或者先把其它几处改掉再回来。`,
    )
    return {
      ok: false,
      schema_version: REVISE_SCHEMA_VERSION,
      text,
      changed: null,
      candidates,
      diagnostics,
    }
  }

  const revised = `${text.slice(0, target.at)}${to}${text.slice(target.at + from.length)}`
  return {
    ok: true,
    schema_version: REVISE_SCHEMA_VERSION,
    text: revised,
    changed: {
      count: 1,
      from,
      to,
      at: target.at,
      length: from.length,
      clause_before: target.clause,
      clause_after: clauseAt(revised, target.at).text,
    },
    candidates,
    instruction: { noun, from, to, selector, language: parsed.language },
    diagnostics,
  }
}
