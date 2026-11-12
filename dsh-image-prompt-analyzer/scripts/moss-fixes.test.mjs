// 三项修正的针对性验收：局部修改、多人关系、提交文本。
//
// 这里的每一条都打在生产入口上：
//   局部修改 → runReviseCaption（工具入口）→ reviseCaption
//   多人关系 → compilePrompt（IR → Caption）
//   提交文本 → planWorkflowPatch → applyWorkflowPatch → submitPrompt → client.postJson
//              → JSON.stringify → 注入的 fetchImpl 截获请求体
//
// 不调用视觉模型、不连真实 ComfyUI、不提交生图任务。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { compilePrompt } from '../lib/compile/index.js'
import { reviseCaption, REVISE_CODES } from '../lib/compile/revise.js'
import { runReviseCaption } from '../lib/tools/impl/revise-caption.js'
import { createIR, addFeature, addEntity, addEntityFeature, addRelation, finalizeIR } from '../lib/ir/build.js'
import { createConfigStore } from '../lib/config/loader.js'
import { checkPromptDelivery } from '../lib/comfyui/prompt-check.js'
import { planWorkflowPatch, applyWorkflowPatch } from '../lib/comfyui/patch.js'
import { createComfyClient } from '../lib/comfyui/client.js'
import { submitPrompt, RUN_STATES } from '../lib/comfyui/runs.js'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SILENT = { debug() {}, info() {}, warn() {}, error() {} }

async function loadStore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-fixes-'))
  const store = createConfigStore({ configDir: join(PACKAGE_DIR, 'configs'), dataDir, logger: null })
  await store.get()
  const entry = store.getModelProfile('moss')
  assert.ok(entry, 'moss 档案没有加载出来')
  return { store, profile: entry.config, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) }
}

// ── 一. 局部修改 ──────────────────────────────────────────────────────────

test('局部修改：单人只改外套颜色，替换片段之外逐字不动', async () => {
  const { store, cleanup } = await loadStore()
  try {
    const original = '一名成年女性穿着深蓝色长外套，站在车站雨棚下。她的右手握着收拢的白色雨伞。'
    const out = await runReviseCaption({ getConfigStore: async () => store, pluginConfig: {} }, {
      target_profile: 'moss',
      original,
      instruction: '只把外套颜色从深蓝改成酒红',
    })
    assert.equal(out.status, 'ok')
    assert.equal(out.positive, '一名成年女性穿着酒红色长外套，站在车站雨棚下。她的右手握着收拢的白色雨伞。')
    // 服装类型没有被顺手改掉：还是「长外套」，不是「风衣」。
    assert.match(out.positive, /酒红色长外套/)
    assert.ok(!out.positive.includes('风衣'))
    // 替换片段之外完全一致。
    const { at, length, to } = out.changed
    assert.equal(out.positive.slice(0, at), original.slice(0, at))
    assert.equal(out.positive.slice(at + to.length), original.slice(at + length))
    assert.equal(out.changed.count, 1)
  } finally {
    cleanup()
  }
})

test('局部修改：两人只改被点名的那一位', async () => {
  const { store, cleanup } = await loadStore()
  try {
    const original = '银发的女人穿着深蓝色长外套。黑发的女人也穿着深蓝色长外套。'
    const out = await runReviseCaption({ getConfigStore: async () => store, pluginConfig: {} }, {
      target_profile: 'moss',
      original,
      instruction: '只把银发女人外套的颜色从深蓝改成酒红',
    })
    assert.equal(out.status, 'ok')
    assert.match(out.positive, /^银发的女人穿着酒红色长外套。/)
    assert.match(out.positive, /黑发的女人也穿着深蓝色长外套。$/)
  } finally {
    cleanup()
  }
})

test('局部修改：同一个颜色出现在背景和服装上时只改服装', async () => {
  const { store, cleanup } = await loadStore()
  try {
    const original = '她穿着深蓝色长外套。身后的天空也是深蓝色。'
    const out = await runReviseCaption({ getConfigStore: async () => store, pluginConfig: {} }, {
      target_profile: 'moss',
      original,
      instruction: '只把外套颜色从深蓝改成酒红',
    })
    assert.equal(out.status, 'ok')
    assert.equal(out.positive, '她穿着酒红色长外套。身后的天空也是深蓝色。')
    assert.equal(out.changed.count, 1)
  } finally {
    cleanup()
  }
})

