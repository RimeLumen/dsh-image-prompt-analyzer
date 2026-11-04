
const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
}

export function escapePointerToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1')
}

export function joinPointer(base, token) {
  return `${base}/${escapePointerToken(token)}`
}

export function humanizePointer(pointer) {
  if (!pointer) return '(root)'
  return pointer
    .split('/')
    .slice(1)
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.')
}

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return null
  const parts = ref
    .slice(1)
    .split('/')
    .filter((p) => p !== '')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
  let node = root
  for (const part of parts) {
    if (node === null || typeof node !== 'object') return null
    node = node[part]
  }
  return node ?? null
}

function matchesType(value, type) {
  const check = TYPE_CHECKS[type]
  return check ? check(value) : true
}

function describeValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

const patternCache = new WeakMap()
function compilePattern(schema) {
  if (patternCache.has(schema)) return patternCache.get(schema)
  let re = null
  try {
    re = new RegExp(schema.pattern)
  } catch {
    re = null
  }
  patternCache.set(schema, re)
  return re
}

function walk(value, schema, pointer, root, errors, options) {
  if (errors.length >= (options.maxErrors ?? 200)) return
  if (schema === null || typeof schema !== 'object') return

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(root, schema.$ref)
    if (target) {
      walk(value, target, pointer, root, errors, options)
      return
    }
    errors.push({ field_path: pointer, message: `无法解析的 $ref：${schema.$ref}` })
    return
  }

  const push = (message, keyword) => errors.push(keyword ? { field_path: pointer, message, keyword } : { field_path: pointer, message })

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => matchesType(value, t))) {
      push(`类型应为 ${types.join(' 或 ')}，实际是 ${describeValue(value)}`)
      return // 类型都不对，后面的关键字没有意义
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    push(`必须等于 ${JSON.stringify(schema.const)}，实际是 ${JSON.stringify(value)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === value)) {
    push(`取值必须是 ${schema.enum.map((v) => JSON.stringify(v)).join(' / ')} 之一，实际是 ${JSON.stringify(value)}`)
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) push(`不得小于 ${schema.minimum}（实际 ${value}）`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) push(`不得大于 ${schema.maximum}（实际 ${value}）`)
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) push(`必须大于 ${schema.exclusiveMinimum}（实际 ${value}）`)
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) push(`必须小于 ${schema.exclusiveMaximum}（实际 ${value}）`)
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const q = value / schema.multipleOf
      if (Math.abs(q - Math.round(q)) > 1e-9) push(`必须是 ${schema.multipleOf} 的整数倍（实际 ${value}）`)
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) push(`长度不得少于 ${schema.minLength} 个字符`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) push(`长度不得超过 ${schema.maxLength} 个字符`)
    if (typeof schema.pattern === 'string') {
      const re = compilePattern(schema)
      if (re === null) {
        if (!options.reportedPatterns.has(schema.pattern)) {
          options.reportedPatterns.add(schema.pattern)
          errors.push({
            field_path: pointer,
            message: `schema 里的 pattern 不是合法正则：${schema.pattern}`,
            keyword: 'schema',
          })
        }
      } else if (!re.test(value)) {
        push(`格式不匹配 ${schema.pattern}（实际 ${JSON.stringify(value)}）`)
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) push(`至少需要 ${schema.minItems} 项（实际 ${value.length} 项）`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) push(`最多允许 ${schema.maxItems} 项（实际 ${value.length} 项）`)
    if (schema.uniqueItems === true) {
      const seen = new Set()
      value.forEach((item, index) => {
        const key = JSON.stringify(item)
        if (seen.has(key)) push(`第 ${index} 项与前面的项重复：${key}`)
        seen.add(key)
      })
    }
    if (schema.items) {
      value.forEach((item, index) => walk(item, schema.items, joinPointer(pointer, index), root, errors, options))
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {}
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push({ field_path: joinPointer(pointer, key), message: '缺少必需字段', keyword: 'required' })
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        walk(child, properties[key], joinPointer(pointer, key), root, errors, options)
        continue
      }
      if (schema.additionalProperties === false) {
        errors.push({
          field_path: joinPointer(pointer, key),
          message: `未知字段（本结构不允许额外字段）：${key}`,
          keyword: 'additionalProperties',
        })
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        walk(child, schema.additionalProperties, joinPointer(pointer, key), root, errors, options)
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) walk(value, sub, pointer, root, errors, options)
  }
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((sub) => {
      const bucket = []
      walk(value, sub, pointer, root, bucket, options)
      return bucket.length === 0
    })
    if (!ok) push('不满足 anyOf 中的任何一个分支')
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((sub) => {
      const bucket = []
      walk(value, sub, pointer, root, bucket, options)
      return bucket.length === 0
    })
    if (matched.length !== 1) push(`oneOf 要求恰好命中 1 个分支，实际命中 ${matched.length} 个`)
  }
  if (schema.not) {
    const bucket = []
    walk(value, schema.not, pointer, root, bucket, options)
    if (bucket.length === 0) push('命中了 not 禁止的结构')
  }
}

export function validateAgainstSchema(value, schema, options = {}) {
  const errors = []
  walk(value, schema, '', schema, errors, { ...options, reportedPatterns: new Set() })
  return errors
}
