import { CATEGORY_IDS } from '../config/categories.js'

/**
 * 观察维度：这套八维拆图法是分析管线的骨架，改自「万能拆图模板」
 * （主体/场景、风格/流派、构图/视角、光影、色彩/氛围、材质、层次/重点、渲染/技术特征）。
 *
 * 这里是 D1–D8 的唯一运行期定义。历史上曾有一份 `configs/image-types/general.json`
 * 当它的"规则文件孪生"，用 `ir_category` + `slot` 描述同一个维度，两处必须手工保持同义；
 * 那份配置从未被运行时加载（只被一个测试当对照物），已随图像类型分类引擎一并移除。
 * 现在改维度只改这一个文件。
 *
 * 字段说明：
 * - `primary_category` / `primary_slot`：该维度的主落点。
 * - `categories`：该维度下合法的内部分类。分类越界会被 IR 校验拦住。
 * - `hints`：判定"这条观察是不是真的属于这个维度"的 key 关键词（小写子串匹配）。
 *   同一分类被多个维度共享时（lighting_color 属于 D4 与 D5），靠 hints 区分。
 * - `fallback_uncertainty`：该维度观察不到时，uncertainty 必须用的 code。
 * - `requires_categories`：这些分类必须先有观察，该维度才算 observed；否则降为 partial。
 *   用来防"D1 写了有个人就算看完了"这种空过——动作、表情没写就是没看。
 */

function defineDimension(definition) {
  for (const category of definition.categories) {
    if (!CATEGORY_IDS.has(category)) {
      throw new Error(`维度 ${definition.id} 引用了未知分类 ${category}`)
    }
  }
  for (const category of definition.requires_categories ?? []) {
    if (!definition.categories.includes(category)) {
      throw new Error(`维度 ${definition.id} 的 requires_categories 含未声明的分类 ${category}`)
    }
  }
  if (!definition.criteria.length) throw new Error(`维度 ${definition.id} 缺少观察要点`)
  return Object.freeze({
    ...definition,
    categories: Object.freeze([...definition.categories]),
    requires_categories: Object.freeze([...(definition.requires_categories ?? [])]),
    criteria: Object.freeze([...definition.criteria]),
    forbidden: Object.freeze([...definition.forbidden]),
    hints: Object.freeze([...definition.hints]),
  })
}

