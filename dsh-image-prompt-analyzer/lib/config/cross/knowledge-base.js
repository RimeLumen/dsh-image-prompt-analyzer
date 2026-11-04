
import { CATEGORY_IDS, MUST_KEEP_CATEGORIES, DANBOORU_NATIVE_CATEGORIES } from '../categories.js'
import { findDuplicates, forEachPathField, makeCollectors, unsafeRelativePath } from './shared.js'

const LOCAL_FORMATS = Object.freeze(['csv', 'xlsx', 'docx', 'pdf', 'txt', 'md'])

export function crossValidateKnowledgeBase(document, { config_file }) {
  const out = []
  const { err, warn } = makeCollectors(out, config_file)

  forEachPathField(document, ({ pointer, value }) => {
    const reason = unsafeRelativePath(value)
    if (reason) {
      err(
        'CONFIG_PATH_UNSAFE',
        pointer,
        `路径不安全：${reason}（实际值 ${JSON.stringify(value)}）`,
        '改成相对插件包目录的普通路径，例如 res/danbooru_all.csv。',
      )
    }
  })

  const sources = Array.isArray(document?.sources) ? document.sources : []

  for (const duplicate of findDuplicates(sources.map((s) => s?.source_id))) {
    err(
      'KB_SOURCE_ID_DUPLICATE',
      '/sources',
      `source_id ${duplicate} 重复。`,
      '每个数据源的 source_id 必须唯一，诊断信息靠它定位数据源。',
    )
  }

  sources.forEach((source, index) => {
    const at = `/sources/${index}`
    if (source === null || typeof source !== 'object') return

    if (source.type !== undefined && source.type !== 'local_file') {
      err(
        'KB_SOURCE_MISSING_FIELD',
        `${at}/type`,
        `知识库 2.0 只支持 local_file 数据源，收到 type = ${JSON.stringify(source.type)}。`,
        '删掉在线源/JSON 快照源，改成本地文件：type = local_file、format = csv/xlsx/docx/pdf/txt/md、path = 数据文件路径。',
      )
    }

    if (typeof source.path !== 'string' || source.path === '') {
      err('KB_SOURCE_MISSING_FIELD', `${at}/path`, `${source.source_id} 没有 path。`, '补上相对插件包目录的数据文件路径，例如 res/danbooru_all.csv。')
    }

    if (source.format !== undefined && !LOCAL_FORMATS.includes(source.format)) {
      err(
        'KB_SOURCE_MISSING_FIELD',
        `${at}/format`,
        `${source.source_id} 的 format = ${JSON.stringify(source.format)} 不是本地文件格式。`,
        `可用取值：${LOCAL_FORMATS.join(' / ')}。`,
      )
    }

    if (source.format === 'csv' && source.column_map !== undefined) {
      const map = source.column_map
      if (map === null || typeof map !== 'object' || Array.isArray(map)) {
        err('KB_COLUMN_MAP_INVALID', `${at}/column_map`, 'column_map 必须是「字段名 → 表头名或列下标」的对象。', '例如 { "tag": 0, "aliases": 3 }。')
      } else if (!Object.hasOwn(map, 'tag')) {
        err('KB_COLUMN_MAP_INVALID', `${at}/column_map`, 'column_map 没有声明 tag 列，导入后拿不到标签名。', '至少给 tag 声明表头名或列下标。')
      }
    }

    if (source.format === 'csv' && source.delimiter !== undefined && (typeof source.delimiter !== 'string' || [...source.delimiter].length !== 1)) {
      err('KB_COLUMN_MAP_INVALID', `${at}/delimiter`, 'delimiter 必须是单个字符。', '用 ";" 或 "\\t" 这类单字符分隔符。')
    }

    if (source.limit !== undefined && source.limit !== null && (!Number.isInteger(source.limit) || source.limit <= 0)) {
      err('KB_COLUMN_MAP_INVALID', `${at}/limit`, 'limit 必须是正整数或 null。', '调试时给 1000 这类正整数；全量导入用 null。')
    }
  })

  const enabledSources = sources.filter((s) => s?.enabled === true)
  if (enabledSources.length === 0) {
    err('KB_NO_ENABLED_SOURCE', '/sources', '没有任何启用的数据源，标签查询与经验库都无法工作。', '至少启用一个本地文件源。')
  }

  const categories = Array.isArray(document?.categories) ? document.categories : []
  for (const duplicate of findDuplicates(categories.map((c) => c?.category_id))) {
    err('KB_CATEGORY_DUPLICATE', '/categories', `category_id ${duplicate} 重复。`, '每个内部分类在配置里只能出现一次。')
  }
  categories.forEach((category, index) => {
    const id = category?.category_id
    if (typeof id === 'string' && !CATEGORY_IDS.has(id)) {
      err(
        'KB_UNKNOWN_CATEGORY',
        `/categories/${index}/category_id`,
        `未知的内部分类 ID：${id}。`,
        `可用取值：${[...CATEGORY_IDS].join(' / ')}。新分类必须先加进 lib/config/categories.js。`,
      )
    }
    const natives = category?.native_categories
    if (Array.isArray(natives)) {
      for (const native of natives) {
        if (!DANBOORU_NATIVE_CATEGORIES.includes(native)) {
          err(
            'KB_UNKNOWN_NATIVE_CATEGORY',
            `/categories/${index}/native_categories`,
            `未知的 Danbooru 原生类别：${native}。`,
            `可用取值：${DANBOORU_NATIVE_CATEGORIES.join(' / ')}。`,
          )
        }
      }
    }
  })

  const enabledCategories = categories.filter((c) => c?.enabled === true)
  if (categories.length > 0 && enabledCategories.length === 0) {
    warn('KB_NO_ENABLED_CATEGORY', '/categories', '所有内部分类都被禁用了，编译阶段没有可用的分类。', '至少启用 composition / camera / subject。')
  }
  for (const required of MUST_KEEP_CATEGORIES) {
    const found = categories.find((c) => c?.category_id === required)
    if (found && found.enabled === false) {
      warn(
        'KB_MUST_KEEP_CATEGORY_DISABLED',
        '/categories',
        `${required} 被禁用，但文档 §6.6 要求任何档位都不得删除构图、镜头与主体关系。`,
        `把 ${required} 的 enabled 改回 true。`,
      )
    }
  }

  return out
}