test('局部修改：目标不唯一时不动手，把候选交回去要求指明', async () => {
  const { store, cleanup } = await loadStore()
  try {
    const original = '银发的女人穿着深蓝色长外套。黑发的女人也穿着深蓝色长外套。'
    const out = await runReviseCaption({ getConfigStore: async () => store, pluginConfig: {} }, {
      target_profile: 'moss',
      original,
      instruction: '只把外套颜色从深蓝改成酒红',
    })
    assert.equal(out.status, 'failed')
    assert.ok(out.diagnostics.some((item) => item.error_code === REVISE_CODES.TARGET_AMBIGUOUS))
    // 一个字都没改：不任选一位，也不两位都改。
    assert.equal(out.positive, original)
    assert.equal(out.candidates.length, 2)
    assert.match(out.candidates[0].clause, /银发/)
    assert.match(out.candidates[1].clause, /黑发/)
  } finally {
    cleanup()
  }
})

test('局部修改：原文没写这个属性时不把替换变成新增设定', async () => {
  const { store, cleanup } = await loadStore()
  try {
    const original = '一名成年女性穿着长外套，站在车站雨棚下。'
    const out = await runReviseCaption({ getConfigStore: async () => store, pluginConfig: {} }, {
      target_profile: 'moss',
      original,
      instruction: '只把外套颜色从深蓝改成酒红',
    })
    assert.equal(out.status, 'failed')
    assert.ok(out.diagnostics.some((item) => item.error_code === REVISE_CODES.VALUE_ABSENT))
    assert.equal(out.positive, original, '不许把「没有颜色」补成「酒红色」')
  } finally {
    cleanup()
  }
})

test('局部修改：只给目标值、没给旧值时拒绝猜', async () => {
  const { store, cleanup } = await loadStore()
  try {
    const original = '她穿着深蓝色长外套。'
    const out = await runReviseCaption({ getConfigStore: async () => store, pluginConfig: {} }, {
      target_profile: 'moss',
      original,
      instruction: '把外套改成酒红色',
    })
    assert.equal(out.status, 'failed')
    assert.ok(out.diagnostics.some((item) => item.error_code === REVISE_CODES.FROM_REQUIRED))
    assert.equal(out.positive, original)
  } finally {
    cleanup()
  }
})

test('局部修改：英文指令同样只动颜色', async () => {
  const { profile, cleanup } = await loadStore()
  try {
    const original = 'A woman wears a navy long coat. She stands under a canopy.'
    const out = reviseCaption({
      target_profile: 'moss',
      original,
      instruction: 'change the coat color from navy to burgundy',
      profile,
    })
    assert.equal(out.ok, true)
    assert.equal(out.text, 'A woman wears a burgundy long coat. She stands under a canopy.')
  } finally {
    cleanup()
  }
})

// ── 二. 多人关系 ──────────────────────────────────────────────────────────

/** 用户给的反例：伞在 P2 手上，行李箱在 P1 脚边，两人发色可辨。 */
function trapIR({ silverFirst = false } = {}) {
  const ir = createIR({
    taskId: 'moss-trap',
    image: { width: 1024, height: 1024, source: 'fixture' },
    provenance: { stage: 'fixture' },
  })
  const person = (hair, clothing) => {
    const entity = addEntity(ir, { kind: 'person', label: 'woman', confidence: 0.9 })
    addEntityFeature(ir, entity.entity_id, 'appearance', 'hair_color', { value: hair })
    addEntityFeature(ir, entity.entity_id, 'clothing', 'outerwear', { value: clothing })
    return entity
  }
  const black = silverFirst ? null : person('black hair', 'navy long coat')
  const silver = person('silver hair', 'grey cardigan')
  const blackFinal = black ?? person('black hair', 'navy long coat')
  const umbrella = addEntity(ir, { kind: 'object', label: 'umbrella', confidence: 0.85 })
  const suitcase = addEntity(ir, { kind: 'object', label: 'suitcase', confidence: 0.8 })
  addRelation(ir, {
    type: 'holding',
    from: silver.entity_id,
    to: umbrella.entity_id,
    description: 'right hand holds the folded white umbrella',
    confidence: 0.9,
  })
  addRelation(ir, {
    type: 'placed_at',
    from: suitcase.entity_id,
    to: blackFinal.entity_id,
    description: 'a brown suitcase rests by her feet',
    confidence: 0.8,
  })
  addFeature(ir, 'background', 'setting', { value: 'station canopy' })
  return finalizeIR(ir)
}