export const DIMENSIONS = Object.freeze([
  defineDimension({
    id: 'D1',
    name: '主体内容与场景设定',
    primary_category: 'subject',
    primary_slot: 'subject.subject_scene',
    categories: ['subject', 'background', 'pose_action', 'expression'],
    // D1 光有"主体是个人"不算观察完：动作与表情也是这一维的内容，
    // 因此 requires_categories 规定：没有 pose_action 的观察，D1 只能算 partial。
    requires_categories: ['pose_action'],
    hints: ['subject', 'scene', 'setting', 'environment', 'count', 'weather', 'fog', 'mist', 'rain', 'snow', 'pose', 'action', 'gesture', 'hand', 'arm', 'leg', 'stance', 'expression', 'gaze', '物体', '人物', '场景', '室内', '室外', '天气', '雾', '霾', '动作', '姿势', '手势', '表情', '视线'],
    weight: 0.95,
    question: '画面的主体是什么，它处在什么场景与情境里？它在做什么动作，表情和视线朝哪？',
    criteria: [
      '主体用可数的名词描述：一个 / 两个 / 一群，不要写"一些元素"',
      '场景给出空间属性：室内或室外、封闭或开阔、真实或虚构',
      '天气与大气状态是要观察的：晴 / 阴 / 雾 / 霾 / 雨 / 雪 / 沙尘，以及时间感（清晨、正午、黄昏、夜晚）',
      '动作必须拆成五轴写：躯干朝向（facing viewer / facing left / facing right / 转身中）、肩线与髋线是否平行（不平行就是 contrapposto，要写髋部朝哪）、重心落在哪条腿（另一条腿伸直 / 屈膝 / 抬起 / 踮脚）、双手各在哪并伸向哪（伸出、扶胸、垂放、持物——分左右）、手指状态（张开 / 并拢 / 握拳）',
      '表情与视线只写可观察的肌肉与眼睑状态（微垂眼、嘴角上扬、张口、皱眉、视线朝下），不写"她很悲伤"这类推断',
      '接触关系要单独写：手扶着什么、身体靠着什么、脚踩在什么上、有没有交叠遮挡',
    ],
    forbidden: [
      '不要写画面里看不见的情节（"她刚失恋"）',
      '不要用形容词代替主体（"一个美丽的场景"）',
      '不要只给一个总括动作词（只写 standing / dynamic pose）就算交代了动作：五轴缺一项，该条只能给 tentative，并在 note 里写清缺哪一项',
      '不要用机位词代替朝向：straight-on / from front / from side 属 camera，不能拿来回答"身体朝哪"；身体侧转、头部回看必须写成 facing right + 头转向 viewer',
      '不要把心理状态写进表情观察（"眼神坚定"要落到"眉压低、下颌抬"这种可见描述）',
    ],
    fallback_uncertainty: 'entity_ambiguous',
  }),
  defineDimension({
    id: 'D2',
    name: '艺术风格与视觉流派',
    primary_category: 'quality_style',
    primary_slot: 'quality_style.style_genre',
    categories: ['quality_style'],
    hints: ['style', 'genre', 'medium', 'art', 'painting', 'photo', 'illustration', 'render', '画风', '风格', '媒介', '流派'],
    weight: 0.8,
    question: '这张图属于什么风格谱系？判断依据是笔触、媒介还是渲染特征？',
    criteria: [
      '先判媒介（摄影 / 绘画 / 三维 / 平面），再判流派（写实 / 表现 / 装饰 / 极简）',
      '媒介要按渲染证据判，而不是按题材猜：边缘是硬是软、色块之间是平切还是连续过渡、有没有可见线稿、有没有笔触与颗粒——这四项决定它是平涂线稿还是厚涂写实',
      '边缘发软、过渡连续、看不到线稿时，媒介词只能落在 painterly / soft rendering / airbrushed / smooth tonal transitions 这一侧，不许写 anime / cel shading / lineart / flat color',
      '流派名用可被检索的既有名词，不要自创复合词',
      '风格判断必须给出至少一条像素级依据',
    ],
    forbidden: [
      '不要用"高级感""氛围感"这类落不到参数的词当风格结论',
      '不要仅凭题材推风格（有古装不等于国风）',
      '不要用题材词顶替媒介结论：fantasy / character design / concept art 说的是画什么，不是怎么画',
    ],
    fallback_uncertainty: 'unsupported_observation',
  }),
  defineDimension({
    id: 'D3',
    name: '构图逻辑与镜头视角',
    primary_category: 'composition',
    primary_slot: 'composition.framing_logic',
    categories: ['composition', 'camera'],
    hints: ['composition', 'framing', 'shot', 'angle', 'view', 'thirds', 'symmetry', 'perspective', '构图', '景别', '视角', '机位'],
    weight: 0.9,
    question: '画面怎么分割？主体放在哪个位置、占多大？四周留白如何分布？观看角度是什么？',
    criteria: [
      '分割方式：三分 / 居中 / 对角线 / 对称 / 框架式 / 留白式',
      '主体位置与占比：左 / 右 / 上 / 下 / 中央，以及占画幅比例（有像素框时以框为准，不要目测）',
      '留白分布：上留白 / 下留白 / 左右留白各占多少；headroom 多少、脚下是否被裁',
      '画面重心：主体重心落在横向中线的哪一侧、纵向偏上还是偏下；五段亮度说明视觉重量在上半还是下半',
      '对称性：左右是否近似镜像；不是镜像就不要写 symmetrical',
      '视角：平视 / 俯视 / 仰视 / 鸟瞰 / 荷兰角，以及机位高度；镜头语言只给定性，不猜数值',
    ],
    forbidden: [
      '不要只写"构图精美"，必须指明是哪一种构图法',
      '不要把"居中构图"当默认答案：竖幅人像也常常偏左或偏右，有量化数字就按数字写',
      '不要在这个维度里写"哪一层最先被看到"，那是 D7',
    ],
    fallback_uncertainty: 'unsupported_observation',
  }),
  defineDimension({
    id: 'D4',
    name: '光影结构与照明方式',
    primary_category: 'lighting_color',
    primary_slot: 'lighting_color.lighting_structure',
    categories: ['lighting_color'],
    hints: ['light', 'lighting', 'shadow', 'highlight', 'glow', 'contrast', 'rim', 'backlit', 'soft', 'hard', 'fog', 'mist', 'haze', 'smoke', 'dust', 'volumetric', 'scatter', 'hazy', '光源', '光比', '阴影', '打光', '雾', '霾', '烟', '尘', '散射'],
    weight: 0.85,
    question: '光从哪来？几个光源？软硬如何？明暗对比强不强？有雾烟尘这类介质吗？',
    criteria: [
      '主光方向（相对镜头）：左前 / 右前 / 顶光 / 逆光 / 侧逆',
      '光源数量与性质：单光源 / 双光源 / 环境漫射 / 混合',
      '软硬判据：阴影边缘锐利 = 硬光，过渡宽 = 软光；再给出光比（高 / 中 / 低）',
      '介质与散射：雾 / 霾 / 烟 / 尘 / 水汽 / 玻璃反射是否存在；存在时写清它是否造成体积光、光晕，或让远处清晰度下降（aerial perspective）',
      '光的空间形态：光是"有方向地穿过空气"还是"整幅画面一起发亮"（全局辉光 / 高调逆光 / 大面积光晕）——后者要写明光从哪一处最亮、如何向外衰减',
    ],
    forbidden: [
      '不要写"打光很好看"，必须落到方向、软硬、光比三要素',
      '不要把"整体发灰、没有纯黑"误当成低对比打光：那是散射介质的证据，要写成雾/霾而不是"光很柔"',
    ],
    fallback_uncertainty: 'unsupported_observation',
  }),
  defineDimension({
    id: 'D5',
    name: '色彩体系与情绪氛围',
    primary_category: 'lighting_color',
    primary_slot: 'lighting_color.color_system',
    categories: ['lighting_color', 'background'],
    hints: ['color', 'colour', 'palette', 'tone', 'saturation', 'temperature', 'hue', 'scheme', 'monochrome', 'greyscale', 'grayscale', 'duotone', 'sepia', 'black and white', '氛围', '色调', '饱和', '冷', '暖', '黑白', '灰阶', '单色'],
    weight: 0.85,
    question: '这张图是彩色的还是单色的？主色是什么？配色关系是什么？',
    criteria: [
      '先判色彩制式：彩色 / 单色（greyscale）/ 双色调（duotone）/ 单色加局部点缀。这是后续所有颜色观察的前提',
      '单色图只写 greyscale / monochrome / black and white，可以补"高对比黑白""柔和灰阶"，但不要给任何色相名',
      '彩色图给主色与辅色的具体色相名（"琥珀色主调 + 青灰辅调"，不要只说"暖色调"）',
      '配色关系：单色 / 邻近 / 互补 / 分裂互补 / 三角；再给饱和度与明度区间',
      '情绪只能由色彩关系推出：氛围线索（雾、尘埃、冷光）写 tentative，情绪结论写 uncertainties',
    ],
    forbidden: [
      '不要用"电影感调色"这类未定义词代替具体色彩关系',
      '不要在单色或双色调图上编造色相——黑白图里写"blue eyes""blonde hair"是本插件最严重的错误',
    ],
    fallback_uncertainty: 'emotion_inferred',
  }),
  defineDimension({
    id: 'D6',
    name: '材质表现与纹理细节',
    primary_category: 'appearance',
    primary_slot: 'appearance.material_texture',
    categories: ['appearance', 'clothing'],
    hints: ['material', 'texture', 'fabric', 'metal', 'glass', 'skin', 'wood', 'stone', 'silk', 'lace', 'sheer', 'leather', 'latex', 'satin', 'knit', 'structure', 'silhouette', 'neckline', 'hem', 'sleeve', 'cut', 'layering', 'trim', '材质', '纹理', '质感', '布料', '纱', '蕾丝', '皮革', '裙', '衣', '结构', '版型', '领口', '肩线', '腰线', '裙摆', '剪裁', '层次', '靴筒'],
    weight: 0.75,
    question: '画面里能认出哪些材质？服装与配饰各是什么做的？它们的结构是怎么组织的（领口、肩、腰线、裙型、靴筒高度、剪裁与分层）？表面反应是怎样的？',
    criteria: [
      '逐主体列材质：织物 / 金属 / 玻璃 / 皮肤 / 石材 / 塑料 / 木',
      '服装与配饰单独拆材质：纱（半透、边缘发亮）/ 缎（宽高光）/ 皮革（紧高光）/ 金属（硬反射）/ 蕾丝（镂空投影）——不要只说"穿着裙子"',
      '服装的**结构**也要单独写成观察，不能只堆材质词：领口与肩线（挂脖 / 露肩 / 平口 / 高领、有没有袖子、袖子是连身还是分离）、腰线（腰封 / 系带 / 上下分体 / 束腰）、裙型（A 字 / 直筒 / 不规则斜裁 / 多层短裙压着长垂布）、垂布与配饰各自挂在哪、腿部与脚踝的覆盖（裸腿 / 短袜 / 过膝袜 / 长靴，靴筒到脚踝还是到小腿，鞋跟形态）',
      '一条 feature 要能独立读懂："哪件东西 + 什么结构 + 什么材质 + 明度"，例如"斜裁的半透明薄纱长垂布，末端印有十字形纹章，比背景暗一档"，而不是孤立地写"translucent"；明度永不可省——同样的版型换成另一个明度就完全不是这件衣服（单色图里明度就是它的"颜色"，不要写色相）',
      '表面反应：镜面反射 / 漫反射 / 半透 / 次表面散射',
      '纹理尺度：细密（布纹）/ 中（木纹）/ 粗（岩石）；判断要落到高光形状与阴影过渡',
    ],
    forbidden: [
      '不要给画面里不存在的材质（把"丝绸"用在棉布上）',
      '不要用服装名称代替材质判断（"晚礼服"不是材质）',
      '不要凭"这类服装通常长什么样"补全画面上看不到的部件（看到紧身胸衣就补上百褶裙、看到腿就补上过膝袜、看到裙摆就补上荷叶边）——每一件被写下的衣物部件都要能在画面里指出来；看不清是踝靴还是过膝靴就写 uncertainty 说明看不到靴筒上沿，不要挑更常见的那种写',
    ],
    fallback_uncertainty: 'insufficient_detail',
  }),
  defineDimension({
    id: 'D7',
    name: '画面层次与视觉重点',
    primary_category: 'composition',
    primary_slot: 'composition.visual_hierarchy',
    categories: ['composition'],
    hints: ['hierarchy', 'layer', 'foreground', 'background', 'focus', 'depth', 'visual', '层次', '重点', '景深', '虚化'],
    weight: 0.7,
    question: '眼睛第一眼落在哪？前中后景怎么分？',
    criteria: [
      '第一视觉重点及其位置，并说明为什么是它（对比 / 亮度 / 色彩 / 清晰度）',
      '前景—中景—背景的分层，以及各层是否清晰（焦外虚化程度）',
      '视觉动线：视线从哪走到哪',
    ],
    forbidden: ['不要把画面里所有元素都说成重点'],
    fallback_uncertainty: 'unsupported_observation',
  }),
  defineDimension({
    id: 'D8',
    name: '渲染质量与技术特征',
    primary_category: 'quality_style',
    primary_slot: 'quality_style.technical_signature',
    categories: ['quality_style'],
    hints: ['quality', 'resolution', 'sharp', 'noise', 'grain', 'film', 'hdr', 'post', 'watermark', 'signature', 'text', 'monochrome', 'greyscale', 'black and white', '锐', '噪点', '颗粒', '水印', '后期', '黑白', '灰阶'],
    weight: 0.65,
    question: '这张图的技术完成度如何？有什么可复现的技术痕迹？',
    criteria: [
      '分辨率观感与锐度：全幅清晰 / 局部柔化 / 整体软化',
      '噪点与颗粒：无 / 细颗粒 / 明显颗粒；后期痕迹：高光滚降、暗部提亮、色散、加锐',
      '画幅技术制式：彩色 / 单色 / 双色调；单色还要说明是高对比硬调、柔和灰阶，还是带网点/扫描质感',
      '可复现的技术痕迹：渲染器质感、水印、签名、画面文字（只写有证据的）',
    ],
    forbidden: ['不要凭画面猜具体设备型号与软件版本'],
    fallback_uncertainty: 'unsupported_observation',
  }),
])

