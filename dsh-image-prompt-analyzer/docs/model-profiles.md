# 模型档案与提示词写法

插件把「反推出的 IR」编译成目标模型能吃的提示词。同一份 IR 可以编译成不同写法，
差别由档案里的 `tag_standard.word_style` 决定，而不是由工具参数决定。

当前内置三份档案：

| 档案 | `config_id` | 写法 | `prompt_style` | 适合的模型 |
| --- | --- | --- | --- | --- |
| Anima | `anima` | 成分句（把标签串成句子） | `prose` | Anima / Animagine XL 4.0 一类的 prose 档 |
| Illustrious | `illustrious` | Danbooru 标签流 | `tag` | Illustrious / 光辉系 SDXL |
| MOSS-Image | `moss` | 完整 Caption（连贯自然语言） | `caption` | OpenMOSS 的 MOSS-Image Base / SFT |

`prompt_style` 只有这三个值，工具返回里也只有这三个值。三档各自独立编译，
互不翻译对方的成品。

MOSS 还有一层可选的 JSON Layout 输出，它不是第四种 Profile，也不是第四个
`prompt_style` 值——它是在 `caption` 之上多排一层结构化元素，用结果信封里的
`prompt_format` 区分（`caption` / `layout_json`）。详见下面的「JSON Layout」。

## 档案管写法，词表管收录

这两件事在 v2.1 里是分开的，混在一起会同时搞坏两样东西：

- **档案**（`configs/model-profiles/*.json`）只决定**怎么写**：标签流还是成分句、槽位顺序、
  质量词与评分词、负向条数、权重语法、角色名格式。它不提供词条，也不判断某个词是否
  存在于训练分布里。
- **词表**（知识库的 `local_file` 源）决定**收不收录**。Illustrious 与 Anima 各自用自己的
  词表，两者互不覆盖；`unknown_tag_policy` 一律是 `description_only`，即词表里没有的词
  只写进描述、不硬塞成标签。

绘画工作室的词库（`studio_sqlite`）**不是第四种模型词表**。它默认只做中文检索与解释，
不参与编译；即使显式打开 `lookup.studio_fallback` 让它参与，命中也标 `source: "studio"`，
不会因此把某个词算成 Illustrious 或 Anima 认识。接入它**不扩大任何一份档案的兼容性声明**：
`source_confidence`、别名列表、负向条数、槽位规则一个都没动。

Anima 与 Animagine XL 4.0 是同一份档案：`anima` 的别名里同时登记了 `animagine-xl-4.0`、
`animaimage`、`animagine`、`animagine-xl`，`word_style` 是 `prose`。档案不按文件名猜版本，
也不为旧名另建一份。

## 三档的差别

- **`tag`（Illustrious）**：逗号分隔的 Danbooru 标签，带权重语法 `(cowboy shot:1.1)`。
  标签词库（知识库）参与解析，档案里带 11 条负向。
- **`prose`（Anima）**：仍以标签为原料，但由 `lib/compile/compose.js` 的成分句
  把它们串成句子。质量词、评分词照常出现在正稿里，因为 Anima 的训练分布吃这些。
- **`caption`（MOSS）**：由 `lib/compile/moss.js` 从 IR 事实直接写成一段连贯描述。
  不查标签词库、不加权重、不写质量词与评分词；负向只有官方那几条。

MOSS 之所以不复用 Anima 的 `prose`：`prose` 的目标是「把标签写得像句子」，
MOSS 要的是「描述最终画面里有什么」。它读得懂空间关系（谁在谁左边、手搭在椅背上、
前景花枝遮住主体）、构图和光照，把这些拆成互不相关的逗号词，等于把 MOSS 唯一比
CLIP 强的能力扔掉。

## MOSS Caption 的编译规则

官方依据（哪条是官方写死的、哪条是从示例归纳的、哪条是本插件自己的选择）、三个
入口的对照、以及交付核对，都在 [moss-caption.md](moss-caption.md) 里。本节只讲
编译规则本身。

### 三个入口

反推、编写、局部修改是三条路，事实来源不同，不能互相顶替：

- **图片反推**（`analyze_image_prompt`，`target_profile: moss`）：事实来自图片，
  不借润色增加画面内容。
- **自然语言需求**（`write_caption`）：事实来自用户那句话，原样成文，不扩写、
  不润色、不补细节，只摘掉质量词并判语言。
