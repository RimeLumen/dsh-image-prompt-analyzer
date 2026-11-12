import { COMFY_CODES } from './errors.js'
import { isLinkRef, requireApiPrompt } from './workflow.js'
import { isTextNodeClass, detectPromptEnhancers } from './enhancer.js'

/**
 * 核对「编译出来的文本」与「真正进模型的文本」。
 *
 * 本插件交出去的 Caption 是逐词可追溯到 IR 事实的一段话。用户在 ComfyUI 里把
 * 它粘进文本节点，中间还可能夹着改写节点、还可能粘错一份旧稿。这件事只看
 * 工作流 JSON 就能查清一半：
 *
 *   - 没有改写节点时，采样器 positive 指向的文本节点内容就是最终文本。
 *     可以逐字比对，不一致就指出第一个不同在哪。
 *   - 有改写节点时，最终文本由那个节点在运行时生成，工作流 JSON 里没有它。
 *     这时候只能报"已知的输入是什么、谁会在中间改它"，**不能假装知道最终文本**。
 *
 * 所以这个模块的返回值里有一个明确的 `final_text_known`：false 的时候，
 * 除了输入以外什么都别当成事实用。
 */

/** 比较两段文本，给出人能看懂的第一个差异位置，而不是只回一个 false。 */
function compareText(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') {
    return { compared: false, matches: null, reason: 'missing_text' }
  }
  if (expected === actual) {
    return { compared: true, matches: true, reason: null, length: { expected: expected.length, actual: actual.length } }
  }
  const limit = Math.min(expected.length, actual.length)
  let index = 0
  while (index < limit && expected[index] === actual[index]) index += 1
  return {
    compared: true,
    matches: false,
    reason: index === limit ? 'length_differs' : 'content_differs',
    first_difference_at: index,
    // 差异点前后各取一小段：够定位，又不至于把整段提示词再抄一遍。
    expected_excerpt: expected.slice(Math.max(0, index - 20), index + 40),
    actual_excerpt: actual.slice(Math.max(0, index - 20), index + 40),
    length: { expected: expected.length, actual: actual.length },
  }
}

/** 这个文本节点到采样器之间，有没有节点会改写它。 */
function rewritersOnChain(enhancer, samplerId, role, prompt) {
  const chain = (enhancer.chains ?? []).find((item) => item.sampler_id === samplerId && item.role === role)
  if (!chain) return []
  const ids = new Set()
  for (const entry of chain.chain ?? []) {
    // 文本节点自己不是改写者；采样器也不是。剩下的才是中间那一层。
    if (isTextNodeClass(entry.class_type)) continue
    if (/^ksampler/i.test(entry.class_type ?? '')) continue
    ids.add(String(entry.node_id))
  }
  const targetClass = prompt?.[String(chain.target?.node_id)]?.class_type ?? ''
  if (targetClass !== '' && !isTextNodeClass(targetClass) && !/^ksampler/i.test(targetClass)) {
    // 直接接在采样器上的不是文本节点 —— 它就在这条路上，哪怕它不吃 text 字段。
    ids.add(String(chain.target.node_id))
  }
  return [...ids]
}

/**
 * @param {object} prompt  API Prompt
 * @param {object} options
 * @param {string|null} options.expectedPositive 期望进模型的正向文本
 * @param {string|null} options.expectedNegative 期望进模型的负向文本
 * @param {string|null} options.role            只核对哪一个采样器（可选）
 */