export const DIMENSION_IDS = Object.freeze(DIMENSIONS.map((dimension) => dimension.id))

export const DIMENSION_STATUSES = Object.freeze(['observed', 'partial', 'missing'])

/**
 * 画面里有没有"能动的主体"（人物 / 动物）。
 *
 * 为什么需要它：D1 的 `requires_categories` 强制要求 pose_action，
 * 于是**静物、风景、空镜**这类画面永远只能算 partial，还会被报一条
 * "缺必看分类 pose_action"的警告，并建议"对该维度做一次定向复核（动作看躯干朝向…）"——
 * 图里根本没有躯干，这条诊断是拿人物模板去量所有图。
 *
 * 判定只看 IR 自己的证据，不猜：
 * - `present`：实体 kind 是人物/动物，或 subject 分类的观察里出现了可数的人物/动物词；
 * - `absent`：有 subject 观察，且只匹配静物/风景/物件词，没有一条人物/动物证据；
 * - `unknown`：没有 subject 观察，或证据两头都命不中——这种情况维持原判，宁可多要一次动作观察。
 */
const ANIMATE_KINDS = new Set([
  'character', 'person', 'human', 'animal', 'creature', 'figure', 'girl', 'boy', 'man', 'woman',
  'child', 'kid', 'cat', 'dog', 'bird', 'horse', 'dragon',
])

