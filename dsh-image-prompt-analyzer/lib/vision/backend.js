
import { diagnostic, SEVERITY } from '../diagnostics.js'
import { DEFAULT_MAX_TOKENS, VisionError, VISION_CODES } from './errors.js'
import {
  DEFAULT_UNAVAILABLE_TTL_SECONDS,
  classifyVisionFailure,
  isUnavailable,
  markUnavailable,
  resolveVisionCandidates,
  resolveVisionTarget,
} from './discovery.js'

export { VISION_CODES, SUGGESTED_FIX, VisionError, DEFAULT_MAX_TOKENS } from './errors.js'
export {
  DEFAULT_UNAVAILABLE_TTL_SECONDS,
  classifyVisionFailure,
  isUnavailable,
  markUnavailable,
  resetAvailability,
  resolveVisionCandidates,
  resolveVisionTarget,
} from './discovery.js'
export { resolveVisionTarget as resolveDshTarget } from './discovery.js'

const RETRY_LIMIT = 2

function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.round(timeoutMs)))
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function classifyAbort(error, timeoutSignal, callerSignal) {
  if (callerSignal?.aborted) return new VisionError(VISION_CODES.ABORTED, '视觉分析被取消。')
  if (timeoutSignal.aborted) {
    return new VisionError(VISION_CODES.TIMEOUT, '视觉分析超时。')
  }
  if (error?.name === 'TimeoutError') return new VisionError(VISION_CODES.TIMEOUT, '视觉分析超时。')
  if (error?.name === 'AbortError') return new VisionError(VISION_CODES.ABORTED, '视觉分析被取消。')
  return null
}

function finishFailureToVisionError(reason, { timeoutSignal, callerSignal, target }) {
  const failure = reason?.failure ?? {}
  const detail = typeof failure.message === 'string' && failure.message.trim() ? failure.message : ''
  const code = typeof failure.code === 'string' && failure.code ? failure.code : ''
  const tail = detail ? `：${detail}${code ? `（${code}）` : ''}` : code ? `（${code}）` : '。'

  if (reason?.kind === 'aborted') {
    if (callerSignal?.aborted) return new VisionError(VISION_CODES.ABORTED, '视觉分析被取消。')
    if (timeoutSignal?.aborted) return new VisionError(VISION_CODES.TIMEOUT, '视觉分析超时。')
    return new VisionError(VISION_CODES.REQUEST_FAILED, `视觉模型调用被中止${tail}`)
  }

  if (code === 'IMAGE_OFFLOAD_REQUIRED') {
    return new VisionError(
      VISION_CODES.MODEL_NO_IMAGE_INPUT,
      `模型 ${target.model} 不接受图片输入${tail}`,
    )
  }

  return new VisionError(
    VISION_CODES.REQUEST_FAILED,
    `视觉模型调用失败${tail}`,
    '先看 message 里的运行时错误码：凭据 / 登录问题去 DSH 的 provider 设置里修，模型能力问题换一个 inputModalities 含 image 的模型。',
  )
}

