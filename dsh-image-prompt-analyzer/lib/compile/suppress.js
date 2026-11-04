
import { SEVERITY, diagnostic } from '../diagnostics.js'
import { normalizeTagName } from '../kb/index.js'
import { isHueless } from '../vision/preflight.js'

export const SUPPRESS_CODES = Object.freeze({
  REQUIRED_BUT_EMPTY: 'COMPILE_NEGATIVE_REQUIRED_BUT_EMPTY',
  SCENE_RULE_FIRED: 'COMPILE_SCENE_SUPPRESSION_APPLIED',
  POSE_RULE_FIRED: 'COMPILE_POSE_SUPPRESSION_APPLIED',
  CONTRADICTION_REMOVED: 'COMPILE_NEGATIVE_CONTRADICTION_REMOVED',
  POSITIVE_CONTRADICTION_DROPPED: 'COMPILE_POSITIVE_CONTRADICTION_DROPPED',
  BUDGET_TRUNCATED: 'COMPILE_NEGATIVE_BUDGET_TRUNCATED',
})

/**
 * 超预算时的保留优先级：数字越小越先保留。
 * 依据是"这条有多依赖这张图"——像素证据最依赖，档案基线最不依赖。
 */
const SOURCE_PRIORITY = Object.freeze({
  evidence: 0,
  pose: 1,
  scene: 2,
  structural: 3,
  profile: 4,
})

export const STRUCTURAL_ERROR_TERMS = Object.freeze([
  'bad anatomy',
  'bad hands',
  'bad proportions',
  'extra digits',
  'fewer digits',
  'missing fingers',
  'fused fingers',
  'extra limbs',
  'mutated hands',
])

export const SCENE_SUPPRESSION_RULES = Object.freeze([
  {
    id: 'single_subject_multiplicity',
    when: ({ personCount }) => personCount === 1,
    tag: 'multiple girls',
    reason: 'IR 里恰好只有 1 个人物主体，抑制多人标签有助于避免生成多余的人。',
  },
  {
    id: 'transparent_background',
    when: ({ hasAlpha }) => hasAlpha === true,
    tag: 'white background',
    reason: '原图带透明区域，透明区不是白底；抑制白底可以避免把透明当成白色背景生成。',
  },
])

/**
 * 单色图专用负向。
 *
 * 正向里写 `greyscale, monochrome, black and white` 只是"建议"，模型仍会按题材先验
 * 上色（人像 → 肤色偏暖、头发偏金）。像素已经证明原图无彩，那就必须把"上色"
 * 这件事明确挡在门外——负向是唯一能真正压住色彩的位置。
 */
export const MONOCHROME_NEGATIVE_TERMS = Object.freeze([
  'color',
  'colorful',
  'vibrant colors',
  'saturated colors',
  'color photography',
  'hue',
])

/**
 * 剪影图专用负向：主体是一块纯色时，模型最爱自己脑补内部细节。
 * 这些词不是"错"，是"原图里根本看不见"，写出来就等于让模型编。
 */
export const SILHOUETTE_NEGATIVE_TERMS = Object.freeze([
  'detailed face',
  'facial features',
  'skin texture',
  'visible eyes',
])

/**
 * 姿势抑制段：正向写「佩在腰上」只能算"说明"，掐不断模型对武器的默认先验。
 *
 * 底模见过的大多数带剑二次元图都是握着的，所以只要正向出现 sword，它就先画一只手。
 * 正向的 `sword hilt at hip` 要生效，必须在负向里把"握着"这条先验明确挡掉——
 * 这是正向做不到的事：正向只能说"有"，说不了"不要那样"。
 */
export const WEAPON_NOT_HELD_TERMS = Object.freeze([
  'holding sword',
  'sword in hand',
  'holding weapon',
  'wielding',
  'weapon raised',
  'sword raised',
  'pointing sword',
])

export const NON_COMBAT_TERMS = Object.freeze([
  'combat pose',
  'battle stance',
  'action pose',
  'fighting stance',
  'attack pose',
  'dynamic pose',
  'arms raised',
])

/**
 * 风格抑制段：原图是平涂插画时，模型仍会往"亮面 3D 手办"跑。
 * 这些词不是画质问题，是风格先验——光靠正向写 `cel shading` 压不住。
 */
