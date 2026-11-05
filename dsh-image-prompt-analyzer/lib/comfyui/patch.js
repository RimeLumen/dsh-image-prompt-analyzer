
import { createHash } from 'node:crypto'

import { COMFY_CODES, ComfyError } from './errors.js'
import { isWritableField, requireApiPrompt } from './workflow.js'

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function stableFingerprint(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}

function typeNameOf(spec) {
  const head = Array.isArray(spec) ? spec[0] : spec
  if (Array.isArray(head)) return 'COMBO'
  return typeof head === 'string' ? head : 'UNKNOWN'
}

function optionsOf(spec) {
  const head = Array.isArray(spec) ? spec[0] : null
  return Array.isArray(head) ? head : null
}

function constraintsOf(spec) {
  const opts = Array.isArray(spec) ? spec[1] : null
  return opts && typeof opts === 'object' ? opts : {}
}

/**
 * 用当前 ComfyUI 的 /object_info 校验一个字段值。
 * 不拿任何硬编码的旧版 Schema 兜底：拿不到 Schema 就是无法校验，直接拒绝。
 */
export function validateFieldValue({ classType, field, value, objectInfo }) {
  const nodeInfo = objectInfo?.[classType]
  if (!nodeInfo) {
    throw new ComfyError(
      COMFY_CODES.CAPABILITY_UNAVAILABLE,
      `拿不到 ${classType} 的节点 Schema，无法校验 ${field}。`,
      '确认 ComfyUI 正在运行，且该节点已安装。',
    )
  }
  const spec = nodeInfo?.input?.required?.[field] ?? nodeInfo?.input?.optional?.[field]
  if (!spec) {
    throw new ComfyError(
      COMFY_CODES.VALIDATION_FAILED,
      `${classType} 上没有输入字段 ${field}。`,
      '首版只修改工作流里已经存在、且当前节点 Schema 里确实有的字段。',
    )
  }

  const type = typeNameOf(spec)
  const options = optionsOf(spec)
  const limits = constraintsOf(spec)

  if (options) {
    if (!options.includes(value)) {
      throw new ComfyError(
        COMFY_CODES.VALIDATION_FAILED,
        `${classType}.${field} 只能是枚举里的值，收到 ${JSON.stringify(value)}。`,
        `可选值：${options.slice(0, 12).join('、')}${options.length > 12 ? ' …' : ''}`,
      )
    }
    return value
  }

  if (type === 'INT') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new ComfyError(COMFY_CODES.VALIDATION_FAILED, `${classType}.${field} 需要整数。`)
    }
    if (!Number.isSafeInteger(value)) {
      throw new ComfyError(
        COMFY_CODES.UNSAFE_INTEGER,
        `${classType}.${field} 的取值超出 JavaScript 安全整数范围，拒绝提交。`,
        '这是本插件的安全限制，不是 ComfyUI 的限制；请换一个能被精确表示的整数。',
      )
    }
    if (typeof limits.min === 'number' && value < limits.min) {
      throw new ComfyError(COMFY_CODES.VALIDATION_FAILED, `${classType}.${field} 小于最小值 ${limits.min}。`)
    }
    if (typeof limits.max === 'number' && value > limits.max) {
      throw new ComfyError(COMFY_CODES.VALIDATION_FAILED, `${classType}.${field} 大于最大值 ${limits.max}。`)
    }
    return value
  }

  if (type === 'FLOAT') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ComfyError(COMFY_CODES.VALIDATION_FAILED, `${classType}.${field} 需要数字。`)
    }
    if (typeof limits.min === 'number' && value < limits.min) {
      throw new ComfyError(COMFY_CODES.VALIDATION_FAILED, `${classType}.${field} 小于最小值 ${limits.min}。`)
    }
    if (typeof limits.max === 'number' && value > limits.max) {
      throw new ComfyError(COMFY_CODES.VALIDATION_FAILED, `${classType}.${field} 大于最大值 ${limits.max}。`)
    }
    return value
  }

  if (type === 'STRING') {
    if (typeof value !== 'string') {
      throw new ComfyError(COMFY_CODES.VALIDATION_FAILED, `${classType}.${field} 需要字符串。`)
    }
    return value
  }

  throw new ComfyError(
    COMFY_CODES.VALIDATION_FAILED,
    `${classType}.${field} 的类型 ${type} 首版不支持写入。`,
  )
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * 生成补丁计划。只改已存在的字段，绝不新增/删除节点或输入。
 *
 * 全有或全无：任意一项校验失败，整份计划作废，不返回半成品工作流。
 */
