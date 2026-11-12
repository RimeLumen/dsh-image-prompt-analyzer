
import { registerTool } from './registry.js'
import { registerComfyTools } from '../comfyui/tools.js'
import { fromException, envelope, TASK_STATUS } from '../diagnostics.js'
import { runValidateConfigs } from './impl/validate-configs.js'
import { runDiagnoseKnowledgeBase } from './impl/diagnose-kb.js'
import { runRebuildKnowledgeBase } from './impl/rebuild-kb.js'
import { runManageExperiences } from './impl/manage-experiences.js'
import { runSearchTags } from './impl/search-tags.js'
import { runExplainTag } from './impl/explain-tag.js'
import { runCompileBasket } from './impl/compile-basket.js'
import { runWriteCaption } from './impl/write-caption.js'
import { runReviseCaption } from './impl/revise-caption.js'

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
      '两种用法之一：图片反推。有图，先从图里读出看得见的事实，再按目标档案写成提示词。' +
      '把一张图片逆向成提示词，按所选目标档案的写法给出一条正向提示词与一条反向提示词。' +
      '正向只给一种形态，由档案决定：标签档（word_style=spaced）给标签流，描述档（prose）给成分句，Caption 档（caption，MOSS-Image）给一段连贯的自然语言描述，不并列几版让你挑。' +
      '返回只有正向、反向、目标档案、写法（prompt_style: tag / prose / caption）、图片尺寸，以及控制网模式下必须带走的权重与区间建议。' +
      'Caption 档在明确要求时还会多一个 prompt_format（caption / layout_json）——它说的是这串描述有没有排成结构化元素，不是另一种写法。' +
      'Caption 可以要中文（caption_language=zh-CN）：中文由视觉分析阶段直接产出，不是把英文 Caption 翻译一遍，所以语言要在分析开始前定，改语言要重新分析。' +
      '槽位明细、成分句、事实台账、还原审计、覆盖率、统计这些是分析过程，写到本地 trace（data/traces/<task_id>/），不占对话；' +
      '要逐条追查某条观察去了哪里，用 scripts/inspect-prompt.mjs 读 trace 里的 IR。' +
      '诊断只回 warning 与 error，INFO 级说明留在 trace 里。' +
      '分析严格区分「可观察到的内容」与「推断的内容」，每条特征都带置信度与重要度，低置信度项不会被当成事实写进提示词。' +
      '可选传 character 声明角色名（插件不做角色识别）。',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '图片文件路径（PNG/JPG/JPEG/WEBP/BMP；RAW 依赖解码器支持）。' },
        target_profile: {
          type: 'string',
          description:
            '目标模型档案的 config_id，如 illustrious / anima / moss。必须显式指定：没有默认档案，不传会报 MODEL_PROFILE_NOT_SELECTED。',
        },
        variant: {
          type: 'string',
          description: '已废弃：2.0 档案没有变体概念，传了只会得到一条提示并被忽略。',
        },
        detail_level: { ...DETAIL_LEVEL, description: '提示词细节密度，覆盖 profile / preset 的默认值。' },
        character: {
          type: 'string',
          description:
            '可选：你直接给出的角色名，如 dorothy (nikke)。插件不做角色识别，只有传了这个字段才会写角色标签；不传就不写、也不猜。',
        },
        include_negative: { type: 'boolean', description: '是否输出抑制提示词。默认 true；为 false 时只给正向。' },
        pose_control: {
          type: 'string',
          enum: ['none', 'openpose', 'controlnet'],
          description:
            '可选：姿势由谁负责。默认 none，姿势写在正向提示词里（插件自己的观察口径）。' +
            'openpose / controlnet 表示你另外接骨架或深度控制：姿态词会让位，改给控制网权重与区间建议。',
        },
        include_ir: {
          type: 'boolean',
          description: '调试用：把完整 IR 一并返回。默认 false，出图与反推都不需要它——分析过程数据在本地 trace 里。',
        },
        explain_terms: {
          type: 'boolean',
          description:
            '可选：把提示词里每个词在词库里的解释一并返回（中文名、来源、是否只是补充词典的线索）。' +
            '默认 false——分析结果本身不带这些，需要时再用 explain_tag 单查，或在这里一次要齐。',
        },
        layout: {
          description:
            '仅 Caption 档（moss）有意义：把 Caption 排成 MOSS 的 Layout JSON。默认不排。' +
            '传 true 用默认格式（abs / xyxy，画布取原图尺寸）；也可以传对象指定 coord_space（abs / abs_centralized）、' +
            'bbox_format（xyxy / yxyx）、canvas_width、canvas_height、max_elements。' +
            '坐标只来自 IR 里视觉模型给出的区域，没有区域的元素不进 Layout——插件不会编造 Bounding Box。' +
            '非 caption 档案传了会被忽略。',
          anyOf: [
            { type: 'boolean' },
            {
              type: 'object',
              properties: {
                coord_space: { type: 'string', enum: ['abs', 'abs_centralized'] },
                bbox_format: { type: 'string', enum: ['xyxy', 'yxyx'] },
                canvas_width: { type: 'integer', minimum: 1 },
                canvas_height: { type: 'integer', minimum: 1 },
                max_elements: { type: 'integer', minimum: 1, maximum: 64 },
              },
              additionalProperties: false,
            },
          ],
        },
        save_experience: { type: 'boolean', description: '是否把本次结果保存进本地经验库。默认 false（需配置允许）。' },
        caption_language: {
          type: 'string',
          enum: ['en', 'zh-CN'],
          description:
            '仅 Caption 档（moss）有意义：Caption 用哪种语言写，en 或 zh-CN。不传就用档案里的 caption_language（默认 en）。' +
            '中文不是把英文 Caption 翻一遍：传 zh-CN 会让视觉分析阶段直接用中文写观察值，所以语言必须在分析开始前定下来，' +
            '事后改语言要重新分析这张图（不会拿旧 IR 硬翻）。非 caption 档案传了会被忽略。',
        },
      },
      required: ['image_path', 'target_profile'],
      additionalProperties: false,
    },
    execute: guarded('analyze_image_prompt', runtime, (rt, args) =>
      rt.runAnalyze({ ...args, include_ir: args.include_ir === true, explain_terms: args.explain_terms === true })),
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
      '配置声明的数据源在不在。studio_sqlite 源会额外体检源库表结构、行数与指纹是否与上次导入一致（没导过、导过但源库变了都会单独报）。' +
      '知识库是纯本地的：本工具不联网，也不读取或上传图片。',
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
      '从配置声明的数据源重建标签知识库：local_file（CSV / XLSX / DOCX / PDF / TXT / MD）与 studio_sqlite（绘画工作室导出的 SQLite 词库，只读打开）。' +
      '复用与 scripts/import-tags.mjs 相同的读取与导入管线：按 (source_id, tag) 幂等 upsert；' +
      '每个数据源在事务内先清空旧行再整份导入，失败回滚保留旧数据。studio_sqlite 以源库 sha256 判定是否需要重导，指纹没变就直接跳过。' +
      'limit 限制最多重建多少个数据源（默认 500，上限 20000），行级试跑请用 dry_run 或 CLI 的 --limit。',
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
        target_profile: { type: 'string', description: '要预览的档案 config_id，如 illustrious / anima / moss。' },
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
function searchTags(runtime) {
  return {
    name: 'search_tags',
    description:
      '按中文或英文关键词检索本地标签词表（这就是 search_studio_tags：一个工具同时查模型词表与工作室补充词典）。' +
      '返回英文规范名、中文名、别名、来源、命中方式、常用度、翻译状态、是否废弃，以及模型词表重叠情况（model_overlap：模型词表里有没有同名同拼写的词）。' +
      '两种来源分开标注：model（模型词表，决定这个词能不能进提示词）与 studio（补充词典，解释得清楚但不替模型词表背书）。' +
      '可按工作室分类（category，名字或分类 ID）、是否废弃（deprecated）、翻译状态（translation_status）、档案（profile）过滤。' +
      'post_count 是作品数，只说明这个词在公开图库里被用了多少次，不代表生成质量。' +
      'scope=tree 时改查工作室分类树（视觉特征 → 画面构图与风格 → …），只返回分支路径。' +
      '纯本地检索：不联网、不读图片、不改任何数据。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，中文或英文均可，例如「女仆」或 maid。' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回多少条，默认 10。' },
        scope: {
          type: 'string',
          enum: ['tags', 'tree', 'both'],
          description: 'tags 只查标签（默认），tree 只查分类树分支，both 两边都查。',
        },
        include_deprecated: { type: 'boolean', description: '是否连已废弃的标签一起返回。默认 false。' },
        deprecated: {
          type: 'string',
          enum: ['exclude', 'only', 'include'],
          description: '废弃词处理：exclude 不返回（默认），only 只返回废弃词，include 一起返回。',
        },
        translation_status: {
          type: 'string',
          description: '只返回这个翻译状态的词，例如 machine_draft_1 / wiki_definition_reviewed / curated / manual。',
        },
        category: {
          type: 'string',
          description: '只返回挂在这个工作室分类下的词：可以填分类名（如「画质与媒介」）或分类 ID。需要已导入 studio_sqlite 源。',
        },
        profile: {
          type: 'string',
          description: '按档案收窄模型词表那一侧（illustrious / anima / moss）。补充词典不区分档案。',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    presentationMeta: (args, value) => ({
      state: typeof value?.status === 'string' ? value.status : 'unknown',
      message:
        typeof value?.query === 'string'
          ? `「${value.query}」查到 ${Array.isArray(value.results) ? value.results.length : 0} 条标签`
          : null,
      results: Array.isArray(value?.results)
        ? value.results.slice(0, 8).map((item) => ({ tag: item.tag, zh_name: item.zh_name, source: item.source, match: item.match }))
        : [],
    }),
    execute: guarded('search_tags', runtime, runSearchTags),
  }
}

function explainTag(runtime) {
  return {
    name: 'explain_tag',
    description:
      '解释一个标签：中文名、别名、原生分类、kind、常用度、工作室分组、翻译状态、是否已废弃，以及它在模型词表与补充词典里各自的说法。' +
      '两边都存在时分开列，因为「模型认不认」与「工作室怎么解释」是两个问题。' +
      '传 target_profile 会额外给出按该档案渲染后的写法（例如标签档的空格写法、Caption 档的句式），不传就不猜。' +
      '词表里没有时返回近义词建议，并说明这个词会作为自由描述进描述版、不进标签版。',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: '要解释的标签或中文名，例如 maid / 女仆。' },
        target_profile: { type: 'string', description: '可选：额外给出按这个档案渲染后的写法（illustrious / anima / moss）。' },
        slot: { type: 'string', description: '可选：渲染时按哪个槽位处理，例如 general / clothing。不传就按普通标签。' },
      },
      required: ['tag'],
      additionalProperties: false,
    },
    presentationMeta: (args, value) => ({
      state: typeof value?.status === 'string' ? value.status : 'unknown',
      message: value?.found === true
        ? `「${value.query}」${value.hits?.[0]?.tag?.zh_name ? `＝${value.hits[0].tag.zh_name}` : '已收录'}`
        : typeof value?.query === 'string'
          ? `「${value.query}」不在词表里`
          : null,
      hits: Array.isArray(value?.hits)
        ? value.hits.slice(0, 4).map((hit) => ({ source: hit.source, tag: hit.tag?.name, zh_name: hit.tag?.zh_name, via: hit.via }))
        : [],
      emitted: typeof value?.rendering?.emitted === 'string' ? value.rendering.emitted : null,
    }),
    execute: guarded('explain_tag', runtime, runExplainTag),
  }
}