export const FLAT_ART_STYLE_TERMS = Object.freeze([
  '3d render',
  'photorealistic',
  'octane render',
  'unreal engine',
  'cinema4d',
  'glossy skin',
  'plastic texture',
  'specular highlight',
])

const WEAPON_WORDS = Object.freeze([
  'sword', 'blade', 'dagger', 'katana', 'saber', 'sabre', 'rapier', 'knife',
  'scabbard', 'sheath', 'spear', 'lance', 'axe', 'halberd', 'staff', 'rifle', 'pistol', 'gun',
])

const COMBAT_WORDS = Object.freeze([
  'combat', 'battle', 'fighting', 'attack', 'charging', 'lunging', 'striking', 'swinging',
  'mid-air', 'running', 'jumping', 'dashing', 'leaping',
])

const FLAT_ART_WORDS = Object.freeze([
  'cel shading', 'flat color', 'flat colour', 'anime', 'illustration', 'lineart', 'line art',
  '2d', 'painted', 'airbrush', 'manga',
])

function irText(ir) {
  const parts = []
  for (const feature of Array.isArray(ir?.features) ? ir.features : []) {
    parts.push(String(feature?.value ?? ''))
  }
  for (const entity of Array.isArray(ir?.entities) ? ir.entities : []) {
    parts.push(String(entity?.label ?? ''))
    parts.push(String(entity?.description ?? ''))
    for (const feature of Array.isArray(entity?.features) ? entity.features : []) {
      parts.push(String(feature?.value ?? ''))
    }
  }
  for (const relation of Array.isArray(ir?.relations) ? ir.relations : []) {
    parts.push(String(relation?.description ?? ''))
  }
  return parts.join(' | ').toLowerCase()
}

function mentionsAny(text, words) {
  return words.some((word) => text.includes(word))
}

/**
 * "握着武器"的写法。放在正向里就等于把武器塞进手里，
 * 与"佩在髋侧"的观察直接打架。
 */
const HELD_WEAPON_PATTERN =
  /\b(?:holding|holds|grasping|grips|gripping|wielding|clutching|carrying|brandishing)\b[\s\S]{0,40}?\b(?:swords?|blades?|daggers?|katana|sabers?|rapiers?|knives|knife|scabbard|sheath|spears?|lances?|axes?|halberds?|staffs?|rifles?|pistols?|guns?|hilts?|hilted)\b/

/**
 * 负向压制只能挡掉"模型自己脑补的手"，挡不住正向里那句已经写出来的 holding。
 * 正向说"握着剑柄"、负向说"不要握着剑"，模型收到的是互相抵消的两条指令，
 * 最后怎么画全看权重——多数时候会画成握着的。
 *
 * 所以这里做的是另一半：IR 说武器是佩挂、且没有任何战斗动作时，
 * 把正向里"握着武器"的词直接删掉。真的在挥剑的图 combatClaim 为真，不动。
 */
export function dropHeldWeaponClaims(terms, ir) {
  const context = poseSuppressionContext(ir)
  if (!context.carriedWeapon || context.combatClaim) {
    return { terms: Array.isArray(terms) ? terms : [], dropped: [] }
  }
  const kept = []
  const dropped = []
  for (const term of Array.isArray(terms) ? terms : []) {
    const plain = String(term?.text ?? '').replace(/_/g, ' ')
    if (HELD_WEAPON_PATTERN.test(plain)) {
      dropped.push(term)
      continue
    }
    kept.push(term)
  }
  return { terms: kept, dropped }
}

/**
 * 从 IR 读出"该压什么"。只根据已确认的观察下判断，不猜。
 */
export function poseSuppressionContext(ir) {
  const text = irText(ir)
  const relations = Array.isArray(ir?.relations) ? ir.relations : []
  const entities = Array.isArray(ir?.entities) ? ir.entities : []
  // 关系的 to 是实体 id，不是标签：直接拿它比武器词永远匹配不上，必须先解析回实体。
  const labelOf = (ref) => {
    if (ref && typeof ref === 'object') return String(ref?.label ?? ref?.entity_id ?? '')
    const id = String(ref ?? '')
    const entity = entities.find((item) => item?.entity_id === id)
    return entity ? `${entity?.label ?? ''} ${entity?.description ?? ''}` : id
  }
  const carriedWeapon = relations.some((relation) => {
    const type = String(relation?.type ?? '')
    if (type !== 'accessory' && type !== 'wearing') return false
    const target = labelOf(relation?.to).toLowerCase()
    const description = String(relation?.description ?? '').toLowerCase()
    return mentionsAny(target, WEAPON_WORDS) || mentionsAny(description, WEAPON_WORDS)
  })
  return {
    carriedWeapon,
    combatClaim: mentionsAny(text, COMBAT_WORDS),
    flatArt: mentionsAny(text, FLAT_ART_WORDS),
  }
}

