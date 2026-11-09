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

### 语义顺序

一段 Caption 按下面的顺序组织，缺哪类事实就跳过哪一类：

1. 主体与外观、服装（同一句，外观用 `with ...` 挂在名词后）
2. 表情
3. 姿态与肢体动作
4. 空间关系（谁握着什么、谁在谁身后）
5. 构图与取景
6. 镜头角度
7. 背景环境
8. 光照与色彩
9. 艺术风格（`detail_level: minimal` 时不写）
10. 画面里的文字（逐字保留原文）

### 依据边界

- 只用 IR 里有的事实。连接词、冠词、代词可以补，内容词不能补。
- `verifyCaptionGrounding()` 逐词核对：不在任何 IR 事实里、也不属于语法骨架词
  （`CAPTION_SCAFFOLDING`）的词会被列进 `unsupported`，并产生
  `COMPILE_MOSS_CAPTION_UNGROUNDED` 诊断（INFO 级，留在 trace 里）。
- 低置信度、被否定的观察在 `describe.js` 那层就已经被剔掉，Caption 拿不到它们。
- 画面里的文字是**内容**不是观察，所以绕过英文过滤直接取原文：招牌上的中文
  照抄中文，不翻译、不转小写。

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

MOSS 官方推荐英文（训练数据更多），也支持中文。当前 Caption 固定输出英文：
IR 里的观察值本身就是英文（视觉阶段被要求写成英文小写），画面里的文字则逐字保留
原文。插件没有 prompt 语言配置项，本次也没有新增——真要中英切换，得先有语言配置，
而不是给 MOSS 单独发明一个。

### JSON Layout

MOSS 支持用 JSON 描述物体、文字与 Bounding Box。本插件**不输出 Layout**：
反推任务的主要产出仍是正负向提示词，而 IR 里没有可靠的位置数据时编造坐标，
比不给更糟。Layout 留作独立扩展。

### Prompt Enhancer

官方 ComfyUI 工作流带可选的 Prompt Enhancer，会把短提示词改写成完整 Caption。
本插件已经直接输出完整 Caption，再开 Enhancer 等于让工作流改写一遍整理好的内容。
要精确控制输出就把它关掉；插件不会去改用户的工作流，也不会额外调用远程 LLM
二次扩写。

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

## 新增档案要改哪里

1. `configs/model-profiles/<id>.json`：`schema_version: "2.0"`，`word_style` 取
   `underscored` / `spaced` / `prose` / `caption`，`source_confidence` 必填。
2. 新写法要新编译器时，在 `lib/compile/` 下单独成文件，由 `lib/compile/index.js`
   按 `word_style` 分派，并在 `lib/pipeline/stages.js` 的 `prompt_style` 映射里
   补上对应值。
3. `scripts/core-baseline.test.mjs` 里钉着档案清单（`listModelProfileIds()` 与
   `configs/model-profiles` 目录内容），新增档案要一起更新。
