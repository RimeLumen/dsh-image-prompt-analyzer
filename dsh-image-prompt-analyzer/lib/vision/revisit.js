import { CATEGORY_INSTRUCTIONS } from './prompt.js'
import { parseModelJson } from './parse.js'
import { clamp01 } from '../ir/schema.js'

/** 二次分析的三种取框方式：4 宫格、9 宫格、用户自由框选。 */
export const REVISIT_MODES = Object.freeze({
  GRID4: 'grid4',
  GRID9: 'grid9',
  FREE: 'free',
})

export const TILE_LAYOUT = Object.freeze({
  [REVISIT_MODES.GRID4]: { cols: 2, rows: 2 },
  [REVISIT_MODES.GRID9]: { cols: 3, rows: 3 },
})

const MAX_FREE_BOXES = 9
const MAX_BOXES = 9

/** 等分切块。返回归一化框 [x0,y0,x1,y1]，不带任何间隙。 */
export function planTiles(mode) {
  const layout = TILE_LAYOUT[mode]
  if (!layout) return []
  const boxes = []
  for (let row = 0; row < layout.rows; row += 1) {
    for (let col = 0; col < layout.cols; col += 1) {
      boxes.push([
        round4(col / layout.cols),
        round4(row / layout.rows),
        round4((col + 1) / layout.cols),
        round4((row + 1) / layout.rows),
      ])
    }
  }
  return boxes
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

function normalizeBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null
  const nums = box.map((item) => Number(item))
  if (nums.some((item) => !Number.isFinite(item))) return null
  const [x0, y0, x1, y1] = nums
  const box01 = [clamp01(Math.min(x0, x1)), clamp01(Math.min(y0, y1)), clamp01(Math.max(x0, x1)), clamp01(Math.max(y0, y1))]
  const width = box01[2] - box01[0]
  const height = box01[3] - box01[1]
  // 太小的框裁出来就是一团噪点，模型只会编。
  if (width < 0.04 || height < 0.04) return null
  return box01.map(round4)
}

/** 把请求里的 mode/boxes 收敛成一组可用框。非法输入不抛错，返回空数组由上层报 400。 */
export function resolveRevisitBoxes({ mode, boxes } = {}) {
  if (mode === REVISIT_MODES.GRID4 || mode === REVISIT_MODES.GRID9) {
    return planTiles(mode)
  }
  if (mode !== REVISIT_MODES.FREE) return []
  const list = Array.isArray(boxes) ? boxes : []
  const cleaned = []
  for (const box of list) {
    const normalized = normalizeBox(box)
    if (!normalized) continue
    if (cleaned.some((item) => item.every((value, index) => Math.abs(value - normalized[index]) < 0.005))) continue
    cleaned.push(normalized)
    if (cleaned.length >= MAX_FREE_BOXES) break
  }
  return cleaned
}

function categoryVocabulary() {
  const lines = ['可用分类：']
  for (const [category, text] of Object.entries(CATEGORY_INSTRUCTIONS)) {
    lines.push(`- ${category}：${text}`)
  }
  return lines.join('\n')
}

export const REVISIT_SYSTEM = [
  '你是图像局部观察器。用户会给你整张图里的一小块区域，以及这张图之前已经得到的观察结论。',
  '你的任务不是重新描述整张图，而是回答两件事：',
  '1. 这一块里有没有和已有观察**不一致**的地方？有不一致就给出你看到的正确值。',
  '2. 这一块里有没有已有观察**漏掉**的细节？有就补上。',
  '规则：',
  '- 只写这个区域里看得到的。框外的东西一律不写，哪怕你从整图的上下文知道。',
  '- value 用英文小写、Danbooru 风格的短标签或短语，不要写句子。',
  '- 每条观察必须给 category（从下方分类里选）、key（同一分类内唯一）、value、confidence（0–1）。',
  '- confidence ≥ 0.75 表示"确定看到"，0.5–0.75 表示"大概是"，低于 0.5 就别写，改写成 uncertainties。',
  '- 看不出来就少写。空数组是完全合法的答案。',
  '- 只输出一个 JSON 对象，不要代码围栏，不要解释文字。',
  '输出格式：',
  '{"observations":[{"category":"lighting_color","key":"lighting_structure","value":"soft rim light from left","confidence":0.8}],"uncertainties":[{"code":"insufficient_detail","question":"这块区域被遮挡的部分有什么？"}],"note":"一句话说明这块区域最值得注意的差异"}',
  categoryVocabulary(),
].join('\n')

/** 只保留必要上下文：已有提示词太长会把模型带偏到"重写"，所以截断。 */
export function summarizePreviousPrompt(text, limit = 700) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}

