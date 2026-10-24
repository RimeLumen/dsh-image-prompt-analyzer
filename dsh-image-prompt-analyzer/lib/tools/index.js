
import { registerTool } from './registry.js'
import { fromException, envelope, TASK_STATUS } from '../diagnostics.js'
import { runValidateConfigs } from './impl/validate-configs.js'
import { runDiagnoseKnowledgeBase } from './impl/diagnose-kb.js'
import { runRebuildKnowledgeBase } from './impl/rebuild-kb.js'
import { runManageExperiences } from './impl/manage-experiences.js'

const DETAIL_LEVEL = { type: 'string', enum: ['minimal', 'standard', 'high'] }

function guarded(toolName, runtime, impl) {
  return async (args, exec) => {
    try {
      const signal = args?.signal ?? exec?.signal ?? null
      return await impl(runtime, signal ? { ...(args ?? {}), signal } : (args ?? {}))
    } catch (error) {
      runtime.logger.error(`工具 ${toolName} 执行失败`, error)
      return envelope({
        status: TASK_STATUS.FAILED,
        diagnostics: [
          typeof error?.toDiagnostic === 'function'
            ? error.toDiagnostic()
            : fromException(error, { error_code: error?.code ?? 'TOOL_EXECUTION_FAILED' }),
        ],
      })
    }
  }
}
function analyzeImagePrompt(runtime) {
  return {
    name: 'analyze_image_prompt',
    description:
      '把一张图片逆向成结构化的视觉描述，再按所选目标档案的官方标签标准编译成正向提示词与抑制提示词。' +
      '输入是图片文件路径；输出包含统一视觉描述 IR、正向 / 抑制提示词、槽位明细与逐条诊断。' +
      '分析严格区分「可观察到的内容」与「推断的内容」，每条特征都带置信度与重要度，低置信度项不会被当成事实写进提示词。',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '图片文件路径（PNG/JPG/JPEG/WEBP/BMP；RAW 依赖解码器支持）。' },
        target_profile: {
          type: 'string',
          description:
            '目标模型档案的 config_id，如 pony-v6 / noobai-xl / illustrious / animagine-xl-4.0。必须显式指定：没有默认档案，不传会报 MODEL_PROFILE_NOT_SELECTED。',
        },
        variant: {
          type: 'string',
          description: '已废弃：2.0 档案没有变体概念，传了只会得到一条提示并被忽略。',
        },
        detail_level: { ...DETAIL_LEVEL, description: '提示词细节密度，覆盖 profile / preset 的默认值。' },
        include_negative: { type: 'boolean', description: '是否输出抑制提示词。默认 true；为 false 时只给正向。' },
        include_ir: { type: 'boolean', description: '是否包含完整 IR。默认 false：提示词与槽位明细不受影响，需复核 IR 时显式传 true。' },
        save_experience: { type: 'boolean', description: '是否把本次结果保存进本地经验库。默认 false（需配置允许）。' },
      },
      required: ['image_path', 'target_profile'],
      additionalProperties: false,
    },
    execute: guarded('analyze_image_prompt', runtime, (rt, args) =>
      rt.runAnalyze({ ...args, include_ir: args.include_ir === true })),
  }
}
function validateConfigs(runtime) {
  return {
    name: 'validate_configs',
    description:
      '对随包配置与用户覆盖配置做静态校验：JSON 语法与编码、schema_version 是否受支持、必需字段与类型、ID 重复、' +
      '枚举合法、数值范围、general_order 里的分类是否已定义、引用的本地数据源 / preset / 档案是否存在、路径是否可安全解析。' +
      '本工具只做静态检查，不打开数据库、不读用户文件。' +
      '每条问题都带 config_file、field_path、error_code 与 suggested_fix。',
    parameters: {
      type: 'object',
      properties: {
        config_id: { type: 'string', description: '只校验这一份配置；缺省校验全部。' },
        strict_mode: { type: 'boolean', description: '把未知字段从警告升级为错误。缺省用配置自身的 strict_mode。' },
      },
      additionalProperties: false,
    },
    execute: guarded('validate_configs', runtime, runValidateConfigs),
  }
}

function diagnoseKnowledgeBase(runtime) {
  return {
    name: 'diagnose_knowledge_base',
    description:
      '诊断标签知识库：数据库能否打开且可写、表结构版本是否兼容、库里有多少标签与 kind / 分类分布、最近一次导入是什么时候、' +
      '配置声明的本地数据文件在不在。知识库是纯本地的：本工具不联网，也不读取或上传图片。',
    parameters: {
      type: 'object',
      properties: {
        source_id: { type: 'string', description: '只诊断这一个本地数据源；缺省诊断全部已启用的数据源。' },
      },
      additionalProperties: false,
    },
    execute: guarded('diagnose_knowledge_base', runtime, runDiagnoseKnowledgeBase),
  }
}

