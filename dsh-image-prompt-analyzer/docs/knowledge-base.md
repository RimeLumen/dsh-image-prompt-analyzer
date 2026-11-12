# 知识库与数据源

插件自己不生产标签词条。它把**你本机已有的词表**读进自己的 SQLite 库，之后所有解析、
诊断、检索都查这份本地库。词表文件留在原地，插件只读。

v2.3 起支持三种数据源类型，外加一个区分「这源说话算不算数」的 `role`：

| `type` | 是什么 | 路径规则 | 默认 `role` |
| --- | --- | --- | --- |
| `local_file` | 词表文件（CSV / XLSX / DOCX / PDF / TXT / MD） | 必须是插件目录内的相对路径 | `model` |
| `studio_sqlite` | 绘画工作室导出的 `tags.sqlite` | 绝对路径或插件目录内相对路径都行 | `supplement` |
| `local_sqlite` | v2.0 遗留类型，读取 `tags` 表的 `name/category/post_count/zh_name` 四列 | 同上（相对） | `model` |

`role` 只有两个取值：`model` 决定"这个词能不能进提示词"，`supplement` 只用于检索与解释。
不写就按 `type` 推断；写了就以写的为准——随包的中文对照表是 `local_file`，但它必须是
`supplement`，否则一份翻译表会让解释性词条跑进提示词。

## 发布边界

- **插件包不含任何数据库。** `package.json` 的 `files` 里没有 `data/`，也没有任何
  `.sqlite` 文件；发行包里只有导入器和配置模板。工作室的数据库、网页、第三方词条、
  图片都不随插件分发，需要你自己指向本机的那一份。
- **源库只读。** `studio_sqlite` 用 `DatabaseSync(path, { readOnly: true })` 打开，并强制
  `PRAGMA query_only = 1`。导入全程不写源库——有测试在导入前后比对源文件 sha256。
- **源库不在也能跑。** 只要这个源已经导入过（`source_meta.row_count > 0` 或库里有它的
  行），运行期一条提示都不出——日常使用不要求原目录存在。只有"从来没导入过"时才会推
  一条 `KB_STUDIO_SOURCE_MISSING`，告诉你还差这一步。
- **随包的中文对照表不是工作室数据。** `res/studio-zh.csv` 是英文名 ↔ 中文名的对照
  （含翻译状态、弃用标记、标签分组），42455 行、约 3.2 MB，随插件分发。它只补中文名，
  不含工作室的分类树、用户备注、画师目录或任何图片。

## studio 源库的字段契约

适配器（`lib/kb/adapters/studio-sqlite.js`）按下面的映射读 `tags` 表：

| 源库列 | 落到插件库 | 说明 |
| --- | --- | --- |
| `en` | `tags.name` / `tags.canonical_name` | 规范名，统一小写、空格转下划线 |
| `zh` | `tags.zh_name` | 允许为空；为空就是没有中文名，不编一个 |
| `category` | `tags.native_category` | 经 `normalizeNativeCategory` 归一，再由 `inferTagKind` 推出 kind |
| `post_count` | `tags.post_count` | 排序与"这个词有多常见"的依据 |
| `aliases` | `tag_aliases` | 分隔符认空格、逗号（中英）、顿号、分号、竖线；指向自己的别名丢掉 |
| `deprecated` | `tags.deprecated` | 1 表示源库已声明废弃，查询默认跳过，但保留以便解释 |
| `tag_group` | `tags.tag_group` | 源库的浏览分组，只用于展示与检索 |
| `translation_status` | `tags.translation_status` | 中文名的可信度，编译器不按它取舍 |
| `updated_at` | `tags.updated_at` | 缺失时用导入时间兜底 |

必需列只有三列：`en`、`category`、`post_count`。其余列缺了照样能导，缺哪些会写进
`source_meta` 的体检结果里。

另外两张表会一起带过来：

- `user_categories` + `user_category_tags` → `source_user_categories`（每个分类下有多少标签）。
  配置里写 `import_user_categories: false` 可以跳过。
- 整个文件的 `sha256` 记为 `source_meta.fingerprint`，`tags` 表的列名与类型拼起来算一个
  `schema_hash`。这两个值是判断"要不要重导"的依据。

## 分类树：1208 个分类、12873 条归属

工作室的分类树分两半，各存各的：