test('多人关系：伞归银发那位、行李箱归黑发那位，两句各自点名', async () => {
  const { profile, cleanup } = await loadStore()
  try {
    const out = await compilePrompt({ ir: trapIR(), profile, includeNegative: false })
    assert.equal(out.caption.complete, true)
    assert.match(out.prompts.positive, /The silver-haired woman's right hand holds the folded white umbrella\./)
    assert.match(out.prompts.positive, /A brown suitcase rests by the black-haired woman's feet\./)
    assert.equal(out.caption.grounding.ok, true)
  } finally {
    cleanup()
  }
})

test('多人关系：调换人物描述顺序后，归属不跟着换', async () => {
  const { profile, cleanup } = await loadStore()
  try {
    const out = await compilePrompt({ ir: trapIR({ silverFirst: true }), profile, includeNegative: false })
    assert.match(out.prompts.positive, /The silver-haired woman's right hand holds the folded white umbrella\./)
    assert.match(out.prompts.positive, /A brown suitcase rests by the black-haired woman's feet\./)
    assert.equal(out.caption.grounding.ok, true)
  } finally {
    cleanup()
  }
})

test('多人关系：一人把东西递给另一人时，执行者与接收者不互换', async () => {
  const { profile, cleanup } = await loadStore()
  try {
    const ir = createIR({
      taskId: 'moss-handoff',
      image: { width: 1024, height: 1024, source: 'fixture' },
      provenance: { stage: 'fixture' },
    })
    const black = addEntity(ir, { kind: 'person', label: 'woman', confidence: 0.9 })
    addEntityFeature(ir, black.entity_id, 'appearance', 'hair_color', { value: 'black hair' })
    const silver = addEntity(ir, { kind: 'person', label: 'woman', confidence: 0.9 })
    addEntityFeature(ir, silver.entity_id, 'appearance', 'hair_color', { value: 'silver hair' })
    const fan = addEntity(ir, { kind: 'object', label: 'fan', confidence: 0.8 })
    addRelation(ir, {
      type: 'handing',
      from: black.entity_id,
      to: silver.entity_id,
      description: 'hands her folded fan to her',
      confidence: 0.8,
    })
    const out = await compilePrompt({ ir: finalizeIR(ir), profile, includeNegative: false })
    assert.match(out.prompts.positive, /The black-haired woman hands her folded fan to the silver-haired woman\./)
    assert.ok(!/silver-haired woman hands/.test(out.prompts.positive), '接收者不能被写成执行者')
    assert.ok(fan, 'fan 实体存在但不参与关系句的称呼')
  } finally {
    cleanup()
  }
})

test('多人关系：四个人各自的外观与关键关系都保留，不静默丢第四个人', async () => {
  const { profile, cleanup } = await loadStore()
  try {
    const ir = createIR({
      taskId: 'moss-four',
      image: { width: 1024, height: 1024, source: 'fixture' },
      provenance: { stage: 'fixture' },
    })
    const people = [
      ['black hair', 'navy coat', 'right hand holds a paper cup'],
      ['silver hair', 'grey cardigan', 'left hand holds a paper bag'],
      ['blonde hair', 'red scarf', 'right hand holds a small camera'],
      ['brown hair', 'green jacket', 'both hands hold an open book'],
    ].map(([hair, clothing, action]) => {
      const entity = addEntity(ir, { kind: 'person', label: 'woman', confidence: 0.9 })
      addEntityFeature(ir, entity.entity_id, 'appearance', 'hair_color', { value: hair })
      addEntityFeature(ir, entity.entity_id, 'clothing', 'outerwear', { value: clothing })
      const object = addEntity(ir, { kind: 'object', label: 'prop', confidence: 0.8 })
      addRelation(ir, {
        type: 'holding',
        from: entity.entity_id,
        to: object.entity_id,
        description: action,
        confidence: 0.8,
      })
      return { entity, action }
    })
    const out = await compilePrompt({ ir: finalizeIR(ir), profile, includeNegative: false, detailLevel: 'high' })
    for (const [hair] of [['black hair'], ['silver hair'], ['blonde hair'], ['brown hair']]) {
      assert.match(out.prompts.positive, new RegExp(hair.replace(' hair', '-haired')), `缺 ${hair} 的外观`)
    }
    for (const person of people) {
      const core = person.action.replace(/^(left|right|both) hand(s)? /, '')
      assert.ok(
        out.prompts.positive.includes(core),
        `缺一条关键关系：${person.action}`,
      )
    }
    assert.equal(out.caption.complete, true)
    assert.deepEqual(out.caption.omitted.relations, [])
  } finally {
    cleanup()
  }
})

test('多人关系：预算真的不够时明确报告不完整并列出省略项', async () => {
  const { profile, cleanup } = await loadStore()
  try {
    const ir = createIR({
      taskId: 'moss-budget',
      image: { width: 1024, height: 1024, source: 'fixture' },
      provenance: { stage: 'fixture' },
    })
    for (const [hair, clothing, action] of [
      ['black hair', 'navy coat', 'right hand holds a paper cup'],
      ['silver hair', 'grey cardigan', 'left hand holds a paper bag'],
      ['blonde hair', 'red scarf', 'right hand holds a small camera'],
      ['brown hair', 'green jacket', 'both hands hold an open book'],
    ]) {
      const entity = addEntity(ir, { kind: 'person', label: 'woman', confidence: 0.9 })
      addEntityFeature(ir, entity.entity_id, 'appearance', 'hair_color', { value: hair })
      addEntityFeature(ir, entity.entity_id, 'clothing', 'outerwear', { value: clothing })
      const object = addEntity(ir, { kind: 'object', label: 'prop', confidence: 0.8 })
      addRelation(ir, {
        type: 'holding',
        from: entity.entity_id,
        to: object.entity_id,
        description: action,
        confidence: 0.8,
      })
    }
    const out = await compilePrompt({ ir: finalizeIR(ir), profile, includeNegative: false, detailLevel: 'minimal' })
    assert.equal(out.caption.complete, false)
    assert.ok(out.caption.omitted.relations.length > 0, '省略了哪些关系必须列出来')
    assert.ok(
      out.diagnostics.some((item) => item.error_code === 'COMPILE_MOSS_CAPTION_TRUNCATED'),
      '不完整时必须给出明确状态，不能报成功',
    )
  } finally {
    cleanup()
  }
})

test('多人关系：缺少识别特征时不虚构发色、服装或左右位置', async () => {
  const { profile, cleanup } = await loadStore()
  try {
    const ir = createIR({
      taskId: 'moss-nofeature',
      image: { width: 1024, height: 1024, source: 'fixture' },
      provenance: { stage: 'fixture' },
    })
    const first = addEntity(ir, { kind: 'person', label: 'woman', confidence: 0.9 })
    const second = addEntity(ir, { kind: 'person', label: 'woman', confidence: 0.9 })
    addEntityFeature(ir, first.entity_id, 'clothing', 'top', { value: 'white shirt' })
    const bag = addEntity(ir, { kind: 'object', label: 'bag', confidence: 0.8 })
    addRelation(ir, {
      type: 'holding',
      from: second.entity_id,
      to: bag.entity_id,
      description: 'left hand holds a paper bag',
      confidence: 0.8,
    })
    const out = await compilePrompt({ ir: finalizeIR(ir), profile, includeNegative: false })
    assert.ok(!/-haired/.test(out.prompts.positive), `不许编发色：${out.prompts.positive}`)
    assert.match(out.prompts.positive, /The other woman's left hand holds a paper bag\./)
  } finally {
    cleanup()
  }
})

// ── 三. 提交文本 ──────────────────────────────────────────────────────────

function workflowWith({ positiveText, negativeText = 'worst quality', enhancer = false }) {
  const prompt = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'moss.safetensors' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: positiveText, clip: ['1', 1] } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: negativeText, clip: ['1', 1] } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    6: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: [enhancer ? '3' : '2', 0],
        negative: ['4', 0],
        latent_image: ['5', 0],
        seed: 1,
        steps: 50,
        cfg: 3,
        sampler_name: 'euler',
        scheduler: 'sgm_uniform',
        denoise: 1,
      },
    },
    7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'moss' } },
  }
  if (enhancer) prompt[3] = { class_type: 'PromptEnhancer', inputs: { text: ['2', 0], seed: 7 } }
  return prompt
}