function rebuildKnowledgeBase(runtime) {
  return {
    name: 'rebuild_knowledge_base',
    description:
      '从配置声明的本地文件重建标签知识库（CSV / XLSX / DOCX / PDF / TXT / MD）。' +
      '复用与 scripts/import-tags.mjs 相同的读取与导入管线：按 (source_id, tag) 幂等 upsert；' +
      '每个数据源在事务内先清空旧行再整份导入，失败回滚保留旧数据。limit 限制最多重建多少个数据源（默认 500，上限 20000），' +
      '行级试跑请用 dry_run 或 CLI 的 --limit。',
    parameters: {
      type: 'object',
      properties: {
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: '只重建这些 source_id；缺省重建全部已启用的本地 source。',
        },
        dry_run: { type: 'boolean', description: '只读取与统计，不写数据库。默认 false。' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20000,
          description: '最多重建多少个数据源（默认 500，上限 20000）。每个选中的数据源都会在事务内清空旧行后整份导入。',
        },
      },
      additionalProperties: false,
    },
    execute: guarded('rebuild_knowledge_base', runtime, runRebuildKnowledgeBase),
  }
}

function previewModelProfile(runtime) {
  return {
    name: 'preview_model_profile',
    description:
      '预览一个模型档案的编译行为，不调用视觉模型、不读图片：把给定的示例 IR（或内置的合成 IR）跑一遍提示词编译器，' +
      '返回按槽位排好的正向提示词、抑制提示词、dropped 列表与预算统计。' +
      '用于在真正分析图片之前确认「这套档案编译出来的是什么」。',
    parameters: {
      type: 'object',
      properties: {
        target_profile: { type: 'string', description: '要预览的档案 config_id，如 pony-v6 / noobai-xl / illustrious / animagine-xl-4.0。' },
        variant: { type: 'string', description: '已废弃：2.0 档案没有变体概念。' },
        detail_level: { ...DETAIL_LEVEL, description: '覆盖细节密度。' },
        sample_ir: { type: 'object', description: '自定义示例 IR；缺省使用内置合成 IR。' },
      },
      required: ['target_profile'],
      additionalProperties: false,
    },
    execute: guarded('preview_model_profile', runtime, (rt, args) => rt.runPreviewProfile(args)),
  }
}
function manageExperiences(runtime) {
  return {
    name: 'manage_experiences',
    description:
      '查看、检索、评分、导出、导入与删除本地经验库里的历史分析记录。' +
      '`list` / `search` / `get` / `stats` 只读；`rate` / `delete` / `export` / `import` 会改动数据。' +
      '检索结果一律标明来源：历史记录只说明以前用过哪些标签组合，不代表这些标签生成效果更好 —— 历史频率不等于生成有效性。' +
      '经验库只保存内容哈希与元数据，不保存原图。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'search', 'get', 'stats', 'rate', 'delete', 'export', 'import'],
          description: '要做的动作。缺省 list。',
        },
        experience_id: { type: 'integer', description: '经验编号（get / rate / delete 用）。' },
        task_id: { type: 'string', description: '分析任务号（get / delete 用，与 experience_id 二选一）。' },
        tags: { type: 'array', items: { type: 'string' }, description: 'search 用的标签组合。' },
        require_all: { type: 'boolean', description: 'search 是否要求全部标签都命中。默认 false（按命中比例排序）。' },
        target_model: { type: 'string', description: '只筛某个 target_model（profile 的 display_name）的经验。' },
        target_profile: {
          type: 'string',
          description:
            '只筛某个模型档案（config_id）的经验。2.0 起经验按档案隔离，list / search / stats / export 都支持；1.0 旧记录没有档案，一律归入 legacy。',
        },
        image_hash: { type: 'string', description: 'list 时按原图内容哈希筛选，用于找「同一张图」的历史记录。' },
        rating: { type: 'integer', minimum: 1, maximum: 5, description: 'rate 用：用户看过生成结果后的效果评分。' },
        note: { type: 'string', description: 'rate 用：评分理由。' },
        ids: { type: 'array', items: { type: 'integer' }, description: 'export 时只导出这几条；缺省按 limit 导出最近的。' },
        path: { type: 'string', description: 'export / import 的文件路径。export 缺省写到配置里的 experience_export_path。' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: '返回或导出的条数上限。' },
      },
      additionalProperties: false,
    },
    execute: guarded('manage_experiences', runtime, runManageExperiences),
  }
}
export function registerAllTools(ctx, runtime) {
  const specs = [
    analyzeImagePrompt(runtime),
    validateConfigs(runtime),
    diagnoseKnowledgeBase(runtime),
    rebuildKnowledgeBase(runtime),
    previewModelProfile(runtime),
    manageExperiences(runtime),
  ]
  const disposers = []
  for (const spec of specs) {
    try {
      disposers.push(registerTool(ctx, spec))
    } catch (error) {
      runtime.logger.error(`注册工具 ${spec.name} 失败`, error)
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (disposeError) {
          runtime.logger.warn('回退已注册工具时出错', disposeError)
        }
      }
      throw error
    }
  }
  return disposers
}

export { fromException }
