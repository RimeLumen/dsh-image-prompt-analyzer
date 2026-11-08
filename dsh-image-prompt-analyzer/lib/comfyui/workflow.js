
import { COMFY_CODES, ComfyError } from './errors.js'

// 首版支持的节点与字段。字段类型、范围、枚举一律以运行时 /object_info 为准，
// 这里只声明"我们能安全读写哪些字段"。
export const SUPPORTED_NODES = Object.freeze({
  CheckpointLoaderSimple: { fields: ['ckpt_name'], writable: ['ckpt_name'] },
  // UNET 与 CLIP 分开加载是 Flux / SD3 一类的常规做法，
  // 只认 CheckpointLoaderSimple 会让这些工作流整份被判成"不支持"。
  UNETLoader: { fields: ['unet_name', 'weight_dtype'], writable: ['unet_name', 'weight_dtype'] },
  CLIPLoader: { fields: ['clip_name', 'type'], writable: ['clip_name', 'type'] },
  LoraLoader: { fields: ['lora_name', 'strength_model', 'strength_clip'], writable: ['lora_name', 'strength_model', 'strength_clip'] },
  VAELoader: { fields: ['vae_name'], writable: ['vae_name'] },
  CLIPTextEncode: { fields: ['text'], writable: ['text'] },
  KSampler: { fields: ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'], writable: ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'] },
  EmptyLatentImage: { fields: ['width', 'height', 'batch_size'], writable: ['width', 'height', 'batch_size'] },
  VAEDecode: { fields: [], writable: [] },
  SaveImage: { fields: ['filename_prefix'], writable: [] },
})

export const READ_ONLY_NODES = Object.freeze(['VAEDecode', 'SaveImage'])

export function isSupportedNode(classType) {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_NODES, classType)
}

export function isWritableField(classType, field) {
  return SUPPORTED_NODES[classType]?.writable?.includes(field) === true
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** API 格式的输入值：要么是标量，要么是 `[nodeId, outputIndex]` 这样的连接引用。 */
export function isLinkRef(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (typeof value[0] === 'string' || typeof value[0] === 'number') &&
    Number.isInteger(value[1])
  )
}

/**
 * 识别格式。两种都认，但只有 API 格式能改能提交；
 * UI 格式只做结构与连接统计，不做转换。
 */
export function detectWorkflowFormat(value) {
  if (!isPlainObject(value)) return 'unsupported'

  if (Array.isArray(value.nodes) && Array.isArray(value.links)) {
    return 'ui'
  }

  const keys = Object.keys(value)
  if (keys.length === 0) return 'unsupported'
  const allApi = keys.every((key) => {
    const node = value[key]
    return isPlainObject(node) && typeof node.class_type === 'string'
  })
  return allApi ? 'api' : 'unsupported'
}

export function requireApiPrompt(prompt) {
  const format = detectWorkflowFormat(prompt)
  if (format === 'api') return prompt
  if (format === 'ui') {
    throw new ComfyError(
      COMFY_CODES.WORKFLOW_FORMAT_UNSUPPORTED,
      '这是 UI Workflow 格式，首版不做自动转换。',
      '在 ComfyUI 里用「导出 (API)」得到 API 格式的 JSON，再交给本插件。',
    )
  }
  throw new ComfyError(
    COMFY_CODES.WORKFLOW_FORMAT_UNSUPPORTED,
    '既不是 API Prompt 也不是 UI Workflow。',
    '确认文件是 ComfyUI 导出的 JSON，而不是图片或文本。',
  )
}

function summarizeInputs(inputs) {
  const values = {}
  const links = {}
  for (const [key, value] of Object.entries(inputs ?? {})) {
    if (isLinkRef(value)) links[key] = { node_id: String(value[0]), output_index: value[1] }
    else values[key] = value
  }
  return { values, links }
}

/**
 * 检查一份 API Prompt 的结构。
 * 不做修改，也不碰网络；/object_info 相关的校验留给 patch 阶段。
 */
export function inspectApiPrompt(prompt) {
  requireApiPrompt(prompt)

  const nodes = []
  const unsupported = []
  const danglingLinks = []
  const diagnostics = []

  for (const [id, node] of Object.entries(prompt)) {
    const classType = node.class_type
    const { values, links } = summarizeInputs(node.inputs)
    const supported = isSupportedNode(classType)

    nodes.push({
      id: String(id),
      class_type: classType,
      supported,
      read_only: READ_ONLY_NODES.includes(classType),
      values,
      links,
      input_count: Object.keys(node.inputs ?? {}).length,
    })

    if (!supported) unsupported.push({ id: String(id), class_type: classType })
  }

  for (const node of nodes) {
    for (const [inputName, link] of Object.entries(node.links)) {
      if (!Object.prototype.hasOwnProperty.call(prompt, link.node_id)) {
        danglingLinks.push({
          node_id: node.id,
          input: inputName,
          target: link.node_id,
          message: `节点 ${node.id} 的 ${inputName} 指向不存在的节点 ${link.node_id}。`,
        })
      }
    }
  }

  for (const item of danglingLinks) {
    diagnostics.push({
      error_code: COMFY_CODES.VALIDATION_FAILED,
      node_id: item.node_id,
      field_path: `/inputs/${item.input}`,
      message: item.message,
      suggested_fix: '修正工作流里的连接，或在 ComfyUI 里重新导出。',
    })
  }
  for (const item of unsupported) {
    diagnostics.push({
      error_code: COMFY_CODES.NODE_UNSUPPORTED,
      node_id: item.id,
      message: `节点 ${item.id}（${item.class_type}）不在首版支持范围内，未做任何修改。`,
      suggested_fix: '首版只处理基础本地文生图节点；该节点保留原样。',
    })
  }

  return {
    format: 'api',
    nodes,
    unsupported,
    dangling_links: danglingLinks,
    diagnostics,
    node_count: nodes.length,
    link_count: nodes.reduce((sum, node) => sum + Object.keys(node.links).length, 0),
  }
}

/** UI Workflow 只做只读统计：节点数、连接数、按类型分组。 */
export function inspectUiWorkflow(workflow) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : []
  const links = Array.isArray(workflow.links) ? workflow.links : []
  const byType = {}
  for (const node of nodes) {
    const type = node?.type ?? 'unknown'
    byType[type] = (byType[type] ?? 0) + 1
  }
  return {
    format: 'ui',
    node_count: nodes.length,
    link_count: links.length,
    types: byType,
    node_ids: nodes.map((node) => node?.id ?? null),
    convertible: false,
    note: 'UI Workflow 可读取与检查，但首版不转换为 API Prompt。',
  }
}

export function inspectWorkflow(value) {
  const format = detectWorkflowFormat(value)
  if (format === 'api') return inspectApiPrompt(value)
  if (format === 'ui') return inspectUiWorkflow(value)
  throw new ComfyError(
    COMFY_CODES.WORKFLOW_FORMAT_UNSUPPORTED,
    '无法识别的工作流格式。',
    '需要 ComfyUI 的 API 格式 JSON（含 class_type 与 inputs）或 UI 格式 JSON（含 nodes 与 links）。',
  )
}