/** 只够校验 CLIPTextEncode.text 的节点 Schema；不联网。 */
function objectInfoStub() {
  return {
    CLIPTextEncode: { input: { required: { text: ['STRING', {}] } } },
  }
}

/** 截获最终请求体的传输层：生产代码自己做 JSON.stringify，这里只收字符串。 */
function capturingTransport() {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body })
    const payload = JSON.stringify({ prompt_id: randomUUID(), number: 1, node_errors: {} })
    const bytes = new TextEncoder().encode(payload)
    return {
      status: 200,
      ok: true,
      body: {
        getReader() {
          let done = false
          return {
            async read() {
              if (done) return { done: true, value: undefined }
              done = true
              return { done: false, value: bytes }
            },
            async cancel() {},
            releaseLock() {},
          }
        },
      },
    }
  }
  return { calls, fetchImpl }
}

function clientFor(transport) {
  return createComfyClient({
    baseUrl: 'http://127.0.0.1:8188',
    fetchImpl: transport.fetchImpl,
    env: {},
  })
}

test('提交文本：补丁改过的提示词，发出去的就是改过的那一版', async () => {
  const oldText = 'A woman in a navy coat holds a closed white umbrella.'
  const newText = 'A woman in a burgundy coat holds a closed white umbrella.'
  const prompt = workflowWith({ positiveText: oldText })
  const plan = planWorkflowPatch({
    prompt,
    objectInfo: objectInfoStub(),
    changes: [{ node_id: '2', field: 'text', value: newText }],
  })
  const patched = applyWorkflowPatch({ plan, prompt })

  const transport = capturingTransport()
  const run = await submitPrompt({ client: clientFor(transport), prompt: patched })
  assert.equal(run.state, RUN_STATES.ACCEPTED)

  assert.equal(transport.calls.length, 1)
  const sent = JSON.parse(transport.calls[0].body)
  // 解码后比对：不要求 JSON 空白或转义写法一致。
  assert.equal(sent.prompt['2'].inputs.text, newText)
  assert.equal(sent.prompt['2'].inputs.text === oldText, false, '不许回退到旧稿')

  const check = checkPromptDelivery(sent.prompt, { expectedPositive: newText })
  assert.equal(check.final_text_known, true)
  const positive = check.checks.find((item) => item.side === 'positive')
  assert.equal(positive.final_text, newText)
  assert.equal(positive.comparison.matches, true)
  assert.deepEqual(check.diagnostics, [])
})

