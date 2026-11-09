
import { COMFY_CODES, ComfyError } from './errors.js'
import { envelope, fromException, diagnostic, SEVERITY, TASK_STATUS } from '../diagnostics.js'
import { registerTool } from '../tools/registry.js'
import { KNOWN_MODEL_EXTENSIONS, extensionOf } from './catalog.js'
import { CATEGORY_LOADERS, filterByStates, reconcileModels } from './reconcile.js'
import { inspectWorkflow, requireApiPrompt } from './workflow.js'
import { applyWorkflowPatch, planWorkflowPatch } from './patch.js'
import { ROLE_VALUES, resolveSemanticChanges } from './edits.js'
import { classesInPrompt } from './build.js'
import { RUN_STATES } from './runs.js'
import { LAUNCHER_ACTION_VALUES } from './launcher.js'

const STATE_FILTER = {
  type: 'object',
  properties: {
    disk_present: { type: 'string', enum: ['true', 'false', 'unknown'] },
    runtime_visible: { type: 'string', enum: ['true', 'false', 'unknown'] },
    loader_selectable: { type: 'string', enum: ['true', 'false', 'unknown'] },
    execution_success: { type: 'string', enum: ['true', 'false', 'unknown'] },
  },
  additionalProperties: false,
}

// 运行时独有条目的上报上限。custom_nodes 这类目录型分类能上万条，
// 截断但如实报总数，比让调用方一次收几 MB 更有用。
const VIRTUAL_LIMIT = 200

async function readWorkflowFromPath(rt, filePath, signal) {
  const adapter = rt.fsAdapter
  const target = await adapter.resolve(filePath, { signal })
  const info = await adapter.stat(target, { signal })
  if (!info || info.type !== 'file') {
    throw new ComfyError(COMFY_CODES.PATH_MISSING, `工作流文件不存在：${filePath}`)
  }
  const text = await adapter.readTextBounded(target, { signal })
  try {
    return JSON.parse(text)
  } catch {
    throw new ComfyError(
      COMFY_CODES.WORKFLOW_FORMAT_UNSUPPORTED,
      `${filePath} 不是合法 JSON。`,
    )
  }
}

async function resolveWorkflow(rt, args, signal) {
  if (args.workflow && typeof args.workflow === 'object') return args.workflow
  if (typeof args.workflow_path === 'string' && args.workflow_path !== '') {
    return readWorkflowFromPath(rt, args.workflow_path, signal)
  }
  if (typeof args.workflow_name === 'string' && args.workflow_name.trim() !== '') {
    // 用户只报了个名字：先在工作流目录里找，找不到会带着可用名一起报错。
    const found = await rt.resolveLocalWorkflow(args.workflow_name.trim(), { signal })
    return readWorkflowFromPath(rt, found.item.display_path, signal)
  }
  throw new ComfyError(
    COMFY_CODES.VALIDATION_FAILED,
    '需要提供 workflow（对象）、workflow_path（文件路径）或 workflow_name（本地工作流名）之一。',
  )
}

/** 每个工具失败时要说清是哪个动作被拦下的，不能出现 undefined。 */
const TOOL_ACTIONS = Object.freeze({
  comfyui_status: '检查连接状态',
  comfyui_list_models: '列出本地模型',
  comfyui_list_workflows: '列出本地工作流',
  comfyui_inspect_workflow: '检查工作流',
  comfyui_plan_workflow_patch: '规划工作流补丁',
  comfyui_build_workflow: '新建工作流',
  comfyui_save_workflow: '保存工作流',
  comfyui_submit_workflow: '提交工作流',
  comfyui_get_job: '查询任务',
  comfyui_start: '启动或打开 ComfyUI',
})

function actionLabelOf(toolName) {
  const label = TOOL_ACTIONS[toolName]
  return typeof label === 'string' && label !== '' ? label : '该操作'
}

/**
 * 提交之后该做什么，三种情况必须分开说。
 * 服务端明确拒绝（rejected）是"改完可以再提一次"，说成"结果未知、请勿重复提交"
 * 会让调用方以为队列里躺着一份任务，白白卡住。
 */
function nextStepFor(run) {
  if (run?.prompt_id) return `用 comfyui_get_job 查询 ${run.prompt_id} 的执行结果。`
  if (run?.state === RUN_STATES.FAILED && run?.error_code === COMFY_CODES.SUBMISSION_REJECTED) {
    return 'ComfyUI 明确拒绝了这份工作流，队列里没有这次任务。按 node_errors 改完参数可以重新提交一次。'
  }
  return '提交结果未知，请勿重复提交；先确认 ComfyUI 队列里有没有这次任务。'
}