export function planWorkflowPatch({ prompt, objectInfo, changes }) {
  requireApiPrompt(prompt)
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new ComfyError(COMFY_CODES.VALIDATION_FAILED, '没有要修改的字段。')
  }

  const errors = []
  const planned = []

  for (const change of changes) {
    const { node_id: nodeId, class_type: classType, field, value } = change ?? {}
    try {
      if (typeof field !== 'string' || field === '') {
        throw new ComfyError(COMFY_CODES.VALIDATION_FAILED, '缺少 field。')
      }
      const node = prompt[String(nodeId)]
      if (!node) {
        throw new ComfyError(COMFY_CODES.NODE_UNSUPPORTED, `节点 ${nodeId} 不存在。`)
      }
      if (classType && node.class_type !== classType) {
        throw new ComfyError(
          COMFY_CODES.VALIDATION_FAILED,
          `节点 ${nodeId} 是 ${node.class_type}，不是 ${classType}。`,
        )
      }
      if (!Object.prototype.hasOwnProperty.call(node.inputs ?? {}, field)) {
        throw new ComfyError(
          COMFY_CODES.VALIDATION_FAILED,
          `节点 ${nodeId} 上没有字段 ${field}，首版不新增输入。`,
        )
      }
      if (!isWritableField(node.class_type, field)) {
        throw new ComfyError(
          COMFY_CODES.NODE_UNSUPPORTED,
          `${node.class_type}.${field} 不在首版可修改字段里。`,
          '首版只修改 CheckpointLoaderSimple / LoraLoader / VAELoader / CLIPTextEncode / KSampler / EmptyLatentImage 的白名单字段。',
        )
      }
      const before = node.inputs[field]
      if (Array.isArray(before)) {
        throw new ComfyError(
          COMFY_CODES.VALIDATION_FAILED,
          `节点 ${nodeId} 的 ${field} 是连接而不是固定值，首版不改连接。`,
        )
      }
      const validated = validateFieldValue({ classType: node.class_type, field, value, objectInfo })
      planned.push({
        node_id: String(nodeId),
        class_type: node.class_type,
        field,
        before,
        after: validated,
      })
    } catch (error) {
      errors.push({
        node_id: nodeId === undefined ? null : String(nodeId),
        field: field ?? null,
        error_code: error.code ?? COMFY_CODES.VALIDATION_FAILED,
        message: error.message,
        suggested_fix: error.suggested_fix ?? null,
      })
    }
  }

  if (errors.length > 0) {
    // 一处失败即整份作废。错误码能收敛成一个具体原因时就用那个原因
    // （比如全部都是"节点不支持"），混着多种原因才退回 VALIDATION_FAILED；
    // 无论哪种，details 里都保留每一条真实原因。
    const codes = [...new Set(errors.map((item) => item.error_code))]
    const code = codes.length === 1 ? codes[0] : COMFY_CODES.VALIDATION_FAILED
    const failure = new ComfyError(
      code,
      errors.length === 1
        ? errors[0].message
        : `${errors.length} 处修改未通过校验，整份补丁已作废。`,
      (codes.length === 1 ? errors[0].suggested_fix : null)
        ?? '修掉下面列出的问题后重新生成补丁；不会出现只改一半的工作流。',
    )
    failure.details = errors
    throw failure
  }

  const next = deepClone(prompt)
  for (const item of planned) {
    next[item.node_id].inputs[item.field] = item.after
  }

  return {
    workflow_id: stableFingerprint(prompt),
    workflow_format: 'api',
    changes: planned,
    changed_nodes: [...new Set(planned.map((item) => item.node_id))],
    node_count_before: Object.keys(prompt).length,
    node_count_after: Object.keys(next).length,
    prompt: next,
  }
}

/**
 * 应用补丁。plan.workflow_id 与当前工作流指纹不一致时拒绝——
 * 说明原工作流在生成计划之后被改过，旧计划可能覆盖别人的修改。
 */
export function applyWorkflowPatch({ plan, prompt }) {
  requireApiPrompt(prompt)
  if (!plan || typeof plan !== 'object') {
    throw new ComfyError(COMFY_CODES.VALIDATION_FAILED, '缺少补丁计划。')
  }
  const current = stableFingerprint(prompt)
  if (plan.workflow_id !== current) {
    throw new ComfyError(
      COMFY_CODES.WORKFLOW_STALE,
      '原工作流在生成补丁之后发生了变化，拒绝应用旧补丁。',
      '重新读取工作流并重新生成补丁计划。',
    )
  }
  const next = deepClone(prompt)
  for (const item of plan.changes ?? []) {
    const node = next[item.node_id]
    if (!node || !Object.prototype.hasOwnProperty.call(node.inputs ?? {}, item.field)) {
      throw new ComfyError(
        COMFY_CODES.WORKFLOW_STALE,
        `补丁目标 ${item.node_id}.${item.field} 已不存在。`,
      )
    }
    node.inputs[item.field] = item.after
  }
  return next
}

/** 补丁前后差异，用于回显给用户确认。 */
export function diffPatch(plan) {
  return (plan?.changes ?? []).map((item) => ({
    node_id: item.node_id,
    class_type: item.class_type,
    field: item.field,
    before: item.before,
    after: item.after,
  }))
}
