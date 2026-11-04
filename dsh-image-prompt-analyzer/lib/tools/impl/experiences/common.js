
import { SEVERITY, diagnostic } from '../../../diagnostics.js'
import { EXPERIENCE_CODES } from '../../../experience/index.js'

export function missingId() {
  return diagnostic({
    error_code: EXPERIENCE_CODES.INVALID_RECORD,
    severity: SEVERITY.ERROR,
    message: '这个动作需要 experience_id 或 task_id 指定一条经验。',
    suggested_fix: '先用 action: "list" 或 action: "search" 拿到编号或 task_id。',
  })
}
