
import { diagnostic, SEVERITY } from '../diagnostics.js'

export const VISION_CODES = Object.freeze({
  LLM_UNAVAILABLE: 'VISION_LLM_UNAVAILABLE',
  ATTACHMENTS_UNAVAILABLE: 'VISION_ATTACHMENTS_UNAVAILABLE',
  MODEL_NOT_FOUND: 'VISION_MODEL_NOT_FOUND',
  MODEL_NO_IMAGE_INPUT: 'VISION_MODEL_NO_IMAGE_INPUT',
  NO_IMAGE_MODEL: 'VISION_NO_IMAGE_MODEL',
  MODEL_CATALOG_UNAVAILABLE: 'VISION_MODEL_CATALOG_UNAVAILABLE',
  MODEL_AMBIGUOUS: 'VISION_MODEL_AMBIGUOUS',
  MODEL_AUTO_SELECTED: 'VISION_MODEL_AUTO_SELECTED',
  IMAGE_UNREADABLE: 'VISION_IMAGE_UNREADABLE',
  REQUEST_FAILED: 'VISION_REQUEST_FAILED',
  HTTP_ERROR: 'VISION_HTTP_ERROR',
  EMPTY_RESPONSE: 'VISION_EMPTY_RESPONSE',
  TIMEOUT: 'VISION_TIMEOUT',
  ABORTED: 'VISION_ABORTED',
})

export const SUGGESTED_FIX = Object.freeze({
  [VISION_CODES.LLM_UNAVAILABLE]: '本 profile 没有挂载 llm 服务，插件无法读模型目录、也无处发请求。',
  [VISION_CODES.ATTACHMENTS_UNAVAILABLE]: '本 profile 没有挂载 attachments 服务，走 DSH 路由时必须由它把图片交给模型。',
  [VISION_CODES.MODEL_NOT_FOUND]: '用 cordis 的模型列表确认可用的 provider/model，或把 vision.provider / vision.model 留空让插件自动发现。',
  [VISION_CODES.MODEL_NO_IMAGE_INPUT]: '换一个声明了 image 输入的模型（profile 里给模型加 input: [text, image]）；纯文本模型看不到图。',
  [VISION_CODES.NO_IMAGE_MODEL]: '在 DSH 的 profile 里给至少一个模型声明 input: [text, image]（或挂一个多模态 provider）；插件不会凭空知道哪个模型能看图。',
  [VISION_CODES.MODEL_CATALOG_UNAVAILABLE]: '检查该 provider 的挂载状态与凭据；单个 provider 目录读不到时插件会跳过它，但会留下这条诊断。',
  [VISION_CODES.MODEL_AMBIGUOUS]: '在插件配置里显式填 vision.provider 与 vision.model，或把 agent 默认模型设成能看图的那个，避免每次靠"第一个候选"。',
  [VISION_CODES.MODEL_AUTO_SELECTED]: '这是正常提示，不需要处理；想固定下来就显式配置 vision.provider 与 vision.model。',
  [VISION_CODES.IMAGE_UNREADABLE]: '确认图片路径可读、字节数没有超过 image.max_bytes。',
  [VISION_CODES.REQUEST_FAILED]: '检查模型服务是否可达；本地服务确认已启动。',
  [VISION_CODES.HTTP_ERROR]: '看 message 里的状态码与响应体摘要：401/403 是密钥问题，404 多半是 base_url 少了 /v1，429 是限流。',
  [VISION_CODES.EMPTY_RESPONSE]: '模型返回了空内容，或输出无法解析成 JSON。重试一次；反复出现就换一个多模态模型。',
  [VISION_CODES.TIMEOUT]: '调大 vision.timeout_seconds，或换一个更快的视觉模型。',
  [VISION_CODES.ABORTED]: '任务被主动取消，不需要处理；重跑即可。',
})

export class VisionError extends Error {
  constructor(code, message, suggestedFix) {
    super(message)
    this.name = 'VisionError'
    this.code = code
    this.suggested_fix = suggestedFix ?? SUGGESTED_FIX[code] ?? '检查 vision 段配置。'
  }

  toDiagnostic({ configFile = 'plugin config', fieldPath = null } = {}) {
    const target = this.vision_target
    const usedModel = target?.provider && target?.model ? `（实际使用的模型：${target.provider}/${target.model}）` : ''
    return diagnostic({
      error_code: this.code,
      severity: SEVERITY.ERROR,
      config_file: configFile,
      field_path: fieldPath,
      message: `${this.message}${usedModel}`,
      suggested_fix: this.suggested_fix,
    })
  }
}

export const DEFAULT_MAX_TOKENS = 4096
