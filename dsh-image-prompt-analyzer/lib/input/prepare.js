
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { stat as statFile } from 'node:fs/promises'

import { DecodeError } from './decoder.js'
import { NULL_LOGGER } from '../log.js'
import { PACKAGE_DIR, resolveWithin } from '../paths.js'

export async function resolveImagePath(ctx, imagePath, { signal } = {}) {
  const raw = String(imagePath ?? '').trim()
  if (raw.length === 0) {
    throw new Error('图片路径为空')
  }
  const fs = ctx?.fs
  if (fs && typeof fs.resolve === 'function') {
    try {
      const target = await fs.resolve(raw, { signal })
      if (target && typeof fs.processPath === 'function') {
        return fs.processPath(target)
      }
    } catch {
    }
  }
  return isAbsolute(raw) ? raw : resolvePath(process.cwd(), raw)
}

async function packageCandidateHint(raw, absolute) {
  if (typeof raw !== 'string' || raw.trim() === '' || isAbsolute(raw)) return ''
  const candidate = resolveWithin(PACKAGE_DIR, raw)
  if (!candidate || candidate === absolute) return ''
  try {
    const info = await statFile(candidate)
    if (!info.isFile()) return ''
  } catch {
    return ''
  }
  return `；插件目录下有一份同名文件：${candidate}（要分析它请把这个绝对路径传给 image_path）`
}

async function assertSourceExists(absolute, { raw = '' } = {}) {
  let info
  try {
    info = await statFile(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new DecodeError(
        'IMAGE_NOT_FOUND',
        `图片文件不存在：${absolute}${await packageCandidateHint(raw, absolute)}`,
        null,
        '确认路径拼写。相对路径由宿主的文件服务按它自己的基准解析（不一定是插件目录）；最稳的做法是直接传绝对路径。',
      )
    }
    return
  }
  if (info.isDirectory()) {
    throw new DecodeError(
      'IMAGE_NOT_READABLE',
      `这是一个目录，不是图片文件：${absolute}`,
      null,
      '传入一张图片文件的路径（PNG / JPG / JPEG / WEBP / BMP）。',
    )
  }
}

const METRIC_NUMBERS = Object.freeze([
  'luma_mean',
  'luma_std',
  'luma_p01',
  'luma_p99',
  'dark_ratio',
  'bright_ratio',
  'sat_mean',
  'mono_ratio',
  'colorfulness',
  'edge_energy',
  'haze_score',
])

function finiteOr(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 比例类指标的定义域是 [0,1]；解码器给越界值只可能是 bug，夹取比原样写进提示词安全。 */
const RATIO_METRICS = new Set([
  'luma_mean',
  'luma_std',
  'luma_p01',
  'luma_p99',
  'dark_ratio',
  'bright_ratio',
  'sat_mean',
  'mono_ratio',
  'haze_score',
])

/** 归一化比例统一夹到 [0,1]：解码器给越界值只可能是 bug。 */
function clampRatio(value) {
  return Math.min(1, Math.max(0, value))
}

function clampMetric(key, value) {
  if (value === null) return null
  if (RATIO_METRICS.has(key)) return Math.min(1, Math.max(0, value))
  return Math.max(0, value)
}

/**
 * 像素预检指标的白名单收敛。
 *
 * 这些数字会直接写进阶段 A 的提示词当证据，所以不能让它带着解码器的任意字段进模型；
 * 只保留能被测量、能被复算的那几个，palette 也只留 hex/share/hue。
 *
 * 注意：结构化证据块（diffusion / silhouette / geometry / background）必须一起放行。
 * 它们不是"额外数字"，而是判定的唯一依据 —— 早先只放行扁平数字时，
 * 提示词里的"主体明度分布 / 主体框 / 留白 / 朦胧度 / 背景判定"整段都是空的，
 * 模型只能按题材先验猜环境，于是灰阶剪影图被写成了实景。
 */
export function sanitizeMetrics(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const key of METRIC_NUMBERS) {
    const value = clampMetric(key, finiteOr(raw[key]))
    if (value !== null) out[key] = value
  }
  if (Object.keys(out).length === 0) return null
  const palette = Array.isArray(raw.palette)
    ? raw.palette
        .filter((item) => item && typeof item.hex === 'string')
        .slice(0, 4)
        .map((item) => ({
          hex: item.hex,
          share: finiteOr(item.share, 0),
          hue: finiteOr(item.hue, 0),
        }))
    : []
  out.palette = palette
  const verdict = raw.verdict && typeof raw.verdict === 'object' ? raw.verdict : {}
  out.verdict = {
    monochrome: verdict.monochrome === true,
    near_duotone: verdict.near_duotone === true,
    hazy: verdict.hazy === true,
    silhouette: verdict.silhouette === true,
  }
  const diffusion = sanitizeDiffusion(raw.diffusion)
  if (diffusion) out.diffusion = diffusion
  const silhouette = sanitizeSilhouette(raw.silhouette)
  if (silhouette) out.silhouette = silhouette
  const geometry = sanitizeGeometry(raw.geometry)
  if (geometry) out.geometry = geometry
  const background = sanitizeBackground(raw.background)
  if (background) out.background = background
  return out
}