export function buildRevisitPrompt({ box, index = 1, total = 1, previousPrompt = '', previousSummary = '' }) {
  const lines = []
  lines.push(previousSummary ? `整张图的一句话概述：${previousSummary}` : '整张图的一句话概述：（无）')
  lines.push('')
  lines.push('这张图之前得到的提示词（英文 tag，可能不完整或有错）：')
  lines.push(summarizePreviousPrompt(previousPrompt) || '（还没有提示词）')
  lines.push('')
  lines.push(
    `现在只看第 ${index}/${total} 块区域，归一化坐标 [x0, y0, x1, y1] = [${box.join(', ')}]。`,
  )
  lines.push('请对照上面的提示词，回答这块区域里：哪些地方不一致、哪些地方漏了。')
  lines.push('只输出 JSON。')
  return lines.join('\n')
}

function normalizeObservation(raw) {
  if (!raw || typeof raw !== 'object') return null
  const category = String(raw.category ?? '').trim()
  const key = String(raw.key ?? '').trim()
  const value = typeof raw.value === 'string' ? raw.value.trim() : raw.value
  const confidence = clamp01(raw.confidence)
  if (!category || !key || value === null || value === undefined || value === '') return null
  if (confidence === null || confidence < 0.35) return null
  return { category, key, value, confidence }
}

/**
 * 逐块观察。每块一次独立调用；某块失败不影响其他块，只记诊断。
 * 返回的 observations 已经带上各自的 region，交给 merge 层决定替换/补齐。
 */
export async function runRevisitVision({
  prepared,
  preparer,
  backend,
  boxes,
  previousPrompt = '',
  previousSummary = '',
  visionConfig = {},
  logger = null,
  diagnostics = [],
  onProgress = null,
}) {
  const stats = { boxes: boxes.length, calls: 0, observations: 0, failed: 0, repairs: 0 }
  const observations = []
  if (!Array.isArray(boxes) || boxes.length === 0) return { observations, stats }

  const crops = boxes.map((box, index) => ({ id: `revisit_${index + 1}`, box }))
  const cropResult = await preparer.prepare({
    imagePath: prepared.sourcePath,
    outDir: prepared.tempDir,
    crops,
  })
  const minSide = Number(visionConfig.min_crop_side ?? 0.08)
  const tempDir = prepared.tempDir

  const tasks = []
  for (const crop of crops) {
    const decoded = cropResult?.crops?.find((item) => item.id === crop.id)
    if (!decoded?.path) {
      stats.failed += 1
      continue
    }
    const width = Number(decoded.width ?? 0)
    const height = Number(decoded.height ?? 0)
    if (width > 0 && height > 0 && Math.min(width, height) < 96) {
      stats.failed += 1
      logger?.debug?.('二次分析裁图过小，跳过：%s (%sx%s)', crop.id, width, height)
      continue
    }
    tasks.push({ crop, decoded })
  }

  onProgress?.('revisit', `二次分析：把画面切成 ${boxes.length} 块，正在逐块复核…`)
  const results = await Promise.allSettled(
    tasks.map(async ({ crop, decoded }, index) => {
      onProgress?.('revisit', `二次分析：正在看第 ${index + 1}/${tasks.length} 块…`)
      const prompt = buildRevisitPrompt({
        box: crop.box,
        index: index + 1,
        total: tasks.length,
        previousPrompt,
        previousSummary,
      })
      const response = await backend.complete({
        prompt,
        system: REVISIT_SYSTEM,
        images: [{ path: decoded.path, mediaType: 'image/png', name: `${crop.id}.png` }],
        maxTokens: Number(visionConfig.max_tokens ?? 2048),
        temperature: Number(visionConfig.temperature ?? 0.2),
      })
      stats.calls += 1
      const parsed = parseModelJson(response?.text ?? '', { expected: 'object' })
      stats.repairs += parsed.repairs?.length ?? 0
      const list = Array.isArray(parsed.data?.observations) ? parsed.data.observations : []
      const clean = []
      for (const item of list) {
        const normalized = normalizeObservation(item)
        if (!normalized) continue
        clean.push({ ...normalized, region: crop.box })
      }
      return clean
    }),
  )

  for (const result of results) {
    if (result.status === 'fulfilled') {
      observations.push(...result.value)
      stats.observations += result.value.length
    } else {
      stats.failed += 1
      diagnostics.push({
        error_code: 'REVISIT_CALL_FAILED',
        severity: 'warning',
        message: `二次分析有一块失败：${result.reason?.message ?? result.reason}`,
        suggested_fix: '其余区域的结论仍然有效；可以只对失败的区域重新框选一次。',
      })
    }
  }

  if (minSide > 0) {
    // 框太小是用户在界面上手抖，不是模型问题：单独记一条，便于面板提示。
    const tiny = boxes.filter((box) => box[2] - box[0] < minSide || box[3] - box[1] < minSide).length
    if (tiny > 0) stats.tiny_boxes = tiny
  }

  return { observations, stats }
}

export { MAX_BOXES, MAX_FREE_BOXES }