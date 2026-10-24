
import { INTERNAL_CATEGORIES, DANBOORU_NATIVE_CATEGORIES } from '../config/categories.js'
import { ENTITY_KINDS, RELATION_TYPES, UNCERTAINTY_CODES } from '../ir/schema.js'

export const ANALYSIS_CATEGORY_IDS = Object.freeze(
  INTERNAL_CATEGORIES.filter((category) => !['suppression', 'unsorted'].includes(category.category_id)).map(
    (category) => category.category_id,
  ),
)

export const CATEGORY_INSTRUCTIONS = Object.freeze({
  composition: '景别、主体在画面中的位置与占比、画面分割方式、视线引导、留白。',
  camera: '视角高度（俯视/平视/仰视）、镜头朝向、透视强度、画面倾斜。**不要**给焦距或光圈数字。',
  subject: '主体数量与身份关系、各自在画面中的位置、谁在前谁在后、谁挡住谁。',
  pose_action: '可观察的身体姿态（朝向、支撑、四肢端点）与动作。动作只能推断时，写进 uncertainties。',
  appearance: '发型、发色、瞳色、体型、体表特征（兽耳、角、纹身这类）。',
  clothing: '穿着物、佩戴物、手持物、周围物件四者必须分开，用 entity 的 kind 与 relations 表达。',
  expression: '可观察的面部表情（嘴角、眉毛、眼睛开合）。**推断出来的情绪**写进 uncertainties。',
  background: '场景类型、背景物件、天气、时间。',
  lighting_color: '光源方向、明暗对比、整体色彩倾向（暖/冷、饱和/灰）。',
  quality_style: '画风、媒介、完成度、明显的水印或文字。',
})

export const STAGE_A_SYSTEM = [
  '你是一个严谨的图像结构分析器。你的输出会被程序解析，用于重建这张图的提示词。',
  '',
  '硬性要求：',
  '1. 只输出一个 JSON 对象，不要任何解释、前言、Markdown 代码围栏。',
  '2. 只描述你在图里**看得到**的东西。看不到就写进 uncertainties，不要猜。',
  '3. 置信度（confidence）与重要度（importance）是两个独立的 0 到 1 的小数：',
  '   置信度 = 你有多确定；重要度 = 这条对还原这张图有多关键。不要给两者相同的值。',
  '4. 数值必须是纯小数，不要写百分号、不要写字符串形式的数字。',
  '5. value 用英文小写、接近 Danbooru 标签的写法（空格分隔，不用下划线）。',
  '   中文只允许出现在 note 与 uncertainties 的 question 里。',
].join('\n')

