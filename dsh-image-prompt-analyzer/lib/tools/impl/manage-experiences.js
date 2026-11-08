
import { SEVERITY, TASK_STATUS, diagnostic, envelope } from '../../diagnostics.js'
import { EXPERIENCE_CODES } from '../../experience/index.js'
import { runReadAction } from './experiences/read.js'
import { runDeleteAction, runExportAction, runImportAction, runRateAction } from './experiences/write.js'

const EXPERIENCE_ACTIONS = Object.freeze(['list', 'search', 'get', 'stats', 'rate', 'delete', 'export', 'import'])

async function openHandle(runtime) {
  const opened = await runtime.getKnowledgeBase()
  return opened.handle
}

/**
 * 把用户给的档案名展开成"这个档案曾经用过的所有名字"。
 * 档案改过名之后，旧记录里存的还是旧 config_id；只按新名查等于把历史清空。
 * 展开结果只用于筛选，不改变记录的存储值。
 */
async function expandProfileAliases(runtime, value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let store
  try {
    store = await runtime.getConfigStore()
  } catch {
    return null
  }
  const entry = store?.getModelProfile?.(value)
  if (!entry) return null
  const names = [entry.config_id]
  for (const alias of Array.isArray(entry.config?.aliases) ? entry.config.aliases : []) {
    const text = typeof alias === 'string' ? alias.trim() : ''
    if (text !== '' && !names.includes(text)) names.push(text)
  }
  // 用户写的就是别名时，也把它自己带上，免得历史里存的是用户习惯的写法。
  const requested = value.trim()
  if (!names.includes(requested)) names.push(requested)
  return names
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

  const readOnly = runReadAction(handle, action, { ...args, target_profile_aliases: await expandProfileAliases(runtime, args.target_profile) }, diagnostics)
  if (readOnly) return readOnly

  if (action === 'rate') return runRateAction(handle, args, diagnostics)
  if (action === 'delete') return runDeleteAction(handle, args, diagnostics)
  if (action === 'export') return runExportAction(runtime, handle, args, diagnostics)
  return runImportAction(handle, args, diagnostics)
}