function compileTagBasket(runtime) {
  return {
    name: 'compile_tag_basket',
    description:
      '两种用法之一：基于用户标签的编写。没有图，用户给词（中英文都行），按目标档案写成提示词。' +
      '中文创作需求先拆成词，再用 search_tags 查成英文规范名，最后交到这里编译——这是目前唯一支持的中文需求链路，不做自由文本改写。' +
      '把用户自己挑好的一串词按指定档案编译成正向与反向提示词，不需要图片。' +
      '复用整条编译链路：分类 → 槽位 → 词库解析 → 预算 → 渲染 → 抑制词，与图片反推得到的是同一套输出。' +
      '每个词都回报解析状态（命中 / 未命中 / 别名归一 / 来自哪条源），未命中的词照旧保留，不替用户删词。' +
      '中文词会先换成词库里的英文名再写进去，换过哪些逐条列出来。' +
      '用户亲手挑的词按满重要度处理，不会被预算挤掉；只编提示词，不提交生成任务。' +
      'Caption 档案（moss）不吃标签流：没有自然语言事实时它会直接失败并说明原因，不会替你编一段描述。',
    parameters: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '词篮，最多 80 条；重复的自动去重。例如 ["1girl","long_hair","maid"]。',
        },
        target_profile: { type: 'string', description: '目标档案 config_id（illustrious / anima / moss）。缺省用插件配置里的默认档案。' },
        detail_level: { ...DETAIL_LEVEL, description: '覆盖细节密度。' },
        include_negative: { type: 'boolean', description: '是否输出抑制提示词。默认 true。' },
        character: { type: 'string', description: '可选：角色名，按档案的 character_format 渲染；不传就不写、也不猜。' },
        pose_control: {
          type: 'string',
          enum: ['none', 'openpose', 'controlnet'],
          description: '可选：姿势由谁负责。默认 none；接骨架时姿态词会让位并给出控制网建议。',
        },
      },
      required: ['tags'],
      additionalProperties: false,
    },
    presentationMeta: (args, value) => ({
      state: typeof value?.status === 'string' ? value.status : 'unknown',
      message:
        typeof value?.target_profile === 'string'
          ? `${value.target_profile} · ${Array.isArray(value?.slots) ? value.slots.length : 0} 个槽位 · ${value?.stats?.terms ?? 0} 个词`
          : null,
      positive: typeof value?.positive === 'string' ? value.positive : null,
      negative: typeof value?.negative === 'string' ? value.negative : null,
    }),
    execute: guarded('compile_tag_basket', runtime, runCompileBasket),
  }
}

