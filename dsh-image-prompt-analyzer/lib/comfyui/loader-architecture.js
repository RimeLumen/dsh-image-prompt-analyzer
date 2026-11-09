/**
 * 模型加载架构：同一个模型文件只能喂给特定的 Loader。
 *
 * 用户的两套约定：
 *   Anima      → diffusion_models 分类，UNETLoader.unet_name，CLIP 与 VAE 各自独立加载
 *   Illustrious→ checkpoints 分类，CheckpointLoaderSimple.ckpt_name，MODEL/CLIP/VAE 三输出
 *
 * 判定顺序按可靠性排：先看 Loader 枚举里到底有没有这个名字（那是 ComfyUI 自己的答案），
 * 再看文件落在哪个分类目录。文件名里带 anima / illustrious 之类的字样不算依据——
 * 用户的文件可以叫任何名字，靠字符串猜等于替用户做决定。
 */

/** 两条加载路径的静态描述。node/field 是真正会被写进 prompt 的位置。 */
export const ARCHITECTURES = Object.freeze({
  checkpoint: Object.freeze({
    architecture: 'checkpoint',
    loader: 'checkpoint',
    category: 'checkpoints',
    node: 'CheckpointLoaderSimple',
    field: 'ckpt_name',
    outputs: Object.freeze(['MODEL', 'CLIP', 'VAE']),
  }),
  unet: Object.freeze({
    architecture: 'unet',
    loader: 'unet',
    category: 'diffusion_models',
    node: 'UNETLoader',
    field: 'unet_name',
    outputs: Object.freeze(['MODEL']),
    companions: Object.freeze(['CLIPLoader', 'VAELoader']),
  }),
})

/** 磁盘分类 → 架构。别名目录（clip/unet）由调用方先归一，这里只认规范名。 */
const CATEGORY_ARCHITECTURES = Object.freeze({
  checkpoints: 'checkpoint',
  diffusion_models: 'unet',
  unet: 'unet',
})

export function architectureOfCategory(category) {
  const key = String(category ?? '').trim().toLowerCase()
  return CATEGORY_ARCHITECTURES[key] ?? null
}

/** Loader 枚举值可能带子目录前缀，Windows 用反斜杠，磁盘相对路径用正斜杠。 */
export function normalizeModelName(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .toLowerCase()
}

function enumHas(options, value) {
  if (!Array.isArray(options) || options.length === 0) return false
  const wanted = normalizeModelName(value)
  if (wanted === '') return false
  return options.some((option) => normalizeModelName(option) === wanted)
}

/**
 * 判断一个模型该用哪条加载路径。
 *
 * @param {object} input
 * @param {string} input.model            模型名（相对路径或裸文件名）
 * @param {string|null} input.category    磁盘扫描得到的分类（规范名优先，别名也可）
 * @param {object|null} input.loaderEnums 形如 { checkpoint: [...], unet: [...] } 的 Loader 枚举
 * @returns {{architecture: string|null, node: string|null, field: string|null,
 *            evidence: string, candidates: string[]}}
 */
export function resolveModelArchitecture({ model = null, category = null, loaderEnums = null } = {}) {
  const wanted = String(model ?? '').trim()
  const enums = loaderEnums ?? {}
  const inCheckpoint = wanted !== '' && enumHas(enums.checkpoint, wanted)
  const inUnet = wanted !== '' && enumHas(enums.unet, wanted)

  if (inCheckpoint && !inUnet) return describe('checkpoint', 'loader_enum', [])
  if (inUnet && !inCheckpoint) return describe('unet', 'loader_enum', [])
  if (inCheckpoint && inUnet) {
    // 两边都说认识，说明有同名文件落在两个分类里。挑一个就是猜。
    return { architecture: null, node: null, field: null, evidence: 'ambiguous', candidates: ['checkpoint', 'unet'] }
  }

  const byCategory = architectureOfCategory(category)
  if (byCategory) {
    // 枚举里没有它，但磁盘分类明确：可能服务端还没刷新模型列表。
    // 这时候给出架构，同时把 evidence 标成 disk_category，让调用方知道依据更弱。
    return describe(byCategory, 'disk_category', [])
  }

  return { architecture: null, node: null, field: null, evidence: 'unknown', candidates: ['checkpoint', 'unet'] }
}

function describe(architecture, evidence, candidates) {
  const spec = ARCHITECTURES[architecture]
  return {
    architecture: spec.architecture,
    node: spec.node,
    field: spec.field,
    evidence,
    candidates,
  }
}

/**
 * 从 prompt 里认出当前用的是哪条加载路径。
 * 只看真实存在的节点类，不看参数名，免得把别的节点的同名字段算进来。
 */
export function architectureInPrompt(prompt) {
  const classes = new Set(
    Object.values(prompt ?? {})
      .map((node) => node?.class_type)
      .filter((value) => typeof value === 'string'),
  )
  const hasCheckpoint = classes.has('CheckpointLoaderSimple')
  const hasUnet = classes.has('UNETLoader')
  if (hasCheckpoint && !hasUnet) return 'checkpoint'
  if (hasUnet && !hasCheckpoint) return 'unet'
  if (hasCheckpoint && hasUnet) return 'mixed'
  return null
}
