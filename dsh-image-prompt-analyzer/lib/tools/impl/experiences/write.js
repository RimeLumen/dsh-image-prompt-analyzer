
import { SEVERITY, TASK_STATUS, diagnostic, envelope } from '../../../diagnostics.js'
import {
  EFFECT_RATING_MAX,
  EFFECT_RATING_MIN,
  EXPERIENCE_CODES,
  deleteExperience,
  deleteExperienceByTaskId,
  getExperience,
  importExperiences,
  listExperiences,
  parseJsonl,
  setEffectRating,
  toLine,
} from '../../../experience/index.js'
import { missingId } from './common.js'
import { readImportFile, writeExportStream } from './files.js'

export function runRateAction(handle, args, diagnostics) {
  if (args.experience_id == null) {
    diagnostics.push(missingId())
    return envelope({ status: TASK_STATUS.FAILED, diagnostics })
  }
  if (!Number.isInteger(Number(args.rating))) {
    diagnostics.push(
      diagnostic({
        error_code: EXPERIENCE_CODES.RATING_INVALID,
        severity: SEVERITY.ERROR,
        message: `效果评分必须是 ${EFFECT_RATING_MIN} 到 ${EFFECT_RATING_MAX} 的整数。`,
        suggested_fix: '评分来自用户看过生成结果后的判断；没有判断就不要写。',
      }),
    )
    return envelope({ status: TASK_STATUS.FAILED, diagnostics })
  }
  const result = setEffectRating(handle, args.experience_id, { rating: Number(args.rating), note: args.note ?? null })
  return envelope({
    status: TASK_STATUS.OK,
    diagnostics,
    extra: {
      action: 'rate',
      ...result,
      notice: '评分只记录用户给出的评价，插件不会用它反推规则或自动提高某些标签的权重。',
    },
  })
}

export function runDeleteAction(handle, args, diagnostics) {
  const result = args.experience_id != null
    ? deleteExperience(handle, args.experience_id)
    : args.task_id
      ? deleteExperienceByTaskId(handle, args.task_id)
      : null
  if (!result) {
    diagnostics.push(missingId())
    return envelope({ status: TASK_STATUS.FAILED, diagnostics })
  }
  if (!result.deleted) {
    diagnostics.push(
      diagnostic({
        error_code: EXPERIENCE_CODES.NOT_FOUND,
        severity: SEVERITY.WARNING,
        message: '没有找到这条经验，什么也没删。',
        suggested_fix: '用 action: "list" 确认它是否已经不存在。',
      }),
    )
  }
  return envelope({
    status: result.deleted ? TASK_STATUS.OK : TASK_STATUS.OK_WITH_WARNINGS,
    diagnostics,
    extra: { action: 'delete', ...result },
  })
}

export async function runExportAction(runtime, handle, args, diagnostics) {
  const kbConfig = runtime.getConfigStore ? (await runtime.getConfigStore()).getKnowledgeBaseDocument() : null
  const defaultPath = kbConfig?.storage?.experience_export_path ?? 'data/experiences/experiences.jsonl'
  const targetPath = args.path ?? defaultPath

  const rows = Array.isArray(args.ids) && args.ids.length > 0
    ? args.ids.map((id) => getExperience(handle, id)).filter(Boolean)
    : listExperiences(handle, {
        limit: args.limit ?? 1000,
        targetModel: args.target_model ?? null,
        targetProfile: args.target_profile ?? null,
      })

  const written = await writeExportStream(targetPath, toLine, rows)
  if (!written.ok) {
    diagnostics.push(written.diagnostic)
    return envelope({ status: TASK_STATUS.FAILED, diagnostics })
  }
  return envelope({
    status: TASK_STATUS.OK,
    diagnostics,
    extra: {
      action: 'export',
      count: rows.length,
      path: written.path,
      relative_path: targetPath,
      notice: '导出文件只含内容哈希与元数据，不含原图。',
    },
  })
}

export async function runImportAction(handle, args, diagnostics) {
  if (args.path == null) {
    diagnostics.push(
      diagnostic({
        error_code: EXPERIENCE_CODES.IMPORT_EMPTY,
        severity: SEVERITY.ERROR,
        message: '导入需要 path 指向一个 JSONL 文件。',
        suggested_fix: '用 action: "export" 生成的文件可以直接导回。',
      }),
    )
    return envelope({ status: TASK_STATUS.FAILED, diagnostics })
  }

  let text
  try {
    text = await readImportFile(args.path)
  } catch (error) {
    diagnostics.push(
      diagnostic({
        error_code: error?.code ?? 'EXPERIENCE_IMPORT_FILE_UNREADABLE',
        severity: SEVERITY.ERROR,
        message: `读不到导入文件：${error?.message ?? error}`,
        suggested_fix: '确认路径存在且可读。',
      }),
    )
    return envelope({ status: TASK_STATUS.FAILED, diagnostics })
  }

  let parsed
  try {
    parsed = parseJsonl(text, { tolerant: true })
  } catch (error) {
    diagnostics.push(
      typeof error?.toDiagnostic === 'function'
        ? error.toDiagnostic()
        : diagnostic({
            error_code: EXPERIENCE_CODES.JSONL_SYNTAX,
            severity: SEVERITY.ERROR,
            message: String(error?.message ?? error),
            suggested_fix: '用 manage_experiences 的 export 先导出一份，再对照它的每行结构修这份文件；或把这行删掉重试（导入按行解析，坏一行不影响其它行）。',
          }),
    )
    return envelope({ status: TASK_STATUS.FAILED, diagnostics })
  }

  const result = importExperiences(handle, parsed.records)
  if (parsed.skipped.length > 0) {
    diagnostics.push(
      diagnostic({
        error_code: EXPERIENCE_CODES.JSONL_SYNTAX,
        severity: SEVERITY.WARNING,
        message: `有 ${parsed.skipped.length} 行没能解析，已跳过。`,
        suggested_fix: `跳过的行号：${parsed.skipped.map((item) => item.line).join(', ')}。`,
      }),
    )
  }
  return envelope({
    status: diagnostics.some((item) => item.severity === SEVERITY.WARNING) ? TASK_STATUS.OK_WITH_WARNINGS : TASK_STATUS.OK,
    diagnostics,
    extra: {
      action: 'import',
      ...result,
      notice: '导入按 task_id 覆盖同一条经验，所以「导出再导回」是幂等的。用户给过的评分会保留。',
    },
  })
}