| 来源 | 提供什么 | 落到哪里 |
| --- | --- | --- |
| `ui/visual-index-seed.json` + `ui/wiki-section-seed.json` | 分类 ID、名字、父子层级 | 合并进 `studio_categories` |
| 源库 `user_categories` | 排序、分类本身 | `studio_categories`（与种子按 ID 合并） |
| 源库 `user_category_tags` | 哪些标签挂在哪个分类下 | `studio_category_tags` |

发行版实测：种子 1198 个节点，源库 1208 个分类（多出的 10 个是种子里没有的独立分类，
按根节点处理），12873 条标签归属，覆盖 1014 个分类。导入后 `studio_categories` 就是
1208 行、`studio_category_tags` 12873 行——与源库一致，一条不多一条不少。

三个设计决定：

1. **存 `tag_name` 不存源库 `tag_id`。** 两个库的 ID 不是一套编号，存源库 ID 等于埋一个
   对不上的雷。名字是唯一的对接点，反正导入时已经归一过。
2. **种子与源库按 ID 对齐，但只在同名时采用父子关系。** ID 对得上、名字对不上，说明两边
   不是同一版；这时候硬接会把标签挂到不相干的分类下面，比没有层级更糟。名字对不上的
   数量记在 `stats.seed_mismatch` 里，不静默。
3. **分类树不进 `tag_categories`。** 那是编译槽位（`clothing` / `pose_action` 这些），
   工作室分支（`制服和服装` / `标记的动词列表`）是浏览用的，混进去会让编译器多出一堆
   它不认识的分类。两张表各管各的，检索时再按 `tag_name` 连起来。

`import_user_categories: false` 会连分类树一起跳过——它读的是同一批源库表。

## 迁移一次，之后独立使用

工作室词库的定位是「一次迁移，之后不用管」：

1. 把 `studio_sqlite` 源的 `path` 指向本机的 `tags.sqlite`，运行一次导入；
2. 导入会把标签、中文名、别名、原生分类、作品数、弃用标记、翻译状态、用户分类、
   分类树层级与标签归属全部写进插件自己的库；
3. 之后搜索、解释、分类导航、词篮编译只读插件库，**原目录可以删掉、改名、拔掉移动硬盘**。

分类树也是这么处理的：导入时把 `ui/visual-index-seed.json` 与 `ui/wiki-section-seed.json`
的层级和源库的 `user_categories` 合起来写进 `studio_categories` / `studio_category_tags`，
运行时从表里拼树，不再回头读那两个 JSON。

想更新就在原目录还在的时候再导一次。指纹没变会直接跳过（`KB_IMPORT_SOURCE_UNCHANGED`）；
指纹变了会整源替换；**中途失败会回滚，旧数据一个字节都不少**。

## 数据放在哪

插件库不在插件包内——整包升级会把包内文件换掉，数据放那里等于每次升级都清空。

| 平台 | 默认位置 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\dsh-image-prompt-analyzer\` |
| macOS | `~/Library/Application Support/dsh-image-prompt-analyzer/` |
| Linux | `$XDG_DATA_HOME/dsh-image-prompt-analyzer/` 或 `~/.local/share/…` |

`storage.database_path` 写相对路径时相对这个目录（默认 `knowledge.sqlite3`），也可以填
绝对路径。CLI 脚本用同一个规则，要临时换位置就设环境变量
`DSH_IMAGE_PROMPT_ANALYZER_DATA_DIR`。

老版本把库放在包内 `data/` 的，第一次以新版本启动时会自动复制到用户数据目录
（目标已存在则跳过，不会覆盖你后来新建的库）。

## 配置怎么写

```json
{
  "schema_version": "2.1",
  "sources": [
    { "source_id": "illustrious-tags", "type": "local_file", "enabled": true, "format": "csv", "path": "res/illustrious_tags_no_artist.csv" },
    {
      "source_id": "studio-tags",
      "type": "studio_sqlite",
      "enabled": true,
      "path": "G:/绘画工作室/绘画工作室-公开版-2026-11-10/data/tags.sqlite",
      "import_user_categories": true,
      "force": false
    }
  ],
  "lookup": { "mode": "local_only", "studio_fallback": false }
}
```

`studio_sqlite` 不写 `format`、也不写 `column_map`——列结构由适配器按上面的契约读。
真写了会得到一条 `KB_SOURCE_FIELD_IGNORED` 警告，而不是静默忽略。

## 导入、幂等与失败保护

导入分三步，顺序是刻意的：

1. 打开源库体检、算指纹（此时插件库一个字节都没动）；
2. 把标签、别名、用户分类全部读进内存；
3. 一个事务里删掉这一源的旧行、写新行、记指纹、写分类。

任何一步抛错，事务回滚，库里仍是上一份快照。**导入失败不会留下半份数据。**

幂等靠指纹：源文件 sha256 与上次导入记录一致时直接跳过，返回 `unchanged: true` 并推
`KB_IMPORT_SOURCE_UNCHANGED`。想强制重导（换了分类规则、想重建归属）就把配置里那条源
的 `force` 设成 `true`，或者调用时带 `force`。

命令行：

```bash
# 直接导一个工作室库（扩展名是 .sqlite / .sqlite3 / .db 时自动按 studio_sqlite 处理）
node scripts/import-tags.mjs --file "G:/绘画工作室/绘画工作室-公开版-2026-11-10/data/tags.sqlite"

