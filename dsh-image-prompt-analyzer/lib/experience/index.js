
import { buildExperienceRecord, collectExperienceTags, EXPERIENCE_ROLES } from './store.js'

export {
  EFFECT_RATING_MAX,
  EFFECT_RATING_MIN,
  EXPERIENCE_CODES,
  EXPERIENCE_EXPORT_SCHEMA_VERSION,
  EXPERIENCE_ROLE_IDS,
  EXPERIENCE_ROLES,
  ExperienceError,
  buildExperienceRecord,
  collectExperienceTags,
  deleteExperience,
  deleteExperienceByTaskId,
  experienceStats,
  findByTaskId,
  getExperience,
  imageContentHash,
  importExperiences,
  listExperiences,
  parseJsonl,
  saveExperience,
  searchExperiences,
  setEffectRating,
  statsByProfile,
  toLine,
  toJsonl,
} from './store.js'

export function buildAnalysisExperience({
  taskId,
  prepared = null,
  ir = null,
  compiled = null,
  profile = null,
  preset = null,
  configVersion = null,
  imageHash = null,
}) {
  const image = prepared?.image ?? ir?.image ?? null
  const imageMeta = image
    ? {
        width: image.width ?? null,
        height: image.height ?? null,
        aspect_ratio: image.aspect_ratio ?? null,
        has_alpha: image.has_alpha === true,
        src_format: image.src_format ?? null,
        decoded_via: image.decoded_via ?? null,
        orientation_applied: image.orientation_applied ?? null,
      }
    : null

  const targetModel = profile?.display_name ?? profile?.config_id ?? compiled?.target_profile ?? 'unknown'
  const targetProfile = profile?.config_id ?? compiled?.target_profile ?? null
  const detailLevel = preset?.detail_density ?? 'standard'

  const record = buildExperienceRecord({
    taskId,
    imageHash,
    imageMeta,
    targetModel,
    targetProfile,
    detailLevel,
    positivePrompt: compiled?.prompts?.positive ?? '',
    negativePrompt: compiled?.prompts?.negative || null,
    controlSuggestions: null,
    slotsSnapshot: Array.isArray(compiled?.slots) ? compiled.slots : null,
    qualityBlock: Array.isArray(compiled?.quality_block) ? compiled.quality_block : null,
    irSnapshot: ir,
    configVersion,
  })

  const positiveTerms = Array.isArray(compiled?.slots)
    ? compiled.slots.flatMap((segment) => (Array.isArray(segment?.terms) ? segment.terms : []))
    : []
  const tags = collectExperienceTags({
    positiveTerms,
    negativeTerms: compiled?.prompts?.negative ? compiled.prompts.negative.split(',').map((item) => item.trim()) : [],
    lowConfidenceTerms: [],
  })

  return { record, tags, image_meta: imageMeta }
}

export function describeConfigVersion({ profile = null, variant = null, knowledgeBase = null, pluginVersion = null } = {}) {
  const profilePart = profile
    ? `${profile.config_id ?? 'unknown'}@${profile.schema_version ?? '?'}${variant && variant !== 'none' ? `/${variant}` : ''}`
    : 'unknown'
  const kbPart = knowledgeBase
    ? `${knowledgeBase.config_id ?? 'unknown'}@${knowledgeBase.schema_version ?? '?'}`
    : 'no-kb'
  return `${profilePart}+${kbPart}${pluginVersion ? `+plugin-${pluginVersion}` : ''}`
}

export function describeExperienceMatches(matches, { query = [] } = {}) {
  return {
    query_tags: query,
    count: matches.length,
    source: 'experience',
    notice: '这些是历史记录，只说明以前用过哪些标签组合，不代表这些标签在生成时效果更好。历史频率不等于生成有效性。',
    matches: matches.map((item) => ({
      id: item.id,
      task_id: item.task_id,
      target_profile: item.target_profile ?? null,
      target_model: item.target_model,
      detail_level: item.detail_level,
      created_at: item.created_at,
      match_score: item.match_score,
      matched_tags: item.matched_tags,
      effect_rating: item.effect_rating,
      positive_prompt: item.positive_prompt,
      negative_prompt: item.negative_prompt,
      tags: item.tags,
      source: item.source,
    })),
  }
}

export function summarizeExperience(experience) {
  if (!experience) return null
  const byRole = { [EXPERIENCE_ROLES.POSITIVE]: 0, [EXPERIENCE_ROLES.NEGATIVE]: 0, [EXPERIENCE_ROLES.LOW_CONFIDENCE]: 0 }
  for (const tag of experience.tags ?? []) {
    if (byRole[tag.role] !== undefined) byRole[tag.role] += 1
  }
  return {
    id: experience.id,
    task_id: experience.task_id,
    target_profile: experience.target_profile ?? null,
    target_profile_display: experience.target_profile ?? experience.target_model ?? null,
    target_model: experience.target_model,
    detail_level: experience.detail_level,
    config_version: experience.config_version,
    created_at: experience.created_at,
    effect_rating: experience.effect_rating,
    image_hash: experience.image_hash,
    image_meta: experience.image_meta,
    positive_prompt: experience.positive_prompt,
    negative_prompt: experience.negative_prompt,
    tag_counts: byRole,
  }
}
