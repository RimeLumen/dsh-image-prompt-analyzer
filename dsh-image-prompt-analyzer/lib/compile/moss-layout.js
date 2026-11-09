/**
 * MOSS-Image 的可选 JSON Layout 编译。
 *
 * Layout 不是第三个档案，也不是第二个视觉阶段：它只是同一份 IR 的另一种排布。
 * Caption 说的是"画面里有什么、怎么摆"，Layout 额外把"在哪儿"写成坐标。
 *
 * 三条硬约束，全部来自一个理由——坐标错了比没有坐标更糟：
 *   1. 只用 IR 里已有的归一化 region。没有 region 的对象不进 Layout，也不给它
 *      编一个"大概在中间"的框。缺坐标是事实，补坐标是造假。
 *   2. 画布尺寸就是出图尺寸（IR 的 image.width / height）。Layout 的坐标和
 *      EmptyLatentImage 的宽高必须是同一套数，否则框会整体偏移。
 *   3. 画面文字逐字保留，包括换行。文字是内容，不是描述。
 *
 * 坐标格式按官方两份定义分开：
 *   - 草稿格式（默认输出）：`bbox_coord_space: "abs"` + `bbox_format: "xyxy"`，
 *     原点在画布左上角，`[x_min, y_min, x_max, y_max]`。这是人能读、能改的形态。
 *   - 模型输入格式：`"abs_centralized"` + `"yxyx"`，原点在画布中心，
 *     `[y_min, x_min, y_max, x_max]`。换算必须由代码做，不能靠心算。
 */

import { SEVERITY, diagnostic } from '../diagnostics.js'
import { isNormalizedBox } from '../ir/index.js'
import { isNegatedObservation, isPlaceholderObservation } from './terms.js'

export const MOSS_LAYOUT_SCHEMA_VERSION = '1.0'

export const MOSS_LAYOUT_CODES = Object.freeze({
  CANVAS_UNKNOWN: 'COMPILE_MOSS_LAYOUT_CANVAS_UNKNOWN',
  CANVAS_NOT_ALIGNED: 'COMPILE_MOSS_LAYOUT_CANVAS_NOT_ALIGNED',
  NO_REGION: 'COMPILE_MOSS_LAYOUT_NO_REGION',
  BOX_REJECTED: 'COMPILE_MOSS_LAYOUT_BOX_REJECTED',
  TEXT_NO_REGION: 'COMPILE_MOSS_LAYOUT_TEXT_NO_REGION',
  EMPTY: 'COMPILE_MOSS_LAYOUT_EMPTY',
  TRUNCATED: 'COMPILE_MOSS_LAYOUT_TRUNCATED',
  FORMAT_INVALID: 'COMPILE_MOSS_LAYOUT_FORMAT_INVALID',
})

/** 官方支持的两套坐标空间与两种轴序。 */
export const MOSS_BBOX_COORD_SPACES = Object.freeze(['abs', 'abs_centralized'])
export const MOSS_BBOX_FORMATS = Object.freeze(['xyxy', 'yxyx'])

/** 画面文字用的分类与键名，和 `moss.js` 的取法保持一致。 */
const TEXT_CATEGORIES = new Set(['text'])
const TEXT_KEYS = new Set(['text', 'lettering', 'sign_text', 'caption_text', 'logo_text'])

/** 低于这个置信度的框不写进 Layout：错位的框会把整张图的构图带跑。 */
const MIN_REGION_CONFIDENCE = 0.35
const DEFAULT_MAX_ELEMENTS = 24
/** 单个元素描述里最多带几条观察，防止一个主体吃掉整份 Layout。 */
const MAX_DESC_FACTS = 4
/** 官方草稿格式要求画布边长为 16 的倍数。 */
const CANVAS_ALIGNMENT = 16

const round = (value) => Math.round(value * 10000) / 10000

/**
 * 归一化框 → 像素框（左上角原点，`[x_min, y_min, x_max, y_max]`）。
 *
 * 结果一律是整数，并且必须落在画布内。越界不裁剪、不夹紧：裁剪会把一个错误的
 * 框变成一个看起来正确的框，那比直接丢掉更危险。
 */
export function toPixelBox(region, width, height) {
  if (!isNormalizedBox(region)) return null
  const [x0, y0, x1, y1] = region
  const box = [
    Math.round(x0 * width),
    Math.round(y0 * height),
    Math.round(x1 * width),
    Math.round(y1 * height),
  ]
  if (box.some((value) => !Number.isFinite(value))) return null
  if (box[0] < 0 || box[1] < 0) return null
  if (box[2] > width || box[3] > height) return null
  if (box[2] <= box[0] || box[3] <= box[1]) return null
  return box
}

