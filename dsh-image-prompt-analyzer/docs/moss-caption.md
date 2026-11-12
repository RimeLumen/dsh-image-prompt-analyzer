# MOSS-Image 的自然语言提示词

这份文档回答四件事：官方到底怎么要求的、本插件按什么规则写、两个入口（图片反推 /
自然语言需求）分别做什么、以及怎么确认最终进模型的文本没被改。

配套代码：`lib/compile/moss.js`（反推 → Caption）、`lib/compile/brief.js`（需求 → Caption）、
`lib/compile/moss-layout.js`（可选 Layout）、`lib/comfyui/prompt-check.js`（交付核对）。
回归样例：`scripts/moss-caption.test.mjs`。

## 1. 我们实际在用什么

| 项目 | 实际情况 | 怎么确认的 |
| --- | --- | --- |
| 权重 | `moss_image_base_bf16.safetensors` 与 `moss_image_sft_bf16.safetensors`，各 10,164,655,808 字节，2026-11-04 落盘 | 读本机 ComfyUI 的 `models/diffusion_models/moss/` 目录 |
| 文本编码器 | `qwen3.5_9b_bf16.safetensors` | 同上，`models/text_encoders/moss/` |
| VAE | `flux2-vae.safetensors` | 同上，`models/vae/moss/` |
| LoRA | `moss_image_color_depth_control.safetensors`、`moss_image_edit_lora_rank_64_bf16.safetensors` | 同上 |
| ComfyUI 节点 | 自定义节点 `moss-image` v0.1.1，commit `e6515b16ed360b01bd6548bffaca193f88f181fb`（2026-11-06） | `custom_nodes/moss-image/pyproject.toml` 与 `git log -1` |
| 实际在跑的工作流 | `MOSS-Image-SFT-INT8-8GB.json`（SFT 权重）与官方示例 `moss-image.json`（Base） | `user/default/workflows/moss/` 与 `custom_nodes/moss-image/example_workflows/` |

**无法确认的**：上游仓库的模型 commit / 权重哈希。文件名只写了 `base` 与 `sft`，
`bf16`，没有语义版本号。本插件因此**不按文件名推版本**，也不在档案里写死版本号；
`moss` 档案的别名（`moss-image-base`、`moss-image-sft`、`openmoss`）只是名字归一，
不代表两份权重在提示词写法上有差别。

官方来源（本地留存副本在 `_references/moss/`）：

- 仓库 `github.com/OpenMOSS/MOSS-Image`：`README.md`、`USERGUIDE.md`、`USERGUIDE_ZH.md`
- 提示词增强技能 `skills/moss-image-prompt-enhancer/SKILL.md`
- ComfyUI 侧说明 `comfyui-README.md`
- 论文 arXiv `2610.23374`（README 里给出，未逐条核对正文）

## 2. 官方依据表

「档」这一列是后面所有规则的标签：**官方明确要求** = 原文写死的；**样例归纳** = 从官方
示例里看出来的规律，原文没明说；**工程选择** = 本插件自己的决定，官方没有要求。