function writeCaption(runtime) {
  return {
    name: 'write_caption',
    description:
      '三种用法之三：基于自然语言需求的编写。没有图，用户给一段画面描述（中文或英文都行），按 Caption 档案（moss）写出一段连贯的自然语言正向提示词。' +
      '与 compile_tag_basket 的分工：那个吃标签、走词表解析与槽位渲染；这个吃一句话，原样交出一段 Caption——不拆成标签，不翻译，不补人物或关系。' +
      '用户写什么就是什么：「她的右手握着收拢的白色雨伞」「行李箱在脚边」这类归属与位置，只要需求里写了就完整保留。' +
      '语言按需求文本判定（有汉字就是中文），与档案默认语言不一致只提醒、不翻译；MOSS 官方说明中英文都支持。' +
      '会摘掉 masterpiece / best quality / score_9 这类冗余质量词（官方 SKILL.md 要求避免），并给出档案声明的负向词（MOSS 是四条官方基线）。' +
      '默认正向只放这段描述，不产出标签流，也不产出 Layout JSON；只编提示词，不提交生成任务。',
    parameters: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description:
            '画面需求，一段中文或英文描述。例如「一名成年女性穿着深蓝色长外套，站在车站雨棚下。她的右手握着收拢的白色雨伞，脚边放着棕色行李箱。」',
        },
        target_profile: { type: 'string', description: '目标档案 config_id。这个入口只服务 Caption 档案（moss）；缺省用插件配置里的默认档案。' },
        language: {
          type: 'string',
          enum: ['en', 'zh-CN'],
          description: '可选：期望的 Caption 语言。省略则按需求文本自动判定；与文本不一致时不翻译，按原文输出并提示。',
        },
        include_negative: { type: 'boolean', description: '是否输出负向提示词。默认 true。' },
      },
      required: ['brief'],
      additionalProperties: false,
    },
    presentationMeta: (args, value) => ({
      state: typeof value?.status === 'string' ? value.status : 'unknown',
      message:
        typeof value?.target_profile === 'string'
          ? `${value.target_profile} · ${value?.language ?? 'unknown'} · ${value?.brief?.chars ?? 0} 字`
          : null,
      positive: typeof value?.positive === 'string' ? value.positive : null,
      negative: typeof value?.negative === 'string' ? value.negative : null,
    }),
    execute: guarded('write_caption', runtime, runWriteCaption),
  }
}