test('提交文本：中文、换行、引号、反斜杠在编解码后保持一致', async () => {
  const caption = '一名女性穿着酒红色长外套，站在车站雨棚下。\n她说"这班车晚点了"，雨伞柄上刻着 C:\\temp\\umbrella。'
  const transport = capturingTransport()
  const run = await submitPrompt({
    client: clientFor(transport),
    prompt: workflowWith({ positiveText: caption }),
  })
  assert.equal(run.state, RUN_STATES.ACCEPTED)
  const sent = JSON.parse(transport.calls[0].body)
  assert.equal(sent.prompt['2'].inputs.text, caption)
  const check = checkPromptDelivery(sent.prompt, { expectedPositive: caption })
  assert.equal(check.checks.find((item) => item.side === 'positive').comparison.matches, true)
})

test('提交文本：链路上有改写节点时归为无法确认，不计入一致', async () => {
  const transport = capturingTransport()
  const caption = 'A woman holds a closed white umbrella.'
  const run = await submitPrompt({
    client: clientFor(transport),
    prompt: workflowWith({ positiveText: caption, enhancer: true }),
  })
  assert.equal(run.state, RUN_STATES.ACCEPTED)
  const sent = JSON.parse(transport.calls[0].body)
  const check = checkPromptDelivery(sent.prompt, { expectedPositive: caption })
  assert.equal(check.final_text_known, false)
  const positive = check.checks.find((item) => item.side === 'positive')
  assert.equal(positive.final_text, null)
  assert.equal(positive.comparison.compared, false)
  assert.deepEqual(positive.rewritten_by, ['3'])
})

test('提交文本：没接到采样器的文本节点不算数', async () => {
  const caption = 'A woman holds a closed white umbrella.'
  const prompt = workflowWith({ positiveText: caption })
  prompt[9] = { class_type: 'CLIPTextEncode', inputs: { text: 'an unrelated stray prompt', clip: ['1', 1] } }

  const transport = capturingTransport()
  const run = await submitPrompt({ client: clientFor(transport), prompt })
  assert.equal(run.state, RUN_STATES.ACCEPTED)
  const sent = JSON.parse(transport.calls[0].body)
  assert.equal(sent.prompt['9'].inputs.text, 'an unrelated stray prompt', '未连接的节点照原样发出')

  const check = checkPromptDelivery(sent.prompt, { expectedPositive: caption })
  const positive = check.checks.find((item) => item.side === 'positive')
  assert.equal(positive.text_node.node_id, '2')
  assert.equal(positive.comparison.matches, true)
})

test('提交文本：发出去的与预期不一致时能指出第一个差异位置', async () => {
  const expected = 'A woman in a navy coat holds a closed white umbrella.'
  const actual = 'A woman in a navy coat holds an open white umbrella.'
  const transport = capturingTransport()
  await submitPrompt({ client: clientFor(transport), prompt: workflowWith({ positiveText: actual }) })
  const sent = JSON.parse(transport.calls[0].body)
  const check = checkPromptDelivery(sent.prompt, { expectedPositive: expected })
  const positive = check.checks.find((item) => item.side === 'positive')
  assert.equal(positive.comparison.matches, false)
  assert.equal(positive.comparison.reason, 'content_differs')
  assert.equal(positive.comparison.first_difference_at, 30)
})
