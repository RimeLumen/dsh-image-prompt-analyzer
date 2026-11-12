
export const KB_SCHEMA_VERSION = '2.3'

// 2.1 / 2.2 加的四张表抽成常量。
// 老库升级时 KB_DDL 不会重跑，只能靠迁移语句补建；抽出来两边共用一份定义，
// 免得"新建的库"和"升上来的库"长出两种表结构。
//
// DDL_SOURCE_META_2_1 是 2.1 当时的样子（还没有 role / coverage）：
// 迁移必须按当年那一版建表，否则紧接着的 2.2→2.3 ALTER 会撞上"列已存在"。
const DDL_SOURCE_META_2_1 = `
CREATE TABLE IF NOT EXISTS source_meta (
  source_id                TEXT PRIMARY KEY,
  kind                     TEXT NOT NULL,
  adapter                  TEXT,
  adapter_version          TEXT,
  declared_path            TEXT,
  resolved_path            TEXT,
  fingerprint              TEXT,
  bytes                    INTEGER,
  schema_hash              TEXT,
  row_count                INTEGER,
  deprecated_count         INTEGER,
  imported_row_count       INTEGER,
  translation_status_counts TEXT,
  tag_group_counts         TEXT,
  imported_at              TEXT NOT NULL,
  extra                    TEXT
);`

// 2.1 新增：每个外部源库的指纹与统计。
// 源库在插件目录之外、用户随时会换，光看 path 认不出"这次导入的是不是上次那个文件"。
// fingerprint 是源文件内容的 sha256；schema_hash 是 tags 表列定义的哈希。
// 重复导入时两者与 row_count 都不变，就直接跳过，不再重写六万行。
const DDL_SOURCE_META = `
CREATE TABLE IF NOT EXISTS source_meta (
  source_id                TEXT PRIMARY KEY,
  kind                     TEXT NOT NULL,
  -- model：决定"这个词能不能进提示词"的词表；supplement：只解释、不判定。
  -- NULL 视为按源类型推断（见 lib/kb/role.js），旧库升级后行为不变。
  role                     TEXT,
  adapter                  TEXT,
  adapter_version          TEXT,
  declared_path            TEXT,
  resolved_path            TEXT,
  fingerprint              TEXT,
  bytes                    INTEGER,
  schema_hash              TEXT,
  row_count                INTEGER,
  deprecated_count         INTEGER,
  imported_row_count       INTEGER,
  translation_status_counts TEXT,
  tag_group_counts         TEXT,
  imported_at              TEXT NOT NULL,
  -- 2.3 新增：这一份导入到底落下了什么。字段数对不上时用它解释差在哪，
  -- 而不是让使用者自己猜"是不是丢了几千条"。
  coverage                 TEXT,
  extra                    TEXT
);`

// 2.1 新增：外部源库自带的"用户分类"（工作室词典的 1208 个自定义分组）。
// 这些分组不属于插件的 15 个内部分类，塞进 tag_categories 会污染编译器的槽位判断，
// 所以单独存：只留名字、排序与成员数，标签解释与浏览用得到，编译不读它。
const DDL_SOURCE_USER_CATEGORIES = `
CREATE TABLE IF NOT EXISTS source_user_categories (
  source_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  sort_order  INTEGER,
  tag_count   INTEGER,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (source_id, name)
);`

// 2.2 新增：工作室分类树（含 ID、父子关系、深度、排序）。
// 这是 1208 个分类的权威表：source_user_categories 只留名字与成员数给诊断用，
// 层级与 ID 在这里。studio_id 是工作室自己的分类 ID（种子文件与 user_categories 共用同一套编号，
// 发行版实测 1208 个分类里 1198 个能在种子树里找到同名同 ID 的节点）。
const DDL_STUDIO_CATEGORIES = `
CREATE TABLE IF NOT EXISTS studio_categories (
  source_id   TEXT NOT NULL,
  studio_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  parent_id   TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  depth       INTEGER NOT NULL DEFAULT 0,
  tag_count   INTEGER NOT NULL DEFAULT 0,
  origin      TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (source_id, studio_id)
);`