/**
 * 草稿格式（abs / xyxy）→ 模型输入格式（abs_centralized / yxyx）。
 *
 * 官方给的换算式：原始框 `[x1,y1,x2,y2]`，画布 `W×H`，模型格式是
 * `[y1-H/2, x1-W/2, y2-H/2, x2-W/2]`。顺序换了，原点也移了，两件事一起做。
 */
export function toModelBox(bbox, width, height) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null
  const [x1, y1, x2, y2] = bbox.map(Number)
  if ([x1, y1, x2, y2].some((value) => !Number.isFinite(value))) return null
  return [y1 - height / 2, x1 - width / 2, y2 - height / 2, x2 - width / 2]
}

function isUsableText(value) {
  const text = String(value ?? '')
  if (text.trim().length === 0) return false
  if (isNegatedObservation(text)) return false
  if (isPlaceholderObservation(text)) return false
  return true
}

function featureList(entity) {
  return Array.isArray(entity?.features) ? entity.features : []
}

function describeEntity(entity) {
  const values = featureList(entity)
    .filter((feature) => feature && typeof feature.value === 'string' && feature.value.trim())
    .filter((feature) => String(feature.category ?? '') !== 'quality_style')
    .filter((feature) => String(feature.status ?? '') !== 'unknown')
    .filter((feature) => !isNegatedObservation(feature.value))
    .sort((a, b) => (b?.importance ?? 0) - (a?.importance ?? 0))
    .slice(0, MAX_DESC_FACTS)
    .map((feature) => feature.value.trim())
  const label = String(entity?.label ?? '').trim()
  return [label, ...values].filter(Boolean).join(', ')
}

function collectTextItems(ir, { width, height, diagnostics }) {
  const items = []
  const seen = new Set()

  const consider = (feature) => {
    if (!feature || typeof feature !== 'object') return
    const category = String(feature.category ?? '')
    const key = String(feature.key ?? '')
    if (!TEXT_CATEGORIES.has(category) && !TEXT_KEYS.has(key)) return
    if (!isUsableText(feature.value)) return
    const text = String(feature.value)
    if (seen.has(text)) return
    const box = toPixelBox(feature.region, width, height)
    if (!box) {
      // 有文字没坐标：Caption 里照写，Layout 里不给。这里说清楚是"没框"，不是"没看见"。
      if (!diagnostics.some((item) => item.error_code === MOSS_LAYOUT_CODES.TEXT_NO_REGION)) {
        diagnostics.push(
          diagnostic({
            error_code: MOSS_LAYOUT_CODES.TEXT_NO_REGION,
            severity: SEVERITY.WARNING,
            message: `画面文字「${text.slice(0, 40)}」没有可用的 region，Layout 里没有它的位置。`,
            suggested_fix: '文字元素要有可靠框才能进 Layout；没有框时它只出现在 Caption 里。',
          }),
        )
      }
      return
    }
    seen.add(text)
    items.push({
      label: 'text',
      caption: `the text "${text}"`,
      text,
      bbox: box,
    })
  }

  for (const feature of Array.isArray(ir?.features) ? ir.features : []) consider(feature)
  for (const entity of Array.isArray(ir?.entities) ? ir.entities : []) {
    for (const feature of featureList(entity)) consider(feature)
  }
  return items
}

/**
 * 编译一份 JSON Layout。
 *
 * @param {object} options
 * @param {object} options.ir 已 finalize 的 IR
 * @param {object} options.profile 目标档案（只读 config_id）
 * @param {string|null} options.caption 同一份 IR 的 Caption，作为 `summary.caption`
 * @param {number|null} options.canvasWidth 覆盖画布宽（默认取 IR 的 image.width）
 * @param {number|null} options.canvasHeight 覆盖画布高
 * @param {number} options.maxElements 元素上限
 * @param {string} options.coordSpace `abs`（默认）或 `abs_centralized`
 * @param {string} options.bboxFormat `xyxy`（默认）或 `yxyx`
 */