| 规则 | 档 | 出处（文件 / 小节 / 原文） | 插件落点 |
| --- | --- | --- | --- |
| 正向提示词可以是自然语言、标签流或 JSON Layout 三种形态 | 官方明确要求 | `USERGUIDE.md` § Prompt Guidelines：「MOSS-Image-Base supports multiple input formats, including natural language, tag sequences, and JSON layouts.」 | 档案 `word_style: "caption"`，默认只走自然语言 |
| 推荐英文，中文与其他语言也支持 | 官方明确要求 | `USERGUIDE.md` § Prompt Guidelines → Language：「We recommend **English**, which has the most training data. Chinese and other languages are also supported.」 | `caption_language` 默认 `en`，可显式设 `zh-CN` |
| 负向推荐四条 | 官方明确要求 | `USERGUIDE.md` § Prompt Guidelines → Negative Prompt：「`nsfw, worst quality, bad anatomy, watermark, jpeg artifact`」 | `MOSS_NEGATIVE_BASE` 就是这四条（`nsfw` 只在用户显式声明全年龄时补） |
| 标签流有推荐顺序 | 官方明确要求 | `USERGUIDE.md` § Prompt Guidelines → Recommended Tag Order：Quality → Score → Meta → Year → Character → Series → Artist → General | 只影响标签流；Caption 档不排序，也不产标签流 |
| 换行要自己写 | 官方明确要求 | `USERGUIDE.md` § Prompt Guidelines → Text Layout：模型会自动换行但结果未必符合预期，要精确控制就在 prompt 里插 `\n` | 画面文字逐字保留，含换行 |
| 普通场景用 caption，不要因为"图很细"就上 Layout | 官方明确要求 | `SKILL.md`：「A detailed image does not automatically need Layout.」 | `layout` 默认关闭，只有显式传参才编 |
| Layout 只用于海报、多格、受控文字排布 | 官方明确要求 | `SKILL.md`：只有需要特定文字排布、海报、多格、受控物体关系时才用 Layout | `lib/compile/moss-layout.js` 不主动产出 |
| 保留主体、数量、关系、媒介、风格、排除项与可见文字 | 官方明确要求 | `SKILL.md`：「Preserve the user's subjects, counts, relationships, medium, style, exclusions and intended visible wording.」 | 关系句按实体归属写（见 §4） |
| Caption 是连贯散文，空间关系用文字表达，不加坐标或 JSON 字段 | 官方明确要求 | `SKILL.md`：「The caption is cohesive prose, with spatial relations in words ... do not add coordinates or JSON-layout fields to a caption」 | Caption 里不出现 `bbox`、`{`、坐标 |
| 可见文字逐字保留原语言，含标点与换行 | 官方明确要求 | `SKILL.md`：「Preserve visible text verbatim in its original language, including punctuation, capitalization and requested line breaks.」 | `collectImageText()` 绕过语言过滤直接取原文 |
| 避免冗余质量词 | 官方明确要求 | `SKILL.md`：「Avoid redundant quality tags, unrequested style changes, arbitrary word budgets and invisible process notes.」 | `QUALITY_WORD` / `RATING_WORD` 正则把它们挡在 Caption 外；`write_caption` 入口直接摘掉 |
| 最终只有 caption 或编译后的 Layout 进正向提示词 | 官方明确要求 | `SKILL.md`：「Only the caption or compiled Layout belongs in MOSS-Image's positive prompt.」 | `output_contract` 字段逐项声明这次交了什么 |
| 分辨率、步数、CFG、Shift、采样器、SLG | 官方明确要求 | `USERGUIDE.md` § Inference Parameters：1M–2M 像素（可外推 0.25M–4M）、边长 16 的倍数、步数 ≥50、CFG 3.0（3.0–6.0）、Shift 5.0、Euler、SLG skip layer 22 | 插件不改工作流参数；`comfyui_inspect_workflow` 只读检查 |
| 长提示词上限约 4K token | 官方明确要求 | `README.md`：long-prompt 支持最多 4K tokens | `write_caption` 超过 4000 字符报 `BRIEF_VERY_LONG`（WARNING，不截断） |
| 主体句用「名词 + with + 外观」，不加逗号 | 样例归纳 | `USERGUIDE.md` 英文示例：「A wide view of a refrigerator beside a kitchen counter with a fruit bowl.」——`with` 直接贴着名词 | `composeMossCaption()` 的 `with ...` 不加逗号，避免读成另一个人 |
| 一句说一件事，句子短 | 样例归纳 | 官方两个示例的句子普遍 8–20 词 | `detailBudget()` 按 `detail_level` 限句数与每段条数 |
| 光线写成「被什么光照亮」 | 样例归纳 | 官方示例用 `lit by` 的被动写法描述光源，而不是罗列光照标签 | `The scene is lit by overcast daylight.` |
| 中文需求可以不翻译直接给模型 | 官方明确要求 | `USERGUIDE.md` 中文示例：整段中文 prompt 配 `worst quality, bad anatomy` | `write_caption` 检测到中文就按中文输出，不翻成英文 |
| 中文 Caption 由分析阶段直接写，不是编译期翻译 | 工程选择 | 官方只说"支持中文"，没说该在哪一步定语言 | 语言一路推到视觉阶段（`observation_language`），编译期语言不一致就硬失败 |
| 词表未命中的观察不丢 | 工程选择 | 官方无对应条款 | `collectDescriptionFacts()` 只按语言/否定/占位/量测过滤，不查词表 |
| 关系句必须点名是谁的手 | 工程选择 | 官方只说"保留关系" | `describe.js` 给关系事实挂 `entity_id` / `entity_kind`，`moss.js` 按归属补主语 |

## 3. 两个入口

三条路径的事实来源不同，**不能互相顶替**：

| 入口 | 工具 | 事实来源 | 处理原则 |
| --- | --- | --- | --- |
| 图片反推 | `analyze_image_prompt`（`target_profile: moss`） | 图片里看得见的东西 | 不借润色增加画面内容；已确认的关系一条不少 |
| 自然语言需求 | `write_caption` | 用户这句话 | 在用户要求范围内组织；用户明确指定的要素优先；不添人、不改关系、不拆标签、不翻译 |
| 局部修改 | `revise_caption` | 已有 Caption + 一句修改要求 | 只替换被点名的那一处属性值，其余字符逐字不动；目标不唯一时不替用户选 |
| 词篮辅助 | `compile_tag_basket` | 用户挑的词 | 只能表达已知属性；没给的关系、动作归属、空间位置保持未指定 |

