
import { COMFY_CODES, ComfyError } from './errors.js'
import { envelope, fromException, TASK_STATUS } from '../diagnostics.js'
import { registerTool } from '../tools/registry.js'
import { filterByStates, reconcileModels } from './reconcile.js'
import { inspectWorkflow, requireApiPrompt } from './workflow.js'
import { applyWorkflowPatch, planWorkflowPatch } from './patch.js'
import { RUN_STATES } from './runs.js'

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
  throw new ComfyError(
    COMFY_CODES.VALIDATION_FAILED,
    '需要提供 workflow（对象）或 workflow_path（文件路径）之一。',
  )
}

function guarded(toolName, runtime, impl, { requiresEnabled = true } = {}) {
  return async (args, exec) => {
    try {
      const comfy = await runtime.getComfyUI()
      // 未启用时先拦下来：参数校验、文件解析、网络请求一个都不该发生，
      // 否则用户会拿到"参数不对"这种与真实原因无关的报错。
      if (requiresEnabled) comfy.ensureEnabled()
      const signal = args?.signal ?? exec?.signal ?? null
      return await impl(comfy, signal ? { ...(args ?? {}), signal } : (args ?? {}))
    } catch (error) {
      runtime.logger?.error?.(`工具 ${toolName} 执行失败`, error)
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
          const status = await comfy.status({ signal: args.signal })
          return { ...described, ...status, reachable: true }
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
        try {
          const client = comfy.getClient()
          models = await client.getModels({ signal: args.signal })
          runtimeAvailable = true
          loaderEnums = {}
          for (const node of ['CheckpointLoaderSimple', 'LoraLoader', 'VAELoader']) {
            const info = await client.getObjectInfoFor(node, { signal: args.signal }).catch(() => null)
            if (info) loaderEnums[node] = info
          }
        } catch {
          // 连不上就如实记 unknown，不把"没启动"写成"运行时不可见"。
          runtimeAvailable = false
        }

        const reconciled = reconcileModels({
          entries: scanned.entries,
          models,
          loaderEnums,
          runtimeAvailable,
        })

        let entries = reconciled.entries
        if (typeof args.category === 'string' && args.category !== '') {
          entries = entries.filter((entry) => entry.category === args.category)
        }
        if (typeof args.name_contains === 'string' && args.name_contains !== '') {
          const needle = args.name_contains.toLowerCase()
          entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle))
        }
        if (args.states && typeof args.states === 'object') {
          entries = filterByStates(entries, args.states)
        }

        const limit = args.limit ?? 200
        return {
          total: entries.length,
          returned: Math.min(limit, entries.length),
          entries: entries.slice(0, limit),
          virtual_entries: reconciled.virtual,
          categories: scanned.categories,
          roots: scanned.roots,
          partial: scanned.partial,
          runtime_available: runtimeAvailable,
          diagnostics: [...scanned.diagnostics, ...reconciled.diagnostics],
        }
      }),
    },

    {
      name: 'comfyui_inspect_workflow',
      description:
        '读取并检查一份工作流：识别是 UI Workflow 还是 API Prompt，列出节点、输入、连接与不支持项。' +
        'UI 格式只做只读检查，首版不转换成 API 格式；正负提示词按 KSampler 的连接判定，不按节点顺序猜。',
      parameters: {
        type: 'object',
        properties: {
          workflow_path: { type: 'string', description: '工作流 JSON 的绝对路径。' },
          workflow: { type: 'object', description: '直接传入工作流对象；与 workflow_path 二选一。' },
        },
        additionalProperties: false,
      },
      execute: guarded('comfyui_inspect_workflow', runtime, async (comfy, args) => {
        const workflow = await resolveWorkflow(comfy, args, args.signal)
        const report = inspectWorkflow(workflow)
        if (report.format !== 'api') return report
        const { analyzeBindings } = await import('./bindings.js')
        return { ...report, bindings: analyzeBindings(workflow) }
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
          workflow_path: { type: 'string', description: 'API Prompt JSON 的绝对路径。' },
          workflow: { type: 'object', description: '直接传入 API Prompt 对象；与 workflow_path 二选一。' },
          changes: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                node_id: { type: 'string', description: '目标节点 ID。' },
                field: { type: 'string', description: '要改的输入字段名。' },
                value: { description: '新值：数字、字符串或布尔。' },
              },
              required: ['node_id', 'field', 'value'],
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
        const client = comfy.getClient()
        const objectInfo = await client.getObjectInfo({ signal: args.signal })
        const plan = planWorkflowPatch({ prompt: workflow, objectInfo, changes: args.changes })
        return {
          workflow_id: plan.workflow_id,
          changes: plan.changes,
          changed_nodes: plan.changed_nodes,
          node_count_before: plan.node_count_before,
          node_count_after: plan.node_count_after,
          prompt: plan.prompt,
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
          workflow_path: { type: 'string', description: '要提交的 API Prompt 文件路径；与 workflow 二选一。' },
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
          next: run.prompt_id
            ? `用 comfyui_get_job 查询 ${run.prompt_id} 的执行结果。`
            : '提交结果未知，请勿重复提交；先确认 ComfyUI 队列里有没有这次任务。',
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
            : { attachments: [], images: [], diagnostics: [] }
        return {
          run_id: run.run_id ?? null,
          prompt_id: run.prompt_id ?? null,
          state: run.state ?? RUN_STATES.UNKNOWN,
          message: run.message ?? null,
          attachments: collected.attachments,
          images: includeImages
            ? (run.images ?? []).map((image) => ({
                ...image,
                url: comfy.imageViewUrl(image),
              }))
            : [],
          diagnostics: collected.diagnostics,
          finished_at: run.finished_at ?? null,
        }
      }),
    },
  ]
}

/** 注册六个 ComfyUI 工具。注册失败时回滚已注册的部分。 */
export function registerComfyTools(ctx, runtime) {
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
