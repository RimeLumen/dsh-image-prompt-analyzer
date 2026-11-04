import { SEVERITY, diagnostic } from '../diagnostics.js'

/**
 * 姿势归属：默认由提示词承担，只有用户明说要接 OpenPose / ControlNet 时才交给控制网。
 *
 * 理由是两条路的失效方式不一样：
 *   - 提示词管姿势：能写"哪侧肩更近"，但写不出精确角度，模型每次给你一个大概的斜身；
 *   - ControlNet 管姿势：骨架是硬的，但一旦权重过高，衣褶、发丝、手指也会被一起锁死，
 *     画面变成描图。
 *
 * 所以这不是"哪个更好"的问题，是"谁负责"的问题。默认走插件自己的观察口径，
 * 用户说了要用骨架，才把这部分职责让出去，并给出对应的权重与区间。
 */
export const CONTROL_MODES = Object.freeze(['none', 'openpose', 'controlnet'])

/** 交给控制网之后，这些分类不再往正向标签里塞——它们会和骨架打架。 */
export const DELEGATED_CATEGORIES = Object.freeze(['pose_action'])

export const CONTROL_CODES = Object.freeze({
  POSE_DELEGATED: 'COMPILE_POSE_DELEGATED_TO_CONTROL',
  MODE_UNKNOWN: 'COMPILE_CONTROL_MODE_UNKNOWN',
})

const MODE_ALIASES = Object.freeze({
  openpose: 'openpose',
  'open pose': 'openpose',
  open_pose: 'openpose',
  pose: 'openpose',
  dwpose: 'openpose',
  controlnet: 'controlnet',
  control_net: 'controlnet',
  cn: 'controlnet',
  depth: 'controlnet',
  none: null,
  '': null,
  off: null,
  auto: null,
})

export function normalizeControlMode(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === '') return { mode: null, unknown: false }
  if (Object.prototype.hasOwnProperty.call(MODE_ALIASES, raw)) return { mode: MODE_ALIASES[raw], unknown: false }
  return { mode: null, unknown: true }
}

function openposeUnit() {
  return {
    type: 'openpose',
    weight: 0.85,
    start: 0.0,
    end: 0.8,
    note: '从原图提骨架。低于 0.75 骨架会松，高过 0.9 会把衣褶与发丝一起锁死，画面变成描图。',
  }
}

function controlnetUnits() {
  return [
    openposeUnit(),
    {
      type: 'depth',
      weight: 0.55,
      start: 0.0,
      end: 0.6,
      note: '补景别与前后层次。前伸的手臂这类强透视靠深度图比靠词稳。',
    },
    {
      type: 'ipadapter',
      weight: 0.6,
      start: 0.0,
      end: 1.0,
      note: '服装版型与配色从原图取。提示词写不全的材质细节走这条，别在正向里堆形容词。',
    },
  ]
}

/**
 * 生成控制网建议。只给"该怎么接"，不改 IR——观察是事实，交给谁用是策略。
 */
export function buildControlAdvice({ ir, mode, profile } = {}) {
  if (!mode) return null
  const units = mode === 'controlnet' ? controlnetUnits() : [openposeUnit()]
  const poseTerms = []
  for (const feature of Array.isArray(ir?.features) ? ir.features : []) {
    if (!DELEGATED_CATEGORIES.includes(String(feature?.category ?? ''))) continue
    const text = String(feature?.value ?? '').trim()
    if (text) poseTerms.push(text)
  }
  const sampling = profile?.sampling ?? profile?.generation ?? {}
  const notes = [
    '姿势、肢体与配件空间位置改由骨架/深度承担；正向里的姿态词已让位，只留"人物在做什么"的一句话。',
    '正向单次只加权 3–5 个词：权重铺得越广，骨架与提示词越容易互相拉扯。',
  ]
  if (mode === 'controlnet') {
    notes.push('ControlNet 段之间不要同时开满：骨架 + 深度已经够定结构，第三段留给配色。')
  }
  return {
    mode,
    pose_ownership: 'control',
    delegated_categories: [...DELEGATED_CATEGORIES],
    units,
    params: {
      cfg_scale: sampling.cfg_scale ?? [5.5, 7.5],
      steps: sampling.steps ?? [24, 32],
      clip_skip: sampling.clip_skip ?? 2,
      denoise_img2img: [0.4, 0.6],
    },
    pose_terms: poseTerms,
    notes,
  }
}

/**
 * 把已让位的分类从标签流里摘掉。返回新数组，不改原对象。
 */
export function delegatePoseTerms(terms, mode) {
  if (!mode) return { terms: Array.isArray(terms) ? terms : [], removed: [] }
  const kept = []
  const removed = []
  for (const term of Array.isArray(terms) ? terms : []) {
    const category = String(term?.category ?? '')
    if (DELEGATED_CATEGORIES.includes(category)) {
      removed.push(String(term?.text ?? term?.display ?? ''))
      continue
    }
    kept.push(term)
  }
  return { terms: kept, removed }
}

export function controlDiagnostics({ mode, unknown, advice }) {
  const diagnostics = []
  if (unknown) {
    diagnostics.push(
      diagnostic({
        error_code: CONTROL_CODES.MODE_UNKNOWN,
        severity: SEVERITY.WARNING,
        message: '不认识的姿势控制模式，已按默认（提示词负责姿势）处理。',
        suggested_fix: `可用的值：${CONTROL_MODES.join(' / ')}。`,
      }),
    )
  }
  if (advice) {
    const unitText = advice.units.map((unit) => `${unit.type} ${unit.weight}`).join('、')
    diagnostics.push(
      diagnostic({
        error_code: CONTROL_CODES.POSE_DELEGATED,
        severity: SEVERITY.INFO,
        message: `姿势交给控制网（${advice.mode}）：${unitText}。正向里 ${advice.pose_terms.length} 条姿态观察已让位，保留在描述版里备查。`,
        suggested_fix: '这是显式选择。不传姿势控制参数时，姿势仍由插件自己的观察口径负责。',
      }),
    )
  }
  return diagnostics
}