export function createDshRouteBackend({ ctx, visionConfig, readImageBytes, logger }) {
  const unavailableTtl = visionConfig?.fallback?.unavail_ttl_seconds ?? DEFAULT_UNAVAILABLE_TTL_SECONDS

  async function attemptOn({ prompt, system, images = [], signal, maxTokens, temperature, target, onDelta = null }) {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.round((visionConfig?.timeout_seconds ?? 120) * 1000)))
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

    const refs = []
    for (const image of images) {
      const bytes = await readImageBytes(image.path, { signal: combined })
      if (!bytes || bytes.byteLength === 0) {
        throw new VisionError(VISION_CODES.IMAGE_UNREADABLE, `读不到图片字节：${image.name ?? image.path}`)
      }
      refs.push({ data: new Uint8Array(bytes), mediaType: image.mediaType, ...(image.name ? { name: image.name } : {}) })
    }

    let attachments = []
    try {
      attachments = await ctx.attachments.saveImages(refs)
    } catch (error) {
      throw new VisionError(
        VISION_CODES.IMAGE_UNREADABLE,
        `把图片交给 DSH 附件服务失败：${error?.message ?? error}`,
      )
    }

    const content = [{ type: 'text', text: prompt }, ...attachments.map((attachment) => ({ type: 'image', attachment }))]
    const options = {
      provider: target.provider,
      model: target.model,
      messages: [{ role: 'user', content }],
      temperature: typeof temperature === 'number' ? temperature : 0.2,
      maxTokens: typeof maxTokens === 'number' ? maxTokens : DEFAULT_MAX_TOKENS,
      signal: combined,
    }
    if (system) options.system = system
    if (target.reasoning_effort) options.reasoningEffort = target.reasoning_effort

    try {
      return await collectStream(() => ctx.llm.stream(options), { timeoutSignal, callerSignal: signal, target, logger, onDelta })
    } catch (error) {
      if (error && typeof error === 'object' && !error.vision_target) {
        error.vision_target = { provider: target.provider, model: target.model }
      }
      throw error
    }
  }

  return {
    kind: 'dsh',

    async describe(signal) {
      const target = await resolveVisionTarget(ctx, visionConfig, signal)
      return {
        kind: 'dsh',
        provider: target.provider,
        model: target.model,
        resolved_via: target.resolved_via,
        auto_selected: target.auto_selected === true,
        diagnostics: target.diagnostics,
      }
    },

    async complete(options) {
      if (!ctx?.attachments || typeof ctx.attachments.saveImages !== 'function') {
        throw new VisionError(
          VISION_CODES.ATTACHMENTS_UNAVAILABLE,
          '走 DSH 路由需要 attachments 服务，但本 profile 没有挂载它。',
        )
      }

      const plan = await resolveVisionCandidates(ctx, {
        ...visionConfig,
        ...(options?.visionOverride ?? {}),
      })
      const diagnostics = [...plan.diagnostics]
      const attempted = new Set()
      let lastError = null

      for (const candidate of plan.candidates) {
        const key = `${candidate.provider}/${candidate.model}`
        if (attempted.has(key) || isUnavailable(candidate.provider, candidate.model)) continue
        attempted.add(key)

        for (let retry = 0; ; retry += 1) {
          try {
            const result = await attemptOn({ ...options, target: candidate })
            return { ...result, diagnostics }
          } catch (error) {
            const failure = classifyVisionFailure(error)
            if (failure === 'retry' && retry < RETRY_LIMIT) {
              logger?.debug?.('视觉模型 %s 第 %d 次调用失败（retry 类），就地重试', key, retry + 1)
              continue
            }
            if (failure !== 'unsupported_image' && failure !== 'modality_mismatch') {
              if (failure === 'retry' && error?.code === VISION_CODES.EMPTY_RESPONSE) {
              } else {
                if (error && typeof error === 'object') error.diagnostics = diagnostics
                throw error
              }
            }
            markUnavailable(candidate.provider, candidate.model, unavailableTtl)
            diagnostics.push(
              diagnostic({
                error_code: VISION_CODES.MODEL_NO_IMAGE_INPUT,
                severity: SEVERITY.WARNING,
                message: `模型 ${key} 声明了 image 输入但实际拒绝接收图片（分类：${failure}），已在该模型上标记 ${unavailableTtl} 秒不可用，换下一个候选：${error?.message ?? error}`,
                suggested_fix: '这条通常是模型声明的 inputModalities 与真实能力不一致。插件会自动换用其它 image 候选；TTL 到期后该模型会重新参与候选。',
              }),
            )
            lastError = error
            break
          }
        }
      }

      const error = new VisionError(
        VISION_CODES.NO_IMAGE_MODEL,
        `本次任务里所有 image 候选都没能接收图片${lastError ? `，最后一次失败：${lastError.message}` : '。'}`,
        '检查模型声明与真实能力是否一致；也可以在插件配置里显式指定 vision.provider / vision.model。',
      )
      error.diagnostics = diagnostics
      throw error
    },
  }
}

async function collectStream(makeStream, { timeoutSignal, callerSignal, target, logger, onDelta = null }) {
  let text = ''
  let usage = null
  let finishReason = null
  let reasoningChars = 0
  try {
    for await (const chunk of makeStream()) {
      if (chunk?.type === 'text-delta') {
        text += chunk.text ?? ''
        if (onDelta) onDelta('text-delta', chunk.text ?? '')
      } else if (chunk?.type === 'reasoning-delta') {
        reasoningChars += (chunk.text ?? '').length
        if (onDelta) onDelta('reasoning-delta', chunk.text ?? '')
      } else if (chunk?.type === 'usage') usage = chunk.usage ?? null
      else if (chunk?.type === 'finish') finishReason = chunk.reason ?? null
    }
  } catch (error) {
    const classified = classifyAbort(error, timeoutSignal, callerSignal)
    if (classified) throw classified
    throw new VisionError(VISION_CODES.REQUEST_FAILED, `视觉模型调用失败：${error?.message ?? error}`)
  }
  void timeoutSignal
  if (finishReason?.kind === 'error' || finishReason?.kind === 'aborted') {
    throw finishFailureToVisionError(finishReason, { timeoutSignal, callerSignal, target })
  }
  if (reasoningChars > 0) logger?.debug?.('视觉模型返回了 %d 字符的推理内容，已忽略', reasoningChars)
  if (text.trim() === '' && reasoningChars === 0) {
    throw new VisionError(VISION_CODES.EMPTY_RESPONSE, '模型返回了空内容（无文本也无推理）。')
  }
  return {
    text,
    usage,
    finish_reason: finishReason,
    backend: 'dsh',
    provider: target.provider,
    model: target.model,
  }
}

export function createVisionBackend({ ctx, visionConfig, readImageBytes, logger }) {
  return createDshRouteBackend({ ctx, visionConfig, readImageBytes, logger })
}

export async function describeVisionBackend(backend) {
  try {
    return await backend.describe()
  } catch (error) {
    return { kind: backend?.kind ?? 'unknown', error_code: error?.code ?? null, message: String(error?.message ?? error) }
  }
}
