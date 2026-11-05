
import { COMFY_CODES, ComfyError } from './errors.js'
import { isLinkRef, requireApiPrompt } from './workflow.js'

/**
 * 把 API Prompt 里的连接关系解出来。
 *
 * 关键点：CLIPTextEncode 是正还是负，只看 KSampler 的 positive/negative
 * 输入指向谁。节点 ID 大小、创建顺序、text 内容都不参与判断。
 */
export function analyzeBindings(prompt) {
  requireApiPrompt(prompt)

  const nodes = Object.entries(prompt).map(([id, node]) => ({
    id: String(id),
    class_type: node.class_type,
    inputs: node.inputs ?? {},
  }))
  const byId = new Map(nodes.map((node) => [node.id, node]))

  const ofType = (classType) => nodes.filter((node) => node.class_type === classType)

  const resolveLink = (node, inputName) => {
    const value = node.inputs?.[inputName]
    if (!isLinkRef(value)) return null
    const target = byId.get(String(value[0]))
    if (!target) return { missing: true, node_id: String(value[0]) }
    return { node: target, output_index: value[1] }
  }

  const diagnostics = []
  const samplers = ofType('KSampler').map((node) => {
    const pick = (role) => {
      const link = resolveLink(node, role)
      if (!link) return null
      if (link.missing) {
        diagnostics.push({
          error_code: COMFY_CODES.VALIDATION_FAILED,
          node_id: node.id,
          field_path: `/inputs/${role}`,
          message: `KSampler ${node.id} 的 ${role} 指向不存在的节点 ${link.node_id}。`,
          suggested_fix: '修正连接或重新导出工作流。',
        })
        return { node_id: link.node_id, class_type: null, text: null, missing: true }
      }
      const target = link.node
      return {
        node_id: target.id,
        class_type: target.class_type,
        text: typeof target.inputs?.text === 'string' ? target.inputs.text : null,
        missing: false,
      }
    }
    return {
      id: node.id,
      positive: pick('positive'),
      negative: pick('negative'),
      model: resolveLink(node, 'model')?.node?.id ?? null,
      latent_image: resolveLink(node, 'latent_image')?.node?.id ?? null,
    }
  })

  const roleOf = new Map()
  for (const sampler of samplers) {
    if (sampler.positive?.node_id) roleOf.set(sampler.positive.node_id, 'positive')
    if (sampler.negative?.node_id) roleOf.set(sampler.negative.node_id, 'negative')
  }

  const prompts = ofType('CLIPTextEncode').map((node) => ({
    id: node.id,
    role: roleOf.get(node.id) ?? 'unbound',
    text: typeof node.inputs?.text === 'string' ? node.inputs.text : null,
    clip: resolveLink(node, 'clip')?.node?.id ?? null,
  }))

  // 同一 class_type 有多个实例时，任何按类型定位的字段都必须返回候选，
  // 由调用方指定 node_id；这里不替用户选第一个。
  const ambiguous = []
  const seenTypes = new Map()
  for (const node of nodes) {
    if (!seenTypes.has(node.class_type)) seenTypes.set(node.class_type, [])
    seenTypes.get(node.class_type).push(node.id)
  }
  for (const [classType, ids] of seenTypes) {
    if (ids.length > 1 && classType !== 'CLIPTextEncode') {
      ambiguous.push({ class_type: classType, candidates: ids })
    }
  }

  return {
    samplers,
    prompts,
    checkpoints: ofType('CheckpointLoaderSimple').map((node) => ({
      id: node.id,
      ckpt_name: node.inputs?.ckpt_name ?? null,
    })),
    loras: ofType('LoraLoader').map((node) => ({
      id: node.id,
      lora_name: node.inputs?.lora_name ?? null,
      strength_model: node.inputs?.strength_model ?? null,
      strength_clip: node.inputs?.strength_clip ?? null,
    })),
    vaes: ofType('VAELoader').map((node) => ({ id: node.id, vae_name: node.inputs?.vae_name ?? null })),
    latents: ofType('EmptyLatentImage').map((node) => ({
      id: node.id,
      width: node.inputs?.width ?? null,
      height: node.inputs?.height ?? null,
      batch_size: node.inputs?.batch_size ?? null,
    })),
    decodes: ofType('VAEDecode').map((node) => ({ id: node.id })),
    saves: ofType('SaveImage').map((node) => ({
      id: node.id,
      filename_prefix: node.inputs?.filename_prefix ?? null,
    })),
    ambiguous,
    diagnostics,
  }
}

/**
 * 定位要改的节点。给了 nodeId 就用它；没给且候选唯一就用唯一候选；
 * 多个候选时抛 BINDING_AMBIGUOUS 并把候选原样带回去。
 */
export function resolveNodeTarget(prompt, classType, nodeId = null) {
  requireApiPrompt(prompt)
  const ids = Object.entries(prompt)
    .filter(([, node]) => node.class_type === classType)
    .map(([id]) => String(id))

  if (nodeId !== null && nodeId !== undefined) {
    const id = String(nodeId)
    if (!ids.includes(id)) {
      throw new ComfyError(
        COMFY_CODES.NODE_UNSUPPORTED,
        `节点 ${id} 不存在，或不是 ${classType}。`,
        `工作流里的 ${classType} 节点有：${ids.join('、') || '（无）'}。`,
      )
    }
    return id
  }

  if (ids.length === 0) {
    throw new ComfyError(
      COMFY_CODES.NODE_UNSUPPORTED,
      `工作流里没有 ${classType} 节点。`,
      '首版只修改工作流里已经存在的节点。',
    )
  }
  if (ids.length > 1) {
    const error = new ComfyError(
      COMFY_CODES.BINDING_AMBIGUOUS,
      `工作流里有 ${ids.length} 个 ${classType} 节点，无法确定改哪一个。`,
      `请显式指定 node_id，候选：${ids.join('、')}。`,
    )
    error.candidates = ids
    throw error
  }
  return ids[0]
}

/** 按连接关系找到正/负提示词节点；多条 KSampler 时同样要求显式指定。 */
export function resolvePromptTarget(prompt, role, samplerId = null) {
  const bindings = analyzeBindings(prompt)
  const samplers =
    samplerId === null || samplerId === undefined
      ? bindings.samplers
      : bindings.samplers.filter((item) => item.id === String(samplerId))

  if (samplers.length === 0) {
    throw new ComfyError(
      COMFY_CODES.NODE_UNSUPPORTED,
      samplerId ? `找不到 KSampler ${samplerId}。` : '工作流里没有 KSampler 节点。',
    )
  }
  if (samplers.length > 1) {
    const error = new ComfyError(
      COMFY_CODES.BINDING_AMBIGUOUS,
      `工作流里有 ${samplers.length} 个 KSampler，无法确定 ${role} 提示词属于哪一个。`,
      `请显式指定 sampler_id，候选：${samplers.map((item) => item.id).join('、')}。`,
    )
    error.candidates = samplers.map((item) => item.id)
    throw error
  }

  const target = samplers[0][role]
  if (!target) {
    throw new ComfyError(
      COMFY_CODES.BINDING_AMBIGUOUS,
      `KSampler ${samplers[0].id} 的 ${role} 没有连接。`,
      '在 ComfyUI 里把对应提示词节点连到该输入，或改用 node_id 直接指定。',
    )
  }
  if (target.missing) {
    throw new ComfyError(
      COMFY_CODES.VALIDATION_FAILED,
      `KSampler ${samplers[0].id} 的 ${role} 指向不存在的节点 ${target.node_id}。`,
    )
  }
  return { node_id: target.node_id, class_type: target.class_type, text: target.text }
}