/** 朦胧度：三个布尔 + 一个分数，全部来自像素测量。 */
function sanitizeDiffusion(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    lifted_black: raw.lifted_black === true,
    low_contrast: raw.low_contrast === true,
    soft_edges: raw.soft_edges === true,
    score: clampRatio(finiteOr(raw.score, 0)),
    diffuse: raw.diffuse === true,
  }
}

/** 主体明度分布：决定"这是剪影还是深色主体"，是黑白图最容易判错的一步。 */
function sanitizeSilhouette(raw) {
  if (!raw || typeof raw !== 'object') return null
  const ratio = (value) => clampRatio(finiteOr(value, 0))
  return {
    dark_ratio: ratio(raw.dark_ratio),
    deep_dark_ratio: ratio(raw.deep_dark_ratio),
    mid_dark_ratio: ratio(raw.mid_dark_ratio),
    bright_ratio: ratio(raw.bright_ratio),
    subject_share: ratio(raw.subject_share),
    silhouette: raw.silhouette === true,
  }
}

/** 构图几何：主体框 / 留白 / 重心 / 五段亮度 / 最亮处，D3 与 D7 的量化依据。 */
function sanitizeGeometry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const ratio = (value) => clampRatio(finiteOr(value, 0))
  const point = (value) =>
    Array.isArray(value) && value.length === 2
      ? value.map((item) => clampRatio(finiteOr(item, 0)))
      : null
  const out = {}
  const box = Array.isArray(raw.subject_box) && raw.subject_box.length === 4
    ? raw.subject_box.map((item) => clampRatio(finiteOr(item, 0)))
    : null
  if (box) out.subject_box = box
  for (const key of ['subject_area_ratio', 'offset_x', 'offset_y', 'margin_top', 'margin_bottom', 'margin_left', 'margin_right']) {
    const value = finiteOr(raw[key])
    if (value !== null) out[key] = clampRatio(value)
  }
  const symmetry = finiteOr(raw.symmetry)
  if (symmetry !== null) out.symmetry = clampRatio(symmetry)
  if (typeof raw.placement === 'string' && raw.placement.length > 0) out.placement = raw.placement.slice(0, 24)
  const centroid = point(raw.subject_centroid)
  if (centroid) out.subject_centroid = centroid
  const brightest = point(raw.brightest_point)
  if (brightest) out.brightest_point = brightest
  if (Array.isArray(raw.band_luma)) {
    out.band_luma = raw.band_luma.slice(0, 8).map((item) => clampRatio(finiteOr(item, 0)))
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 背景取样：顶部横带＋左右竖带（避开地面与脚），给出"这是不是控制型背景"的判定与可用标签。
 * 这是"周围环境不对"的直接证据来源 —— 纯白场必须能写出 white background，
 * 而不是让模型按题材先验编一个室内场景。
 */
function sanitizeBackground(raw) {
  if (!raw || typeof raw !== 'object') return null
  const kind = typeof raw.kind === 'string' ? raw.kind.slice(0, 24) : 'unknown'
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag) => typeof tag === 'string' && tag.length > 0).slice(0, 6)
    : []
  const evidence = raw.evidence && typeof raw.evidence === 'object' ? raw.evidence : {}
  const ratio = (value) => clampRatio(finiteOr(value, 0))
  return {
    kind,
    tags,
    evidence: {
      near_white_ratio: ratio(evidence.near_white_ratio),
      bright_ratio: ratio(evidence.bright_ratio),
      dark_ratio: ratio(evidence.dark_ratio),
      luma_mean: ratio(evidence.luma_mean),
      luma_std: ratio(evidence.luma_std),
      sat_mean: ratio(evidence.sat_mean),
      edge_spread: clampRatio(finiteOr(evidence.edge_spread, 0)),
      detail: Math.max(0, finiteOr(evidence.detail, 0)),
      flat: evidence.flat === true,
    },
  }
}

