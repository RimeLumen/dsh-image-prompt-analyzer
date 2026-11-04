
import { DIMENSION_IDS, DIMENSION_STATUSES } from './dimensions.js'
import { COLOR_MODES } from './preflight.js'

const COLOR_MODE_SET = new Set(COLOR_MODES)

/**
 * 模型自己报的色彩制式只在程序没有判定时才算数；认不出的写法一律置 null，
 * 而不是猜一个——猜错的制式会让后面整层色相约束反向失效。
 */
export function normalizeColorMode(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  if (COLOR_MODE_SET.has(text)) return text
  if (/^(b&w|black_and_white|grayscale|monochrome|黑白|黑白灰)$/.test(text)) return 'greyscale'
  if (/^(duo_?tone|two_?tone|双色调)$/.test(text)) return 'duotone'
  if (/^(spot|spot_colou?r|灰底局部彩色)$/.test(text)) return 'spot_color'
  if (/^(colou?r|彩色|彩图)$/.test(text)) return 'color'
  return null
}

const MAX_REPAIR_PASSES = 4

export function stripCodeFences(text) {
  let out = String(text ?? '')
  const fenced = out.match(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/)
  if (fenced) return fenced[1]
  out = out.replace(/^\s*```[a-zA-Z0-9_-]*\s*/i, '')
  out = out.replace(/```\s*$/, '')
  return out
}

export function extractBalancedJson(text) {
  const source = String(text ?? '')
  const start = source.search(/[{[]/)
  if (start === -1) return null

  const open = source[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return source.slice(start)
}

function repairOnce(text) {
  const before = text
  let out = text
  out = out.replace(/,(\s*[}\]])/g, '$1')
  out = out.replace(/:\s*undefined(\s*[,}])/g, ': null$1')
  out = out.replace(/:\s*NaN(\s*[,}])/g, ': null$1')
  out = out.replace(/'([A-Za-z_][A-Za-z0-9_]*)'(\s*:)/g, '"$1"$2')
  out = out.replace(/[“”]([A-Za-z_][A-Za-z0-9_]*)[“”](\s*:)/g, '"$1"$2')
  const opens = (out.match(/[{[]/g) ?? []).length
  const closes = (out.match(/[}\]]/g) ?? []).length
  if (opens > closes) {
    const stack = []
    let inString = false
    let escaped = false
    for (const char of out) {
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{' || char === '[') stack.push(char)
      else if (char === '}' || char === ']') stack.pop()
    }
    if (inString) out += '"'
    while (stack.length) out += stack.pop() === '{' ? '}' : ']'
  }
  return { text: out, changed: out !== before }
}

/**
 * 输出被 max_tokens 砍断时，普通修复救不回来：截断点经常落在某个字符串中间，
 * 甚至落在 `"key": ` 之后、值还没开始写的位置。
 *
 * 这里从尾部逐字符往回退，每退一步就试着把剩下的部分补全括号，
 * 直到能 parse 为止。丢掉的只是最后一小段没写完的字段，
 * 前面的观察全部保留——比整份输出作废要好得多。
 */
export function closeUnbalancedBrackets(text) {
  const stack = []
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') stack.pop()
  }
  if (inString) return null
  let out = text
  while (stack.length) out += stack.pop() === '{' ? '}' : ']'
  return out
}

