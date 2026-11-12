// MOSS-Image 自然语言提示词回归样例。
//
// 覆盖两类入口和一条交付核对：
//   A. 图片反推（IR → Caption）：关系、归属、词表未命中的观察都不能丢；
//   B. 自然语言需求（brief → Caption）：中英文、质量词、Layout JSON、信息不足；
//   C. 工作流实际接收的文本（API Prompt → 采样器）：一致、不一致、被改写。
//
// 这里只验证「文本格式与事实保存」，不判断画面好不好看。生图效果要另开
// 实验，不能用词表命中率或文本覆盖率代替。
//
// 官方依据（本文件里每条断言对应哪一条）：
//   - 普通场景用 caption，不自动上 Layout：skills/moss-image-prompt-enhancer/SKILL.md
//     "A detailed image does not automatically need Layout."
//   - 负向只要官方那几条：USERGUIDE.md "Negative Prompt"
//   - 质量词属于冗余：SKILL.md "Avoid redundant quality tags"
//   - 语言在分析阶段之前定：USERGUIDE.md "Language"（推荐英文，中文也支持）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compilePrompt } from '../lib/compile/index.js'
import { composeCaptionFromBrief, BRIEF_CODES, detectBriefLanguage } from '../lib/compile/brief.js'
import { MOSS_NEGATIVE_BASE } from '../lib/compile/moss.js'
import { createIR, addFeature, addEntity, addEntityFeature, addRelation, finalizeIR } from '../lib/ir/build.js'
import { createConfigStore } from '../lib/config/loader.js'
import { checkPromptDelivery } from '../lib/comfyui/prompt-check.js'
import { COMFY_CODES } from '../lib/comfyui/errors.js'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

async function loadMoss() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-moss-'))
  const store = createConfigStore({ configDir: join(PACKAGE_DIR, 'configs'), dataDir, logger: null })
  await store.get()
  const entry = store.getModelProfile('moss')
  assert.ok(entry, 'moss 档案没有加载出来')
  return { profile: entry.config, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) }
}

/** 两个人、各持一物、一物在地面：关系句最容易被写错的一组。 */
function twoPeopleIR({ language = 'en' } = {}) {
  const ir = createIR({
    taskId: 'moss-regression',
    image: { width: 1024, height: 1024, source: 'fixture' },
    provenance: { stage: 'fixture' },
    observationLanguage: language,
  })
  const woman = addEntity(ir, { kind: 'person', label: 'woman', confidence: 0.9 })
  addEntityFeature(ir, woman.entity_id, 'appearance', 'hair_color', { value: 'silver hair' })
  addEntityFeature(ir, woman.entity_id, 'clothing', 'outerwear', { value: 'navy long coat' })
  const man = addEntity(ir, { kind: 'person', label: 'man', confidence: 0.8 })
  addEntityFeature(ir, man.entity_id, 'appearance', 'hair_color', { value: 'black hair' })
  addEntityFeature(ir, man.entity_id, 'clothing', 'top', { value: 'grey hoodie' })

  const umbrella = addEntity(ir, { kind: 'object', label: 'umbrella', confidence: 0.85 })
  const suitcase = addEntity(ir, { kind: 'object', label: 'suitcase', confidence: 0.8 })

  addRelation(ir, {
    type: 'holding',
    from: woman.entity_id,
    to: umbrella.entity_id,
    description: 'right hand holds a closed white umbrella',
    confidence: 0.9,
  })
  addRelation(ir, {
    type: 'placed_at',
    from: suitcase.entity_id,
    to: woman.entity_id,
    description: 'a brown suitcase rests by her feet',
    confidence: 0.8,
  })
  addFeature(ir, 'background', 'setting', { value: 'station canopy' })
  addFeature(ir, 'lighting', 'quality', { value: 'overcast daylight' })
  return finalizeIR(ir)
}

// ── A. 图片反推 ────────────────────────────────────────────────────────────

test('反推：默认只交一段 Caption，正向里没有标签流也没有 Layout JSON', async () => {
  const { profile, cleanup } = await loadMoss()
  try {
    const out = await compilePrompt({ ir: twoPeopleIR(), profile, includeNegative: true })
    assert.equal(out.register, 'caption')
    assert.equal(out.output_contract.word_style, 'caption')
    assert.equal(out.output_contract.positive_is_natural_language, true)
    assert.equal(out.output_contract.tags_in_positive, false)
    assert.equal(out.output_contract.layout_in_positive, false)
    assert.equal(out.layout, null, '没要 Layout 时必须是 null，不是空对象')
    // 标签版仍在 slots 里可回查，但它没有进正向提示词。
    assert.ok(out.output_contract.tags_available_separately)
    assert.ok(!out.prompts.positive.includes('1girl'), '正向里不该出现标签写法')
    assert.match(out.prompts.positive, /\.\s/)
  } finally {
    cleanup()
  }
})