- **局部修改**（`revise_caption`）：事实来自原文 + 一句「从 A 改成 B」，只替换被点名
  的那一处属性值，其余字符逐字不动；目标不唯一时报歧义并列出候选，不替用户选。

`compile_tag_basket` 在 `moss` 档案下会失败（`COMPILE_BASKET_CAPTION_NEEDS_FACTS`）。
一篮标签里没有「谁握着什么」，硬编成 Caption 只能得到一串逗号词或一段插件自己
编的关系——两者都比直接报错危险。

### 语义顺序

一段 Caption 按下面的顺序组织，缺哪类事实就跳过哪一类：

1. 主体与外观、服装（同一句，外观用 `with ...` 挂在名词后）
2. 画面里的其他人（每人一句，外观与服装各归各家；写不下时报不完整并列出省略项）
3. 表情
4. 姿态与肢体动作
5. 空间关系（谁握着什么、谁在谁身后）
6. 构图与取景
7. 镜头角度
8. 背景环境
9. 光照与色彩
10. 艺术风格（`detail_level: minimal` 时不写）
11. 画面里的文字（逐字保留原文）

关系句的归属规则：画面只有一个人时用主体代词（`Her right hand holds the umbrella
handle.`）；有第二个人时点名归属（`The other girl's left hand holds a folded fan.`）；
`from` 是物件时（箱子放在脚边）不补主语，直接成句。关系不经过词表校验——词表里
没有 `holding_umbrella`，不影响「右手握着伞柄」进 Caption。

### 依据边界

- 只用 IR 里有的事实。连接词、冠词、代词可以补，内容词不能补。
- `verifyCaptionGrounding()` 逐词核对：不在任何 IR 事实里、也不属于语法骨架词
  （`CAPTION_SCAFFOLDING`）的词会被列进 `unsupported`，并产生
  `COMPILE_MOSS_CAPTION_UNGROUNDED` 诊断（INFO 级，留在 trace 里）。
- 词形差异不算「没依据」：大小写、单复数（`blouse` / `blouses`）、连字符与下划线
  （`silver-haired` 拆成两个词分别核对）、所有格（`girl's` 的 `s` 会被长度过滤掉）
  都按同一个词处理。核对时给每个词几个候选形态，任何一条命中事实就放行。
- 不做词干还原。`holding` → `hold` 需要词典，猜错的方向是把「没写的」判成「写过」；
  这里的错判必须保守，宁可多报一个待验证词，也不能放过幻觉。
- 低置信度、被否定的观察在 `describe.js` 那层就已经被剔掉，Caption 拿不到它们。
- 画面里的文字是**内容**不是观察，所以绕过英文过滤直接取原文：招牌上的中文
  照抄中文，不翻译、不转小写。它同时是一条事实，因此不会被 grounding 拦下；
  但凭空写一句 IR 里没有的文字照样会被拦。

### 不重复

- 同一件事只说一次：`long hair` 被 `long silver hair` 包含时后者留下。
- 一句话只用一种句式。外观跟主体同句，服装另起一段，不把同一件衣服说两遍。

### 负向

基线就是官方那四条：

```
worst quality, bad anatomy, watermark, jpeg artifact
```

- `nsfw` 只在**用户显式声明全年龄**时才补（IR 里 `quality_style.rating` 的
  `source` 必须是 `user_correction`）。模型自己判的 `safe` 不触发。
- 正文里已经写过的东西不会同时出现在负向里（MOSS 对自相矛盾的输入敏感）。
- 上限 6 条。不搬 Illustrious 的大段 Danbooru 负向：MOSS 吃自然语言，一长串
  标签式负向既不在训练分布里，又会把「这次真正要排除的那一件事」稀释掉。

### 版本识别

`moss` 档案的别名覆盖 `moss-image`、`moss-image-base`、`moss-image-sft`、
`openmoss`、`moss image`。Base 与 SFT 共用同一套 Caption 规则，不为它们各建一份
模板；档案不按文件名猜版本。

### 语言

MOSS 官方推荐英文（训练数据更多），也支持中文。本插件两种都能出：`en`（默认）
与 `zh-CN`。

**中文不是把英文 Caption 翻一遍。** 语言一路推到最上游：

1. 分析开始前先定语言（任务参数 `caption_language` > 档案里的
   `tag_standard.caption_language` > 默认 `en`）。
