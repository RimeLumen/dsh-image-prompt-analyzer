
export const DIAGNOSTICS_SCHEMA_VERSION = '2.0'

export const ERROR_GROUPS = Object.freeze({
  CONFIG: 'C',
  KNOWLEDGE: 'K',
  RUNTIME: 'W',
  INPUT: 'V',
})

const GROUP_RULES = Object.freeze([
  ['C', ['CONFIG_', 'PLUGIN_CONFIG_', 'MODEL_PROFILE_', 'TAG_STANDARD_', 'VALIDATE_CONFIGS_']],
  ['K', ['KB_', 'DIAGNOSE_', 'EXPERIENCE_']],
  ['W', ['VISION_', 'PIPELINE_', 'PANEL_', 'PYTHON_']],
  ['V', ['IMAGE_', 'INPUT_']],
])

const GROUP_EXACT = Object.freeze({
  UNSUPPORTED_FORMAT: 'V',
  BAD_REQUEST: 'V',
})

export function errorGroupFor(errorCode) {
  const code = typeof errorCode === 'string' ? errorCode : ''
  if (GROUP_EXACT[code]) return GROUP_EXACT[code]
  for (const [group, prefixes] of GROUP_RULES) {
    for (const prefix of prefixes) {
      if (code.startsWith(prefix)) return group
    }
  }
  return ERROR_GROUPS.RUNTIME
}

export const SEVERITY = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
})

export const TASK_STATUS = Object.freeze({
  OK: 'ok',
  OK_WITH_WARNINGS: 'ok_with_warnings',
  PARTIAL: 'partial',
  FAILED: 'failed',
})

let taskCounter = 0

export function newTaskId() {
  taskCounter += 1
  return `${Date.now().toString(36)}-${taskCounter.toString(36)}`
}

export function diagnostic({
  error_code,
  severity = SEVERITY.ERROR,
  config_file = null,
  field_path = null,
  message,
  suggested_fix = null,
}) {
  return {
    error_code,
    error_group: errorGroupFor(error_code),
    severity,
    config_file,
    field_path,
    message,
    suggested_fix,
  }
}

export function envelope({ task_id, status, diagnostics = [], active_configs, extra } = {}) {
  const resolvedStatus = status ?? deriveStatus(diagnostics)
  return {
    schema_version: DIAGNOSTICS_SCHEMA_VERSION,
    task_id: task_id ?? newTaskId(),
    status: resolvedStatus,
    diagnostics,
    active_configs: active_configs ?? {},
    ...(extra ?? {}),
  }
}

export function deriveStatus(diagnostics) {
  if (diagnostics.some((d) => d.severity === SEVERITY.ERROR)) return TASK_STATUS.FAILED
  if (diagnostics.some((d) => d.severity === SEVERITY.WARNING)) return TASK_STATUS.OK_WITH_WARNINGS
  return TASK_STATUS.OK
}

export function hasError(diagnostics) {
  return diagnostics.some((d) => d.severity === SEVERITY.ERROR)
}

export function fromException(error, { error_code = 'UNEXPECTED_ERROR', config_file = null, field_path = null } = {}) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const frame = topStackFrame(error)
  return diagnostic({
    error_code,
    severity: SEVERITY.ERROR,
    config_file,
    field_path,
    message,
    suggested_fix: `这是未预期的内部错误${frame ? `，出错位置：${frame}` : ''}。请把本条诊断的 error_code 与 message 一并反馈，并附上触发时的输入。`,
  })
}

export function topStackFrame(error) {
  const stack = typeof error?.stack === 'string' ? error.stack : ''
  const line = stack
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.startsWith('at ') && !item.includes('node:internal'))
  if (!line) return null
  return line.replace(/^at\s+/, '').slice(0, 200)
}