test('反推：词表里没有的观察照样进 Caption，只按语言/否定/占位过滤', async () => {
  const { profile, cleanup } = await loadMoss()
  try {
    const ir = createIR({
      taskId: 'moss-unknown-tag',
      image: { width: 1024, height: 1024, source: 'fixture' },
      provenance: { stage: 'fixture' },
    })
    const subject = addEntity(ir, { kind: 'person', label: 'woman', confidence: 0.9 })
    // 这个词在三个词表里都不存在：它必须还能进 Caption。
    addEntityFeature(ir, subject.entity_id, 'appearance', 'hair_color', { value: 'moonlit teal hair' })
    addRelation(ir, {
      type: 'holding',
      from: subject.entity_id,
      to: subject.entity_id,
      description: 'her left hand rests on a brass telescope',
      confidence: 0.7,
    })
    const out = await compilePrompt({ ir: finalizeIR(ir), profile, includeNegative: false })
    assert.equal(out.register, 'caption')
    assert.match(out.prompts.positive, /moonlit teal hair/i, '词表未命中不等于观察无效')
    assert.match(out.prompts.positive, /brass telescope/i)
  } finally {
    cleanup()
  }
})

test('反推：两个人的动作各自归位，不会都算到主体头上', async () => {
  const { profile, cleanup } = await loadMoss()
  try {
    const out = await compilePrompt({ ir: twoPeopleIR(), profile, includeNegative: false })
    const positive = out.prompts.positive
    const otherClause = out.caption.clauses.find((clause) => clause.role === 'other_subject')
    assert.ok(otherClause, '第二个人应当有自己的句子')
    assert.match(otherClause.text, /black hair/i, '第二个人的外观不该写进主体那句')
    const subjectClause = out.caption.clauses.find((clause) => clause.role === 'subject')
    assert.ok(!/black hair/i.test(subjectClause.text))
    // 主体那句只写主体的外观。
    assert.match(subjectClause.text, /silver hair/i)
    // 关系句必须点名是谁的手。
    assert.match(positive, /woman's right hand holds/i)
  } finally {
    cleanup()
  }
})

test('反推：负向只有官方那几条，且不与正向自相矛盾', async () => {
  const { profile, cleanup } = await loadMoss()
  try {
    const out = await compilePrompt({ ir: twoPeopleIR(), profile, includeNegative: true })
    const terms = out.prompts.negative.split(', ')
    for (const term of terms) {
      assert.ok(MOSS_NEGATIVE_BASE.includes(term), `负向里出现了官方基线以外的词：${term}`)
    }
    assert.ok(!terms.some((term) => out.prompts.positive.toLowerCase().includes(term.toLowerCase())))
  } finally {
    cleanup()
  }
})

test('反推：中文 Caption 与观察语言一致时才输出，不一致是硬失败而不是翻译', async () => {
  const { profile, cleanup } = await loadMoss()
  try {
    const zh = await compilePrompt({
      ir: twoPeopleIR({ language: 'zh-CN' }),
      profile,
      includeNegative: false,
      captionLanguage: 'zh-CN',
    })
    assert.equal(zh.caption.language, 'zh-CN')
    assert.match(zh.prompts.positive, /。/)

    const mismatch = await compilePrompt({
      ir: twoPeopleIR({ language: 'en' }),
      profile,
      includeNegative: false,
      captionLanguage: 'zh-CN',
    })
    assert.equal(mismatch.prompts.positive, '', '语言不一致时不翻译、不补写')
    assert.ok(mismatch.diagnostics.some((item) => item.error_code === 'COMPILE_MOSS_CAPTION_LANGUAGE_EMPTY'))
  } finally {
    cleanup()
  }
})

// ── B. 自然语言需求 ────────────────────────────────────────────────────────

test('编写：中文需求原样成文，人物、服装、手、位置关系都在', async () => {
  const { profile, cleanup } = await loadMoss()
  try {
    const brief =
      '一名成年女性穿着深蓝色长外套，站在车站雨棚下。她的右手握着收拢的白色雨伞，脚边放着棕色行李箱。'
    const out = composeCaptionFromBrief({ brief, profile, language: 'zh-CN', includeNegative: true })
    assert.equal(out.ok, true)
    assert.equal(out.language, 'zh-CN')
    assert.equal(out.text, brief, '编写入口不替用户改写措辞')
    assert.equal(out.emitted.tags, false)
    assert.equal(out.emitted.layout, false)
    assert.equal(out.emitted.register, 'caption')
    assert.match(out.negative.text, /worst quality/)
  } finally {
    cleanup()
  }
})

test('编写：质量词被摘掉，其余内容逐字保留', async () => {
  const { profile, cleanup } = await loadMoss()
  try {
    const out = composeCaptionFromBrief({
      brief: 'masterpiece, best quality. A woman in a navy coat waits under a station canopy.',
      profile,
      language: 'en',
      includeNegative: false,
    })
    assert.equal(out.ok, true)
    assert.ok(!/masterpiece/i.test(out.text))
    assert.ok(!/best quality/i.test(out.text))
    assert.match(out.text, /navy coat waits under a station canopy/)
    assert.equal(out.stats.removed_quality_words, 2)
  } finally {
    cleanup()
  }
})

test('编写：Layout JSON 不当需求收，标签流只提示不改写', async () => {
  const { profile, cleanup } = await loadMoss()
  try {
    const layout = composeCaptionFromBrief({
      brief: '{"items":[{"label":"text","bbox":[0,0,10,10]}],"bbox_format":"yxyx"}',
      profile,
      language: 'en',
    })
    assert.equal(layout.ok, false)
    assert.ok(layout.diagnostics.some((item) => item.code === BRIEF_CODES.BRIEF_LAYOUT_REJECTED))

    const tags = composeCaptionFromBrief({ brief: '1girl, silver hair, school uniform', profile, language: 'en' })
    assert.equal(tags.ok, true)
    assert.ok(tags.diagnostics.some((item) => item.code === BRIEF_CODES.BRIEF_LOOKS_LIKE_TAGS))
    // 提示归提示，内容一个字都不动。
    assert.equal(tags.text, '1girl, silver hair, school uniform')
  } finally {
    cleanup()
  }
})

test('编写：信息不足就失败，不编一段出来', async () => {
  const { profile, cleanup } = await loadMoss()
  try {
    for (const brief of ['', '   ', null]) {
      const out = composeCaptionFromBrief({ brief, profile, language: 'en' })
      assert.equal(out.ok, false)
      assert.equal(out.text, '')
    }
  } finally {
    cleanup()
  }
})

test('编写：语言由内容决定，用户声明的语言与内容不一致时不翻译', async () => {
  assert.equal(detectBriefLanguage('一名女性站在雨棚下。'), 'zh-CN')
  assert.equal(detectBriefLanguage('A woman stands under a canopy.'), 'en')
  const { profile, cleanup } = await loadMoss()
  try {
    const out = composeCaptionFromBrief({ brief: '一名女性站在雨棚下。', profile, language: 'en' })
    assert.equal(out.language, 'zh-CN')
    assert.match(out.text, /一名女性/)
    assert.ok(out.diagnostics.some((item) => item.code === BRIEF_CODES.BRIEF_LANGUAGE_MISMATCH))
  } finally {
    cleanup()
  }
})

// 局部修改不在这里测。原来那条「预先手写 A、B 两段文本再比句子差异」的用例
// 证明不了插件支持局部修改——两段都是人手写的，中间没有任何修改逻辑。
// 真正的验收在 scripts/moss-fixes.test.mjs：输入原文和一句修改要求，走
// revise_caption 的生产入口，检查替换片段之外逐字未变。

// ── C. 工作流实际接收的文本 ────────────────────────────────────────────────

function workflowWith({ positiveText, enhancer = false }) {
  const prompt = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'moss.safetensors' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: positiveText, clip: ['1', 1] } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality', clip: ['1', 1] } },
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
  if (enhancer) {
    prompt[3] = { class_type: 'PromptEnhancer', inputs: { text: ['2', 0], seed: 7 } }
  }
  return prompt
}