2. 视觉阶段按这个语言写观察值——选 `zh-CN` 时 Stage A / Stage B 直接写
   `银色长发`、`右手握着伞柄`，而不是写完英文再换。IR 里记一个
   `observation_language`。
3. 编译阶段按同一种语言组织句子。中文走 `lib/compile/moss.js` 里的中文模板，
   句与句之间不加空格，用「画面中的主体是……」「她的表情是……」「构图是……」推进。

整个过程没有第二次视觉调用、没有翻译模型、没有中英双份 IR。

语言对不上就明确失败，不硬凑：拿一份英文 IR 要中文（或反过来），编译报
`COMPILE_MOSS_CAPTION_LANGUAGE_EMPTY`，`caption.ok === false`、正文空串。
唯一正确的做法是用对的语言重新分析那张图——把英文 Caption 翻成中文，句子就
回指不到任何一条观察了，那正是这个档案最不该交的东西。

写法归一：`zh`、`zh_hans`、`cn`、`chinese` 都认成 `zh-CN`；`en-US`、`english`
认成 `en`。认不出的（`fr`、`ja`）不猜，档案校验报
`TAG_STANDARD_CAPTION_LANGUAGE_UNSUPPORTED`，运行期报
`COMPILE_MOSS_CAPTION_LANGUAGE_UNSUPPORTED`。

中文 Caption 只有 Caption 档能出。标签档 / 描述档传 `caption_language=zh-CN`
会得到一条 WARNING 级的 `CAPTION_LANGUAGE_IGNORED`，分析照常按英文跑完——
那两档本来就不写 Caption，没必要为此让整次分析失败。

画面里的文字**逐字保留，不翻译**。招牌上写 `营业中 OPEN 24H`，中文 Caption 里
就是 `画面里有文字「营业中 OPEN 24H」。`——翻译它等于改画面内容。

#### 中英同一事实的对照

同一张图，同一份 IR 结构，只换观察语言：

```
en   The image shows a girl with silver hair and red eyes, wearing a white blouse.
     She has a slight smile. She is standing with weight on one leg.
     The framing is a cowboy shot. The background is a rainy street.
     The image contains the text "营业中 OPEN 24H".

zh   画面中的主体是少女，有着银色长发和红色眼睛，穿着白色衬衫。她的表情是微微的笑。
     她左手抬向镜头，掌心张开，重心落在一条腿上。构图是七分身取景。
     背景是雨中的街道。画面里有文字「营业中 OPEN 24H」。
```

注意三件事：英文那句 `The image contains the text "营业中 OPEN 24H"` 里的中文
原样出现，不是 `the text "OPEN 24 hours"`；中文版的句子顺序与英文版一致（主体 →
外观 → 服装 → 表情 → 姿态 → 关系 → 构图 → 镜头 → 背景 → 光线 → 文字）；两边
都没有补一个 IR 里没有的词。

#### 中文接地怎么校验

英文 Caption 按词核对：每个实词都要能在 IR 事实里找到。中文没有空格分词，
按词核对会把模板补的每个虚词都报成幻觉，放宽成「整句对得上某条事实」又等于
不查。所以中文换一个粒度，**按句子挂着的来源核对**：

1. 每句都必须挂着 IR 来源（observation / relation / entity_label 的 ref）。
   挂不上来源的句子，无论读起来多通顺，都算没有依据。
2. 句子里每个汉字，要么出现在这一句自己挂着的那几条事实里，要么属于句法骨架字
   （的、了、是、在、方面、构图、镜头……）。骨架字只承担句子结构，不指认任何
   画面对象——颜色、材质、物体名一个都不在里面。

`caption.grounding.basis` 因此有两种值：英文是 `ir_facts`（按词），中文是
`clause_sources`（按句子的来源）。

#### Layout 里的中文

`layout` 打开时，只有两处跟着语言变：`summary.caption`（就是 Caption 正文）与
`items[].caption`（元素描述串，中文用中文标点分隔，文字条写成
`画面文字「营业中 OPEN 24H」`）。

`label`、`bbox`、`text`、`bbox_coord_space`、`bbox_format`、`canvas` 一个字都不动。
`label` 来自 IR 的实体标签，中文 IR 里它本来就是中文——那是上游写的，不是 Layout
翻的。文字条的 `text` 永远逐字保留原文。

