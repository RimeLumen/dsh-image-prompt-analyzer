
import { NULL_LOGGER } from '../log.js'
import { createHelperRunner } from './decode/helper.js'
import { DecodeError } from './decode/errors.js'

export { DecodeError, suggestedFixFor } from './decode/errors.js'

const PROBE_TIMEOUT_MS = 15000

export function createDecoder({ ctx, config, packageDir, logger = NULL_LOGGER }) {
  const pythonConfig = config?.python ?? {}
  const imageConfig = config?.image ?? {}

  const helper = createHelperRunner({ ctx, pythonConfig, packageDir, logger })

  let capability = null
  let capabilityInFlight = null

  async function probeRuntime({ signal, fresh = false } = {}) {
    if (!fresh && capability) return capability
    if (!fresh && capabilityInFlight) return capabilityInFlight
    const task = (async () => {
      const response = await helper.callHelper('probe', {}, { signal, timeoutMs: PROBE_TIMEOUT_MS })
      capability = Object.freeze({
        python: response.python ?? null,
        pillow: response.pillow ?? null,
        rawpy: response.rawpy ?? null,
        bitmap_formats: response.bitmap_formats ?? [],
        warnings: response.warnings ?? [],
      })
      return capability
    })()
    capabilityInFlight = task
    try {
      return await task
    } finally {
      capabilityInFlight = null
    }
  }

  async function prepareImage(request, { signal } = {}) {
    if (pythonConfig.enabled === false) {
      throw new DecodeError(
        'PYTHON_UNAVAILABLE',
        '插件配置关闭了 Python 解码路径（python.enabled = false）。',
        null,
        '把插件配置的 python.enabled 改回 true 后重试；纯标签库与配置类任务不需要它。',
      )
    }
    const timeoutMs = Math.max(1, Number(pythonConfig.timeout_seconds) || 30) * 1000
    return helper.callHelper('prepare', request, { signal, timeoutMs })
  }

  return {
    helperPath: helper.helperPath,
    resolvePython: helper.resolvePython,
    probeRuntime,
    prepareImage,
    limits: Object.freeze({
      max_edge: Number(imageConfig.max_edge) || 4096,
      max_pixels: Number(imageConfig.max_pixels) || 16777216,
      max_bytes: Number(imageConfig.max_bytes) || 33554432,
      allowed_formats: Object.freeze([...(imageConfig.allowed_formats ?? ['PNG', 'JPEG', 'WEBP', 'BMP'])]),
      raw_enabled: imageConfig.raw_enabled === true,
      keep_temp_files: imageConfig.keep_temp_files !== false,
    }),
  }
}
