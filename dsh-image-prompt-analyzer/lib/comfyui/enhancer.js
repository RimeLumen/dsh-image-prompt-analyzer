
import { COMFY_CODES } from './errors.js'
import { isLinkRef, requireApiPrompt } from './workflow.js'

/**
 * Prompt Enhancer 识别。
 *
 * 有些工作流在提示词节点和采样器之间夹了一个"改写"节点：把用户写的话再喂给
 * 一个小模型，扩写、润色、翻译、补细节，然后才进 CLIP。这件事本身没错，
 * 但它会让本插件的产出失去意义——我们交出去的是一段逐词可追溯到 IR 事实的
 * Caption，被改写之后那些词就没人认得了；Layout 的 JSON 更是会被改成一堆散文。
 *
 * 所以这里只做一件事：**认出来，然后说清楚**。不自动删节点，不自动改接线，
 * 不替用户决定要不要保留它——改别人的工作流是另一回事，需要用户点头。
 *
 * 两条判定线索，任一成立就算：
 *   1. 结构：从采样器的 positive 输入往回走，链路里出现了文本节点以外的中间节点。
 *      这条最可靠：它不依赖节点叫什么名字。
 *   2. 名字：class_type 命中已知的改写/LLM 家族。这条是补充——有些改写节点
 *      直接吃字符串、吐字符串，结构上看不出异常，只能靠名字。
 */

/** 已知会改写提示词的节点家族。宁可少认，不要错认：误报会让用户去关一个无关节点。 */
const ENHANCER_PATTERNS = Object.freeze([
  /prompt[\s_-]*enhanc/i,
  /enhanc[\s_-]*prompt/i,
  /prompt[\s_-]*(rewrit|polish|expand|refine|magic|gen)/i,
  /(rewrit|polish|expand|refine)[\s_-]*prompt/i,
  /\bllm\b/i,
  /ollama/i,
  /chatglm|qwen[\s_-]*chat|deepseek|gpt[\s_-]?(4|3|chat|node)/i,
  /text[\s_-]*generat/i,
  // "GenerateText" / "Generate Text"：词序跟 text_generate 相反，上面那条抓不到。
  // 注意 "Generate" 结尾那个 e 不能漏，"generat" + "eText" 是接不上的。
  /generat(e|ing)?[\s_-]*text/i,
  /(^|[^a-z])moss[\s_-]*image[\s_-]*(enhanc|prompt)/i,
])

/**
 * 改写开关藏在节点输入里，而不是另一个节点。
 *
 * MOSS 官方模板把 `enable_prompt_enhancer` / `prompt_enhancer_seed` 直接做成采样
 * 节点上的输入：勾上之后，进模型的提示词在节点内部被改写一遍，图里根本找不到
 * "另一个改写节点"。只看 class_type 的话这种改写是完全隐形的。
 */
const ENHANCER_INPUT_PATTERN = /(^|_)(prompt_)?enhanc(er|ement|e)?(_|$)/i

/** 这些输入说明节点在吃图像——"把原图再发给 LLM"就是从这里发生的。 */
const IMAGE_INPUT_PATTERN = /(^|_)(ref_image|image|images|pixels|input_image)(_|$)/i

/** 文本节点：它们吐出来的就是提示词本身，链路经过它们是正常的。 */
const TEXT_NODE_PATTERN =
  /text[\s_-]*encode|textencode|string|primitive|note|show[\s_-]*text|display|preview[\s_-]*any|previewany/i

const SAMPLER_PATTERN = /^ksampler/i

/**
 * 这个 class_type 是不是"就是提示词本身"的节点。
 * 导出出去是给 prompt-check 用的：报"谁在改写"时不能把文本节点自己也列进去。
 */
export function isTextNodeClass(classType) {
  return typeof classType === 'string' && TEXT_NODE_PATTERN.test(classType)
}

function classOf(node) {
  return typeof node?.class_type === 'string' ? node.class_type : ''
}

/**
 * 这些输入接的不是文字，是模型、权重、图像、采样结果。
 * 顺着它们往上游走只会走到 CheckpointLoaderSimple 这类加载器，
 * 把加载器当成"改写节点"是最典型的误报。
 */
const NON_PROMPT_INPUTS = Object.freeze(
  new Set(['clip', 'vae', 'model', 'clip_vision', 'control_net', 'image', 'images', 'samples', 'latent_image', 'mask', 'pixels']),
)

/** 从某个输入往上游走，只跟提示词那一路，返回经过的节点 id 列表（不含起点）。 */
function traceUpstream(prompt, startId, limit = 24) {
  const chain = []
  const seen = new Set()
  const queue = [String(startId)]
  while (queue.length > 0 && chain.length < limit) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    const node = prompt[id]
    if (!node) continue
    chain.push(id)
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (NON_PROMPT_INPUTS.has(key)) continue
      if (isLinkRef(value)) queue.push(String(value[0]))
    }
  }
  return chain
}