const ANIMATE_SUBJECT_PATTERN =
  /\b(?:1girl|1boy|1other|2girls|2boys|multiple girls|multiple boys|girl|girls|boy|boys|man|men|woman|women|person|people|human|humans|character|characters|figure|figures|child|children|kid|kids|baby|cat|cats|dog|dogs|bird|birds|animal|animals|creature|creatures|horse|dragon|angel|knight|soldier|warrior|witch|monk|nun|dancer|maid)\b/i

const INANIMATE_SUBJECT_PATTERN =
  /\b(?:still life|no people|no person|no one|nobody|no character|no characters|empty|uninhabited|landscape|scenery|cityscape|seascape|building|buildings|architecture|room|interior|bottle|bottles|vase|vases|fruit|bowl|cup|table|chair|desk|flower|flowers|plant|plants|tree|trees|forest|mountain|mountains|hill|hills|sky|cloud|clouds|road|street|bridge|window|wall|door|product|food|object|objects|statue|book|books|clock|lantern|candle)\b/i

export function animateSubjectState(ir) {
  const subjectValues = []
  for (const feature of Array.isArray(ir?.features) ? ir.features : []) {
    if (String(feature?.category ?? '') !== 'subject') continue
    if (typeof feature?.value === 'string') subjectValues.push(feature.value)
  }
  // 场景总述也算主体证据：`scene.summary` 里常常直接写着 "still life" / "a girl standing"。
  if (typeof ir?.scene?.summary === 'string' && ir.scene.summary.trim()) subjectValues.push(ir.scene.summary)

  const animateKinds = []
  for (const entity of Array.isArray(ir?.entities) ? ir.entities : []) {
    const kind = String(entity?.kind ?? '').trim().toLowerCase()
    if (kind && ANIMATE_KINDS.has(kind)) animateKinds.push(kind)
  }

  const animateHits = subjectValues.filter((value) => ANIMATE_SUBJECT_PATTERN.test(value))
  if (animateKinds.length > 0 || animateHits.length > 0) {
    return {
      state: 'present',
      evidence: animateKinds.length > 0 ? `实体 kind：${[...new Set(animateKinds)].join(', ')}` : `主体观察：${animateHits[0]}`,
    }
  }

  if (subjectValues.length === 0) return { state: 'unknown', evidence: '没有 subject 分类的观察' }

  const inanimateHits = subjectValues.filter((value) => INANIMATE_SUBJECT_PATTERN.test(value))
  if (inanimateHits.length > 0) {
    return { state: 'absent', evidence: `主体观察里没有人物或动物：${inanimateHits[0]}` }
  }

  return { state: 'unknown', evidence: '主体观察既没写人物/动物，也没写静物/风景' }
}

