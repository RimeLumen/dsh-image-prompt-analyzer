import { COMFY_CODES, ComfyError } from './errors.js'
import { validateFieldValue } from './patch.js'

/**
 * 从零搭一份基础 API Prompt。
 *
 * 只覆盖两条最常见的加载路径：Checkpoint 一把抓，和 UNET + CLIP + VAE 分开加载。
 * 结构固定，参数全部由调用方给，节点与连线不靠猜——复杂工作流不在这个模块的能力范围内。
 */

export const BUILD_DEFAULTS = Object.freeze({
  width: 768,
  height: 1024,
  batch_size: 1,
  steps: 24,
  cfg: 6,
  sampler_name: 'euler',
  scheduler: 'normal',
  denoise: 1,
  filename_prefix: 'dsh_comfy',
})

export const BUILD_LOADERS = Object.freeze(['checkpoint', 'unet'])

/** 每个节点用到的输入字段，校验时按这张表查，不靠遍历猜。 */
export const BUILD_NODE_FIELDS = Object.freeze({
  CheckpointLoaderSimple: ['ckpt_name'],
  UNETLoader: ['unet_name', 'weight_dtype'],
  CLIPLoader: ['clip_name', 'type'],
  VAELoader: ['vae_name'],
  LoraLoader: ['lora_name', 'strength_model', 'strength_clip'],
  CLIPTextEncode: ['text'],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  KSampler: ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  VAEDecode: [],
  SaveImage: ['filename_prefix'],
})

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ComfyError(COMFY_CODES.VALIDATION_FAILED, `新建工作流需要 ${field}。`)
  }
  return value.trim()
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 生成工作流。返回的对象与 ComfyUI 的 API Prompt 完全同形：
 * 键是节点 id 字符串，值是 {class_type, inputs}。
 */
export function buildWorkflow(input = {}) {
  const kind = input.loader ?? 'checkpoint'
  if (!BUILD_LOADERS.includes(kind)) {
    throw new ComfyError(
      COMFY_CODES.NODE_UNSUPPORTED,
      `首版只支持 checkpoint 与 unet 两种加载路径，收到 ${JSON.stringify(kind)}。`,
      '把 loader 写成 checkpoint 或 unet。',
    )
  }

  const positive = requireText(input.positive, 'positive（正向提示词）')
  const negative = typeof input.negative === 'string' ? input.negative : ''
  const width = numberOr(input.width, BUILD_DEFAULTS.width)
  const height = numberOr(input.height, BUILD_DEFAULTS.height)
  const batch = numberOr(input.batch_size, BUILD_DEFAULTS.batch_size)
  const seed = numberOr(input.seed, 0)

  const prompt = {}
  let nextId = 1
  const id = () => String(nextId++)

  let modelSource
  let clipSource
  let vaeSource

  if (kind === 'checkpoint') {
    const ckpt = requireText(input.checkpoint, 'checkpoint（Checkpoint 文件名）')
    const loaderId = id()
    prompt[loaderId] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } }
    modelSource = [loaderId, 0]
    clipSource = [loaderId, 1]
    vaeSource = [loaderId, 2]
  } else {
    const unet = requireText(input.unet, 'unet（UNET 文件名）')
    const clip = requireText(input.clip, 'clip（CLIP / 文本编码器文件名）')
    const vae = requireText(input.vae, 'vae（VAE 文件名）')
    const unetId = id()
    prompt[unetId] = {
      class_type: 'UNETLoader',
      inputs: { unet_name: unet, weight_dtype: typeof input.weight_dtype === 'string' ? input.weight_dtype : 'default' },
    }
    const clipId = id()
    prompt[clipId] = {
      class_type: 'CLIPLoader',
      inputs: { clip_name: clip, type: typeof input.clip_type === 'string' ? input.clip_type : 'stable_diffusion' },
    }
    const vaeId = id()
    prompt[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: vae } }
    modelSource = [unetId, 0]
    clipSource = [clipId, 0]
    vaeSource = [vaeId, 0]
  }

  // LoRA 是链式的：每个 LoraLoader 同时吃 model 与 clip，吐出新的一对。
  const loras = Array.isArray(input.loras) ? input.loras : []
  for (const [index, lora] of loras.entries()) {
    const name = requireText(lora?.lora_name ?? lora?.name, `loras[${index}].lora_name`)
    const loraId = id()
    prompt[loraId] = {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: name,
        strength_model: numberOr(lora?.strength_model ?? lora?.strength, 1),
        strength_clip: numberOr(lora?.strength_clip ?? lora?.strength, 1),
        model: modelSource,
        clip: clipSource,
      },
    }
    modelSource = [loraId, 0]
    clipSource = [loraId, 1]
  }

  const positiveId = id()
  prompt[positiveId] = { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: clipSource } }
  const negativeId = id()
  prompt[negativeId] = { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: clipSource } }

  const latentId = id()
  prompt[latentId] = {
    class_type: 'EmptyLatentImage',
    inputs: { width, height, batch_size: batch },
  }

  const samplerId = id()
  prompt[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      seed,
      steps: numberOr(input.steps, BUILD_DEFAULTS.steps),
      cfg: numberOr(input.cfg, BUILD_DEFAULTS.cfg),
      sampler_name: typeof input.sampler_name === 'string' ? input.sampler_name : BUILD_DEFAULTS.sampler_name,
      scheduler: typeof input.scheduler === 'string' ? input.scheduler : BUILD_DEFAULTS.scheduler,
      denoise: numberOr(input.denoise, BUILD_DEFAULTS.denoise),
      model: modelSource,
      positive: [positiveId, 0],
      negative: [negativeId, 0],
      latent_image: [latentId, 0],
    },
  }

  const decodeId = id()
  prompt[decodeId] = { class_type: 'VAEDecode', inputs: { samples: [samplerId, 0], vae: vaeSource } }

  const saveId = id()
  prompt[saveId] = {
    class_type: 'SaveImage',
    inputs: {
      images: [decodeId, 0],
      filename_prefix: typeof input.filename_prefix === 'string' && input.filename_prefix.trim() !== ''
        ? input.filename_prefix.trim()
        : BUILD_DEFAULTS.filename_prefix,
    },
  }

  return {
    prompt,
    loader: kind,
    node_count: Object.keys(prompt).length,
    lora_count: loras.length,
    sampler_id: samplerId,
    save_id: saveId,
  }
}