export function detectPromptEnhancers(prompt) {
  requireApiPrompt(prompt)

  const nodes = Object.entries(prompt).map(([id, node]) => ({
    id: String(id),
    class_type: classOf(node),
    inputs: node.inputs ?? {},
  }))

  const found = new Map()
  const add = (node, reason, samplerId, extra = null) => {
    const key = node.id
    const existing = found.get(key)
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
      if (samplerId && !existing.samplers.includes(samplerId)) existing.samplers.push(samplerId)
      if (extra?.input_keys) {
        existing.input_keys = [...new Set([...(existing.input_keys ?? []), ...extra.input_keys])]
      }
      return
    }
    found.set(key, {
      node_id: node.id,
      class_type: node.class_type,
      reasons: [reason],
      samplers: samplerId ? [samplerId] : [],
      ...(extra?.input_keys ? { input_keys: extra.input_keys } : {}),
    })
  }

  // 线索二：名字。全图扫一遍，不限于正稿链路上——负向被改写同样是问题。
  for (const node of nodes) {
    if (ENHANCER_PATTERNS.some((pattern) => pattern.test(node.class_type))) {
      add(node, 'class_type', null)
    }
  }

  // 线索三：改写开关在节点的输入里。名字上看不出任何异常，链路上也没有中间节点，
  // 但勾上之后提示词在节点内部被改写——这是 MOSS 官方模板的实际形态。
  for (const node of nodes) {
    const flags = Object.keys(node.inputs ?? {}).filter((key) => ENHANCER_INPUT_PATTERN.test(key))
    if (flags.length === 0) continue
    add(node, 'input_flag', null, { input_keys: flags })
  }

  // 线索一：结构。从采样器往回走，链路上第一个"既不是文本节点、也不是加载器"的
  // 中间节点就是改写嫌疑。加载器（CLIP / checkpoint）不在这条链上，它们接的是 clip 输入。
  const samplers = nodes.filter((node) => SAMPLER_PATTERN.test(node.class_type))
  const chains = []
  for (const sampler of samplers) {
    for (const role of ['positive', 'negative']) {
      const link = sampler.inputs?.[role]
      if (!isLinkRef(link)) continue
      const targetId = String(link[0])
      const target = prompt[targetId]
      if (!target) continue
      const targetClass = classOf(target)
      const chain = traceUpstream(prompt, targetId).map((id) => ({
        node_id: id,
        class_type: classOf(prompt[id]),
      }))
      chains.push({ sampler_id: sampler.id, role, target: { node_id: targetId, class_type: targetClass }, chain })

      // 直接接在采样器上的不是文本节点 —— 这句话本身就是结论。
      if (!TEXT_NODE_PATTERN.test(targetClass)) {
        add({ id: targetId, class_type: targetClass }, 'inline_before_sampler', sampler.id)
      }
      // 文本节点上游还有别的节点 —— 那个节点在给提示词做加工。
      for (const entry of chain.slice(1)) {
        if (TEXT_NODE_PATTERN.test(entry.class_type)) continue
        if (SAMPLER_PATTERN.test(entry.class_type)) continue
        if (entry.class_type === '') continue
        add({ id: entry.node_id, class_type: entry.class_type }, 'upstream_of_text', sampler.id)
      }
    }
  }

  const enhancers = [...found.values()].map((item) => {
    const inputs = prompt[item.node_id]?.inputs ?? {}
    const imageKeys = Object.keys(inputs).filter((key) => IMAGE_INPUT_PATTERN.test(key))
    // 这个节点自己在吃图像：说明工作流会把原图再送进改写器。
    // 插件自己从不重复传图，但用户有权知道工作流那头会发生什么。
    return { ...item, uses_image_input: imageKeys.length > 0, image_inputs: imageKeys }
  })
  const diagnostics = enhancers.map((item) => ({
    error_code: COMFY_CODES.PROMPT_ENHANCER_DETECTED,
    severity: 'warning',
    node_id: item.node_id,
    field_path: item.input_keys?.length ? `/${item.input_keys[0]}` : '/class_type',
    message:
      `节点 ${item.node_id}（${item.class_type}）看起来会改写提示词` +
      (item.input_keys?.length ? `，改写开关在输入 ${item.input_keys.join('、')} 上` : '') +
      (item.samplers.length > 0 ? `，位于 KSampler ${item.samplers.join('、')} 的提示词链路上` : '') +
      (item.uses_image_input ? `，并且它自己接收图像输入（${item.image_inputs.join('、')}）` : '') +
      '。交给 ComfyUI 的 Caption / Layout 会被它改一遍再进模型。',
    suggested_fix:
      '本插件不会替你改工作流。要用逐词可追溯的 Caption 或 JSON Layout，就在 ComfyUI 里把这个节点旁路掉（把文本节点直连采样器）；' +
      '要保留它，就把插件给的提示词当成"给改写器的输入"，最终画面与 Caption 的对应关系需要自己复核。',
  }))

  return {
    detected: enhancers.length > 0,
    enhancers,
    chains,
    diagnostics,
    note:
      enhancers.length === 0
        ? '提示词链路上没有发现改写节点。'
        : '发现改写节点。插件只报告，不修改工作流，也不会因此重新分析图片。',
  }
}