/**
 * 某个维度的"必看分类"在这张图上适不适用。
 *
 * 目前只有 D1 的动作轴是有条件的：画面里没有能动的主体时，要求 pose_action
 * 等于要求模型给一个不存在的东西编动作。其余维度的必看分类无条件生效。
 */
export function requiredCategoryApplicable(dimension, category, subjectState) {
  if (dimension?.id !== 'D1' || category !== 'pose_action') return true
  return subjectState?.state !== 'absent'
}

export const COVERAGE_STATUS_LABELS = Object.freeze({
  observed: '已观察',
  partial: '部分观察',
  missing: '未观察',
})

const BY_ID = new Map(DIMENSIONS.map((dimension) => [dimension.id, dimension]))

export function dimensionById(id) {
  return BY_ID.get(String(id ?? '').trim().toUpperCase()) ?? null
}

export function dimensionsForCategory(categoryId) {
  const id = String(categoryId ?? '').trim()
  return DIMENSIONS.filter((dimension) => dimension.categories.includes(id))
}

/**
 * 一条 feature 会同时命中多个维度时（lighting_color 之于 D4/D5），
 * 用 key 里的关键词决定归属；命中不了就都算"沾边"（partial 的依据）。
 */
export function dimensionsForKey(categoryId, key) {
  const candidates = dimensionsForCategory(categoryId)
  if (candidates.length <= 1) return candidates
  const lowered = String(key ?? '').toLowerCase()
  const matched = candidates.filter((dimension) =>
    dimension.hints.some((hint) => lowered.includes(hint)),
  )
  return matched.length > 0 ? matched : candidates
}

export function dimensionSummaryLine(dimension) {
  return `${dimension.id} ${dimension.name}：${dimension.question}`
}