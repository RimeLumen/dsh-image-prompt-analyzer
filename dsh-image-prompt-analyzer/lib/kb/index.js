
export { KB_SCHEMA_VERSION, KB_DDL, META_KEYS } from './schema.js'

export {
  KnowledgeBaseError,
  KB_DB_CODES,
  openKnowledgeDatabase,
  openMemoryDatabase,
  readMeta,
  writeMeta,
  probeWritable,
  listTables,
} from './db.js'

export {
  normalizeTagName,
  normalizeQuery,
  toUnderscored,
  toSpaced,
  SCORE_TAG_PATTERN,
  splitTagList,
  dedupeTags,
  contentHash,
  matchScore,
} from './normalize.js'

export { CLASSIFICATION_RULES, NATIVE_CATEGORY_MAP, classifyTag, ruleStats } from './classify.js'

export {
  upsertTag,
  setTagCategory,
  upsertTagBatch,
  upsertAliasBatch,
  upsertImplicationBatch,
  findTag,
  findTagById,
  searchTagsByPrefix,
  findAlias,
  listTagsByCategory,
  implicationsFor,
  beginSync,
  finishSync,
  writeSyncCursor,
  readSyncCursor,
  lastSyncFor,
  countTags,
  knowledgeStats,
} from './store.js'

export { LOOKUP_STATUS, LOOKUP_SOURCE, LOOKUP_MODES, LOOKUP_REASONS, createKnowledgeBase } from './query.js'

export {
  IMPORT_CODES,
  REBUILD_CODES,
  SOURCE_TYPES,
  parseJsonLines,
  tagRecordFromRow,
  tagRecordsFromRows,
  readLocalSqliteTags,
  importLocalFileSource,
  rebuildLocalSource,
  importLocalSource,
  importAllLocalSources,
} from './import.js'

export { inferTagKind, internalCategoryForKind, normalizeNativeCategory, KIND_RULES } from './kind.js'

export { READER_CODES } from './readers/codes.js'
export { readLocalFile } from './readers/index.js'
