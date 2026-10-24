
export const KB_SCHEMA_VERSION = '2.0'

export const KB_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 元信息表（相对文档 §5.3 的新增）：记 kb_schema_version 与最近一次同步游标。
-- 没有它就无法判断"这个数据库文件是哪个版本的插件建的"。
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 标签主表。一个标签在同一个来源里只能出现一次（UNIQUE(source_id, name)）。
-- canonical_name 与 name 分开存：Danbooru 上 '1girl' 的规范名可能指向别的标签，
-- 而"用户/模型说的原文"必须原样保留（文档 §5.1「保留原始名称」）。
-- kind 是标签种类（general/character/copyright/artist/meta/quality/score/rating/year/aesthetic/source/unknown），
-- 编译器的槽位分配靠它决定词条该进哪一段；zh_name 供中文词表与诊断展示。
CREATE TABLE IF NOT EXISTS tags (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  canonical_name  TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  native_category TEXT,
  post_count      INTEGER,
  zh_name         TEXT,
  kind            TEXT NOT NULL DEFAULT 'general',
  updated_at      TEXT NOT NULL,
  UNIQUE (source_id, name)
);
CREATE INDEX IF NOT EXISTS idx_tags_name       ON tags (name);
CREATE INDEX IF NOT EXISTS idx_tags_canonical  ON tags (canonical_name);
CREATE INDEX IF NOT EXISTS idx_tags_source     ON tags (source_id);
CREATE INDEX IF NOT EXISTS idx_tags_native_cat ON tags (native_category);

-- 别名表。alias → 规范标签。别名是查询路径而不是标签本身，所以单独一张表：
-- 把别名塞进 tags 会让"这个标签有多少作品"这类统计被别名污染。
CREATE TABLE IF NOT EXISTS tag_aliases (
  id         INTEGER PRIMARY KEY,
  alias      TEXT NOT NULL,
  tag_id     INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_alias_alias ON tag_aliases (alias);

-- 内部分类映射。多对多：一个标签可以同时是 clothing 与 appearance。
-- confidence 允许为空——绝大多数映射是规则给的确定值，不需要假装有概率。
CREATE TABLE IF NOT EXISTS tag_categories (
  tag_id     INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  category   TEXT NOT NULL,
  confidence REAL,
  PRIMARY KEY (tag_id, category)
);
CREATE INDEX IF NOT EXISTS idx_tagcat_category ON tag_categories (category);

-- 蕴含关系（相对文档 §5.3 的新增）：'1girl' 蕴含 'solo'、'long_hair' 蕴含 'hair'。
-- 编译器靠它做"标签收敛"，避免把蕴含关系当并列关系全写进提示词。
CREATE TABLE IF NOT EXISTS tag_implications (
  tag_id         INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  implied_tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  source_id      TEXT NOT NULL,
  PRIMARY KEY (tag_id, implied_tag_id)
);

-- 1.0 的在线查询缓存表。2.0 起查询纯本地，这张表不再有任何代码会读或写；
-- 旧库打开时顺手清掉（DROP 幂等，只读打开时不会执行）。
DROP TABLE IF EXISTS source_cache;

-- 分析经验。image_hash 是**内容哈希，不是原图**（文档 §11：默认不永久保存原图）。
-- target_profile 是产出该提示词的目标档案（pony-v6 / noobai-xl / illustrious / animagine-xl-4.0），
-- slots_snapshot 保存编译后的槽位结构，供之后按 target_profile 隔离检索与对照。
CREATE TABLE IF NOT EXISTS prompt_experiences (
  id                  INTEGER PRIMARY KEY,
  task_id             TEXT NOT NULL UNIQUE,
  image_hash          TEXT,
  image_meta          TEXT,
  target_model        TEXT NOT NULL,
  target_profile      TEXT,
  detail_level        TEXT NOT NULL,
  positive_prompt     TEXT NOT NULL,
  negative_prompt     TEXT,
  control_suggestions TEXT,
  slots_snapshot      TEXT,
  ir_snapshot         TEXT,
  config_version      TEXT NOT NULL,
  effect_rating       INTEGER,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exp_created ON prompt_experiences (created_at);
CREATE INDEX IF NOT EXISTS idx_exp_model   ON prompt_experiences (target_model);
CREATE INDEX IF NOT EXISTS idx_exp_hash    ON prompt_experiences (image_hash);

-- 经验里用到的标签。tag_id 允许为空、tag_text 必填：
-- 未命中本地库的标签必须原样留下来，不能因为"库里没有"就丢掉（文档 §5.1）。
CREATE TABLE IF NOT EXISTS experience_tags (
  experience_id INTEGER NOT NULL REFERENCES prompt_experiences (id) ON DELETE CASCADE,
  tag_id        INTEGER REFERENCES tags (id) ON DELETE SET NULL,
  tag_text      TEXT NOT NULL,
  role          TEXT NOT NULL,
  importance    REAL,
  PRIMARY KEY (experience_id, role, tag_text)
);
CREATE INDEX IF NOT EXISTS idx_exptag_text ON experience_tags (tag_text);

-- 同步日志。cursor 是断点续传的关键：中断后重跑靠它跳过已完成的页。
CREATE TABLE IF NOT EXISTS source_sync_log (
  id            INTEGER PRIMARY KEY,
  source_id     TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,
  records       INTEGER,
  cursor        TEXT,
  error_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_source ON source_sync_log (source_id, started_at);
`

export const KB_POST_MIGRATION_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tags_kind  ON tags (kind);
CREATE INDEX IF NOT EXISTS idx_exp_profile ON prompt_experiences (target_profile);
`

export const KB_MIGRATION_1_TO_2 = `
ALTER TABLE tags ADD COLUMN zh_name TEXT;
ALTER TABLE tags ADD COLUMN kind TEXT NOT NULL DEFAULT 'general';
ALTER TABLE prompt_experiences ADD COLUMN target_profile TEXT;
ALTER TABLE prompt_experiences ADD COLUMN slots_snapshot TEXT;
${KB_POST_MIGRATION_INDEXES}
`

export const META_KEYS = Object.freeze({
  SCHEMA_VERSION: 'kb_schema_version',
  CREATED_AT: 'created_at',
  LAST_SYNC_CURSOR: 'last_sync_cursor',
})
