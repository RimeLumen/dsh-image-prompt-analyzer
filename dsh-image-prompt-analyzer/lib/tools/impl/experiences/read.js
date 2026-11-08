
import { TASK_STATUS, envelope } from '../../../diagnostics.js'
import {
  describeExperienceMatches,
  experienceStats,
  findByTaskId,
  getExperience,
  listExperiences,
  searchExperiences,
  statsByProfile,
  summarizeExperience,
} from '../../../experience/index.js'
import { missingId } from './common.js'

export function runReadAction(handle, action, args, diagnostics) {
  // args.target_profile 已经由上层展开成 target_profile_aliases（含档案的所有旧名）。
  // 旧记录里存的是改名前的 config_id，只按新名查会全部漏掉。
  const targetProfiles = Array.isArray(args.target_profile_aliases) ? args.target_profile_aliases : null

  if (action === 'stats') {
    return envelope({
      status: TASK_STATUS.OK,
      diagnostics,
      extra: {
        action,
        stats: experienceStats(handle, { targetProfile: args.target_profile ?? null, targetProfiles }),
        by_profile: statsByProfile(handle),
      },
    })
  }

  if (action === 'list') {
    const rows = listExperiences(handle, {
      limit: args.limit ?? 20,
      targetModel: args.target_model ?? null,
      targetProfile: args.target_profile ?? null,
      targetProfiles,
      imageHash: args.image_hash ?? null,
    })
    return envelope({
      status: TASK_STATUS.OK,
      diagnostics,
      extra: {
        action,
        count: rows.length,
        experiences: rows.map(summarizeExperience),
      },
    })
  }

  if (action === 'search') {
    const tags = Array.isArray(args.tags) ? args.tags : []
    const rows = searchExperiences(handle, {
      tags,
      targetModel: args.target_model ?? null,
      targetProfile: args.target_profile ?? null,
      targetProfiles,
      limit: args.limit ?? 10,
      requireAll: args.require_all === true,
    })
    return envelope({
      status: TASK_STATUS.OK,
      diagnostics,
      extra: { action, ...describeExperienceMatches(rows, { query: tags }) },
    })
  }

  if (action === 'get') {
    const record = args.experience_id != null
      ? getExperience(handle, args.experience_id)
      : args.task_id
        ? findByTaskId(handle, args.task_id)
        : null
    if (!record) {
      diagnostics.push(missingId())
      return envelope({ status: TASK_STATUS.FAILED, diagnostics })
    }
    return envelope({ status: TASK_STATUS.OK, diagnostics, extra: { action, experience: record } })
  }

  return null
}