export function createInputPreparer({ ctx, decoder, temp, config, logger = NULL_LOGGER }) {
  const privacy = config?.privacy ?? {}

  function describePath(path) {
    if (privacy.log_image_paths === true) return path
    return '<已隐去路径>'
  }

  async function prepare({ imagePath, taskLabel = 'analyze', crops = [], outDir = null, signal } = {}) {
    const raw = String(imagePath ?? '').trim()
    const absolute = await resolveImagePath(ctx, imagePath, { signal })
    await assertSourceExists(absolute, { raw })
    const dir = outDir ?? (await temp.allocate(taskLabel))

    let response
    try {
      response = await decoder.prepareImage(
        {
          src: absolute,
          out_dir: dir,
          max_edge: decoder.limits.max_edge,
          max_pixels: decoder.limits.max_pixels,
          max_bytes: decoder.limits.max_bytes,
          allowed_formats: [...decoder.limits.allowed_formats],
          raw_enabled: decoder.limits.raw_enabled,
          keep_temp_files: decoder.limits.keep_temp_files,
          crops: crops.map((crop) => ({ id: String(crop.id), box: [...crop.box] })),
        },
        { signal },
      )
    } catch (error) {
      await temp.release(dir)
      logger.warn(`图片准备失败：${error?.code ?? 'UNKNOWN'}（${describePath(absolute)}）`)
      throw error
    }

    const image = response.image ?? {}
    return {
      sourcePath: absolute,
      tempDir: dir,
      normalizedPath: image.normalized_path ?? null,
      image: {
        width: Number(image.width) || 0,
        height: Number(image.height) || 0,
        source_width: Number(image.source_width) || Number(image.width) || 0,
        source_height: Number(image.source_height) || Number(image.height) || 0,
        aspect_ratio: String(image.aspect_ratio ?? ''),
        has_alpha: image.has_alpha === true,
        transparent_ratio: typeof image.transparent_ratio === 'number' ? image.transparent_ratio : null,
        opaque_ratio: typeof image.opaque_ratio === 'number' ? image.opaque_ratio : null,
        src_format: String(image.src_format ?? ''),
        decoded_via: String(image.decoded_via ?? ''),
        orientation_applied: Number(image.orientation_applied) || 1,
        scale: typeof image.scale === 'number' ? image.scale : 1,
        size_bytes: Number(image.size_bytes) || 0,
        mode: String(image.mode ?? ''),
        metrics: sanitizeMetrics(image.metrics),
      },
      crops: (response.crops ?? []).map((crop) => ({
        id: String(crop.id),
        path: String(crop.path),
        width: Number(crop.width) || 0,
        height: Number(crop.height) || 0,
        box: Array.isArray(crop.box) ? crop.box.map(Number) : [],
      })),
      warnings: Array.isArray(response.warnings) ? [...response.warnings] : [],
    }
  }

  async function finish(tempDir) {
    if (decoder.limits.keep_temp_files) return
    await temp.release(tempDir)
  }

  return { prepare, finish, resolveImagePath: (p, opts) => resolveImagePath(ctx, p, opts) }
}
