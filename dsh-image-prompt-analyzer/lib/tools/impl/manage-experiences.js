
import { SEVERITY, TASK_STATUS, diagnostic, envelope } from '../../diagnostics.js'
import { EXPERIENCE_CODES } from '../../experience/index.js'
import { runReadAction } from './experiences/read.js'
import { runDeleteAction, runExportAction, runImportAction, runRateAction } from './experiences/write.js'

const EXPERIENCE_ACTIONS = Object.freeze(['list', 'search', 'get', 'stats', 'rate', 'delete', 'export', 'import'])

async function openHandle(runtime) {
  const opened = await runtime.getKnowledgeBase()
  return opened.handle
}

export async function runManageExperiences(runtime, args = {}) {
  const action = typeof args.action === 'string' ? args.action : 'list'
  if (!EXPERIENCE_ACTIONS.includes(action)) {
    return envelope({
      status: TASK_STATUS.FAILED,
      diagnostics: [
        diagnostic({
          error_code: EXPERIENCE_CODES.UNKNOWN_ACTION,
          severity: SEVERITY.ERROR,
          message: `不认识的动作：${action}`,
          suggested_fix: `可用动作：${EXPERIENCE_ACTIONS.join(' / ')}。`,
        }),
      ],
    })
  }

  const diagnostics = []
  let handle
  try {
    handle = await openHandle(runtime)
  } catch (error) {
    return envelope({
      status: TASK_STATUS.FAILED,
      diagnostics: [
        typeof error?.toDiagnostic === 'function'
          ? error.toDiagnostic()
          : diagnostic({
              error_code: error?.code ?? 'EXPERIENCE_STORE_UNAVAILABLE',
              severity: SEVERITY.ERROR,
              message: `打不开经验库：${error?.message ?? error}`,
              suggested_fix: '先运行 diagnose_knowledge_base 看存储段是否可写。',
            }),
      ],
    })
  }

  const readOnly = runReadAction(handle, action, args, diagnostics)
  if (readOnly) return readOnly

  if (action === 'rate') return runRateAction(handle, args, diagnostics)
  if (action === 'delete') return runDeleteAction(handle, args, diagnostics)
  if (action === 'export') return runExportAction(runtime, handle, args, diagnostics)
  return runImportAction(handle, args, diagnostics)
}