/**
 * UI 格式（含子图）的改写节点扫描。
 *
 * UI 工作流的连线是 `links` 数组，节点输入只有槽位号，追不出"谁在给提示词做加工"，
 * 所以这里只按节点类型认，不做链路推断——宁可少说，也不能把子图里的普通节点
 * 说成改写器。子图是 MOSS 模板藏东西的地方，所以 `definitions.subgraphs` 也要走一遍。
 */
export function detectUiPromptEnhancers(workflow) {
  const found = new Map()
  const visit = (nodes, scope) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const type = typeof node?.type === 'string' ? node.type : ''
      if (type === '') continue
      if (!ENHANCER_PATTERNS.some((pattern) => pattern.test(type))) continue
      const id = node?.id === undefined || node?.id === null ? '?' : String(node.id)
      const key = `${scope}/${id}`
      if (found.has(key)) continue
      found.set(key, { node_id: id, class_type: type, scope, reasons: ['class_type'] })
    }
  }

  visit(workflow?.nodes, 'root')
  const definitions = workflow?.definitions?.subgraphs
  if (Array.isArray(definitions)) {
    for (const subgraph of definitions) {
      const name = typeof subgraph?.name === 'string' && subgraph.name !== '' ? subgraph.name : 'subgraph'
      visit(subgraph?.nodes, name)
    }
  }

  const enhancers = [...found.values()]
  const subgraphHits = enhancers.filter((item) => item.scope !== 'root').length
  return {
    detected: enhancers.length > 0,
    enhancers,
    chains: [],
    diagnostics: enhancers.map((item) => ({
      error_code: COMFY_CODES.PROMPT_ENHANCER_DETECTED,
      severity: 'warning',
      node_id: item.node_id,
      field_path: '/type',
      message:
        `UI 工作流里发现改写节点 ${item.node_id}（${item.class_type}）` +
        (item.scope === 'root' ? '' : `，位于子图 ${item.scope} 内`) +
        '。UI 格式的连线是槽位号，追不出它接在谁后面。',
      suggested_fix:
        '本插件不会替你改工作流。要用逐词可追溯的 Caption 或 JSON Layout，就在 ComfyUI 里把它旁路掉；' +
        '也可以把这份 UI 工作流另存为 API 格式再检查一次，那样能看清它到底接在哪一段提示词链路上。',
    })),
    note:
      enhancers.length === 0
        ? 'UI 格式只按节点类型扫描，没有发现已知的改写节点。'
        : `UI 格式只按节点类型扫描（含 ${subgraphHits} 个子图命中），不推断链路；要看清接线请用 API 格式。`,
  }
}

/**
 * 官方模板对 ComfyUI 版本有要求：普通 T2I 模板 0.42.0 起，
 * 图像编辑与 Color/Depth Control 模板 0.43.0 起。
 *
 * 插件不升级 ComfyUI，也不假定用户已经升级——只把实际版本报出来，
 * 让用户自己判断"这个模板在我的版本上到底能不能跑"。
 */
export const MOSS_TEMPLATE_MIN_VERSIONS = Object.freeze({
  t2i: '0.42.0',
  edit: '0.43.0',
})

/** 只取前两段数字比较；版本串带 `v`、`-dev`、`+cu121` 这类后缀时也能读。 */
export function parseVersion(value) {
  const match = String(value ?? '').match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  }
  return 0
}

/**
 * 把 `/system_stats` 里的版本信息翻译成"这个模板能不能用"。
 * 版本读不到时给 unknown，不猜。
 */
export function mossTemplateSupport(system) {
  const version = typeof system?.comfyui_version === 'string' ? system.comfyui_version : null
  const check = (min) => {
    const order = compareVersions(version, min)
    if (order === null) return 'unknown'
    return order >= 0 ? 'supported' : 'unsupported'
  }
  return {
    comfyui_version: version,
    t2i: { required: MOSS_TEMPLATE_MIN_VERSIONS.t2i, status: check(MOSS_TEMPLATE_MIN_VERSIONS.t2i) },
    edit: { required: MOSS_TEMPLATE_MIN_VERSIONS.edit, status: check(MOSS_TEMPLATE_MIN_VERSIONS.edit) },
    note:
      version === null
        ? '当前 ComfyUI 没有回报版本号，无法判断官方 MOSS 模板是否支持；插件不会替你升级。'
        : '插件不会升级 ComfyUI，也不会自动导入官方 UI 工作流。',
  }
}