function reviseCaption(runtime) {
  return {
    name: 'revise_caption',
    description:
      '在已有 Caption 上做定点修改：给原文和一句修改要求，只改被点名的那一处，其余字符逐字不动。' +
      '输入「只把外套颜色从深蓝改成酒红」得到「酒红色长外套」——服装类型、所属人物和其他事实都不动。' +
      '只认带旧值的替换（「从 A 改成 B」）；只给目标值时不猜原文该动哪一处，直接报缺旧值。' +
      '目标在原文里出现多次且没指明是谁时，不替调用方选，返回候选小句要求指明目标。' +
      '原文本来没写这个属性时不把替换变成新增设定。只编提示词，不提交生成任务。',
    parameters: {
      type: 'object',
      properties: {
        original: {
          type: 'string',
          description: '要改的原文，通常是上一次生成的 Caption，原样传入。',
        },
        instruction: {
          type: 'string',
          description:
            '一句修改要求。中文「只把外套颜色从深蓝改成酒红」，英文 "change the coat color from navy to burgundy"。',
        },
        target_profile: { type: 'string', description: '目标档案 config_id。这个入口只服务 Caption 档案（moss）。' },
      },
      required: ['original', 'instruction'],
      additionalProperties: false,
    },
    presentationMeta: (args, value) => ({
      state: typeof value?.status === 'string' ? value.status : 'unknown',
      message:
        value?.changed && typeof value.changed.at === 'number'
          ? `${value.target_profile ?? 'unknown'} · 改了 ${value.changed.count} 处`
          : typeof value?.target_profile === 'string'
            ? `${value.target_profile} · 未修改`
            : null,
      positive: typeof value?.positive === 'string' ? value.positive : null,
    }),
    execute: guarded('revise_caption', runtime, runReviseCaption),
  }
}

export function registerAllTools(ctx, runtime) {
  const specs = [
    analyzeImagePrompt(runtime),
    searchTags(runtime),
    explainTag(runtime),
    compileTagBasket(runtime),
    writeCaption(runtime),
    reviseCaption(runtime),
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

  // ComfyUI 工具是可选能力：注册本身不读文件、不发请求，未启用时每个工具
  // 都会返回 CAPABILITY_UNAVAILABLE。注册失败要连带回滚前面已注册的六项。
  try {
    disposers.push(...registerComfyTools(ctx, runtime))
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (disposeError) {
        runtime.logger.warn('回退已注册工具时出错', disposeError)
      }
    }
    throw error
  }
  return disposers
}

export { fromException }