test('核对：没有改写节点时，文本节点里的内容就是最终进模型的文本', () => {
  const caption = 'A woman in a navy coat holds a closed white umbrella under a station canopy.'
  const out = checkPromptDelivery(workflowWith({ positiveText: caption }), { expectedPositive: caption })
  assert.equal(out.final_text_known, true)
  const positive = out.checks.find((item) => item.side === 'positive')
  assert.equal(positive.final_text, caption)
  assert.equal(positive.comparison.matches, true)
  assert.deepEqual(out.diagnostics, [])
})

test('核对：文本对不上时指出第一个不同的位置，不只是一句不匹配', () => {
  const expected = 'A woman in a navy coat holds a closed white umbrella.'
  const actual = 'A woman in a navy coat holds an open white umbrella.'
  const out = checkPromptDelivery(workflowWith({ positiveText: actual }), { expectedPositive: expected })
  const positive = out.checks.find((item) => item.side === 'positive')
  assert.equal(positive.comparison.matches, false)
  assert.equal(positive.comparison.reason, 'content_differs')
  // 差异落在 closed / open 那个词的开头，不是笼统的"对不上"。
  assert.equal(positive.comparison.first_difference_at, 30)
  // 位置 30 是 "a closed" 与 "an open" 分岔的那个空格，不是句首。
  assert.equal(expected.slice(30, 37), ' closed')
  assert.ok(out.diagnostics.some((item) => item.error_code === COMFY_CODES.PROMPT_TEXT_MISMATCH))
})

test('核对：链路上有改写节点时，不假装知道最终文本', () => {
  const out = checkPromptDelivery(workflowWith({ positiveText: 'a woman', enhancer: true }), {
    expectedPositive: 'a woman',
  })
  assert.equal(out.final_text_known, false)
  const positive = out.checks.find((item) => item.side === 'positive')
  assert.equal(positive.final_text, null)
  assert.deepEqual(positive.rewritten_by, ['3'], '只报改写节点，不把文本节点算进去')
  assert.ok(out.diagnostics.some((item) => item.error_code === COMFY_CODES.PROMPT_TEXT_REWRITTEN))
})