export function buildMossLayout({
  ir = null,
  profile = {},
  caption = '',
  canvasWidth = null,
  canvasHeight = null,
  maxElements = DEFAULT_MAX_ELEMENTS,
  coordSpace = 'abs',
  bboxFormat = 'xyxy',
} = {}) {
  const diagnostics = []
  const width = Number.isInteger(canvasWidth) && canvasWidth > 0 ? canvasWidth : Number(ir?.image?.width)
  const height = Number.isInteger(canvasHeight) && canvasHeight > 0 ? canvasHeight : Number(ir?.image?.height)

  const fail = (code, message, suggestedFix) => {
    diagnostics.push(
      diagnostic({ error_code: code, severity: SEVERITY.ERROR, message, suggested_fix: suggestedFix }),
    )
    return {
      schema_version: MOSS_LAYOUT_SCHEMA_VERSION,
      ok: false,
      profile: profile?.config_id ?? null,
      layout: null,
      text: '',
      stats: { items: 0, objects: 0, texts: 0, skipped: 0, canvas: null },
      diagnostics,
    }
  }

  if (!MOSS_BBOX_COORD_SPACES.includes(coordSpace) || !MOSS_BBOX_FORMATS.includes(bboxFormat)) {
    return fail(
      MOSS_LAYOUT_CODES.FORMAT_INVALID,
      `坐标格式 ${coordSpace} / ${bboxFormat} 不在官方定义里。`,
      '只接受 abs 或 abs_centralized 配 xyxy 或 yxyx；模型输入用 abs_centralized + yxyx。',
    )
  }

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return fail(
      MOSS_LAYOUT_CODES.CANVAS_UNKNOWN,
      'IR 里没有可用的画布尺寸，Layout 无法把归一化坐标换算成像素。',
      'Layout 的坐标必须和出图尺寸一致；先确认 image.width / image.height，或用 canvas 参数显式给出。',
    )
  }

  if (width % CANVAS_ALIGNMENT !== 0 || height % CANVAS_ALIGNMENT !== 0) {
    // 不替用户改尺寸：改了就不是同一张画布，框会跟着漂。只说清楚风险。
    diagnostics.push(
      diagnostic({
        error_code: MOSS_LAYOUT_CODES.CANVAS_NOT_ALIGNED,
        severity: SEVERITY.WARNING,
        message: `画布 ${width}×${height} 不是 16 的倍数，官方草稿格式要求边长可被 16 整除。`,
        suggested_fix: '出图尺寸对齐到 16 的倍数，或确认这条工作流接受非对齐尺寸。',
      }),
    )
  }

  const objects = []
  let skipped = 0
  const entities = (Array.isArray(ir?.entities) ? ir.entities : [])
    .filter((entity) => entity && typeof entity === 'object')
    .filter((entity) => String(entity.status ?? '') !== 'unknown')
    .slice()
    .sort((a, b) => (b?.importance ?? 0) - (a?.importance ?? 0))

  for (const entity of entities) {
    const box = toPixelBox(entity.region, width, height)
    if (!box) {
      skipped += 1
      // 有 region 但换算不过去 = 框本身有问题，要说出来；根本没有 region 的对象
      // 只是"不知道在哪儿"，不算错误。
      if ('region' in entity && entity.region !== undefined) {
        diagnostics.push(
          diagnostic({
            error_code: MOSS_LAYOUT_CODES.BOX_REJECTED,
            severity: SEVERITY.WARNING,
            message: `实体 ${entity.entity_id ?? '?'} 的 region 不是合法的归一化框，已从 Layout 中剔除。`,
            suggested_fix: 'region 必须是 [x0,y0,x1,y1]、每项在 0–1、且 x1>x0、y1>y0。',
          }),
        )
      }
      continue
    }
    // 置信度只在真的写了数字时才用来筛。缺字段不等于「置信度 0」——
    // 老 IR 或手写的 IR 常常不带 confidence，按 0 处理会把有框的元素静默删掉，
    // 用户看到的是「Layout 空了」，却不知道是被一个没写的字段筛掉的。
    const confidence = Number(entity.confidence)
    if (Number.isFinite(confidence) && confidence < MIN_REGION_CONFIDENCE) {
      skipped += 1
      continue
    }
    objects.push({
      label: String(entity.label ?? '').trim() || String(entity.kind ?? 'object'),
      caption: describeEntity(entity),
      bbox: box,
    })
  }

  const texts = collectTextItems(ir, { width, height, diagnostics })
  let items = [...objects, ...texts].sort((a, b) => {
    const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1])
    const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1])
    return areaB - areaA
  })

  const limit = Number.isInteger(maxElements) && maxElements > 0 ? maxElements : DEFAULT_MAX_ELEMENTS
  if (items.length > limit) {
    const dropped = items.length - limit
    items = items.slice(0, limit)
    diagnostics.push(
      diagnostic({
        error_code: MOSS_LAYOUT_CODES.TRUNCATED,
        severity: SEVERITY.INFO,
        message: `Layout 元素超过 ${limit} 个上限，丢弃 ${dropped} 个最小的。`,
        suggested_fix: '元素太多的画面，Layout 不如 Caption 好用；必要时调大 maxElements。',
      }),
    )
  }

  if (items.length === 0) {
    return fail(
      MOSS_LAYOUT_CODES.EMPTY,
      'IR 里没有任何带可靠 region 的元素，Layout 为空，本次没有生成 JSON。',
      '没有坐标就不编坐标。需要 Layout 时，先让视觉阶段产出 entity.region，或改用 Caption。',
    )
  }

  if (skipped > 0 && objects.length === 0) {
    diagnostics.push(
      diagnostic({
        error_code: MOSS_LAYOUT_CODES.NO_REGION,
        severity: SEVERITY.WARNING,
        message: '所有实体都缺少可用 region，Layout 里只剩画面文字。',
        suggested_fix: 'Layout 只排布有框的东西；对象没有框时用 Caption。',
      }),
    )
  }

  const finalItems = items.map((item) => {
    const out = { label: item.label, caption: item.caption }
    if (typeof item.text === 'string') out.text = item.text
    // 四组合同一条算式：先按坐标空间平移原点，再按轴序决定谁在前。
    // 官方模型输入是 abs_centralized + yxyx，等价于 toModelBox；草稿格式是原样。
    const [x0, y0, x1, y1] = item.bbox
    const shiftX = coordSpace === 'abs_centralized' ? width / 2 : 0
    const shiftY = coordSpace === 'abs_centralized' ? height / 2 : 0
    const px = [x0 - shiftX, y0 - shiftY, x1 - shiftX, y1 - shiftY]
    out.bbox = bboxFormat === 'yxyx' ? [px[1], px[0], px[3], px[2]] : px
    return out
  })

  const layout = {
    schema_version: MOSS_LAYOUT_SCHEMA_VERSION,
    summary: {
      meta: {
        profile: profile?.config_id ?? 'moss',
        source: 'image_ir',
        elements: finalItems.length,
      },
      canvas: { width, height },
      caption: String(caption ?? ''),
    },
    bbox_coord_space: coordSpace,
    bbox_format: bboxFormat,
    items: finalItems,
  }

  return {
    schema_version: MOSS_LAYOUT_SCHEMA_VERSION,
    ok: true,
    profile: profile?.config_id ?? null,
    layout,
    text: serializeMossLayout(layout),
    stats: {
      items: finalItems.length,
      objects: objects.length,
      texts: texts.length,
      skipped,
      canvas: { width, height },
    },
    diagnostics,
  }
}