# 按配置里声明的源导（只跑 local_file 与 studio_sqlite）
node scripts/import-tags.mjs --source studio-tags

# 试跑，只统计不写库
node scripts/import-tags.mjs --file ".../tags.sqlite" --dry-run

# 无视指纹强制重导
node scripts/import-tags.mjs --file ".../tags.sqlite" --force
```

工具侧用 `rebuild_knowledge_base`，`sources` 指定 source_id，`dry_run` 只统计：

```json
{ "sources": ["studio-tags"] }
```

## 查询：模型词表与补充词典是两件事

- **模型词表**（`local_file` / `local_sqlite`）决定"这个词能不能进提示词"。
- **补充词典**（`studio_sqlite`）默认只做中文检索与解释，不参与判定。

`lookup.studio_fallback` 为 `false`（默认）时，工作室里独有的词对编译来说仍然是"没收录"：
正稿一个字都不变，只在报告里多一条 `COMPILE_STUDIO_SUPPLEMENT_HINT`，附带中文名、
分组与翻译状态，方便你自己判断要不要换词。开了 `studio_fallback` 之后，命中会标
`source: "studio"`、`fallback: true`，并带上 `source_id`，`mode` 也从 `local_only` 变成
`local_with_studio`。

无论开关如何，`deprecated = 1` 的词都不会被命中——它留在库里只为了在报告里解释
"这个词为什么不能用"。

中文检索走 `searchStudio(query)`：按中文名或英文名做 LIKE，排序是未废弃优先、热度降序。

## 诊断

`diagnose_knowledge_base` 对 `studio_sqlite` 会额外体检：文件字节数、sha256、schema_hash、
总行数 / 可用行数 / 废弃行数、已审核翻译条数、用户分类数、有没有 FTS、更新时间范围、
缺了哪些可选列，以及和上次导入的指纹差。

| 错误码 | 级别 | 含义 |
| --- | --- | --- |
| `KB_STUDIO_SOURCE_MISSING` | 警告 | 配置里开着的工作室源还没导入过，且文件不存在 |
| `KB_STUDIO_NOT_IMPORTED` | 警告 | 文件在，但这一源还没导入过 |
| `KB_STUDIO_STALE` | 警告 | 源库指纹变了，插件库里还是旧快照 |
| `KB_IMPORT_SOURCE_UNCHANGED` | 提示 | 指纹没变，这次跳过，没有重写任何行 |
| `COMPILE_STUDIO_SUPPLEMENT_HINT` | 提示 | 工作室有这个词，但它不算模型词表命中 |
| `KB_SOURCE_FIELD_IGNORED` | 警告 | studio 源上写了不生效的 `format` / `column_map` |

## 版本迁移

插件库的 schema 走到 2.3，一路都是自动迁的：

| 版本 | 加了什么 |
| --- | --- |
| 2.0 → 2.1 | `tags` 加 `deprecated` / `tag_group` / `translation_status` 三列，新增 `source_meta` 与 `source_user_categories` 两张表，加一条 `deprecated` 索引 |
| 2.1 → 2.2 | 新增 `studio_categories` 与 `studio_category_tags` 两张表（工作室分类树与标签归属），加三条索引 |
| 2.2 → 2.3 | `source_meta` 加 `role`（模型词表 / 补充词典）与 `coverage`（这次导入落了哪些字段、差在哪） |

打开旧库时会按版本号一步步往上迁，每一步推一条 `CONFIG_SCHEMA_VERSION_MIGRATED` 诊断；
遇到不认识的版本号宁可打不开，也不猜着迁。
