
import { COMFY_CODES } from './errors.js'
import { enumOptionsOf } from './patch.js'

// 四种状态各自独立记录，任何一个都不允许由另一个推导出来。
export const MODEL_STATES = Object.freeze({
  DISK_PRESENT: 'disk_present',
  RUNTIME_VISIBLE: 'runtime_visible',
  LOADER_SELECTABLE: 'loader_selectable',
  EXECUTION_SUCCESS: 'execution_success',
})

export const STATE_VALUES = Object.freeze(['true', 'false', 'unknown'])

// 分类 → 哪个 loader 节点的哪个输入负责选择它。只覆盖官方节点，
// 自定义节点的枚举无从得知，一律 unknown。
export const CATEGORY_LOADERS = Object.freeze({
  checkpoints: { node: 'CheckpointLoaderSimple', field: 'ckpt_name' },
  loras: { node: 'LoraLoader', field: 'lora_name' },
  vae: { node: 'VAELoader', field: 'vae_name' },
  text_encoders: { node: 'CLIPLoader', field: 'clip_name' },
  diffusion_models: { node: 'UNETLoader', field: 'unet_name' },
  controlnet: { node: 'ControlNetLoader', field: 'control_net_name' },
  upscale_models: { node: 'UpscaleModelLoader', field: 'model_name' },
})

// VAELoader 会把这些名字塞进枚举里，但它们不是磁盘上的文件。
export const VIRTUAL_ENUM_ENTRIES = Object.freeze({
  vae: Object.freeze(['pixel_space', 'taesd', 'taesdxl', 'taesd3', 'taef1']),
})

function normalizeRelative(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase()
}

/**
 * 磁盘条目记的是相对扫描根的路径（`checkpoints/sd15.safetensors`），
 * 而 /models 与 loader 枚举给的是相对分类目录的路径（`sd15.safetensors`）。
 * 两边要能对上，就得把分类那一段去掉。去掉之后仍保留原路径用于回显。
 */
function withinCategory(entry) {
  const rel = normalizeRelative(entry.relative_path)
  const category = normalizeRelative(entry.category)
  if (category && rel.startsWith(`${category}/`)) return rel.slice(category.length + 1)
  return rel
}

/**
 * 把磁盘扫描结果、/models 枚举、loader 枚举三者对账。
 *
 * runtimeAvailable 为 false 时，运行时三态一律 unknown——服务没起，
 * 我们不知道它会不会认这个文件，不能替它回答 false。
 */
export function reconcileModels({
  entries = [],
  models = null,
  loaderEnums = null,
  runtimeAvailable = false,
} = {}) {
  const diagnostics = []

  const modelsByCategory = new Map()
  if (models && typeof models === 'object') {
    for (const [category, names] of Object.entries(models)) {
      if (!Array.isArray(names)) continue
      modelsByCategory.set(category, new Set(names.map(normalizeRelative)))
    }
  }

  const enumsByNode = new Map()
  if (loaderEnums && typeof loaderEnums === 'object') {
    for (const [node, entry] of Object.entries(loaderEnums)) {
      if (!entry || typeof entry !== 'object') continue
      enumsByNode.set(node, entry)
    }
  }

  const merged = entries.map((entry) => {
    const category = entry.category
    const rel = normalizeRelative(entry.relative_path)
    const relInCategory = withinCategory(entry)

    let runtimeVisible = 'unknown'
    if (runtimeAvailable) {
      const set = category ? modelsByCategory.get(category) : null
      runtimeVisible = set ? String(set.has(relInCategory) || set.has(rel)) : 'unknown'
    }

    let loaderSelectable = 'unknown'
    const loader = category ? CATEGORY_LOADERS[category] : null
    if (runtimeAvailable && loader) {
      const info = enumsByNode.get(loader.node)
      const spec = info?.input?.required?.[loader.field]
      const options = enumOptionsOf(spec)
      if (Array.isArray(options)) {
        const names = options.map(normalizeRelative)
        loaderSelectable = String(names.includes(relInCategory) || names.includes(rel))
      }
    }

    return {
      ...entry,
      states: {
        [MODEL_STATES.DISK_PRESENT]: 'true',
        [MODEL_STATES.RUNTIME_VISIBLE]: runtimeVisible,
        [MODEL_STATES.LOADER_SELECTABLE]: loaderSelectable,
        // 只有真的跑成功过才有资格写 true；这里永远不推断。
        [MODEL_STATES.EXECUTION_SUCCESS]: 'unknown',
      },
    }
  })

  // 运行时枚举里有、磁盘上没有的项：可能是虚拟项，也可能是扫描根没覆盖到。
  const virtual = []
  if (runtimeAvailable && models && typeof models === 'object') {
    const diskByCategory = new Map()
    for (const entry of entries) {
      if (!entry.category) continue
      if (!diskByCategory.has(entry.category)) diskByCategory.set(entry.category, new Set())
      const bucket = diskByCategory.get(entry.category)
      bucket.add(withinCategory(entry))
      bucket.add(normalizeRelative(entry.relative_path))
    }
    for (const [category, names] of Object.entries(models)) {
      if (!Array.isArray(names)) continue
      const diskSet = diskByCategory.get(category) ?? new Set()
      for (const name of names) {
        const rel = normalizeRelative(name)
        if (diskSet.has(rel)) continue
        const known = VIRTUAL_ENUM_ENTRIES[category] ?? []
        virtual.push({
          category,
          name,
          virtual: known.some((item) => normalizeRelative(item) === rel),
          states: {
            [MODEL_STATES.DISK_PRESENT]: 'false',
            [MODEL_STATES.RUNTIME_VISIBLE]: 'true',
            [MODEL_STATES.LOADER_SELECTABLE]: 'unknown',
            [MODEL_STATES.EXECUTION_SUCCESS]: 'unknown',
          },
        })
      }
    }
  }

  if (!runtimeAvailable) {
    diagnostics.push({
      error_code: COMFY_CODES.CAPABILITY_UNAVAILABLE,
      field_path: '/comfyui/baseUrl',
      message: 'ComfyUI 运行时不可达，运行时三态记为 unknown。',
      suggested_fix: '启动 ComfyUI 后重试，或先用磁盘扫描结果。',
    })
  }

  return {
    entries: merged,
    virtual,
    runtime_available: runtimeAvailable,
    diagnostics,
  }
}

/** 按四态过滤。值为 'true'/'false'/'unknown' 字符串，过滤条件同样接受这三值。 */
export function filterByStates(entries, filter = {}) {
  const wanted = Object.entries(filter).filter(([, value]) => value !== undefined && value !== null)
  if (wanted.length === 0) return entries
  return entries.filter((entry) =>
    wanted.every(([state, value]) => entry.states?.[state] === String(value)),
  )
}