/**
 * 按节点定义校验刚搭好的工作流。
 * objectInfoByClass 只含本次真正用到的节点，缺哪个就报哪个，不去拉全量。
 */
export function validateBuiltWorkflow({ prompt, objectInfoByClass = {}, requireObjectInfo = true } = {}) {
  const problems = []
  const push = (item) => problems.push(item)

  for (const [nodeId, node] of Object.entries(prompt ?? {})) {
    const classType = node?.class_type
    const inputs = node?.inputs ?? {}
    const nodeInfo = objectInfoByClass[classType]

    if (!nodeInfo) {
      if (requireObjectInfo) {
        push({
          node_id: nodeId,
          class_type: classType,
          field: null,
          error_code: COMFY_CODES.CAPABILITY_UNAVAILABLE,
          message: `拿不到 ${classType} 的节点定义，无法确认它是否存在、必填项是否齐全。`,
        })
      }
      continue
    }

    const required = Object.keys(nodeInfo.input?.required ?? {})
    for (const field of required) {
      if (!Object.prototype.hasOwnProperty.call(inputs, field)) {
        push({
          node_id: nodeId,
          class_type: classType,
          field,
          error_code: COMFY_CODES.VALIDATION_FAILED,
          message: `${classType} 缺少必需输入 ${field}。`,
        })
      }
    }

    const known = new Set([
      ...Object.keys(nodeInfo.input?.required ?? {}),
      ...Object.keys(nodeInfo.input?.optional ?? {}),
    ])
    for (const field of Object.keys(inputs)) {
      if (!known.has(field)) {
        push({
          node_id: nodeId,
          class_type: classType,
          field,
          error_code: COMFY_CODES.VALIDATION_FAILED,
          message: `${classType} 上不存在输入字段 ${field}。`,
        })
      }
    }

    for (const [field, value] of Object.entries(inputs)) {
      if (Array.isArray(value)) continue // 连接由 inspectApiPrompt 单独查
      try {
        validateFieldValue({ classType, field, value, objectInfo: objectInfoByClass })
      } catch (error) {
        push({
          node_id: nodeId,
          class_type: classType,
          field,
          error_code: error?.code ?? COMFY_CODES.VALIDATION_FAILED,
          message: error?.message ?? String(error),
          suggested_fix: error?.suggested_fix ?? null,
        })
      }
    }
  }

  return { ok: problems.length === 0, problems }
}

/** 校验用到的节点类名，用来决定要问 /object_info 哪几个。 */
export function classesInPrompt(prompt) {
  const set = new Set()
  for (const node of Object.values(prompt ?? {})) {
    if (node && typeof node.class_type === 'string') set.add(node.class_type)
  }
  return [...set].sort()
}
