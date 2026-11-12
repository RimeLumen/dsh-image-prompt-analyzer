
import { CATEGORY_IDS, MUST_KEEP_CATEGORIES, DANBOORU_NATIVE_CATEGORIES } from '../categories.js'
import { findDuplicates, forEachPathField, makeCollectors, unsafeRelativePath, unsafeSourcePath } from './shared.js'

const LOCAL_FORMATS = Object.freeze(['csv', 'xlsx', 'docx', 'pdf', 'txt', 'md'])

// studio_sqlite 指向工作室自己的 SQLite 词库，格式由适配器判断，不需要用户声明。
const STUDIO_SOURCE_TYPE = 'studio_sqlite'

const KNOWN_SOURCE_TYPES = Object.freeze(['local_file', STUDIO_SOURCE_TYPE])

const SOURCE_ROLES_LIST = Object.freeze(['model', 'supplement'])

export function crossValidateKnowledgeBase(document, { config_file }) {
  const out = []
  const { err, warn } = makeCollectors(out, config_file)

  forEachPathField(document, ({ pointer, value }) => {
    // 数据源路径要按类型分级校验：studio_sqlite 允许外部绝对路径，local_file 不允许。
    if (pointer.startsWith('/sources/')) return
    // 插件自己的库现在放在用户数据目录（跨升级保留），相对路径与绝对路径都合法。
    if (pointer === '/storage/database_path') {
      const reason = unsafeSourcePath(value, { allowAbsolute: true })
      if (reason) {
        err(
          'CONFIG_PATH_UNSAFE',
          pointer,
          `路径不安全：${reason}（实际值 ${JSON.stringify(value)}）`,
          '填相对用户数据目录的路径（例如 knowledge.sqlite3），或填一个绝对路径。',
        )
      }
      return
    }
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

    const type = source.type === undefined ? 'local_file' : String(source.type)
    const isStudio = type === STUDIO_SOURCE_TYPE

    if (!KNOWN_SOURCE_TYPES.includes(type)) {
      err(
        'KB_SOURCE_MISSING_FIELD',
        `${at}/type`,
        `不支持的数据源类型 type = ${JSON.stringify(source.type)}。`,
        `可用取值：${KNOWN_SOURCE_TYPES.join(' / ')}。local_file 是插件目录内的词表文件；studio_sqlite 是绘画工作室导出的 SQLite 词库。`,
      )
    }

    // role 决定"这个词源算不算数"。写错了不能静默按类型推断：
    // 一份中文对照表被当成模型词表，会让解释性条目跑进提示词。
    if (source.role !== undefined && !SOURCE_ROLES_LIST.includes(String(source.role))) {
      err(
        'KB_SOURCE_MISSING_FIELD',
        `${at}/role`,
        `不认识的角色 role = ${JSON.stringify(source.role)}。`,
        `可用取值：${SOURCE_ROLES_LIST.join(' / ')}。model 决定词能不能进提示词；supplement 只用于检索与解释。不写就按类型推断。`,
      )
    }

    if (typeof source.path !== 'string' || source.path === '') {
      err(
        'KB_SOURCE_MISSING_FIELD',
        `${at}/path`,
        `${source.source_id} 没有 path。`,
        isStudio
          ? '填工作室数据文件的位置，例如 G:/绘画工作室/绘画工作室-公开版/data/tags.sqlite。'
          : '补上相对插件包目录的数据文件路径，例如 res/danbooru_all.csv。',
      )
    } else {
      const reason = unsafeSourcePath(source.path, { allowAbsolute: isStudio })
      if (reason) {
        err(
          'CONFIG_PATH_UNSAFE',
          `${at}/path`,
          `路径不安全：${reason}（实际值 ${JSON.stringify(source.path)}）`,
          isStudio
            ? '填本机上的真实文件路径，可以是绝对路径（如 G:/…/data/tags.sqlite），但不能是 URL 或含 .. 的路径。'
            : '改成相对插件包目录的普通路径，例如 res/danbooru_all.csv。',
        )
      }
    }

    if (isStudio) {
      // 工作室词库不需要 format / column_map / delimiter：列名由适配器按契约读取。
      // 但用户如果硬写了一个，要明确告诉他不生效，而不是默默忽略。
      if (source.format !== undefined && source.format !== null && source.format !== 'sqlite') {
        warn(
          'KB_SOURCE_FIELD_IGNORED',
          `${at}/format`,
          `${source.source_id} 是 studio_sqlite 数据源，format = ${JSON.stringify(source.format)} 不会生效。`,
          '删掉 format；studio_sqlite 的列结构由适配器按 en/category/post_count 契约读取。',
        )
      }
      if (source.column_map !== undefined) {
        warn(
          'KB_SOURCE_FIELD_IGNORED',
          `${at}/column_map`,
          `${source.source_id} 是 studio_sqlite 数据源，column_map 不会生效。`,
          '删掉 column_map；只有在导入 CSV 时才需要列映射。',
        )
      }
    }

    if (!isStudio && source.format !== undefined && !LOCAL_FORMATS.includes(source.format)) {
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
