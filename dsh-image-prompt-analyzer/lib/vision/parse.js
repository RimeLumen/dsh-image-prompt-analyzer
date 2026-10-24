
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

export function normalizeStageA(data) {
  const source = data && typeof data === 'object' ? data : {}
  const entities = asArray(source.entities).map((entity, index) => ({
    ...entity,
    entity_id: String(entity?.entity_id ?? '').trim() || `e${index + 1}`,
  }))
  return {
    scene: typeof source.scene === 'object' && source.scene !== null ? source.scene : {},
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
