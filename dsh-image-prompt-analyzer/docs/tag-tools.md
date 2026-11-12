# 检索、解释、词篮：三个不吃图只吃词的入口

插件只有两种写法，别把它们混成一个"生成提示词"的按钮：

| 模式 | 入口 | 输入 | 输出 |
| --- | --- | --- | --- |
| **图片反推** | `analyze_image_prompt` | 一张图 | 一条正向 + 一条反向，事实来自图里看得见的东西 |
| **基于用户标签的编写** | `compile_tag_basket` | 用户自己挑的词 | 一条正向 + 一条反向，不需要图 |
| **基于自然语言需求的编写** | `write_caption` | 一段中文或英文的画面需求 | 一段 Caption（仅 `caption` 档，即 MOSS） |
| **已有 Caption 的局部修改** | `revise_caption` | 原文 + 一句「从 A 改成 B」 | 只改那一处的 Caption（仅 `caption` 档） |

前两条路共用同一条编译链路（分类 → 槽位 → 词库解析 → 预算 → 渲染 → 抑制词），所以同一批词，
词篮编出来的写法与反推得到的是同一套。区别只在上游：一个是视觉分析产出的事实，一个是人写的词。

第三条不共用那条链路：它不走词表、不拆标签、不排序，用户写的句子原样成文，只摘掉质量词。
细节见 [moss-caption.md](moss-caption.md)。

下面三个工具（`search_tags` / `explain_tag` / `compile_tag_basket`）不吃图，只吃词。

## 中文需求怎么走到提示词

按目标模型分两种情况，别混着看：

**MOSS（`caption` 档）**：直接写。`write_caption` 吃一段中文需求，原样交出一段中文 Caption，
不拆词、不翻译、不润色。中文需求 → 中文 Caption，一步。

```
"穿女仆装的长发女孩站在雨里的车站"  →  write_caption  →  同一句话 + 官方四条负向
```

**Illustrious / Anima（`tag` / `prose` 档）**：仍然没有"把一段自由文本改写成标签流"的能力，
也不打算假装有。能走通的是三步：

```
中文需求  → 拆成词  → search_tags 查成英文规范名  → compile_tag_basket 编译
"穿女仆装的长发女孩"      ["女仆","长发"]        maid / long_hair          正向 + 反向
```

拆词这一步由人（或对话模型）完成，插件不猜。好处是每一步都能核对：查到的词对不对、
换名换了哪些、哪些词词库里没有，全部写在返回里。整条链路有测试覆盖
（`中文需求：拆成词 → 查成英文规范名 → 编译成提示词`）。

不想拆也可以直接把中文原词丢进词篮，`basket.renamed` 会告诉你换成了什么。

## search_tags：中文也能搜

```json
{ "query": "女仆", "limit": 10, "scope": "tags" }
```

返回每条结果都带四样东西：`source`（`model` 模型词表 / `studio` 补充词典）、`source_id`（具体哪条源）、
`match`（`exact` / `alias` / `prefix` / `contains`）、`matched_field`（`name` / `zh_name` / `alias`）。
模型词表与补充词典**各留一条，不合并**——同名同词在两个源里是两个事实，合并会丢信息。

结果里还有三样容易看错的：

| 字段 | 是什么 | 不是什么 |
| --- | --- | --- |
| `post_count` | 源库里这个词的**作品数** | 不是画质分，不是推荐度；冷门词也可能正是你要的 |
| `model_overlap` / `model_sources` | 这个词在模型词表里有没有同名同拼写的条目 | 不是"模型认这个词"，只是词表收录 |
| `studio_categories` | 这个词挂在工作室哪几个分支下 | 不是编译槽位，不影响排序 |

`scope` 三档：

| 取值 | 查什么 |
| --- | --- |
| `tags`（默认） | 只查词条 |
| `tree` | 只查分类树分支 |
| `both` | 两边都查 |

分类树来自工作室包里的 `ui/visual-index-seed.json` 与 `ui/wiki-section-seed.json`，
合并后是一个单一根的分层树（发行版里是 1198 个节点）。

**分类树有两套用途，别混**：`scope:"tree"` 查的是种子里的**层级**（1198 个节点）；
`category` 过滤查的是源库里的**标签归属**（1208 个分类、12873 条归属，存在
`studio_categories` / `studio_category_tags` 两张独立表里）。前者回答"有哪些分支"，
后者回答"这个分支下挂了哪些词"。归属数据不进 `tag_categories`，所以它不影响编译时
落在哪个槽位。

### 四个筛子

