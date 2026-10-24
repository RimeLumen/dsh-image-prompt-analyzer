
import { errorGroupFor } from '../../diagnostics.js'

export class DecodeError extends Error {
  constructor(code, message, detail = null, suggestedFix = null) {
    super(message)
    this.name = 'DecodeError'
    this.code = code
    this.detail = detail
    this.suggested_fix = suggestedFix
  }

  toDiagnostic({ configFile = null, fieldPath = null } = {}) {
    return {
      error_code: this.code,
      error_group: errorGroupFor(this.code),
      severity: 'error',
      config_file: configFile,
      field_path: fieldPath,
      message: this.detail ? `${this.message}（${this.detail}）` : this.message,
      suggested_fix: this.suggested_fix,
    }
  }
}

export function suggestedFixFor(code) {
  switch (code) {
    case 'IMAGE_NOT_FOUND':
      return '确认路径拼写正确，并且用的是绝对路径或相对工作区根目录的路径。'
    case 'IMAGE_NOT_READABLE':
      return '检查文件权限；目录也会走到这个码，确认传的是文件而不是目录。'
    case 'UNSUPPORTED_FORMAT':
      return '第一版支持 PNG/JPG/JPEG/WEBP/BMP。扩展名不可信——本插件按文件头判断，改扩展名不会让它变得可读。'
    case 'RAW_DECODER_MISSING':
      return '安装 rawpy（会带入 LibRaw 原生库），或先把 RAW 转成 PNG/JPEG 再分析。'
    case 'IMAGE_TOO_LARGE':
      return '调大插件配置的 image.max_pixels / image.max_edge，或先自行缩小图片。'
    case 'IMAGE_CORRUPT':
    case 'DECODE_FAILED':
      return '换一张能正常打开的图片；若原图确实损坏，先用别的工具修复再试。'
    case 'BAD_REQUEST':
      return '这是插件内部构造请求时的缺陷，请把诊断里的 field_path 一起报告。'
    default:
      return '重试一次；若持续失败，把本条诊断与插件日志一起报告。'
  }
}
