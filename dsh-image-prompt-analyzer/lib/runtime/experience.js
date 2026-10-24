
import { SEVERITY, diagnostic } from '../diagnostics.js'
import {
  EXPERIENCE_CODES,
  buildAnalysisExperience,
  describeConfigVersion,
  imageContentHash,
  saveExperience as saveExperienceRow,
} from '../experience/index.js'

export function createExperienceRuntime({ knowledgeLazy, readImageBytes, pluginConfig, logger }) {
  return {
    async saveExperience({
      taskId,
      prepared = null,
      sourcePath = null,
      ir = null,
      compiled = null,
      profile = null,
      preset = null,
      pluginVersion = null,
      knowledgeBase = null,
    } = {}) {
      const { handle } = await knowledgeLazy.get()

      let imageHash = null
      if (sourcePath) {
        try {
          const bytes = await readImageBytes(sourcePath, { maxBytes: pluginConfig.image.max_bytes })
          imageHash = imageContentHash(bytes)
        } catch (error) {
          logger.warn(`保存经验时无法读取原图以计算内容哈希：${error?.message ?? error}`)
        }
      }

      const configVersion = describeConfigVersion({
        profile,
        variant: profile?.variant ?? null,
        knowledgeBase,
        pluginVersion,
      })
      const built = buildAnalysisExperience({
        taskId,
        prepared,
        ir,
        compiled,
        profile,
        preset,
        configVersion,
        imageHash,
      })

      const saved = saveExperienceRow(handle, built.record, { tags: built.tags })
      logger.info(
        `经验已保存：task_id=${taskId} id=${saved.id} 标签 ${saved.tags} 条（命中本地库 ${saved.linked_tags} 条）`,
      )

      return {
        id: saved.id,
        task_id: saved.task_id,
        tags: saved.tags,
        linked_tags: saved.linked_tags,
        image_hash: imageHash,
        config_version: configVersion,
        diagnostics: imageHash
          ? []
          : [
              diagnostic({
                error_code: EXPERIENCE_CODES.IMAGE_HASH_MISSING,
                severity: SEVERITY.WARNING,
                message: '经验已保存，但没能算出原图的内容哈希，以后无法按「同一张图」检索这条经验。',
                suggested_fix: '确认原图仍然存在于原路径且可读。',
              }),
            ],
      }
    },
  }
}