export function salvageTruncatedJson(text) {
  const source = String(text ?? '')
  const start = source.search(/[{[]/)
  if (start === -1) return null

  let body = source.slice(start).replace(/[,\s]+$/, '')
  for (let cut = 0; cut < 400 && body.length > 2; cut += 1) {
    const closed = closeUnbalancedBrackets(body)
    if (closed) {
      try {
        JSON.parse(closed)
        return closed
      } catch {
        // 还不行，继续往回退
      }
    }
    body = body.slice(0, -1).replace(/[,\s]+$/, '')
    // 退到 `"key":` 这种“键写完了、值没写”的位置时，把整个键删掉
    body = body.replace(/"[^"\\]*"\s*:\s*$/, '').replace(/[,\s]+$/, '')
  }
  return null
}

export function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const percent = trimmed.match(/^(\d+(?:\.\d+)?)\s*%$/)
  if (percent) return Number(percent[1]) / 100
  const plain = trimmed.match(/^-?\d+(?:\.\d+)?$/)
  if (plain) return Number(trimmed)
  return null
}

export function parseModelJson(raw, { expected = 'object' } = {}) {
  const repairs = []
  const text = String(raw ?? '')
  if (!text.trim()) {
    return { ok: false, data: null, repairs, error: '模型返回了空内容。' }
  }

  const unfenced = stripCodeFences(text)
  if (unfenced !== text) repairs.push('stripped_code_fence')

  const extracted = extractBalancedJson(unfenced)
  if (extracted === null) {
    return { ok: false, data: null, repairs, error: '在模型输出里找不到 JSON 对象或数组。' }
  }
  if (extracted !== unfenced.trim()) repairs.push('trimmed_to_first_json_value')

  const attempts = [extracted]
  let current = extracted
  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass += 1) {
    const result = repairOnce(current)
    if (!result.changed) break
    current = result.text
    attempts.push(current)
  }

  let parsed = null
  let lastError = null
  let usedPasses = 0
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    try {
      parsed = JSON.parse(attempts[index])
      usedPasses = index
      break
    } catch (error) {
      lastError = error
    }
  }
  for (let pass = 1; pass <= usedPasses; pass += 1) repairs.push(`repair_pass_${pass}`)

  if (parsed === null) {
    // 最后再试一次“截断抢救”：从尾部往回退，补全括号后 parse
    const salvaged = salvageTruncatedJson(extracted)
    if (salvaged) {
      try {
        parsed = JSON.parse(salvaged)
        repairs.push('salvaged_truncated_json')
      } catch {
        // 抢救也失败，走下面的失败分支
      }
    }
  }

  if (parsed === null) {
    return {
      ok: false,
      data: null,
      repairs,
      error: `模型输出不是合法 JSON：${lastError?.message ?? '未知原因'}`,
    }
  }

  const isArray = Array.isArray(parsed)
  if (expected === 'array' && !isArray) {
    return { ok: false, data: null, repairs, error: '模型返回的是对象，但这里期望数组。' }
  }
  if (expected === 'object' && (isArray || typeof parsed !== 'object')) {
    return { ok: false, data: null, repairs, error: '模型返回的不是 JSON 对象。' }
  }

  return { ok: true, data: parsed, repairs, error: null }
}

const DIMENSION_ID_SET = new Set(DIMENSION_IDS)

/**
 * 模型的自检声明只保留认得出来的东西：未知维度、未知状态、重复维度都丢掉。
 * 状态非法时置 null，而不是猜一个值——猜出来的状态会污染覆盖度核对。
 */
export function normalizeDimensionCoverage(value) {
  const seen = new Set()
  const out = []
  for (const item of asArray(value)) {
    const raw = typeof item === 'string' ? { dimension: item } : item
    if (!raw || typeof raw !== 'object') continue
    const id = String(raw.dimension ?? raw.dimension_id ?? raw.id ?? '')
      .trim()
      .toUpperCase()
    if (!DIMENSION_ID_SET.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push({
      dimension: id,
      status: DIMENSION_STATUSES.includes(raw.status) ? raw.status : null,
      note: typeof raw.note === 'string' ? raw.note.trim().slice(0, 200) : '',
    })
  }
  return out
}

export function normalizeStageA(data) {
  const source = data && typeof data === 'object' ? data : {}
  const entities = asArray(source.entities).map((entity, index) => ({
    ...entity,
    entity_id: String(entity?.entity_id ?? '').trim() || `e${index + 1}`,
  }))
  return {
    color_mode: normalizeColorMode(source.color_mode ?? source.colorMode ?? source.mode),
    scene: typeof source.scene === 'object' && source.scene !== null ? source.scene : {},
    dimension_coverage: normalizeDimensionCoverage(
      source.dimension_coverage ?? source.dimensions ?? source.coverage,
    ),
    features: asArray(source.features),
    entities,
    relations: asArray(source.relations),
    uncertainties: asArray(source.uncertainties),
    review_requests: asArray(source.review_requests),
  }
}

export function normalizeStageB(data) {
  const source = data && typeof data === 'object' ? data : {}
  return {
    features: asArray(source.features),
    entities: asArray(source.entities),
    relations: asArray(source.relations),
    uncertainties: asArray(source.uncertainties),
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null) return []
  if (typeof value === 'object') return [value]
  return []
}
