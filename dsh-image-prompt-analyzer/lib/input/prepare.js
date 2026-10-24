
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
