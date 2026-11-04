/**
 * 姿态合成层：把"描述型"的姿态观察折成 Danbooru 认得的动作标签。
 *
 * 为什么需要它：动作是反推里最容易"看着对、生成不像"的一维。模型写出来的
 * 往往是 `right arm reaching toward viewer` 这种只有句子才说得清的话；双版本
 * 输出以后，这种句子按规则只进描述版，标签版就只剩下 `outstretched hand`
 * 这种没有方向、没有目标位置的裸词。生成端拿到裸词，手就朝画面侧面一伸，
 * 与"朝镜头伸出来"完全是两个动作。
 *
 * 所以这里做一件很窄的事：把常见的姿态句子映射成画面语言里确实存在的标签
 * （reaching_towards_viewer / hand_on_own_chest / looking_down / contrapposto …），
 * 让标签版保住动作的方向与接触关系。映射表只收知识库里真实存在的标签；
 * 认不出的句子不猜，仍然只留在描述版。
 */

import { collectFeatures } from '../ir/index.js'

const POSE_SOURCE_CATEGORIES = new Set(['pose_action', 'expression', 'appearance'])

/** 判定用的最短长度：太短的词（standing）没有方向信息，折了也没意义。 */
const MIN_SOURCE_WORDS = 2

export const POSE_TAG_RULES = Object.freeze([
  {
    tag: 'reaching_towards_viewer',
    test: /(?:reach|reaches|reaching|extend|extends|extended|extending|stretch(?:es|ed|ing)?)[^.]{0,40}\b(?:toward|towards|at|for|to)\b[^.]{0,20}\b(?:viewer|camera|audience|foreground)\b/,
  },
  {
    tag: 'outstretched_arm',
    test: /\barms?\b[^.]{0,30}\b(?:outstretched|extended (?:out|to the side|sideways)|stretched out|held out)\b|\boutstretched\b[^.]{0,16}\barms?\b/,
  },
  {
    tag: 'hand_on_own_chest',
    test: /\bhands?\b[^.]{0,36}\b(?:on|over|against|at)\b[^.]{0,16}\b(?:own |her |his |their )?(?:chest|heart|breast)\b/,
  },
  {
    tag: 'looking_down',
    test: /\b(?:head|chin|gaze|eyes?|face)\b[^.]{0,28}\b(?:down|downward|lowered|dropped|bowed|tucked|cast down)\b|looking (?:down|downward)/,
  },
  {
    tag: 'head_tilt',
    // `head tilted down` 是低头（点头/垂首），不是歪头。
    //
    // Danbooru 的 `head_tilt`（175534 篇）指头部向一侧倾，而"低头"由 `looking_down`
    // 承担。原先的正则 `\bhead\b[^.]{0,16}\btilt(?:s|ed|ing)?\b` 把 `head tilted down`
    // 也折成 `head_tilt`，于是同一条观察 `head tilted down, face in shadow, eyes not
    // visible` 在输出里同时得到 `looking_down` 与 `head_tilt`——一句话里两个朝向互相
    // 打架，生成端各取一半，头就歪过去了。
    //
    // 判据只看方向：tilt 后面紧跟（允许一个程度副词）down / downward / forward /
    // lowered / bowed 时不算歪头。"tilted to one side" 这类仍照旧算。
    test: /(?:\bhead\b[^.]{0,16}\btilt(?:s|ed|ing)?\b|\bhead[- ]tilt(?:ed)?\b)(?!\s*(?:slightly\s+|a\s+bit\s+|further\s+)?(?:down|downward|forward|lowered|bowed)\b)/,
  },
  // 这里曾经有一条 `three_quarter_view` 规则：把"侧转"折成同名标签。
  // 删掉是因为它两头都不占好：一是知识库里 `three_quarter_view` 的作品数是 0，
  // 目标模型根本不认这个词；二是观察层已经把朝向写成 `body turned three-quarter,
  // <near> shoulder forward…` 这样的领起句，再合成一个同义标签，等于同一件事说了两遍，
  // 生成端各取一半，反而把转体读轻（真跑里就是 `body turned three-quarter` 与
  // `three quarter view` 并列）。朝向由观察层的句子直接承载，这一层不再折标签。
  {
    tag: 'contrapposto',
    test: /contrapposto|\bhips?\b[^.]{0,20}\b(?:tilted|shifted|thrust|cocked)\b|weight\b[^.]{0,24}\bon (?:the )?(?:forward|front|left|right|one) leg/,
  },
  {
    tag: 'crossed_legs',
    test: /\blegs?\b[^.]{0,12}\bcrossed\b|crossed (?:at the )?(?:legs|thighs)\b/,
  },
  {
    tag: 'crossed_ankles',
    test: /\bankles?\b[^.]{0,12}\bcrossed\b|crossed (?:at the )?ankles\b/,
  },
  {
    tag: 'leaning_forward',
    test: /\blean(?:s|ing|ed)?\b[^.]{0,16}\b(?:forward|in|toward)\b/,
  },
  {
    tag: 'arched_back',
    test: /\bback\b[^.]{0,16}\b(?:arched|bent backward)\b|arched back/,
  },
  {
    tag: 'arms_at_sides',
    test: /\barms?\b[^.]{0,20}\b(?:at|by|along)\b[^.]{0,10}\b(?:her |his |their |the |own )?sides?\b/,
  },
  {
    tag: 'spread_fingers',
    test: /\bfingers?\b[^.]{0,16}\b(?:spread|splayed|parted|outstretched)\b/,
  },
  {
    tag: 'standing_on_one_leg',
    test: /standing on one leg|one leg (?:lifted|raised|bent)/,
  },
  {
    tag: 'hand_up',
    test: /\bhand\b[^.]{0,20}\b(?:raised|lifted|held up)\b/,
    // 举到胸口的"抬手"是 hand_on_own_chest，不是 hand_up；两条一起写会互相削弱。
    exclude: /\b(?:chest|heart|breast|face|shoulder)\b/,
  },
])

