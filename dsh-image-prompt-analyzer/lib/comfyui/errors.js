
import { diagnostic, SEVERITY } from '../diagnostics.js'

// 错误码与规划文档 H4 一一对应。这里只是集中登记，不代表每一码在 T02 都有产生点：
// 扫描、工作流、提交、执行属于 T03 之后的能力，本阶段只有配置与生命周期会真的抛。
export const COMFY_CODES = Object.freeze({
  NOT_CONFIGURED: 'COMFY_NOT_CONFIGURED',
  TARGET_NOT_LOCAL: 'COMFY_TARGET_NOT_LOCAL',
  PATH_MISSING: 'COMFY_PATH_MISSING',
  PATH_DENIED: 'COMFY_PATH_DENIED',
  PATH_UNRESOLVED: 'COMFY_PATH_UNRESOLVED',
  SCAN_PARTIAL: 'COMFY_SCAN_PARTIAL',
  CACHE_STALE: 'COMFY_CACHE_STALE',
  CONNECTION_FAILED: 'COMFY_CONNECTION_FAILED',
  BAD_RESPONSE: 'COMFY_BAD_RESPONSE',
  CAPABILITY_UNAVAILABLE: 'COMFY_CAPABILITY_UNAVAILABLE',
  WORKFLOW_FORMAT_UNSUPPORTED: 'COMFY_WORKFLOW_FORMAT_UNSUPPORTED',
  NODE_UNSUPPORTED: 'COMFY_NODE_UNSUPPORTED',
  BINDING_AMBIGUOUS: 'COMFY_BINDING_AMBIGUOUS',
  WORKFLOW_STALE: 'COMFY_WORKFLOW_STALE',
  UNSAFE_INTEGER: 'COMFY_UNSAFE_INTEGER',
  VALIDATION_FAILED: 'COMFY_VALIDATION_FAILED',
  MODEL_SELECTOR_UNAVAILABLE: 'COMFY_MODEL_SELECTOR_UNAVAILABLE',
  SUBMISSION_REJECTED: 'COMFY_SUBMISSION_REJECTED',
  SUBMISSION_UNKNOWN: 'COMFY_SUBMISSION_UNKNOWN',
  EXECUTION_FAILED: 'COMFY_EXECUTION_FAILED',
  OUTPUT_UNAVAILABLE: 'COMFY_OUTPUT_UNAVAILABLE',
  PROMPT_ENHANCER_DETECTED: 'COMFY_PROMPT_ENHANCER_DETECTED',
  PROMPT_TEXT_MISMATCH: 'COMFY_PROMPT_TEXT_MISMATCH',
  PROMPT_TEXT_REWRITTEN: 'COMFY_PROMPT_TEXT_REWRITTEN',
})

export const SUGGESTED_FIX = Object.freeze({
  [COMFY_CODES.NOT_CONFIGURED]: '在插件配置里加 comfyui.enabled: true 并填好 installRoot 或 baseUrl。',
  [COMFY_CODES.TARGET_NOT_LOCAL]: 'baseUrl 只接受本机回环地址（127.0.0.1 / ::1 / localhost）；远程 ComfyUI 不在本版本支持范围内。',
  [COMFY_CODES.PATH_MISSING]: '核对路径拼写；路径必须真实存在，插件不会替你创建目录。',
  [COMFY_CODES.PATH_DENIED]: '该路径没有读权限。换一个有权限的目录，或在宿主里放开对它的访问。',
  [COMFY_CODES.PATH_UNRESOLVED]: '路径必须写成绝对路径；相对路径无法判断相对谁，插件不会去猜。',
  [COMFY_CODES.SCAN_PARTIAL]: '部分目录读不到，结果只覆盖读到的部分。看 diagnostics 里具体哪个根失败。',
  [COMFY_CODES.CACHE_STALE]: '磁盘目录在这次查询之后被改动过。重跑一次扫描再选模型。',
  [COMFY_CODES.CONNECTION_FAILED]: '确认 ComfyUI 已启动，且端口与 baseUrl 一致；本机防火墙也可能拦回环端口。',
  [COMFY_CODES.BAD_RESPONSE]: '对方回了内容但不是预期的 JSON 形状。确认 baseUrl 指向 ComfyUI 而不是别的服务。',
  [COMFY_CODES.CAPABILITY_UNAVAILABLE]: '该 ComfyUI 版本或本机环境缺少这项能力，换一条路径实现，不要重试同一次调用。',
  [COMFY_CODES.WORKFLOW_FORMAT_UNSUPPORTED]: '这份工作流是 UI 格式或结构无法识别。首版只接受 API 格式，请在 ComfyUI 里用"导出 (API)"。',
  [COMFY_CODES.NODE_UNSUPPORTED]: '工作流里出现了首版不支持的节点类型。换成受支持的基础文生图节点，或等后续版本。',
  [COMFY_CODES.BINDING_AMBIGUOUS]: '同一个参数有多处可填。插件不会替你挑，请在工作流里只留一个候选。',
  [COMFY_CODES.WORKFLOW_STALE]: '工作流里的节点 id 与当前 ComfyUI 的节点定义对不上。重新导出一份。',
  [COMFY_CODES.UNSAFE_INTEGER]: '数值超出了 JS 安全整数范围，直接提交会被悄悄改值。改成字符串或缩小取值。',
  [COMFY_CODES.VALIDATION_FAILED]: '按提示里的字段路径改配置；字段名、类型、取值范围都以 schema 为准。',
  [COMFY_CODES.MODEL_SELECTOR_UNAVAILABLE]: '这个节点没有可用的模型选择器，或枚举值里没有你要的模型。先跑一次模型扫描。',
  [COMFY_CODES.SUBMISSION_REJECTED]: 'ComfyUI 明确拒绝了这次提交，看 node_errors 里指出的节点与字段。',
  [COMFY_CODES.SUBMISSION_UNKNOWN]: '提交结果未知，可能已经排队。不要自动重发，先去队列里确认。',
  [COMFY_CODES.EXECUTION_FAILED]: '任务跑起来了但执行失败，看节点级错误。',
  [COMFY_CODES.OUTPUT_UNAVAILABLE]: '执行成功但没有取到输出文件。确认输出节点存在且文件已落盘。',
  [COMFY_CODES.PROMPT_ENHANCER_DETECTED]: '提示词链路上有改写节点。要用逐词可追溯的 Caption / Layout，就在 ComfyUI 里把它旁路掉；插件不会自动改工作流。',
  [COMFY_CODES.PROMPT_TEXT_MISMATCH]: '文本节点里的内容与期望不一致。把插件给出的文本重新粘一次，或确认你核对的就是这一版。',
  [COMFY_CODES.PROMPT_TEXT_REWRITTEN]: '文本节点之后还有改写节点，最终进模型的文本在运行时才生成。要逐字确认就旁路它；不旁路时只能确认改写器的输入。',
})

export class ComfyError extends Error {
  constructor(code, message, suggestedFix) {
    super(message)
    this.name = 'ComfyError'
    this.code = code
    this.suggested_fix = suggestedFix ?? SUGGESTED_FIX[code] ?? '检查 comfyui 段配置。'
  }

  toDiagnostic({ configFile = 'plugin config', fieldPath = null, nodeId = null } = {}) {
    const where = nodeId === null || nodeId === undefined ? '' : `（节点 ${nodeId}）`
    return diagnostic({
      error_code: this.code,
      severity: SEVERITY.ERROR,
      config_file: configFile,
      field_path: fieldPath,
      message: `${this.message}${where}`,
      suggested_fix: this.suggested_fix,
    })
  }
}