/**
 * 自检：顺序合法、面积为正、落在画布内、没有 NaN / Infinity。
 *
 * 编译时已经保证过一次，这里独立复核——它是给"别人改过这份 JSON"和"将来改了
 * 编译逻辑"留的一道闸，不是重复劳动。
 */
export function validateMossLayout(layout) {
  const problems = []
  if (!layout || typeof layout !== 'object') {
    return { ok: false, problems: ['layout 不是对象'] }
  }
  const canvas = layout.summary?.canvas
  const width = Number(canvas?.width)
  const height = Number(canvas?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    problems.push('summary.canvas 缺失或不是正数')
  }
  const items = Array.isArray(layout.items) ? layout.items : []
  if (items.length === 0) problems.push('items 为空')

  const centered = layout.bbox_coord_space === 'abs_centralized'
  const yxyx = layout.bbox_format === 'yxyx'
  if (!MOSS_BBOX_COORD_SPACES.includes(layout.bbox_coord_space)) problems.push('bbox_coord_space 非法')
  if (!MOSS_BBOX_FORMATS.includes(layout.bbox_format)) problems.push('bbox_format 非法')

  items.forEach((item, index) => {
    const bbox = item?.bbox
    if (!Array.isArray(bbox) || bbox.length !== 4) {
      problems.push(`items[${index}].bbox 不是四元组`)
      return
    }
    if (bbox.some((value) => !Number.isFinite(value))) {
      problems.push(`items[${index}].bbox 含 NaN / Infinity`)
      return
    }
    const [a, b, c, d] = bbox
    // 先还原成 x/y 两组，再判面积与范围：轴序和原点都会变，直接比大小会看错轴。
    const x0 = yxyx ? b : a
    const y0 = yxyx ? a : b
    const x1 = yxyx ? d : c
    const y1 = yxyx ? c : d
    if (!(x1 > x0 && y1 > y0)) problems.push(`items[${index}].bbox 顺序非法（${a},${b},${c},${d}）`)
    if (Number.isFinite(width) && Number.isFinite(height)) {
      if (centered) {
        const halfW = width / 2
        const halfH = height / 2
        if (x0 < -halfW || x1 > halfW || y0 < -halfH || y1 > halfH) {
          problems.push(`items[${index}].bbox 超出中心化画布范围`)
        }
      } else if (x0 < 0 || y0 < 0 || x1 > width || y1 > height) {
        problems.push(`items[${index}].bbox 超出画布范围`)
      }
    }
    if (typeof item?.text === 'string' && item.text.length === 0) {
      problems.push(`items[${index}].text 是空字符串`)
    }
  })

  return { ok: problems.length === 0, problems }
}

/** Layout 的文本形态：Positive Prompt 就是这串 JSON。 */
export function serializeMossLayout(layout) {
  if (!layout || typeof layout !== 'object') return ''
  return JSON.stringify(layout, null, 2)
}