export function buildStageAPrompt({ image, locale = 'zh' } = {}) {
  const aspect = image?.aspect_ratio ? `，画幅比例 ${image.aspect_ratio}` : ''
  const alpha = image?.has_alpha ? '，图片含透明区域（透明区不是背景色）' : ''
  const source =
    image?.scale && image.scale !== 1
      ? `原图 ${image.source_width}×${image.source_height} 已等比缩放到 ${image.width}×${image.height} 后送给你分析，坐标按缩放后的图给。`
      : `图片尺寸 ${image?.width ?? '?'}×${image?.height ?? '?'}。`

  return [
    '分析这张图片，按下面的结构返回 JSON。',
    '',
    source + aspect + alpha,
    '',
    '## 分类词汇表（features[].category 只能取这些值）',
    ...ANALYSIS_CATEGORY_IDS.map((id) => `- ${id}：${CATEGORY_INSTRUCTIONS[id]}`),
    '',
    '## 输出结构',
    '```json',
    '{',
    '  "scene": { "summary": "一句话概括整张图" },',
    '  "features": [',
    '    {',
    '      "category": "composition",',
    '      "key": "shot_type",',
    '      "value": "medium shot",',
    '      "confidence": 0.85,',
    '      "importance": 0.9,',
    '      "region": [0.1, 0.05, 0.9, 0.98],',
    '      "status": "confirmed",',
    '      "note": "可选的简短说明"',
    '    }',
    '  ],',
    '  "entities": [',
    '    {',
    '      "entity_id": "e1",',
    '      "kind": "person",',
    '      "label": "1girl",',
    '      "count": 1,',
    '      "region": [0.2, 0.1, 0.8, 0.95],',
    '      "confidence": 0.95',
    '    }',
    '  ],',
    '  "relations": [',
    '    { "type": "holding", "from": "e1", "to": "e3", "confidence": 0.7, "description": "右手握剑" }',
    '  ],',
    '  "uncertainties": [',
    '    { "code": "action_inferred", "subject": "pose_action.action", "question": "在跑还是在走？", "severity": "medium" }',
    '  ],',
    '  "review_requests": [',
    '    { "id": "face", "reason": "表情看不清", "box": [0.35, 0.08, 0.65, 0.3], "targets": ["expression.expression"] }',
    '  ]',
    '}',
    '```',
    '',
    '## 字段规则',
    `- entities[].kind 只能取：${ENTITY_KINDS.join(' / ')}。`,
    `- relations[].type 只能取：${RELATION_TYPES.join(' / ')}。`,
    `- uncertainties[].code 只能取：${UNCERTAINTY_CODES.join(' / ')}。`,
    '- region 是 [x0, y0, x1, y1] 的归一化坐标（0 到 1，左上为原点，x1 > x0，y1 > y0）。没有明确区域就省略这个字段，不要瞎填。',
    '- status 取 confirmed（看得很确定）/ tentative（看到了但不确定）/ unknown（看不到）。',
    '- 穿着物、佩戴物、手持物、周围物件都要建成 entity，并用 relations 说明归属。这是本插件最看重的一项。',
    '- 优先把构图与镜头写全：它们决定了这张图的骨架。',
    '- 不确定的动作、推断的情绪、看不到的区域，必须出现在 uncertainties 里，**不要**假装确定。',
    '- review_requests 最多 3 条：只有当你真的需要放大某个局部才能判断时才提，并给出足够小的框。',
    '',
    `uncertainties 的 question 用${locale === 'zh' ? '中文' : '英文'}写。`,
  ].join('\n')
}

export const STAGE_B_SYSTEM = [
  '你是一个严谨的图像局部复核器。用户给你一张从原图裁出来的局部图。',
  '',
  '硬性要求：',
  '1. 只输出一个 JSON 对象，不要任何解释、前言、Markdown 代码围栏。',
  '2. 你**只**回答被要求复核的目标，不要顺便描述整张图。',
  '3. 看不出来就把 confidence 写低（低于 0.5）或把 status 写成 unknown，不要编。',
  '4. value 用英文小写、接近 Danbooru 标签的写法。',
].join('\n')

export function buildStageBPrompt({ cropId, targets = [], reason = '' } = {}) {
  const targetLines = targets.length
    ? targets.map((target) => `- ${target}`)
    : ['- 尽量描述这个局部里可观察到的外观与细节特征']
  return [
    `这是从原图裁出来的局部区域「${cropId}」。`,
    reason ? `阶段 A 提出复核的理由：${reason}` : '',
    '',
    '请复核以下目标：',
    ...targetLines,
    '',
    '输出结构：',
    '```json',
    '{',
    '  "features": [ { "category": "expression", "key": "expression", "value": "open mouth", "confidence": 0.8, "importance": 0.4, "status": "confirmed" } ],',
    '  "entities": [ { "kind": "object", "label": "glasses", "count": 1, "confidence": 0.9 } ],',
    '  "relations": [],',
    '  "uncertainties": [ { "code": "insufficient_detail", "subject": "expression.expression", "question": "被头发挡住", "severity": "low" } ]',
    '}',
    '```',
    '',
    'targets 里每一条如果还是看不清，就把它写进 uncertainties，不要硬给一个值。',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export const PROMPT_CONTRACT = Object.freeze({
  categories: ANALYSIS_CATEGORY_IDS,
  entity_kinds: ENTITY_KINDS,
  relation_types: RELATION_TYPES,
  uncertainty_codes: UNCERTAINTY_CODES,
  danbooru_native_categories: DANBOORU_NATIVE_CATEGORIES,
})
