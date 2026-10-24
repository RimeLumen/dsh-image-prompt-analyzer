
import { PACKAGE_DIR } from '../paths.js'
import { createDecoder, createInputPreparer, createTempWorkspace } from '../input/index.js'
import { lazy } from './lazy.js'

export function createInputRuntime({ ctx, pluginConfig, dirs, logger }) {
  const decoderLazy = lazy(async () => createDecoder({ ctx, config: pluginConfig, packageDir: PACKAGE_DIR, logger }))

  const tempLazy = lazy(async () =>
    createTempWorkspace({
      dataDir: dirs.dataDir,
      ttlMinutes: pluginConfig.image.temp_ttl_minutes,
      logger,
    }),
  )

  const preparerLazy = lazy(async () =>
    createInputPreparer({
      ctx,
      decoder: await decoderLazy.get(),
      temp: await tempLazy.get(),
      config: pluginConfig,
      logger,
    }),
  )

  return { decoderLazy, tempLazy, preparerLazy }
}