export function checkPromptDelivery(prompt, { expectedPositive = null, expectedNegative = null, role = null } = {}) {
  requireApiPrompt(prompt)

  const nodes = Object.entries(prompt).map(([id, node]) => ({
    id: String(id),
    class_type: node.class_type,
    inputs: node.inputs ?? {},
  }))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const samplers = nodes.filter((node) => /^ksampler/i.test(node.class_type))
  const enhancer = detectPromptEnhancers(prompt)

  const diagnostics = []
  const checks = []

  for (const sampler of samplers) {
    if (role && sampler.id !== String(role)) continue
    for (const side of ['positive', 'negative']) {
      const expected = side === 'positive' ? expectedPositive : expectedNegative
      const link = sampler.inputs?.[side]
      if (!isLinkRef(link)) {
        checks.push({
          sampler_id: sampler.id,
          side,
          wired: false,
          final_text_known: false,
          comparison: { compared: false, matches: null, reason: 'not_wired' },
        })
        if (expected !== null && expected !== undefined) {
          diagnostics.push({
            error_code: COMFY_CODES.VALIDATION_FAILED,
            node_id: sampler.id,
            field_path: `/inputs/${side}`,
            message: `KSampler ${sampler.id} 的 ${side} 没有接文本节点，期望的文本进不去模型。`,
            suggested_fix: '在 ComfyUI 里把文本节点接到这个采样器的对应输入上。',
          })
        }
        continue
      }

      const targetId = String(link[0])
      const target = byId.get(targetId)
      const targetText = typeof target?.inputs?.text === 'string' ? target.inputs.text : null
      const rewriters = rewritersOnChain(enhancer, sampler.id, side, prompt)
      const finalTextKnown = rewriters.length === 0 && targetText !== null
      const comparison = expected === null || expected === undefined
        ? { compared: false, matches: null, reason: 'no_expectation' }
        : compareText(expected, targetText)

      checks.push({
        sampler_id: sampler.id,
        side,
        wired: true,
        text_node: { node_id: targetId, class_type: target?.class_type ?? null, has_text: targetText !== null },
        // 没有改写节点时，节点里的文本就是最终文本；有改写节点时这里必须是 null。
        final_text: finalTextKnown ? targetText : null,
        final_text_known: finalTextKnown,
        rewritten_by: rewriters,
        comparison,
      })

      if (comparison.compared && comparison.matches === false) {
        diagnostics.push({
          error_code: COMFY_CODES.PROMPT_TEXT_MISMATCH,
          severity: 'warning',
          node_id: targetId,
          field_path: '/inputs/text',
          message:
            `KSampler ${sampler.id} 的 ${side} 文本与期望不一致` +
            (comparison.reason === 'length_differs'
              ? `：前缀相同，长度不同（期望 ${comparison.length.expected} 字符，实际 ${comparison.length.actual} 字符）。`
              : `：从第 ${comparison.first_difference_at} 个字符开始不同。`),
          suggested_fix: '把插件给出的文本重新粘进这个文本节点，或确认你核对的就是这一版。',
        })
      }
      if (finalTextKnown === false && rewriters.length > 0) {
        diagnostics.push({
          error_code: COMFY_CODES.PROMPT_TEXT_REWRITTEN,
          severity: 'warning',
          node_id: targetId,
          field_path: '/inputs/text',
          message:
            `KSampler ${sampler.id} 的 ${side} 在文本节点之后还有改写节点（${rewriters.join('、')}），` +
            '最终进模型的文本由它在运行时生成，工作流 JSON 里看不到。',
          suggested_fix:
            '要逐字确认进模型的内容，就在 ComfyUI 里旁路掉改写节点；' +
            '保留改写节点时，上面给出的只是改写器的输入，不是最终文本。',
        })
      }
    }
  }

  return {
    checks,
    final_text_known: checks.length > 0 && checks.every((item) => item.final_text_known),
    rewriters: enhancer.enhancers.map((item) => ({ node_id: item.node_id, class_type: item.class_type, reasons: item.reasons })),
    diagnostics,
    note:
      checks.length === 0
        ? '这份工作流里没有 KSampler，无法核对提示词最终去了哪里。'
        : checks.every((item) => item.final_text_known)
          ? '提示词链路上没有改写节点：文本节点里的内容就是最终进模型的文本。'
          : '提示词链路上有改写节点：只能确认改写器的输入，最终文本要在 ComfyUI 里看。',
  }
}