### 图片反推

IR → 事实池 → 按语义顺序成句。九段（多人时多一段）：

1. 主体（外观 + 服装，同一句）
2. 画面里的其他人（每人一句；句子预算放不下时报 `COMPILE_MOSS_CAPTION_TRUNCATED`）
3. 表情
4. 姿态
5. 空间关系（谁握着什么、什么放在哪）
6. 构图
7. 镜头角度
8. 背景环境
9. 光照
10. 艺术风格
11. 画面文字

失败语义：写不出一句就**硬失败**（`COMPILE_MOSS_CAPTION_EMPTY`，正向空串），
不退回标签流。理由见 `docs/model-profiles.md` 的「空 IR 是硬失败」。

### 自然语言需求

```json
{
  "brief": "一名成年女性穿着深蓝色长外套，站在车站雨棚下。她的右手握着收拢的白色雨伞，脚边放着棕色行李箱。",
  "target_profile": "moss",
  "language": "zh-CN"
}
```

规则：

- **不改写措辞**。用户怎么写就怎么进正向提示词，插件只做三件事：摘质量词、切句统计、
  判语言。它不扩写、不润色、不补细节——补细节是"编写"，但补什么得用户说了算。
- **质量词直接摘掉**（`masterpiece`、`best quality`、`8k`、`score_9` …），
  并在 `stats.removed_quality_words` 里报数量。依据是官方「避免冗余质量词」。
- **语言由内容决定**。有汉字就是 `zh-CN`，否则 `en`。用户显式声明与内容不一致时
  **不翻译**，按原文输出并报 `BRIEF_LANGUAGE_MISMATCH`。
- **Layout JSON 不当需求收**（`BRIEF_LAYOUT_REJECTED`，硬失败）。默认正向只放 Caption；
  要精确排布走分析链路的 `layout` 参数。
- **标签流照收但提示**（`BRIEF_LOOKS_LIKE_TAGS`）。判据是无句号 + 逗号分句 ≥3 +
  平均每段 ≤3 词。它可能是用户就想这么写，所以只提示、不改内容。
- **信息不足就失败**（`BRIEF_TEXT_REQUIRED`），不编一段出来。

### 局部修改

`write_caption` 只接收"已经写好的一段话"，它没有原文，也就谈不上修改。要改一句话里的
一个属性，用 `revise_caption`：

```json
{
  "original": "一名成年女性穿着深蓝色长外套，站在车站雨棚下。",
  "instruction": "只把外套颜色从深蓝改成酒红",
  "target_profile": "moss"
}
```

输出 `positive` 是 `一名成年女性穿着酒红色长外套，站在车站雨棚下。`，同时给出
`changed: {count, from, to, at, length, clause_before, clause_after}`。

规则：

- **只认带旧值的替换**（「从 A 改成 B」/ `from A to B`）。只给目标值时无法确定原文该动
  哪一处，报 `REVISE_FROM_REQUIRED`，不猜。
- **只替换属性值，不重写名词**。`深蓝色长外套` → `酒红色长外套`：服装类型、所属人物、
  其他事实都不在替换范围内，所以结构上不可能被顺手改掉。
- **目标不唯一就不动手**。两处都符合时返回 `REVISE_TARGET_AMBIGUOUS` 并列出候选小句，
  要求指明是谁的外套，而不是任选一位或两位都改。
- **同一颜色出现在背景里不算候选**。候选必须与目标名词落在同一小句，且颜色词直接修饰它
  （`深蓝色长外套` 算，`身后的天空也是深蓝色` 不算）。
- **原文没写这个属性就失败**（`REVISE_VALUE_ABSENT`）。把「没写颜色」补成「酒红色」是
  新增设定，不是修改。

早期版本给的示例是「深蓝色长外套 → 酒红色风衣」，用「只有一句不同」做验收——它同时改了
服装类型，却照样通过。现在这条示例作废，验收改成走 `revise_caption` 生产入口、检查替换
片段之外的字符完全一致。

### 词篮为什么编不出 MOSS 提示词

`compile_tag_basket` 在 `moss` 档案下会失败（`COMPILE_BASKET_CAPTION_NEEDS_FACTS`）。
这是有意的：一篮标签里没有"谁握着什么"这种关系，硬编成 Caption 只能得到一串用逗号
连起来的词，或者一段插件自己编的关系——两者都比直接报错危险。

要写画面，用 `write_caption`；要用标签挑词，用 `search_tags` / `explain_tag` 把中文需求
拆成词，再把词组织成一句话交给 `write_caption`。

## 4. 关系怎么保真

这是「画面关系能不能读清楚」的核心，也是标签写法最容易丢的东西。

