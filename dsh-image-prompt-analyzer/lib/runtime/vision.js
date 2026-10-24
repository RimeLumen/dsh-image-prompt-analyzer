
import { createVisionBackend } from '../vision/index.js'
import { lazy } from './lazy.js'

export function createVisionRuntime({ ctx, pluginConfig, readImageBytes, logger }) {
  return lazy(async () =>
    createVisionBackend({
      ctx,
      visionConfig: pluginConfig.vision,
      readImageBytes,
      logger,
    }),
  )
}