export function countPersons(ir) {
  const entities = Array.isArray(ir?.entities) ? ir.entities : []
  let count = 0
  for (const entity of entities) {
    if (entity?.kind !== 'person') continue
    const label = String(entity?.label ?? '').trim().toLowerCase()
    const encoded = /^(\d+)\s*(girls?|boys?|others?|people|persons?)$/.exec(label)
    if (encoded) {
      count += Number(encoded[1])
      continue
    }
    count += Number.isInteger(entity?.count) && entity.count > 0 ? entity.count : 1
  }
  return count
}

function termKey(text) {
  return normalizeTagName(text).replace(/ /g, '_')
}

export function buildSuppression({ ir, profile, positiveTerms = [] }) {
  const tagStandard = profile?.tag_standard ?? {}
  const negative = tagStandard.negative ?? {}
  const required = negative.required === true
  const diagnostics = []
  const stats = { base: 0, structural: 0, pose: 0, scene: 0, evidence: 0, removed_contradictions: 0, truncated: 0 }

  const terms = []
  const seen = new Set()
  const push = (text, source, reason = undefined) => {
    const value = String(text ?? '').trim()
    if (!value) return false
    const key = termKey(value)
    if (seen.has(key)) return false
    seen.add(key)
    terms.push({ text: value, source, ...(reason ? { reason } : {}) })
    return true
  }

  for (const text of Array.isArray(negative.terms) ? negative.terms : []) {
    if (push(text, 'profile')) stats.base += 1
  }

  if (required) {
    for (const text of STRUCTURAL_ERROR_TERMS) {
      if (push(text, 'structural')) stats.structural += 1
    }
    // 姿势抑制段：只在 IR 真的说了"武器佩在身上"或"不是战斗姿"时才开。
    // 无条件加会伤到真的在挥剑的图——那时负向里的 holding sword 会跟正向打架。
    const poseContext = poseSuppressionContext(ir)
    if (poseContext.carriedWeapon) {
      for (const text of WEAPON_NOT_HELD_TERMS) {
        if (push(text, 'pose', 'IR 里武器是 accessory（佩在身上）而不是 holding：正向只能说明"有"，掐断"握着"这条先验得靠负向。')) {
          stats.pose += 1
        }
      }
      diagnostics.push(
        diagnostic({
          error_code: SUPPRESS_CODES.POSE_RULE_FIRED,
          severity: SEVERITY.INFO,
          message: `姿势抑制 weapon_not_held 触发：武器关系是佩挂而非手持，已压制 ${WEAPON_NOT_HELD_TERMS.length} 条"握着武器"的写法。`,
          suggested_fix: '这是期望行为。原图真的是握剑时，IR 里那条关系会是 holding，这一段就不会触发。',
        }),
      )
    }
    if (poseContext.flatArt) {
      for (const text of FLAT_ART_STYLE_TERMS) {
        if (push(text, 'pose', 'IR 里风格是平涂插画：亮面 3D 与镜面高光是模型最容易自己加上去的先验。')) {
          stats.pose += 1
        }
      }
    }
    if (!poseContext.combatClaim && poseContext.carriedWeapon) {
      for (const text of NON_COMBAT_TERMS) {
        if (push(text, 'pose', 'IR 里没有任何战斗动作的描述：原图是静态舒展，不是战斗姿。')) {
          stats.pose += 1
        }
      }
    }

    const context = { personCount: countPersons(ir), hasAlpha: ir?.image?.has_alpha === true }
    for (const rule of SCENE_SUPPRESSION_RULES) {
      if (!rule.when(context)) continue
      if (!push(rule.tag, 'scene', rule.reason)) continue
      stats.scene += 1
      diagnostics.push(
        diagnostic({
          error_code: SUPPRESS_CODES.SCENE_RULE_FIRED,
          severity: SEVERITY.INFO,
          message: `场景抑制 ${rule.id} 触发：${rule.tag}。${rule.reason}`,
        }),
      )
    }

    // 像素证据驱动的负向：原图是单色/剪影，就把"上色"与"补内部细节"挡掉。
    // 这些词和 positiveTerms 的冲突消解走同一套逻辑，正向真写了就自动让路。
    // 色彩制式优先看预检结论：verdict.monochrome 只管"完全无彩"，
    // 而双色调图（duotone）同样不该被上成彩色，所以两处都要判。
    const verdict = ir?.provenance?.pixel_verdict ?? {}
    const colorMode = ir?.provenance?.color_mode ?? null
    if (verdict.monochrome === true || isHueless(colorMode)) {
      for (const text of MONOCHROME_NEGATIVE_TERMS) {
        if (push(text, 'evidence', '像素判定为单色：正向写 greyscale 压不住模型按题材上色的先验。')) {
          stats.evidence += 1
        }
      }
    }
    if (verdict.silhouette === true) {
      for (const text of SILHOUETTE_NEGATIVE_TERMS) {
        if (push(text, 'evidence', '像素判定为剪影：主体内部细节在原图里不可见，写出来等于让模型编。')) {
          stats.evidence += 1
        }
      }
    }
  }

  const positives = new Set(
    (Array.isArray(positiveTerms) ? positiveTerms : [])
      .map((term) => (typeof term === 'string' ? term : term?.display ?? term?.text ?? ''))
      .map((text) => termKey(text))
      .filter((key) => key.length > 0),
  )
  if (positives.size > 0) {
    const kept = []
    for (const term of terms) {
      if (positives.has(termKey(term.text))) {
        stats.removed_contradictions += 1
        diagnostics.push(
          diagnostic({
            error_code: SUPPRESS_CODES.CONTRADICTION_REMOVED,
            severity: SEVERITY.INFO,
            message: `正向里已经有「${term.text}」，负向里的同名词已删掉。`,
          }),
        )
        continue
      }
      kept.push(term)
    }
    terms.length = 0
    terms.push(...kept)
  }

  const declaredMax = Number(negative.max_terms)
  const maxTerms = Number.isFinite(declaredMax) && declaredMax > 0 ? declaredMax : 30
  if (terms.length > maxTerms) {
    // 超预算时不能先进先出：档案基线（lowres / worst quality 这类）排在最前，
    // 一截就把尾巴上新算出来的姿势、场景、像素证据全吃掉，而它们才是针对这张图的。
    // 按来源分优先级，先丢通用基线，保住"这张图特有"的条目。
    const keep = [...terms].sort((a, b) => {
      const pa = SOURCE_PRIORITY[a.source] ?? 9
      const pb = SOURCE_PRIORITY[b.source] ?? 9
      if (pa !== pb) return pa - pb
      return terms.indexOf(a) - terms.indexOf(b)
    }).slice(0, maxTerms)
    const droppedTerms = terms.filter((term) => !keep.includes(term))
    stats.truncated = droppedTerms.length
    stats.truncated_sources = droppedTerms.reduce((acc, term) => {
      acc[term.source] = (acc[term.source] ?? 0) + 1
      return acc
    }, {})
    terms.length = 0
    terms.push(...keep)
    diagnostics.push(
      diagnostic({
        error_code: SUPPRESS_CODES.BUDGET_TRUNCATED,
        severity: SEVERITY.INFO,
        message: `负向超过 ${maxTerms} 条上限，按来源优先级丢弃 ${droppedTerms.length} 条：${droppedTerms.map((term) => term.text).join(', ')}。`,
        suggested_fix: '针对这张图算出来的条目（姿势/场景/像素证据）优先保留，被丢的是通用基线。想全留就提高该档案的 negative.max_terms。',
      }),
    )
  }

  if (required && terms.length === 0) {
    diagnostics.push(
      diagnostic({
        error_code: SUPPRESS_CODES.REQUIRED_BUT_EMPTY,
        severity: SEVERITY.WARNING,
        message: '档案要求负向提示词，但最终负向是空的：档案没有声明 negative.terms，且没有触发任何抑制规则。',
        suggested_fix: '在该档案的 negative.terms 里补一条基线负向。',
      }),
    )
  }

  return { terms, diagnostics, stats }
}
