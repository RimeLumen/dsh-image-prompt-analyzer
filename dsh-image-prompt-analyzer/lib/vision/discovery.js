
import { diagnostic, SEVERITY } from '../diagnostics.js'
import { VisionError, VISION_CODES } from './errors.js'

export const DEFAULT_UNAVAILABLE_TTL_SECONDS = 3600

const unavailableUntil = new Map()

function keyOf(provider, model) {
  return `${provider}/${model}`
}

export function markUnavailable(provider, model, ttlSeconds = DEFAULT_UNAVAILABLE_TTL_SECONDS) {
  const ms = Math.max(0, Number(ttlSeconds) || 0) * 1000
  unavailableUntil.set(keyOf(provider, model), Date.now() + ms)
}

export function isUnavailable(provider, model) {
  const until = unavailableUntil.get(keyOf(provider, model))
  if (until === undefined) return false
  if (Date.now() >= until) {
    unavailableUntil.delete(keyOf(provider, model))
    return false
  }
  return true
}

export function resetAvailability() {
  unavailableUntil.clear()
}

function readAgentSelection(ctx) {
  const sources = []
  try {
    if (typeof ctx?.get === 'function') sources.push(ctx.get('agentDefaultModel'))
  } catch {
  }
  try {
    sources.push(ctx?.agentDefaultModel)
  } catch {
  }
  for (const service of sources) {
    if (!service || typeof service.currentSelection !== 'function') continue
    try {
      const selection = service.currentSelection()
      if (selection?.provider && selection?.model) return selection
    } catch {
    }
  }
  return null
}

function declaresImage(model) {
  return Array.isArray(model?.inputModalities) && model.inputModalities.includes('image')
}

async function collectCandidates(ctx, diagnostics) {
  const llm = ctx?.llm
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    throw new VisionError(VISION_CODES.LLM_UNAVAILABLE, '本 profile 没有可用的 llm 服务，读不到模型目录。')
  }

  let providers = []
  try {
    providers = llm.listProviders() ?? []
  } catch (error) {
    throw new VisionError(
      VISION_CODES.MODEL_CATALOG_UNAVAILABLE,
      `读 provider 列表失败：${error?.message ?? error}`,
    )
  }

  const candidates = []
  for (const provider of Array.isArray(providers) ? providers : []) {
    const id = provider?.id
    if (typeof id !== 'string' || id === '') continue
    let models = []
    try {
      models = (await llm.listModels(id)) ?? []
    } catch (error) {
      diagnostics.push(
        diagnostic({
          error_code: VISION_CODES.MODEL_CATALOG_UNAVAILABLE,
          severity: SEVERITY.WARNING,
          message: `读 provider "${id}" 的模型列表失败，已跳过它：${error?.message ?? error}`,
          suggested_fix: `确认 provider "${id}" 已正确挂载且凭据可用；其余 provider 的候选仍然有效。`,
        }),
      )
      continue
    }
    for (const model of Array.isArray(models) ? models : []) {
      if (typeof model?.id !== 'string' || model.id === '') continue
      if (!declaresImage(model)) continue
      candidates.push({ provider: id, model: model.id })
    }
  }
  return candidates
}

function candidateLabel(candidate) {
  return `${candidate.provider}/${candidate.model}`
}

function unavailableDetail(candidates) {
  return candidates.map((candidate) => `${candidateLabel(candidate)}（最近一次失败：模型拒绝接收图片）`).join('、')
}

