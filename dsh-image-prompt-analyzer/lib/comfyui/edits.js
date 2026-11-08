import { COMFY_CODES, ComfyError } from './errors.js'
import { analyzeBindings, resolvePromptTarget } from './bindings.js'

/**
 * 把"换掉 checkpoint""把第一个 LoRA 降到 0.6"这类说法翻成具体节点上的具体字段。
 *
 * 上层模型不该知道节点 id 是怎么排的——那是工作流自己的事。
 * 但它必须知道"这里有两个 UNETLoader，你要改哪个"，所以歧义一律抛出去，
 * 由它带着候选回来问用户，而不是我挑一个动手。
 */

/** role → 从 analyzeBindings 结果里取候选的路径，以及该角色的默认字段。 */
const ROLE_TABLE = Object.freeze({
  checkpoint: { list: 'checkpoints', field: 'ckpt_name', classType: 'CheckpointLoaderSimple' },
  unet: { list: 'unets', field: 'unet_name', classType: 'UNETLoader' },
  vae: { list: 'vaes', field: 'vae_name', classType: 'VAELoader' },
  clip: { list: 'clips', field: 'clip_name', classType: 'CLIPLoader' },
  lora: { list: 'loras', field: 'lora_name', classType: 'LoraLoader' },
  sampler: { list: 'samplers', field: null, classType: 'KSampler' },
  latent: { list: 'latents', field: null, classType: 'EmptyLatentImage' },
})

export const ROLE_VALUES = Object.freeze([...Object.keys(ROLE_TABLE), 'positive', 'negative'])

/** 这些角色天生只可能有一个实例，多了就是工作流本身有歧义。 */
const SINGLETON_ROLES = new Set(['checkpoint', 'unet', 'vae', 'clip', 'sampler', 'latent'])

function candidatesOf(bindings, role) {
  const spec = ROLE_TABLE[role]
  if (!spec) return null
  return Array.isArray(bindings?.[spec.list]) ? bindings[spec.list] : []
}

function ambiguous(role, items) {
  return new ComfyError(
    COMFY_CODES.BINDING_AMBIGUOUS,
    `工作流里有 ${items.length} 个 ${role} 节点，不知道你要改哪一个。`,
    `请用 node_id 指定：${items.map((item) => item.id).join('、')}。`,
  )
}

/**
 * 单条语义变更 → 具体变更。
 * 返回 { node_id, class_type, field, value, role }，与 patch.js 的 changes 同形。
 */
export function resolveSemanticChange(prompt, change) {
  const role = String(change?.role ?? '').trim().toLowerCase()
  if (!ROLE_VALUES.includes(role)) {
    throw new ComfyError(
      COMFY_CODES.VALIDATION_FAILED,
      `不认识的修改目标：${JSON.stringify(change?.role)}。`,
      `可用的是 ${ROLE_VALUES.join(' / ')}，或者直接用 node_id 指定节点。`,
    )
  }

  if (role === 'positive' || role === 'negative') {
    const target = resolvePromptTarget(prompt, role, change.sampler_id ?? null)
    return {
      node_id: target.node_id,
      class_type: target.class_type,
      field: 'text',
      value: change.value,
      role,
    }
  }

  const bindings = analyzeBindings(prompt)
  const items = candidatesOf(bindings, role)
  if (items.length === 0) {
    throw new ComfyError(
      COMFY_CODES.NODE_UNSUPPORTED,
      `这份工作流里没有 ${role} 节点，改不了。`,
      `现有加载节点：${describeLoaders(bindings)}。要换加载方式只能新建工作流。`,
    )
  }

  let picked = items[0]
  if (change.node_id !== undefined && change.node_id !== null) {
    const wanted = String(change.node_id)
    const found = items.find((item) => String(item.id) === wanted)
    if (!found) {
      throw new ComfyError(
        COMFY_CODES.NODE_UNSUPPORTED,
        `节点 ${wanted} 不是 ${role} 节点。`,
        `这一角色下的节点是：${items.map((item) => item.id).join('、')}。`,
      )
    }
    picked = found
  } else if (SINGLETON_ROLES.has(role) && items.length > 1) {
    throw ambiguous(role, items)
  } else if (role === 'lora') {
    // LoRA 允许多个，按 index 取；没给 index 就是第 0 个，这一点要在返回里说清。
    const index = Number.isInteger(change.index) ? change.index : 0
    if (index < 0 || index >= items.length) {
      throw new ComfyError(
        COMFY_CODES.VALIDATION_FAILED,
        `工作流里只有 ${items.length} 个 LoRA，没有第 ${index} 个。`,
      )
    }
    picked = items[index]
  }

  const spec = ROLE_TABLE[role]
  const field = typeof change.field === 'string' && change.field !== '' ? change.field : spec.field
  if (!field) {
    throw new ComfyError(
      COMFY_CODES.VALIDATION_FAILED,
      `改 ${role} 要说明是哪个字段。`,
      role === 'sampler'
        ? '可用字段：seed / steps / cfg / sampler_name / scheduler / denoise。'
        : '可用字段：width / height / batch_size。',
    )
  }

  return {
    node_id: picked.id,
    class_type: picked.class_type ?? spec.classType,
    field,
    value: change.value,
    role,
  }
}

function describeLoaders(bindings) {
  const parts = []
  if (bindings.checkpoints?.length) parts.push(`checkpoints(${bindings.checkpoints.length})`)
  if (bindings.unets?.length) parts.push(`unets(${bindings.unets.length})`)
  if (bindings.clips?.length) parts.push(`clips(${bindings.clips.length})`)
  if (bindings.vaes?.length) parts.push(`vaes(${bindings.vaes.length})`)
  return parts.length > 0 ? parts.join('、') : '无'
}

/**
 * 整批语义变更 → 具体变更。任何一条解析不出来就整批失败：
 * 半份补丁比没有补丁更难解释。
 */
export function resolveSemanticChanges(prompt, changes) {
  const list = Array.isArray(changes) ? changes : []
  const resolved = []
  for (const change of list) {
    if (change && typeof change === 'object' && change.role !== undefined) {
      resolved.push(resolveSemanticChange(prompt, change))
      continue
    }
    resolved.push(change)
  }
  return resolved
}

/** 供工具层拼"我能改什么"的说明，不读磁盘也不发请求。 */
export function describeWorkflowRoles(prompt) {
  const bindings = analyzeBindings(prompt)
  return {
    checkpoints: bindings.checkpoints ?? [],
    unets: bindings.unets ?? [],
    clips: bindings.clips ?? [],
    vaes: bindings.vaes ?? [],
    loras: bindings.loras ?? [],
    samplers: (bindings.samplers ?? []).map((item) => ({ id: item.id })),
    latents: bindings.latents ?? [],
    prompts: (bindings.prompts ?? []).map((item) => ({ id: item.id, role: item.role })),
    ambiguous: bindings.ambiguous ?? [],
  }
}