/**
 * builder 的授权闸门。
 *
 * 生图请求默认走"用本地已有工作流"这条路：找到文件、在副本上改、提交改后的副本。
 * 从零搭一份只该在用户明确要求时发生，所以这里要一个显式的授权字段，
 * 而不是靠"没找到文件"之类的失败自动滑进 builder。
 */
function requireBuildAuthorization(args) {
  if (args?.reason === 'user_requested_new_workflow') return
  throw new ComfyError(
    COMFY_CODES.CAPABILITY_UNAVAILABLE,
    '新建工作流需要用户明确授权，本次调用没有带上 reason: "user_requested_new_workflow"。',
    '先用 comfyui_list_workflows 找本地已有工作流；要换模型或改参数用 comfyui_plan_workflow_patch 在副本上改。只有用户明确说"新建一份""自己搭一份"时才用本工具。',
  )
}

/**
 * 补丁被整份作废时，`error.details` 里每一处失败都带着自己的 node_id / class_type /
 * input。只回一条汇总诊断等于把用户最需要的那行信息丢了，所以逐条摊开。
 */
/** 输出引用不合法时给 null，不替调用方拼一个可能越界的 /view 链接。 */
function safeUrl(comfy, image) {
  // 先试同源转发：页面 CSP 是 default-src 'self'，跨源地址会被浏览器拦掉。
  try {
    const proxied = comfy.imageProxyUrl(image)
    if (typeof proxied === 'string' && proxied !== '') return proxied
  } catch {
    // 宿主没有 webServer 时退回下面的原始地址。
  }
  try {
    return comfy.imageViewUrl(image)
  } catch {
    return null
  }
}

/**
 * Host 的附件引用是下划线式（attachment_id / media_type），浏览器半侧的
 * ImageAttachmentRef 是驼峰（attachmentId / mediaType）。两边字段名不一样，
 * 这里只做改名，不做补全：缺字段的引用在浏览器侧会被判成非法并退回纯文本卡片，
 * 不会被拼成一个假的图片。
 */
function presentationImages(attachments, images) {
  const list = Array.isArray(attachments) ? attachments : []
  // 附件是按文件名建的索引：collectImages 会跳过不合格的图，按下标对会错位。
  const urls = new Map()
  for (const image of Array.isArray(images) ? images : []) {
    if (typeof image?.filename === 'string' && typeof image?.url === 'string') urls.set(image.filename, image.url)
  }
  return list
    .filter((item) => item && typeof item.attachment_id === 'string' && item.attachment_id !== '')
    .map((item) => ({
      attachmentId: item.attachment_id,
      mediaType: item.media_type,
      bytes: item.bytes,
      width: item.width,
      height: item.height,
      ...(typeof item.name === 'string' && item.name !== '' ? { name: item.name } : {}),
      // 宿主只授权「会话事件里出现过的图片」给浏览器读；生成结果不在事件里，
      // 所以附件读不到时浏览器退回直接取 ComfyUI 的 /view。这个地址只在本机有效。
      ...(typeof item.name === 'string' && urls.has(item.name) ? { url: urls.get(item.name) } : {}),
    }))
}

/**
 * 分类视角的统计：磁盘扫到的分类与运行时列出的分类是两套集合。
 * 只报其中一套，用户就问不出"到底漏没漏"——所以这里并集后逐类给数，
 * 数据全部来自已经取到的扫描与对账结果，不额外发请求。
 *
 * runtime_files 为 null 表示"不知道"，不是"零个"：API 不可用、单分类取不到、
 * 或该分类压根没在 /models 里注册，都无从得知运行时到底有几个文件。
 */
function summarizeCategories({
  diskCategories = [],
  runtimeCategories = [],
  runtimeFiles = null,
  entries = [],
  virtual = [],
  runtimeAvailable = false,
} = {}) {
  const diskCounts = new Map()
  for (const entry of entries) {
    if (!entry?.category || entry.known_format === false) continue
    diskCounts.set(entry.category, (diskCounts.get(entry.category) ?? 0) + 1)
  }

  const runtimeOnlyCounts = new Map()
  for (const item of virtual) {
    const looksLikeModel =
      item?.virtual === true || KNOWN_MODEL_EXTENSIONS.includes(extensionOf(item?.name))
    if (!looksLikeModel) continue
    runtimeOnlyCounts.set(item.category, (runtimeOnlyCounts.get(item.category) ?? 0) + 1)
  }

  const names = new Set([...diskCategories, ...runtimeCategories])
  return [...names].sort().map((category) => {
    const diskFiles = diskCounts.get(category) ?? 0
    const listed = runtimeAvailable && runtimeFiles && Array.isArray(runtimeFiles[category])
    return {
      category,
      disk_files: diskFiles,
      runtime_files: listed ? runtimeFiles[category].length : null,
      runtime_only: runtimeOnlyCounts.get(category) ?? 0,
      empty: diskFiles === 0,
      has_loader: Object.prototype.hasOwnProperty.call(CATEGORY_LOADERS, category),
    }
  })
}