#### 中文观察下不拼复合标签

`slots` / `keywords` 这两个标签通道里，英文会把手握、穿戴这类关系压成
`holding_umbrella` 这种复合词。中文下这一步直接跳过，并发一条 INFO 级的
`COMPILE_RELATION_COMPOUND_SKIPPED_ZH`：模板是英文动词前缀，套上中文物体标签只会
得到 `holding_黑伞`——两种语言缝在一起，任何词表里都不存在。关系本身没有丢，
它写在 Caption 的中文句子里（`她右手握着伞柄。`）。

### 空 IR 是硬失败

IR 里没有任何能写进 Caption 的事实时，MOSS 编译**失败**，不是退回标签流：

- `register` 仍是 `caption`（不会偷偷变成 `tag`，也不会把目标档案换成 Illustrious）
- `prompts.positive` 是空字符串
- `caption.ok === false`，`stats.caption_ok === false`
- 诊断里有一条 ERROR 级的 `COMPILE_MOSS_CAPTION_EMPTY`

理由：Caption 档的契约就是「给一段描述」。给不出描述时退回标签流，调用方会以为
拿到的是 MOSS 能吃的提示词，实际拿到的是另一个模型的写法——这种「看起来成功」
的失败比直接报错危险得多。

「一条都写不出来」有两种，都会失败，但原因不同，别混着看：

- IR 是空的（没有实体、没有关系、没有观察）——`caption.observation_stats.scanned` 是 0。
- 观察都在，但没有一条能进正向描述（`no umbrella` 这种否定式、`unknown` 这种占位符、
  量测数字，或者观察语言和目标语言对不上时的整批 `non_english`）——`observation_stats`
  会分别给出 `negated` / `placeholder` / `non_english` / `measurement` 的条数。
  这类失败下 `caption.facts_dropped` 是**空的**，因为那些观察根本没进候选池，
  谈不上「排不上」。

### 只算该算的

Caption 档不再执行 `composeFromIR`。那一步是为 `prose` / `tag` 档准备成分句的，
Caption 从 IR 事实直接成句，用不上它。跳过之后 `composed` 与
`description_candidate` 都是 `null`，`stats.composed_clauses` 是 0，
`stats.description_candidate_chars` 是 `null`。Anima 与 Illustrious 两条分支照旧，
trace 台账也照旧读得到它们。

### 输出约定

结果信封里有 `output_contract`，一眼看清这次交了什么：

```json
{
  "word_style": "caption",
  "register": "caption",
  "positive_is_natural_language": true,
  "tags_in_positive": false,
  "tags_available_separately": true,
  "layout_in_positive": false,
  "layout_available": true
}
```

`tags_in_positive: false` 是说标签版内容仍在 `slots` / `keywords` 里可回查，但没进
正向提示词；`layout_in_positive: false` 是说没要 Layout，或者要了但没编出来——两者
用 `layout` 字段区分，`null` 是"没要"，`ok: false` 是"要了但失败"。历史结构化输出
作为独立兼容能力保留，**不自动插入正向提示词**。

### JSON Layout

MOSS 支持用 JSON 描述物体、文字与 Bounding Box。本插件提供**可选的** Layout 输出，
由 `lib/compile/moss-layout.js` 编译，默认关闭。

Layout 不是第四种 Profile，也不是新的 `prompt_style`。它是在 `caption` 之上多排
一层结构化数据：写法仍是 `caption`，结果信封里多一个 `prompt_format` 字段，
值为 `caption` 或 `layout_json`。

调用方式（`analyze_image_prompt` 的 `layout` 参数）：

```json
{ "layout": true }
```

```json
{
  "layout": {
    "coord_space": "abs",
    "bbox_format": "xyxy",
    "canvas_width": 832,
    "canvas_height": 1216,
    "max_elements": 24
  }
}
```

规则：

- **坐标来源只有一个：IR 里 entity / feature 的 `region`**（视觉阶段给出的归一化
  `[x0,y0,x1,y1]`）。没有 `region` 的元素不进 Layout，也不会被补一个框。
- 越界、零面积、反向的框一律拒收（`COMPILE_MOSS_LAYOUT_BOX_REJECTED`），
  不裁剪、不夹紧——宁可少一个元素，也不给一个看起来合法的假框。