```json
{ "query": "女仆", "category": "制服和服装", "deprecated": "exclude",
  "translation_status": "manual", "profile": "illustrious" }
```

| 参数 | 作用 | 边界 |
| --- | --- | --- |
| `category` | 按工作室分类名或 ID 过滤（名字是模糊匹配，`画面构图` 会连带 `画面构图与风格`） | 需要已导入 `studio_sqlite`；找不到分类时**不静默放行**，会推一条 `KB_SEARCH_CATEGORY_NOT_FOUND` 然后照常查 |
| `deprecated` | `exclude`（默认）/ `only` / `include` | 废弃词的别名同样按这个筛，不会从别名侧漏出来 |
| `translation_status` | 按中文名的翻译状态精确筛，如 `machine_draft_1` / `curated` / `manual` | 只筛工作室侧；模型词表没有这个字段 |
| `profile` | 只收窄**模型词表**那一侧，如 `anima` / `illustrious` | 补充词典不区分档案——它解释的是词本身。认不出档案名会推 `KB_SEARCH_PROFILE_VOCAB_UNKNOWN` 并退回不过滤 |

`profile` 的匹配方式是按数据源名里的家族名找（`anima-tags` 命中 `anima`），
因为词表本身不声明自己服务哪个档案；写死一张映射表，换源名时会悄悄失效。
`moss` 是 Caption 档案，没有标签词表，所以它的模型侧是空的——这是对的。

## explain_tag：这个词到底是什么意思

```json
{ "tag": "女仆", "target_profile": "illustrious" }
```

命中顺序是 `name` → `alias` → `zh_name`。中文名排在最后，且只认精确相等：
中文名不是标签的身份，它只是"用户拿中文找词"的入口，同名中文可能对应多个英文标签。

不传 `target_profile` 就不猜写法，只给词库事实；传了才多一段 `rendering`，
说明这个档案会用哪种写法（`spaced` / `prose` / `caption`）、落在哪个槽位、最终写成什么。

查不到时不会只回一个 `found: false`，会带上几条近义词建议。

## compile_tag_basket：把词篮编成提示词

```json
{ "tags": ["1girl", "女仆", "long_hair"], "target_profile": "illustrious" }
```

最多 80 条，重复的自动去重，分类可以在词上标 `{ "tag": "maid", "category": "clothing" }`。

用户亲手挑的词按满重要度处理，不会被预算挤掉——预算是拿来砍视觉分析里那些低置信度推测的，
不是拿来砍人自己写的词的。

中文词会先换成词库里的英文名再进提示词，换过哪些逐条列在 `basket.renamed` 里。
注意 `terms[].status` 对中文词仍然是 `miss`：任务层只查英文名与别名，换名发生在编译前一步，
所以看的是 `terms[].emitted`。

**Caption 档案（moss）编不出词篮。** 词篮是标签流，里面没有"主体在做什么、画面怎么摆"这类
自然语言事实，Caption 档案必然报 `COMPILE_MOSS_CAPTION_EMPTY`。这种情况工具会补一条
`COMPILE_BASKET_CAPTION_NEEDS_FACTS`，把话说清楚：要 MOSS 的 Caption，用
`analyze_image_prompt` 反推一张图。

## 反推结果里的词典解释

`analyze_image_prompt` 默认不带词典解释——一次分析四十个词，每个词几十字，是很大一段。
要的时候显式传 `explain_terms: true`，结果里会多一个 `explanations` 数组，每项含
中文名、来源、翻译状态、`via_alias`（是拿别名认出来的），以及 `supplement_only`
（只是补充词典的线索，没进提示词）。`source_id` 指回具体数据源，方便核对。

解释只解释：词库里认识、但这张图没观察到的词，一个都不会进提示词。反过来也成立——
`explanations` 不会因为词库里有更多词而变长，它只覆盖 IR 里已经有的观察。

只想查一个词就用 `explain_tag`，比开一整个分析的开关便宜。

**Caption 档案（moss）另说。** Caption 由 IR 里的事实写成，词库只帮忙查英文名和中文解释，
不参与写作：不会把标签流塞进 Caption，也不会凭词典补出区域、动作或人物身份。
`caption_language` 在视觉分析开始前就定下来，事后不能靠词库改语言。

## 一个容易误会的地方

接上工作室词库以后，分析结果**不会**因此改变。工作室命中在编译时等同未命中：
提示词里写什么，仍然由模型词表决定。工作室数据在这里的作用是"告诉你这个词中文叫什么、
大概什么意思、属于哪个浏览分支"，不是"替你换词"。

要让它真的参与编译，得在配置里显式打开 `lookup.studio_fallback`。