function expandDetails(error) {
  const details = Array.isArray(error?.details) ? error.details : []
  return details.map((item) =>
    diagnostic({
      error_code: item.error_code ?? COMFY_CODES.VALIDATION_FAILED,
      severity: SEVERITY.ERROR,
      message: item.message ?? '校验失败。',
      suggested_fix: item.suggested_fix ?? null,
    }),
  ).map((item, index) => ({
    ...item,
    node_id: details[index].node_id ?? null,
    class_type: details[index].class_type ?? null,
    input: details[index].input ?? null,
    field: details[index].field ?? null,
  }))
}

function guarded(toolName, runtime, impl, { requiresEnabled = true, action = null } = {}) {
  return async (args, exec) => {
    try {
      const comfy = await runtime.getComfyUI()
      // 未启用时先拦下来：参数校验、文件解析、网络请求一个都不该发生，
      // 否则用户会拿到"参数不对"这种与真实原因无关的报错。
      if (requiresEnabled) comfy.ensureEnabled(action ?? actionLabelOf(toolName))
      const signal = args?.signal ?? exec?.signal ?? null
      return await impl(comfy, signal ? { ...(args ?? {}), signal } : (args ?? {}))
    } catch (error) {
      runtime.logger?.error?.(`工具 ${toolName} 执行失败`, error)
      const summary =
        typeof error?.toDiagnostic === 'function'
          ? error.toDiagnostic()
          : fromException(error, { error_code: error?.code ?? 'TOOL_EXECUTION_FAILED' })
      return envelope({
        status: TASK_STATUS.FAILED,
        diagnostics: [summary, ...expandDetails(error)],
      })
    }
  }
}