export async function resolveVisionCandidates(ctx, visionConfig = {}) {
  const diagnostics = []
  const all = await collectCandidates(ctx, diagnostics)
  const pinnedProvider = typeof visionConfig?.provider === 'string' ? visionConfig.provider.trim() : ''
  const pinnedModel = typeof visionConfig?.model === 'string' ? visionConfig.model.trim() : ''

  const available = all.filter((candidate) => !isUnavailable(candidate.provider, candidate.model))

  if (pinnedProvider && pinnedModel) {
    const exact = all.find((item) => item.provider === pinnedProvider && item.model === pinnedModel)
    if (!exact) {
      throw new VisionError(
        VISION_CODES.MODEL_NOT_FOUND,
        `vision.provider/vision.model 指定的 ${pinnedProvider}/${pinnedModel} 不在候选里（只统计声明了 image 输入的模型）。实际候选：${all.map(candidateLabel).join('、') || '（无）'}。`,
        '改成候选里的一个，或把 vision.provider / vision.model 清空让插件自动发现。',
      )
    }
    if (isUnavailable(pinnedProvider, pinnedModel)) {
      throw new VisionError(
        VISION_CODES.NO_IMAGE_MODEL,
        `钉死的视觉模型 ${pinnedProvider}/${pinnedModel} 刚被判定为不接收图片，TTL 内不再尝试。可用候选：${available.map(candidateLabel).join('、') || '（无）'}。`,
        '把 vision.provider / vision.model 留空，让插件自动换用其它 image 候选；或换一个模型。',
      )
    }
    return {
      target: { provider: pinnedProvider, model: pinnedModel, resolved_via: 'explicit_config', auto_selected: false },
      candidates: [exact, ...available.filter((item) => candidateLabel(item) !== candidateLabel(exact))],
      diagnostics,
    }
  }

  let pool = available
  if (pinnedProvider) {
    pool = pool.filter((item) => item.provider === pinnedProvider)
    if (pool.length === 0) {
      throw new VisionError(
        VISION_CODES.MODEL_NOT_FOUND,
        `vision.provider 指定的 "${pinnedProvider}" 下没有可用的 image 模型。实际候选：${all.map(candidateLabel).join('、') || '（无）'}。`,
      )
    }
  }
  if (pinnedModel) {
    const byModel = all.filter((item) => item.model === pinnedModel)
    if (byModel.length === 0) {
      throw new VisionError(
        VISION_CODES.MODEL_NOT_FOUND,
        `vision.model 指定的 "${pinnedModel}" 不在候选里（只统计声明了 image 输入的模型）。实际候选：${all.map(candidateLabel).join('、') || '（无）'}。`,
      )
    }
    pool = pool.filter((item) => item.model === pinnedModel)
    if (pool.length === 0) {
      throw new VisionError(
        VISION_CODES.NO_IMAGE_MODEL,
        `vision.model 指定的 "${pinnedModel}" 全部候选都在 TTL 内被标记为不可用。`,
        '等 TTL 到期、重启 DSH，或换一个模型。',
      )
    }
  }

  if (pool.length === 0) {
    if (all.length > 0) {
      throw new VisionError(
        VISION_CODES.NO_IMAGE_MODEL,
        `所有 image 候选都在 TTL 内被标记为不接收图片：${unavailableDetail(all)}。`,
        '等 TTL（默认 1 小时）到期会自动恢复；或换成别的多模态模型。',
      )
    }
    throw new VisionError(
      VISION_CODES.NO_IMAGE_MODEL,
      '没有任何模型声明 image 输入（inputModalities 里没有 image），插件无法看图。',
    )
  }

  const selection = readAgentSelection(ctx)
  if (selection) {
    const hit = pool.find((item) => item.provider === selection.provider && item.model === selection.model)
    if (hit) {
      return {
        target: {
          provider: hit.provider,
          model: hit.model,
          resolved_via: 'agent_default_model',
          auto_selected: false,
          ...(selection.reasoningEffort ? { reasoning_effort: selection.reasoningEffort } : {}),
        },
        candidates: [hit, ...pool.filter((item) => candidateLabel(item) !== candidateLabel(hit))],
        diagnostics,
      }
    }
  }

  const [first, ...rest] = pool
  if (pool.length > 1) {
    diagnostics.push(
      diagnostic({
        error_code: VISION_CODES.MODEL_AMBIGUOUS,
        severity: SEVERITY.WARNING,
        message: `有 ${pool.length} 个模型声明了 image 输入，未配置 vision.provider / vision.model、当前 agent 默认模型也不在候选里，按目录顺序取 ${candidateLabel(first)}。全部候选：${pool.map(candidateLabel).join('、')}。`,
        suggested_fix: '在插件配置里显式填 vision.provider 与 vision.model 固定下来；否则换一台机器可能选中另一个模型。',
      }),
    )
  } else {
    diagnostics.push(
      diagnostic({
        error_code: VISION_CODES.MODEL_AUTO_SELECTED,
        severity: SEVERITY.INFO,
        message: `自动选中唯一声明了 image 输入的模型：${candidateLabel(first)}。`,
        suggested_fix: '这是正常提示；想固定下来就显式配置 vision.provider 与 vision.model。',
      }),
    )
  }

  return {
    target: { provider: first.provider, model: first.model, resolved_via: 'auto_selected', auto_selected: true },
    candidates: [first, ...rest],
    diagnostics,
  }
}

export async function resolveVisionTarget(ctx, visionConfig = {}) {
  const { target, diagnostics } = await resolveVisionCandidates(ctx, visionConfig)
  return { ...target, diagnostics }
}

const UNSUPPORTED_IMAGE_PATTERN = /unsupported (?:image|images|vision|modality|content)|(?:does|do) not support (?:image|images|vision|modality)|not support(?:ed)?[^.]{0,40}(?:image|vision|modalit)|image[^.]{0,20}(?:not supported|unsupported)|content.?type[^.]{0,40}(?:not supported|unsupported)|modalit(?:y|ies)[^.]{0,20}(?:mismatch|not supported)/i
const MODALITY_PATTERN = /modalit(?:y|ies)[^.]{0,20}(?:mismatch|not supported|unsupported)/i
const IMAGE_HINT_PATTERN = /image|vision|modalit|content.?type/i

function httpStatusOf(error) {
  const direct = error?.status ?? error?.statusCode ?? error?.http_status
  if (Number.isFinite(direct)) return Number(direct)
  const matched = /(?:HTTP|status)[^\d]{0,4}(\d{3})/.exec(String(error?.message ?? ''))
  return matched ? Number(matched[1]) : NaN
}

export function classifyVisionFailure(error) {
  const code = error?.code
  if (code === VISION_CODES.MODEL_NO_IMAGE_INPUT) return 'unsupported_image'
  if (code === VISION_CODES.TIMEOUT || code === VISION_CODES.REQUEST_FAILED || code === VISION_CODES.EMPTY_RESPONSE) {
    return 'retry'
  }

  const message = String(error?.message ?? '')
  const status = httpStatusOf(error)
  if (Number.isFinite(status)) {
    if (status === 429 || status >= 500) return 'retry'
    if (status >= 400 && status < 500 && IMAGE_HINT_PATTERN.test(message)) {
      return MODALITY_PATTERN.test(message) ? 'modality_mismatch' : 'unsupported_image'
    }
  }
  if (UNSUPPORTED_IMAGE_PATTERN.test(message)) {
    return MODALITY_PATTERN.test(message) ? 'modality_mismatch' : 'unsupported_image'
  }
  return 'fatal'
}