function textOf(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function isUsableText(text) {
  if (text.length === 0) return false
  if (!/[a-z]/.test(text)) return false
  return text.split(/\s+/).filter(Boolean).length >= MIN_SOURCE_WORDS
}

function featureEntries(ir) {
  const holder = []
  // IR 的 feature 是扁平存在 ir.features 里的（实体内部另有自己的 feature），
  // 所以这里必须走 collectFeatures，不能按分量名猜数组。
  for (const feature of collectFeatures(ir)) {
    if (!feature || typeof feature !== 'object') continue
    const category = String(feature.category ?? '')
    if (!POSE_SOURCE_CATEGORIES.has(category)) continue
    const status = String(feature.status ?? '')
    if (status === 'unknown' || status === 'negated') continue
    const text = textOf(feature.value)
    if (!isUsableText(text)) continue
    holder.push({ text, feature, entityId: feature.entity_id ?? null })
  }
  return holder
}

/**
 * 从 IR 里认出可折的动作标签。
 *
 * 每条规则最多命中一次；同一张图里两条相反的描述（`facing viewer` 与
 * `facing away`）都能命中时，先命中的留下——冲突留给观察层的矛盾检测，
 * 不在这一层猜哪个才对。
 */
export function synthesizePoseTags(ir, { max = 6, existingTexts = [] } = {}) {
  const taken = new Set(
    (Array.isArray(existingTexts) ? existingTexts : [])
      .map((text) => String(text ?? '').trim().toLowerCase().replace(/\s+/g, '_'))
      .filter(Boolean),
  )
  const out = []
  for (const entry of featureEntries(ir)) {
    for (const rule of POSE_TAG_RULES) {
      if (out.length >= max) return out
      if (taken.has(rule.tag)) continue
      if (!rule.test.test(entry.text)) continue
      if (rule.exclude && rule.exclude.test(entry.text)) continue
      taken.add(rule.tag)
      out.push({
        tag: rule.tag,
        source_text: entry.text,
        key: entry.feature?.key ?? null,
        category: String(entry.feature?.category ?? 'pose_action'),
        entity_id: entry.entityId,
        confidence: entry.feature?.confidence ?? null,
        importance: entry.feature?.importance ?? null,
        region: entry.feature?.region ?? null,
      })
    }
  }
  return out
}