// 2.2 新增：分类 → 标签的归属（发行版基线 12873 条）。
// 存 tag_name 而不是源库的 tag_id：源库 ID 与插件库 tags.id 不是一套编号，
// 而标签名是导入时唯一稳定对得上的键。
const DDL_STUDIO_CATEGORY_TAGS = `
CREATE TABLE IF NOT EXISTS studio_category_tags (
  source_id      TEXT NOT NULL,
  studio_id      TEXT NOT NULL,
  tag_name       TEXT NOT NULL,
  studio_tag_id  TEXT,
  PRIMARY KEY (source_id, studio_id, tag_name)
);`

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
--
-- 2.1 起多三列，都是"来源自己声明的状态"，不是插件推断的：
--   deprecated          源库标了废弃（Danbooru 的 deprecated=1）。查询默认跳过，
--                       但它仍然留在库里，标签解释要能说清"这个词已经不用了"。
--   tag_group           源库的浏览分组（服装与饰品 / 头发与五官 / 待归类 …）。只做展示与检索用。
--   translation_status  中文名的可信度（machine_draft_1 / wiki_definition_reviewed / curated …）。
--                       编译器不按它取舍，报告里用它说明"这个中文是机器初稿"。
CREATE TABLE IF NOT EXISTS tags (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  canonical_name     TEXT NOT NULL,
  source_id          TEXT NOT NULL,
  native_category    TEXT,
  post_count         INTEGER,
  zh_name            TEXT,
  kind               TEXT NOT NULL DEFAULT 'general',
  deprecated         INTEGER NOT NULL DEFAULT 0,
  tag_group          TEXT,
  translation_status TEXT,
  updated_at         TEXT NOT NULL,
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
-- 外键是开着的（node:sqlite 默认 enableForeignKeyConstraints: true），
-- 所以删一行 tags 会去 tag_aliases 里找 ON DELETE CASCADE 的子行。
-- tag_id 上没有索引时那是全表扫描：删一个 58519 行的数据源要 91 秒，
-- 看起来像卡死。这三个索引是给级联用的，不是给查询用的。
CREATE INDEX IF NOT EXISTS idx_alias_tag ON tag_aliases (tag_id);

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
-- 主键已经覆盖 tag_id；implied_tag_id 没有索引，级联删 tags 时同样要全表扫。
CREATE INDEX IF NOT EXISTS idx_tagimpl_implied ON tag_implications (implied_tag_id);

-- 1.0 的在线查询缓存表。2.0 起查询纯本地，这张表不再有任何代码会读或写；
-- 旧库打开时顺手清掉（DROP 幂等，只读打开时不会执行）。
DROP TABLE IF EXISTS source_cache;

-- 分析经验。image_hash 是**内容哈希，不是原图**（文档 §11：默认不永久保存原图）。
-- target_profile 是产出该提示词的目标档案（illustrious / anima），
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
-- 同上：删 tags 时要按 tag_id 把这里的引用置空，没有索引就是全表扫。
CREATE INDEX IF NOT EXISTS idx_exptag_tag ON experience_tags (tag_id);

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

${DDL_SOURCE_META}
${DDL_SOURCE_USER_CATEGORIES}
${DDL_STUDIO_CATEGORIES}
${DDL_STUDIO_CATEGORY_TAGS}
`

export const KB_POST_MIGRATION_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tags_kind  ON tags (kind);
CREATE INDEX IF NOT EXISTS idx_exp_profile ON prompt_experiences (target_profile);
CREATE INDEX IF NOT EXISTS idx_studio_cat_parent ON studio_categories (source_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_studio_cat_name   ON studio_categories (source_id, name);
CREATE INDEX IF NOT EXISTS idx_studio_cat_tag    ON studio_category_tags (source_id, tag_name);
`

export const KB_MIGRATION_1_TO_2 = `
ALTER TABLE tags ADD COLUMN zh_name TEXT;
ALTER TABLE tags ADD COLUMN kind TEXT NOT NULL DEFAULT 'general';
ALTER TABLE prompt_experiences ADD COLUMN target_profile TEXT;
ALTER TABLE prompt_experiences ADD COLUMN slots_snapshot TEXT;
${KB_POST_MIGRATION_INDEXES}
`

// 2.0 → 2.1：只加列，不改旧列语义。
// 旧行拿到 deprecated=0（"来源没说它废弃"），tag_group/translation_status 为 NULL，
// 这样 2.0 时代的查询结果在 2.1 上一模一样。
// source_meta / source_user_categories 是 2.1 才有的表，升级路径上必须一起补建：
// 老库不会重跑 KB_DDL，少了这一步，后面的 2.2→2.3 会 ALTER 一张不存在的表。
export const KB_MIGRATION_2_0_TO_2_1 = `
ALTER TABLE tags ADD COLUMN deprecated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tags ADD COLUMN tag_group TEXT;
ALTER TABLE tags ADD COLUMN translation_status TEXT;
CREATE INDEX IF NOT EXISTS idx_tags_deprecated ON tags (deprecated);
${DDL_SOURCE_META_2_1}
${DDL_SOURCE_USER_CATEGORIES}
`

// 2.1 → 2.2：只加两张新表，旧表一个字节都不动。
// 分类树与标签归属单独存，编译器的 tag_categories 仍然只认插件自己的 15 个内部分类。
export const KB_MIGRATION_2_1_TO_2_2 = `
${DDL_STUDIO_CATEGORIES}
${DDL_STUDIO_CATEGORY_TAGS}
CREATE INDEX IF NOT EXISTS idx_studio_cat_parent ON studio_categories (source_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_studio_cat_name   ON studio_categories (source_id, name);
CREATE INDEX IF NOT EXISTS idx_studio_cat_tag    ON studio_category_tags (source_id, tag_name);
`

// 2.2 → 2.3：source_meta 加两列，旧行拿到 NULL。
// role 让"模型词表"和"补充词典"不再靠 type 猜（local_file 既可以是模型词表，
// 也可以是随包发布的中文对照表）；coverage 记下这次导入落了多少字段。
export const KB_MIGRATION_2_2_TO_2_3 = `
${DDL_SOURCE_META_2_1}
ALTER TABLE source_meta ADD COLUMN role TEXT;
ALTER TABLE source_meta ADD COLUMN coverage TEXT;
`

export const META_KEYS = Object.freeze({
  SCHEMA_VERSION: 'kb_schema_version',
  CREATED_AT: 'created_at',
  LAST_SYNC_CURSOR: 'last_sync_cursor',
})
