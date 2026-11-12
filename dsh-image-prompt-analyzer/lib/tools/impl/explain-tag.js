import { SEVERITY, TASK_STATUS, diagnostic, envelope } from '../../diagnostics.js'
import { resolveProfileRequest } from '../../config/index.js'
import { formatTag } from '../../compile/style.js'
import { explainTerm, EXPLAIN_CODES } from '../../kb/explain.js'
import { searchKnowledge } from '../../kb/search.js'

const EXPLAIN_TOOL_CODES = Object.freeze({
  TERM_REQUIRED: 'KB_EXPLAIN_TERM_REQUIRED',
  KNOWLEDGE_UNAVAILABLE: 'KB_EXPLAIN_KNOWLEDGE_UNAVAILABLE',
})

export async function runExplainTag(runtime, args = {}) {
  const diagnostics = []
  const term = String(args.tag ?? '').trim()
  if (term === '') {
    return envelope({
      status: TASK_STATUS.FAILED,
      diagnostics: [
        diagnostic({
          error_code: EXPLAIN_TOOL_CODES.TERM_REQUIRED,
          severity: SEVERITY.ERROR,
          field_path: '/tag',
          message: '没有给出要解释的标签。',
          suggested_fix: '传一个标签名或中文名，例如 maid / 女仆。',
        }),
      ],
    })
  }

  let bundle = null
  try {
    bundle = await runtime.getKnowledgeBase()
  } catch (error) {
    diagnostics.push(
      diagnostic({
        error_code: error?.code ?? EXPLAIN_TOOL_CODES.KNOWLEDGE_UNAVAILABLE,
        severity: SEVERITY.ERROR,
        message: `标签知识库不可用，无法解释：${error?.message ?? error}`,
        suggested_fix: error?.suggested_fix ?? '运行 diagnose_knowledge_base 查看库文件与数据源状态。',
      }),
    )
    return envelope({ diagnostics, extra: { query: term, found: false, hits: [], rendering: null } })
  }

  const { kb, handle, config } = bundle
  const explained = explainTerm(handle, term, {
    modelSourceIds: kb.localSourceIds,
    studioSourceIds: kb.studioSourceIds,
  })
  void config

  const extra = {
    query: explained.query,
    normalized: explained.normalized,
    found: explained.found,
    hits: explained.hits,
    notes: [...explained.notes],
    codes: [...explained.codes],
    rendering: null,
    suggestions: [],
    mode: kb.mode,
    studio_fallback: kb.studioFallback === true,
  }

  // 只在用户点名档案时算一次渲染：不点名就不猜"你大概想用哪个模型"，
  // 猜错会把 `maid` 写成别的模型的写法，而结果本身看不出被换过。
  const profileId = typeof args.target_profile === 'string' ? args.target_profile.trim() : ''
  if (profileId !== '' && explained.found) {
    const store = await runtime.getConfigStore()
    await store.get()
    const request = resolveProfileRequest(store, { profile_id: profileId })
    diagnostics.push(...request.diagnostics)
    if (request.profile) {
      const live = explained.hits.find((hit) => hit.tag.deprecated !== true) ?? explained.hits[0]
      const slot = typeof args.slot === 'string' && args.slot.trim() !== '' ? args.slot.trim() : null
      extra.rendering = {
        target_profile: request.profile.config_id,
        word_style: request.profile.tag_standard?.word_style ?? null,
        slot,
        emitted: formatTag(live.tag.name, request.profile, { slot }),
      }
    }
  }

  if (!explained.found) {
    diagnostics.push(
      diagnostic({
        error_code: EXPLAIN_CODES.MISS,
        severity: SEVERITY.INFO,
        message: `词表里没有「${term}」。`,
        suggested_fix: '这个词按未命中处理：它会作为自由描述进描述版，不进标签版。想找近义词可以看 suggestions。',
      }),
    )
    const near = searchKnowledge(handle, {
      query: term,
      limit: 5,
      modelSourceIds: kb.localSourceIds,
      studioSourceIds: kb.studioSourceIds,
    })
    extra.suggestions = near.results.map((hit) => ({
      tag: hit.tag.name,
      zh_name: hit.tag.zh_name,
      source: hit.source,
      match: hit.match,
    }))
  } else if (explained.codes.includes(EXPLAIN_CODES.DEPRECATED_ONLY)) {
    diagnostics.push(
      diagnostic({
        error_code: EXPLAIN_CODES.DEPRECATED_ONLY,
        severity: SEVERITY.WARNING,
        message: `「${term}」在源库里已标记废弃。`,
        suggested_fix: '解释仍然有效；但不要把它写进提示词，换一个现行标签。',
      }),
    )
  }

  return envelope({ diagnostics, extra })
}