- 一个可靠框都没有时整份失败（`COMPILE_MOSS_LAYOUT_EMPTY`），不给空 JSON。
- 画布默认取原图尺寸；显式给 `canvas_width` / `canvas_height` 时以覆盖为准，
  框跟着画布重新换算。
- `coord_space` 支持 `abs`（左上原点）与 `abs_centralized`（画布中心原点，
  x 右为正、y 下为正）；`bbox_format` 支持 `xyxy` 与 `yxyx`。两者可以叠加。
- 画面文字逐字保留，换行不压平；文字没有 `region` 时只报一次
  `COMPILE_MOSS_LAYOUT_TEXT_NO_REGION`，它留在 Caption 里，不进 Layout。
- 元素按面积降序，超过 `max_elements`（默认 24）截断并报
  `COMPILE_MOSS_LAYOUT_TRUNCATED`（INFO 级）。
- Layout 失败不影响 Caption：正稿仍是那段话，只是 `prompt_format` 保持 `caption`。

`validateMossLayout()` 会独立复核一遍顺序、面积、范围与轴序，结果放在
`layout.validation` 里。

### Prompt Enhancer

官方 ComfyUI 工作流带可选的 Prompt Enhancer，会把短提示词改写成完整 Caption。
本插件已经直接输出完整 Caption，再开 Enhancer 等于让工作流把整理好的内容再改写
一遍——而且是不可追溯的改写。

`comfyui_inspect_workflow` 现在会检查提示词链路上有没有这类节点，结果在
`prompt_enhancer` 字段里。三条判定线索，任一成立就报：

- 名字像改写节点的（`PromptEnhancer`、`OllamaGenerate`、`LLM`、`GenerateText` …）
- 结构上可疑的：直接接在采样器正/负向输入上的非文本节点（`inline_before_sampler`），
  或文本编码节点上游还挂着别的节点（`upstream_of_text`）
- 改写开关藏在节点输入里（`input_flag`）：MOSS 官方模板把 `enable_prompt_enhancer` /
  `prompt_enhancer_seed` 直接做成采样节点的输入。勾上之后提示词在节点内部被改写，
  工作流里根本找不到"另一个改写节点"——只看 class_type 的话这种改写是完全隐形的。

每条命中还会标 `uses_image_input` / `image_inputs`：改写节点自己接了图像输入，
说明工作流会把原图再送进改写器。**这是工作流那头的行为，不是插件的行为**——插件
始终只把原图发一次给视觉模型，Caption / Layout 都从已有 IR 编译。

UI 格式（含子图）走另一条路：连线是槽位号，追不出谁接在谁后面，所以只按节点类型
扫描，`definitions.subgraphs` 里的节点也扫，结果里带 `scope` 标明命中在哪个子图。
UI 格式不返回 `chains`，`note` 里会说明"只按节点类型扫描"。

它**只报告，不改工作流，不重新分析图片**。要用逐词可追溯的 Caption / Layout，
就在 ComfyUI 里把这个节点旁路掉。

同一份检查还会报 MOSS 官方模板的版本门槛（`comfyui.t2i` / `comfyui.edit`，
门槛分别是 0.42.0 与 0.43.0）。读不到 ComfyUI 版本时状态是 `unknown`，不猜。

### 核对最终进模型的文本

`comfyui_inspect_workflow` 可以带两个可选参数，把插件给出的成品和工作流里的文本
节点逐字比对：

```json
{
  "workflow_name": "MOSS-Image-SFT-INT8-8GB",
  "expected_positive": "<插件给出的 Caption>",
  "expected_negative": "worst quality, bad anatomy, watermark, jpeg artifact"
}
```

返回的 `prompt_check.checks[]` 每个采样器每条链路一条：

- `final_text` 是这条链路上最终进模型的文本。没有改写节点时它就是文本节点里的
  内容，可以直接和期望比对；不一致报 `COMFY_PROMPT_TEXT_MISMATCH`（WARNING），
  带 `first_difference_at` 与前后各 20 字符的片段。
- 有改写节点时 `final_text` 是 `null`、`final_text_known` 是 `false`，并报
  `COMFY_PROMPT_TEXT_REWRITTEN`。这时只知道改写器的输入，最终文本由它在运行时
  生成，工作流 JSON 里看不到——不假装知道。
- UI 格式工作流不做这条核对（连线是槽位号，追不出链路），只做改写节点扫描。

