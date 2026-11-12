
export { KB_SCHEMA_VERSION, KB_DDL, META_KEYS } from './schema.js'

export {
  KnowledgeBaseError,
  KB_DB_CODES,
  openKnowledgeDatabase,
  openSourceDatabase,
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
  findTagByZh,
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
  upsertSourceMeta,
  readSourceMeta,
  listSourceMetas,
  replaceSourceUserCategories,
  listSourceUserCategories,
  replaceStudioCategories,
  countStudioCategories,
  listStudioCategories,
  studioCategoryPath,
  findStudioCategoriesByName,
  studioCategoryTagNames,
  studioCategoriesForTag,
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
  importStudioSource,
  rebuildLocalSource,
  importLocalSource,
  importAllLocalSources,
} from './import.js'

export {
  STUDIO_SOURCE_TYPE,
  STUDIO_ADAPTER,
  STUDIO_ADAPTER_VERSION,
  STUDIO_CODES,
  REVIEWED_TRANSLATION_STATUSES,
  hashFile,
  inspectStudioDatabase,
  studioTagRecord,
  readStudioTags,
  readStudioUserCategories,
  readStudioCategories,
} from './adapters/studio-sqlite.js'

export {
  TREE_CODES,
  TREE_SEED_FILES,
  resolveTreeSeedPaths,
  parseStudioTree,
  loadStudioTree,
  treePath,
  treeSubtree,
  searchTree,
} from './tree.js'

export { SEARCH_MATCH, SEARCH_CODES, SEARCH_SCORE, SEARCH_DEPRECATED, MAX_SEARCH_LIMIT, searchKnowledge } from './search.js'

export { EXPLAIN_CODES, EXPLAIN_SOURCE, describeTag, explainTerm } from './explain.js'

export { inferTagKind, internalCategoryForKind, normalizeNativeCategory, KIND_RULES } from './kind.js'

export { READER_CODES } from './readers/codes.js'
export { readLocalFile } from './readers/index.js'