**采集**（`lib/compile/describe.js`）：`ir.relations[].description` 直接进事实池，
同时挂四个字段——`entity_id`（`from` 指向的实体）、`entity_kind`、`entity_label`、
`relation_type`。**不经过任何词表校验**：词表里没有 `holding_umbrella` 这个标签，
不影响「右手握着伞柄」这句话进 Caption。

**成句**（`lib/compile/moss.js`）：

- 画面只有一个人 → 用主体代词：`Her right hand holds the umbrella handle.`
- 画面有两个人及以上 → 关系句用可辨特征点名归属：`The silver-haired woman's right hand
  holds the folded white umbrella.` / `A brown suitcase rests by the black-haired woman's feet.`
- 称呼只用**这个人自己身上观察到的、且全场独一份**的特征（发色优先）。没有可辨特征时
  退回 `the woman` / `the other woman`，不编发色、不编左右位置。
- `from` 是物件（箱子放在脚边）→ 不补人物主语，句中的「她」按关系的另一端解析：多人时
  写成 `by the black-haired woman's feet`，单人时保留 `by her feet`。
- 两端都是人（递东西）→ 主语用施动方，句中的接收方按 `to` 端点名，不互换。

写不下时（句子预算到顶）返回 `complete: false` 与 `omitted.persons` / `omitted.relations`，
并报 `COMPILE_MOSS_CAPTION_TRUNCATED`。**不把缺人缺关系的 Caption 报成完整成功。**

主体之外的人有自己的一句（`role: "other_subject"`），外观与服装各归各家，
不会被写成主体的外观。

## 5. 输出约定

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

- `tags_in_positive: false` —— 标签版内容仍在 `slots` / `keywords` 里可回查，但没进正向提示词。
- `layout_in_positive: false` —— 没要 Layout，或要了但失败。两者用 `layout` 字段区分：
  `null` 是"没要"，`ok: false` 是"要了但没编出来"。
- 历史结构化输出（Layout JSON）作为独立兼容能力保留，**不自动插入正向提示词**。

## 6. 核对最终进模型的文本

`comfyui_inspect_workflow` 新增两个可选参数：

```json
{
  "workflow_name": "MOSS-Image-SFT-INT8-8GB",
  "expected_positive": "<插件给出的 Caption>",
  "expected_negative": "worst quality, bad anatomy, watermark, jpeg artifact"
}
```

返回 `prompt_check`：

- `checks[]` 每个采样器每条链路一条，带 `final_text`（最终文本）、`final_text_known`、
  `rewritten_by`（改写节点）、`comparison`。
- 没有改写节点时，`final_text` 就是文本节点里的内容，可以和期望逐字比对；
  不一致会给出 `first_difference_at` 与前后各 20 字符的片段。
- **有改写节点时 `final_text` 是 `null`、`final_text_known` 是 `false`**。这时只知道
  改写器的输入是什么，最终文本由它在运行时生成，工作流 JSON 里看不到——不假装知道。
- UI 格式工作流不做这条核对（连线是槽位号，追不出链路），只做改写节点扫描。

这一条核对的是**工作流文件里写着的文本**。真正发出去的请求还要经过补丁、序列化与提交，
那段由 `scripts/moss-fixes.test.mjs` 覆盖：注入 `fetchImpl` 截获 `POST /prompt` 的请求体，
用生产代码的 `planWorkflowPatch` → `applyWorkflowPatch` → `submitPrompt` → `client.postJson`
→ `JSON.stringify` 走一遍，再把解码后的工作流交给同一个 `checkPromptDelivery`。它证明的是
**API 提交边界上文本一致**，不宣称观测到模型运行时最终读到的文本。

## 7. 验证边界

`scripts/moss-caption.test.mjs` 能证明的是**格式与事实保存**：

- 正向是一段话，不是标签流，不是 JSON；
- 关系句的归属正确，第二个人的外观没串到主体身上；
- 词表里没有的观察照样进 Caption；
- 负向只有官方那几条，且不与正向矛盾；
- 中文需求原样成文，质量词被摘掉，Layout JSON 被拒；
- 局部修改走 `revise_caption` 入口，替换片段之外逐字不变，服装类型不被连带改掉，
  目标有歧义时不擅自修改，原文没写该属性时不变成新增设定；
- 多人关系里伞与行李箱各自归位、调换描述顺序后归属不变、递东西时执行者与接收者不互换、
  第四个人及其关系不被静默丢弃、预算不足时明确报不完整；
- 提交链路截获的请求体里，中文/换行/引号/反斜杠解码后与预期一致，改写节点归为未知，
  未连接采样器的文本节点不被误当成正负提示词。

它**不能**证明的是「画面偏移是否减少」。那需要实际生图对比实验，不能用词表命中率
或文本覆盖率代替。本插件不自行提交生图任务。