## 同一份 IR 的三档输出

IR：`scripts/fixtures/promptlens/baseline-ir.json`（银发红瞳、白衬衫、微微笑、
举着伞站在雨街上，牛仔镜头、仰角、阴天日光）。三份档案、`kb: null`、不调视觉模型。

**anima**（`prompt_style: prose`）

```
1girl, girl, contrapposto, standing with weight on one leg, holding umbrella, left arm raised toward the viewer palm open, slight smile, wearing white blouse, red eyes, silver hair, rainy street, overcast daylight, shot from below, cowboy shot, masterpiece, best quality, absurdres, high score, great score
```

负向 24 条（`lowres, bad anatomy, bad hands, text, error, missing finger, ...`）。

**illustrious**（`prompt_style: tag`）

```
1girl, girl, contrapposto, standing with weight on one leg, holding umbrella, white blouse, red eyes, silver hair, slight smile, from below, (cowboy shot:1.1), rainy street, overcast daylight, umbrella, masterpiece, best quality, very aesthetic, absurdres, newest
```

负向 18 条（`lowres, bad anatomy, bad hands, text, error, worst quality, ...`）。

**moss**（`prompt_style: caption`）

```
The image shows a girl with silver hair and red eyes, wearing a white blouse. She has a slight smile. Her left arm is raised toward the viewer palm open. She is standing with weight on one leg. Her right hand holds the umbrella handle. The framing is a cowboy shot. The camera angle is from below. The background is a rainy street. The scene is lit by overcast daylight.
```

负向 4 条：`worst quality, bad anatomy, watermark, jpeg artifact`。

三者的差别不是「同一句话换了个说法」：标签档给词，prose 档给成分句，caption 档
给一段能读的描述——关系（`hand holds the umbrella`）在 caption 里是一句话，
在标签档里只能是两个相邻的词。

结果信封里，`prompt_style` 三档分别是 `prose` / `tag` / `caption`；只有 `moss`
还会多一个 `prompt_format`，值为 `caption` 或 `layout_json`。

## Caption 与 Layout 的对比

同一份 IR，开不开 `layout` 的区别：

**默认（Caption）** — `prompt_format: "caption"`

```
The image shows a girl with silver hair, wearing a white blouse. She has a slight smile. The framing is a cowboy shot. The background is a rainy street.
```

**`layout: true`** — `prompt_format: "layout_json"`

```json
{
  "schema_version": "1.0",
  "summary": {
    "meta": { "profile": "moss", "source": "image_ir", "elements": 3 },
    "canvas": { "width": 832, "height": 1216 },
    "caption": "The image shows a girl with silver hair."
  },
  "bbox_coord_space": "abs",
  "bbox_format": "xyxy",
  "items": [
    {
      "label": "1girl",
      "caption": "1girl, silver hair, slight smile",
      "bbox": [208, 122, 624, 1094]
    },
    {
      "label": "umbrella",
      "caption": "umbrella",
      "bbox": [416, 61, 790, 426]
    },
    {
      "label": "text",
      "caption": "the text \"RAIN\nDAY\"",
      "text": "RAIN\nDAY",
      "bbox": [83, 24, 499, 146]
    }
  ]
}
```

> **上面这份 Layout 用的是合成夹具坐标，不是真实图片的反推结果。**
> 它的 region 是手写的（`1girl` 占 `[0.25,0.1,0.75,0.9]`，`umbrella` 占
> `[0.5,0.05,0.95,0.35]`，画面文字占 `[0.1,0.02,0.6,0.12]`），
> 对应测试里的 `syntheticLayoutIr()`。拿它当格式样例看，不要当成某张真图的坐标。

## 新增档案要改哪里

1. `configs/model-profiles/<id>.json`：`schema_version: "2.0"`，`word_style` 取
   `underscored` / `spaced` / `prose` / `caption`，`source_confidence` 必填。
2. 新写法要新编译器时，在 `lib/compile/` 下单独成文件，由 `lib/compile/index.js`
   按 `word_style` 分派，并在 `lib/pipeline/stages.js` 的 `prompt_style` 映射里
   补上对应值。
3. `scripts/core-baseline.test.mjs` 里钉着档案清单（`listModelProfileIds()` 与
   `configs/model-profiles` 目录内容），新增档案要一起更新。