export function createComfyToolSpecs(runtime) {
  return [
    {
      name: 'comfyui_status',
      description:
        '检查本机 ComfyUI 的连接状态：能否连上、版本与设备信息、当前配置是否启用。' +
        '未启用或连不上时返回明确的错误码，不会退回本地扫描或猜测。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: guarded(
        'comfyui_status',
        runtime,
        async (comfy, args) => {
          const described = comfy.describe()
          if (!described.enabled) {
            return { ...described, reachable: false, message: 'ComfyUI 集成未启用。' }
          }

          // 先只做本地发现（不探测端口），这样"已安装未运行"和"根本没装"
          // 能分开报，用户才知道下一步该干什么。
          let discovery = null
          let discoveryError = null
          try {
            discovery = await comfy.discover({ probe: false, signal: args.signal })
          } catch (error) {
            discoveryError = error?.message ?? String(error)
          }

          let status = null
          let reachable = false
          try {
            status = await comfy.status({ signal: args.signal })
            reachable = true
          } catch (error) {
            status = { reachable: false, error: error?.message ?? String(error) }
          }

          const message = (() => {
            if (discoveryError) return `自动发现失败：${discoveryError}`
            if (!discovery) return reachable ? 'ComfyUI 已连接。' : 'ComfyUI 未连接。'
            if (discovery.status === 'not_found') return '没有在本机的已知位置发现 ComfyUI 安装；可以手动填写 comfyui.installRoot。'
            if (discovery.status === 'ambiguous') return `发现 ${discovery.candidates.length} 个 ComfyUI 候选，需要人工确认用哪一个。`
            if (discovery.status === 'not_running') return '发现了 ComfyUI 安装，但它当前没有运行。'
            if (!reachable) return '发现了 ComfyUI 安装，但 API 没有响应。'
            return 'ComfyUI 已连接。'
          })()

          return {
            // 这里要重新取一次：status 刚把地址标成"验证过"，
            // 用开头那份快照会把 base_url_source 和 verified_base_url 报成互相矛盾的值。
            ...comfy.describe(),
            ...(status ?? {}),
            reachable,
            discovery,
            message,
          }
        },
        // status 是唯一在未启用时也要能回答的工具：用户得先看到为什么不能用。
        { requiresEnabled: false },
      ),
    },

    {
      name: 'comfyui_list_models',
      description:
        '列出本地模型目录里的模型文件，并分别标注四种状态：磁盘存在、运行时可见、loader 可选择、执行成功过。' +
        '四种状态互不推导；ComfyUI 没启动时运行时三态一律是 unknown，而不是 false。' +
        '分类来自实际路径配置（含未知分类），不限于 checkpoints / loras / vae。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: '只列这个分类（规范化名，如 checkpoints / text_encoders）。' },
          name_contains: { type: 'string', description: '按文件名子串过滤。' },
          states: { ...STATE_FILTER, description: '按四态过滤；只写想筛的项。' },
          refresh: { type: 'boolean', description: '跳过进程内缓存重新扫描。默认 false。' },
          limit: { type: 'integer', minimum: 1, maximum: 5000, description: '最多返回多少条，默认 200。' },
        },
        additionalProperties: false,
      },
      execute: guarded('comfyui_list_models', runtime, async (comfy, args) => {
        const scanned = await comfy.scanModels({ signal: args.signal, refresh: args.refresh === true })

        let runtimeAvailable = false
        let models = null
        let loaderEnums = null
        let runtimeIndex = null
        const runtimeDiagnostics = []
        try {
          const client = comfy.getClient()
          const index = await client.getModels({ signal: args.signal })
          runtimeIndex = index
          // reconcile 要的是"分类 -> 文件名数组"，client 已经把分类列表摊平好了。
          models = index.files
          runtimeAvailable = true
          if (index.failures.length > 0) {
            runtimeDiagnostics.push(
              diagnostic({
                error_code: COMFY_CODES.SCAN_PARTIAL,
                severity: SEVERITY.WARNING,
                message: `运行时模型索引有 ${index.failures.length} 个分类取不到，这些分类的运行时状态记为 unknown。`,
                suggested_fix: '稍后重试，或在 ComfyUI 日志里确认对应自定义节点是否报错。',
              }),
            )
          }
          loaderEnums = {}
          // 只问有 loader 的分类对应那几个节点：真实实例上 /object_info 是几百 KB，
          // 多问一个就多一次往返，而没 loader 的分类本来就算不出 loader_selectable。
          const loaderNodes = [...new Set(Object.values(CATEGORY_LOADERS).map((item) => item.node))]
          for (const node of loaderNodes) {
            const info = await client.getObjectInfoFor(node, { signal: args.signal }).catch(() => null)
            if (info) loaderEnums[node] = info
          }
        } catch (error) {
          // 连不上就如实记 unknown，不把"没启动"写成"运行时不可见"。
          // 但原因不能吞掉：否则 status 说能连、list_models 说不可达，用户无从判断。
          runtimeAvailable = false
          runtimeDiagnostics.push(
            diagnostic({
              error_code: error?.code ?? COMFY_CODES.CAPABILITY_UNAVAILABLE,
              severity: SEVERITY.WARNING,
              message: `取运行时模型索引失败：${error?.message ?? error}`,
              suggested_fix: error?.suggested_fix ?? '用 comfyui_status 确认连接状态；连不上时运行时三态只能记为 unknown。',
            }),
          )
        }

        const reconciled = reconcileModels({
          entries: scanned.entries,
          models,
          loaderEnums,
          runtimeAvailable,
        })

        // .metadata.json、.txt、预览图常和权重放在同一个目录里，但它们不是模型：
        // ComfyUI 自己只列已知扩展名，这里同样按 known_format 收一遍，并把跳过的数量报出来。
        const categoryFilter = typeof args.category === 'string' && args.category !== '' ? args.category : null
        const scoped = categoryFilter
          ? reconciled.entries.filter((entry) => entry.category === categoryFilter)
          : reconciled.entries
        const nonModelSkipped = scoped.filter((entry) => entry.known_format === false).length
        let entries = scoped.filter((entry) => entry.known_format !== false)
        if (typeof args.name_contains === 'string' && args.name_contains !== '') {
          const needle = args.name_contains.toLowerCase()
          entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
        }
        if (args.states && typeof args.states === 'object') {
          entries = filterByStates(entries, args.states)
        }

        const limit = args.limit ?? 200
        // 运行时分类里有 custom_nodes / configs 这类按目录列举的分类，条目能上万条，
        // 里面绝大多数是 .py/.pyc/.md，不是模型。先按扩展名收一遍，再截断并如实报总数。
        const virtualKnown = reconciled.virtual.filter(
          (item) => item.virtual || KNOWN_MODEL_EXTENSIONS.includes(extensionOf(item.name)),
        )
        const virtualAll = virtualKnown.filter((item) => !categoryFilter || item.category === categoryFilter)
        const virtualTotal = virtualAll.length
        const virtualEntries = virtualAll.slice(0, VIRTUAL_LIMIT)
        const runtimeCategories = runtimeAvailable && runtimeIndex ? runtimeIndex.categories : null
        return {
          total: entries.length,
          returned: Math.min(limit, entries.length),
          entries: entries.slice(0, limit),
          virtual_entries: virtualEntries,
          virtual_total: virtualTotal,
          virtual_truncated: virtualTotal > VIRTUAL_LIMIT,
          virtual_skipped: reconciled.virtual.length - virtualTotal,
          // 与 virtual_skipped 同源，但语义写清楚：这是被扩展名等规则挡掉的运行时独有条目，
          // 不是"跳过了多少个分类"。两者并存，旧调用方不用改。
          virtual_filtered_out: reconciled.virtual.length - virtualKnown.length,
          non_model_skipped: nonModelSkipped,
          categories: scanned.categories,
          runtime_categories: runtimeCategories,
          category_summary: summarizeCategories({
            diskCategories: scanned.categories,
            runtimeCategories: runtimeCategories ?? [],
            runtimeFiles: models,
            entries: reconciled.entries,
            virtual: reconciled.virtual,
            runtimeAvailable,
          }),
          roots: scanned.roots,
          partial: scanned.partial,
          runtime_available: runtimeAvailable,
          diagnostics: [...scanned.diagnostics, ...runtimeDiagnostics, ...reconciled.diagnostics],
        }
      }),
    },

    {
      name: 'comfyui_list_workflows',
      description:
        '列出本机 ComfyUI 工作流目录里的 API 工作流文件，可按名称过滤。' +
        '只读文件名与大小，不解析内容、不扫整个磁盘；用户只要报名字就能用，不需要上传 JSON。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '按名称过滤，可省略扩展名，不区分大小写。' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少条，默认 30。' },
        },
        additionalProperties: false,
      },
      execute: guarded('comfyui_list_workflows', runtime, async (comfy, args) => {
        const listing = await comfy.listLocalWorkflows({
          signal: args.signal,
          query: args.query,
          limit: args.limit ?? 30,
        })
        return {
          total: listing.total,
          returned: listing.items.length,
          match_level: listing.match_level ?? null,
          install_root: listing.install_root,
          roots: listing.roots.map((root) => ({
            path: root.path,
            source: root.root_source ?? root.source ?? null,
            exists: root.exists !== false,
          })),
          workflows: listing.items.map((item) => ({
            name: item.name,
            directory: item.directory,
            display_path: item.display_path,
            root_source: item.root_source,
            size: item.size,
          })),
          skipped: listing.skipped,
          partial: listing.partial,
          diagnostics: listing.diagnostics,
          note: listing.total === 0 ? '这些目录里没有 .json 工作流文件。' : null,
        }
      }),
    },

    {
      name: 'comfyui_build_workflow',
      description:
        '从零搭一份基础文生图 API 工作流，并用 ComfyUI 的真实节点定义逐项校验。' +
        '**只有用户明确要求新建或自行搭建工作流时才调用。**' +
        '用户指定了本地工作流、要求换模型或改参数、找不到文件、文件格式不支持、模型架构不兼容，' +
        '都不构成新建授权：那些情况先用 comfyui_list_workflows 找本地文件，用 comfyui_plan_workflow_patch 在副本上改。' +
        '只支持 checkpoint 与 unet 两条加载路径；模型名必须是本机真实存在的值。' +
        '返回的工作流是本次任务的工作副本，不写文件；要留档用 comfyui_save_workflow。',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            enum: ['user_requested_new_workflow'],
            description:
              '新建授权。只有用户明确说过"新建一个工作流""自己搭一份""不用现有的重新构建"时才填这个值；' +
              '用户只说"我要生图"或指定了本地工作流，就不要调用本工具。',
          },
          loader: {
            type: 'string',
            enum: ['checkpoint', 'unet'],
            description: '加载路径。checkpoint 用 CheckpointLoaderSimple，unet 用 UNETLoader + CLIPLoader + VAELoader。默认 checkpoint。',
          },
          checkpoint: { type: 'string', description: 'loader=checkpoint 时的 ckpt_name，例如 waiIllustriousSDXL_v140.safetensors。' },
          unet: { type: 'string', description: 'loader=unet 时的 unet_name（diffusion_models 分类）。' },
          clip: { type: 'string', description: 'loader=unet 时的 clip_name（text_encoders 分类）。' },
          vae: { type: 'string', description: 'loader=unet 时的 vae_name。' },
          weight_dtype: { type: 'string', description: 'UNETLoader 的 weight_dtype，默认 default。' },
          clip_type: { type: 'string', description: 'CLIPLoader 的 type，默认 stable_diffusion。' },
          positive: { type: 'string', description: '正向提示词。' },
          negative: { type: 'string', description: '反向提示词，可省略。' },
          loras: {
            type: 'array',
            description: '要串进来的 LoRA，按顺序链式连接。',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                strength_model: { type: 'number' },
                strength_clip: { type: 'number' },
              },
              required: ['name'],
              additionalProperties: false,
            },
          },
          steps: { type: 'integer', minimum: 1, maximum: 200 },
          cfg: { type: 'number', minimum: 0, maximum: 100 },
          width: { type: 'integer', minimum: 64, maximum: 4096 },
          height: { type: 'integer', minimum: 64, maximum: 4096 },
          batch_size: { type: 'integer', minimum: 1, maximum: 16 },
          seed: { type: 'integer', minimum: 0 },
          denoise: { type: 'number', minimum: 0, maximum: 1 },
          sampler_name: { type: 'string' },
          scheduler: { type: 'string' },
          filename_prefix: { type: 'string' },
        },
        required: ['positive', 'reason'],
        additionalProperties: false,
      },
      execute: guarded('comfyui_build_workflow', runtime, async (comfy, args) => {
        requireBuildAuthorization(args)
        const built = await comfy.buildLocalWorkflow(args, { signal: args.signal })
        return {
          prompt: built.prompt,
          loader: built.loader,
          node_count: built.node_count,
          lora_count: built.lora_count,
          sampler_id: built.sampler_id,
          save_id: built.save_id,
          validation: {
            ok: built.validation.ok,
            problems: built.validation.problems,
          },
          node_definitions: {
            requested: built.classes,
            missing: built.missing,
            failures: built.failures,
          },
          loader_check: built.loader_check,
          note: built.loader_check?.mismatch
            ? `这个模型在 Loader 枚举里只出现在 ${built.loader_check.expected_loader} 那条路径上，现在用的是 ${built.loader_check.used_loader}。别把模型名硬填进另一个 Loader。`
            : built.validation.ok
              ? '工作流已按真实节点定义校验通过。要留档用 comfyui_save_workflow，要出图用 comfyui_submit_workflow。'
              : '校验没通过，不要提交。按 problems 里的节点与字段改。',
        }
      }),
    },

    {
      name: 'comfyui_save_workflow',
      description:
        '把一份 API 工作流另存为本地文件。只新建、不覆盖：同名文件已存在就报错。' +
        '只能写进已配置的工作流目录（默认 ComfyUI 的 user/default/workflows）。',
      parameters: {
        type: 'object',
        properties: {
          workflow: { type: 'object', description: 'API 格式的工作流对象。' },
          name: { type: 'string', description: '文件名，可省略 .json；不能含路径分隔符。' },
          directory: { type: 'string', description: '目标目录，必须是已配置的工作流根之一；省略则用默认根。' },
        },
        required: ['workflow', 'name'],
        additionalProperties: false,
      },
      execute: guarded('comfyui_save_workflow', runtime, async (comfy, args) => comfy.saveLocalWorkflow({
        workflow: args.workflow,
        name: args.name,
        directory: args.directory ?? null,
        signal: args.signal,
      })),
    },

    {
      name: 'comfyui_inspect_workflow',
      description:
        '读取并检查一份工作流：识别是 UI Workflow 还是 API Prompt，列出节点、输入、连接与不支持项。' +
        'UI 格式只做只读检查，首版不转换成 API 格式；正负提示词按 KSampler 的连接判定，不按节点顺序猜。' +
        '同时检查提示词链路上有没有 Prompt Enhancer 一类的改写节点（只看结构，不改工作流）。',
      parameters: {
        type: 'object',
        properties: {
          workflow_name: {
            type: 'string',
            description: '本地工作流名称，可省略扩展名。按名称在 ComfyUI 工作流目录里查，不需要上传 JSON。',
          },
          workflow_path: { type: 'string', description: '工作流 JSON 的绝对路径。' },
          workflow: { type: 'object', description: '直接传入工作流对象；与上面两项三选一。' },
        },
        additionalProperties: false,
      },
      execute: guarded('comfyui_inspect_workflow', runtime, async (comfy, args) => {
        const workflow = await resolveWorkflow(comfy, args, args.signal)
        const report = inspectWorkflow(workflow)
        if (report.format !== 'api') return report
        const { analyzeBindings } = await import('./bindings.js')
        const { detectPromptEnhancers, mossTemplateSupport } = await import('./enhancer.js')
        const bindings = analyzeBindings(workflow)
        const enhancer = detectPromptEnhancers(workflow)
        // 版本只影响"官方模板能不能跑"，读不到就是 unknown，不影响工作流本身的检查。
        //
        // 这个探测必须封顶：检查一份本地工作流原本是纯本地操作，不该因为 ComfyUI
        // 关着就挂住几十秒。读不到版本和读不到服务是同一件事，都算 unknown。
        let templateSupport = mossTemplateSupport(null)
        try {
          // 两个都可能是 undefined（老 Node 没有 AbortSignal.timeout / any），
          // 缺哪个就少一层保护，不要为了凑组合抛 TypeError。
          const probe = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(2500) : null
          const signal =
            probe && args.signal && typeof AbortSignal.any === 'function'
              ? AbortSignal.any([args.signal, probe])
              : (probe ?? args.signal ?? null)
          const status = await comfy.status({ signal })
          templateSupport = mossTemplateSupport(status?.system ?? null)
        } catch {
          templateSupport = mossTemplateSupport(null)
        }
        return {
          ...report,
          bindings,
          prompt_enhancer: { ...enhancer, comfyui: templateSupport },
          diagnostics: [...report.diagnostics, ...bindings.diagnostics, ...enhancer.diagnostics],
        }
      }),
    },

    {
      name: 'comfyui_plan_workflow_patch',
      description:
        '对一份 API Prompt 生成补丁计划：只改已经存在的字段，用当前 ComfyUI 的 /object_info 校验类型、范围与枚举。' +
        '任意一项不通过，整份补丁作废，不会返回只改了一半的工作流。' +
        '不新增节点、不删除节点、不新增输入、不改 class_type、不覆盖原文件；Seed 必须是可精确表示的整数。',
      parameters: {
        type: 'object',
        properties: {
          workflow_name: {
            type: 'string',
            description: '本地工作流名称，可省略扩展名。按名称在 ComfyUI 工作流目录里查。',
          },
          workflow_path: { type: 'string', description: 'API Prompt JSON 的绝对路径。' },
          workflow: { type: 'object', description: '直接传入 API Prompt 对象；与上面两项三选一。' },
          changes: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                role: {
                  type: 'string',
                  enum: ROLE_VALUES,
                  description:
                    '按角色定位节点：checkpoint / unet / vae / clip / lora / sampler / latent / positive / negative。' +
                    '给了 role 就不必知道 node_id；同一角色有多个节点时会要求你指定。',
                },
                index: { type: 'integer', minimum: 0, description: '仅 lora：第几个 LoRA，默认 0。' },
                node_id: { type: 'string', description: '目标节点 ID。用 role 时可省略。' },
                field: {
                  type: 'string',
                  description: '要改的输入字段名。换模型时可省略（按角色取默认字段）。',
                },
                value: { description: '新值：数字、字符串或布尔。' },
              },
              required: ['value'],
              additionalProperties: false,
            },
            description: '要修改的字段列表。',
          },
        },
        required: ['changes'],
        additionalProperties: false,
      },
      execute: guarded('comfyui_plan_workflow_patch', runtime, async (comfy, args) => {
        const workflow = await resolveWorkflow(comfy, args, args.signal)
        requireApiPrompt(workflow)
        // 语义变更先落到具体节点，再走同一套字段校验——两条路径的规则必须一致。
        const changes = resolveSemanticChanges(workflow, args.changes)
        // 只问这份工作流真正用到的节点定义，不拉整份 /object_info。
        const classes = classesInPrompt(workflow)
        const infos = await comfy.getNodeInfos(classes, { signal: args.signal })
        const objectInfo = Object.fromEntries(infos.byClass)
        const plan = planWorkflowPatch({ prompt: workflow, objectInfo, changes })
        return {
          workflow_id: plan.workflow_id,
          changes: plan.changes,
          changed_nodes: plan.changed_nodes,
          node_count_before: plan.node_count_before,
          node_count_after: plan.node_count_after,
          prompt: plan.prompt,
          node_definitions: {
            requested: classes,
            cached: infos.hits,
            fetched: infos.fetched,
            missing: infos.missing,
            failures: infos.failures,
          },
          note: '这只是计划，尚未提交。提交请把 prompt 交给 comfyui_submit_workflow。',
        }
      }),
    },

    {
      name: 'comfyui_submit_workflow',
      description:
        '把一份已经通过校验的 API Prompt 提交给本机 ComfyUI。不会自动搭图，不会覆盖源文件。' +
        '只有 HTTP 200、拿到合法 prompt_id、且 node_errors 为空才算提交成功。' +
        '请求发出后若超时、断连或响应不完整，结果标记为 unknown，绝不自动重发。',
      parameters: {
        type: 'object',
        properties: {
          workflow: { type: 'object', description: '要提交的 API Prompt 对象。' },
          workflow_name: { type: 'string', description: '本地工作流名称，可省略扩展名。' },
          workflow_path: { type: 'string', description: '要提交的 API Prompt 文件路径；与上面两项三选一。' },
        },
        additionalProperties: false,
      },
      execute: guarded('comfyui_submit_workflow', runtime, async (comfy, args) => {
        const workflow = await resolveWorkflow(comfy, args, args.signal)
        requireApiPrompt(workflow)
        const run = await comfy.submit({ prompt: workflow, signal: args.signal })
        return {
          run_id: run.run_id,
          state: run.state,
          prompt_id: run.prompt_id,
          http_status: run.http_status,
          node_errors: run.node_errors,
          message: run.message ?? null,
          error_code: run.error_code ?? null,
          next: nextStepFor(run),
        }
      }),
    },

    {
      name: 'comfyui_get_job',
      description:
        '查询一次生成任务的状态与结果：运行中、已完成、失败或未知。' +
        '完成与否只看 /history 里的实际状态，不因为"进过队列"就当作完成。' +
        '输出图片按 ComfyUI 的 /view 参数给出，不读取任意本地路径。查询由调用触发，不做后台轮询。',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: '提交时返回的 run_id。' },
          prompt_id: { type: 'string', description: 'ComfyUI 的 prompt_id（没有 run_id 时用）。' },
          include_images: { type: 'boolean', description: '是否返回可下载的图片 URL。默认 true。' },
        },
        additionalProperties: false,
      },
      execute: guarded('comfyui_get_job', runtime, async (comfy, args) => {
        if (!args.run_id && !args.prompt_id) {
          const runs = comfy.runs.list()
          return {
            runs: runs.map((run) => ({
              run_id: run.run_id,
              state: run.state,
              prompt_id: run.prompt_id,
              submitted_at: run.submitted_at ?? null,
            })),
            note: '本进程内还没有提交过任务。' + (runs.length === 0 ? '' : ''),
          }
        }
        const run = await comfy.queryJob({
          runId: args.run_id ?? null,
          promptId: args.prompt_id ?? null,
          signal: args.signal,
        })
        const includeImages = args.include_images !== false
        const collected =
          includeImages && run.state === RUN_STATES.COMPLETED
            ? await comfy.collectImages({ run, signal: args.signal })
            : { attachments: [], images: [], diagnostics: [], partial_saved: false }
        return {
          run_id: run.run_id ?? null,
          prompt_id: run.prompt_id ?? null,
          state: run.state ?? RUN_STATES.UNKNOWN,
          message: run.message ?? null,
          attachments: collected.attachments,
          // 保存阶段中途失败时，attachments 里那几张是真的存下来了。
          partial_saved: collected.partial_saved === true,
          images: includeImages
            ? (run.images ?? []).map((image) => ({
                ...image,
                // 引用不合法时给 null，不替调用方拼一个可能越界的链接。
                url: safeUrl(comfy, image),
              }))
            : [],
          diagnostics: collected.diagnostics,
          finished_at: run.finished_at ?? null,
          // 只有 /history 证明完成、且输出里真有可取的图，这里才有内容。
          execution_success: run.execution_success ?? null,
          workflow: run.workflow ?? null,
        }
      }),
      // 浏览器半侧只认这份最小快照：状态、消息、附件引用。
      // 不放 data URL，也不放 base64——图片字节留在 Host 的附件库里。
      presentationMeta: (args, value) => ({
        state: typeof value?.state === 'string' ? value.state : 'unknown',
        message: typeof value?.message === 'string' ? value.message : null,
        images: presentationImages(value?.attachments, value?.images),
      }),
    },

    {
      name: 'comfyui_start',
      description:
        '启动或打开本机 ComfyUI。只有四个固定动作：打开整合包启动器、直接启动后端、打开安装目录、打开 Web UI。' +
        '不接受命令字符串，也不在你没调用它的时候启动任何进程；已经在响应中的实例不会被重复启动，' +
        '用户自己启动的 ComfyUI 也不会被结束。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...LAUNCHER_ACTION_VALUES],
            description:
              'open_launcher 打开整合包启动器；start_backend 直接跑 main.py；' +
              'open_install_folder 打开安装目录；open_web_ui 用系统浏览器打开当前地址。',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: guarded('comfyui_start', runtime, async (comfy, args) =>
        comfy.start({ action: args.action, signal: args.signal }),
      ),
    },
  ]
}

/**
 * 注册六个 ComfyUI 工具。注册失败时回滚已注册的部分。
 *
 * 显式 enabled:false 时一个都不注册：关闭状态下不该出现这六个工具，
 * 也不该因为注册而触发任何发现或连接。
 */
export function registerComfyTools(ctx, runtime) {
  if (runtime?.comfyuiEnabled === false) {
    runtime.logger?.info?.('comfyui.enabled 为 false，跳过注册 ComfyUI 工具。')
    return []
  }
  const disposers = []
  for (const spec of createComfyToolSpecs(runtime)) {
    try {
      disposers.push(registerTool(ctx, spec))
    } catch (error) {
      runtime.logger?.error?.(`注册工具 ${spec.name} 失败`, error)
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (disposeError) {
          runtime.logger?.warn?.('回退已注册的 ComfyUI 工具时出错', disposeError)
        }
      }
      throw error
    }
  }
  return disposers
}
