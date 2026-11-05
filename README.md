# dsh-image-prompt-analyzer

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.5-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3%20%2B%20Pillow-3776ab?logo=python&logoColor=white)](https://python.org)
[![npm dependencies](https://img.shields.io/badge/npm%20dependencies-1-00add8?logo=npm)](https://www.npmjs.com)
[![License](https://img.shields.io/badge/license-Apache_2.0-blue)](LICENSE)

一个 [[DSH]](https://github.com/deepseek-ai/deepseek-harness) 插件：把本地图片转换成适用于 ComfyUI 的、面向特定模型的提示词。

它先让视觉模型看一张图，产出一份结构化的中间表示（IR），再按目标模型的**官方标签标准**把这份 IR 编译成正向与抑制提示词 —— 槽位顺序、质量块、评分链、禁用标签、词的书写风格，都照那套标准来。

---

## 运行前提

需要两个运行时，**两个都是必需的** —— 缺任何一个插件都无法开始分析图片。

| | 要求 | 原因 |
|---|---|---|
| **Node.js** | **≥ 22.5** | 本地知识库用的是内置的 `node:sqlite`。没有任何 npm 依赖需要安装，完全不需要 `npm install` 这一步。 |
| **Python** | **3 且装有 [Pillow](https://python-pillow.org/)**（实测于 3.10.6 + Pillow 12.1.1） | 图片解码。每一张 PNG / JPEG / WEBP / BMP 都要经过 `python/decode_helper.py`，而它依赖 Pillow。**没有 Pillow，每一张图都会以 `DECODE_FAILED` 失败**，插件等于不可用。 |
| **numpy** *（可选）* | 任意较新版本 | 额外的几何度量（主体区域亮度、对比度剖面）。缺 numpy 时这些度量退化为 `null`，分析照常跑。 |
| **rawpy** *（可选）* | 任意较新版本 | 相机 RAW 格式（`.cr2`、`.nef`、`.dng` 等）。默认关闭（`image.raw_enabled: false`）。 |

安装必需的 Python 部分：

```bash
pip install Pillow
```

然后自检 —— 这是判断 Python 一侧有没有接对最快的方式。请在插件包目录里执行：

```bash
echo '{"op":"probe"}' | python python/decode_helper.py
```

```json
{
  "ok": true,
  "python": { "version": "3.10.6", "executable": "…/python.exe", "platform": "win32" },
  "pillow": { "available": true, "version": "12.1.1" },
  "rawpy": { "available": false, "version": null },
  "bitmap_formats": ["PNG", "JPEG", "WEBP", "BMP"],
  "raw_extensions": [".cr2", ".nef", ".dng", "…"],
  "warnings": []
}
```

如果 `pillow.available` 是 `false`，先把这个解决掉再谈别的。如果 `python` 不在 `PATH` 上，或者你要指定某个解释器，在插件配置里指过去：

```yaml
python:
  executable: "C:/Python311/python.exe"
  timeout_seconds: 30
  enabled: true
```

---

## 安装

从本地检出安装：

```bash
dsh plugin install ./dsh-image-prompt-analyzer
```

或者让 profile 直接指向这个包（开发时 `link:` 就能用）：

```yaml
plugins:
  - include:@RimeLumen/dsh-image-prompt-analyzer
```

---

## 快速开始

在对话里直接让模型做：

```
Analyze this image with the illustrious profile:
  image_path: "D:/pics/sample.png"
  target_profile: "illustrious"
```

本插件是纯对话形态：没有侧栏入口，也没有网页工作台，所有能力都以工具形式暴露给模型。

`target_profile` 没有默认值 —— 不传会返回 `MODEL_PROFILE_NOT_SELECTED`。从随包发布的两个档案里选一个。

---

## 工具

| 工具 | 作用 |
|---|---|
| `analyze_image_prompt` | 主入口。图片 → IR → 提示词。返回标签版、描述版、抑制提示词、槽位明细与逐条观察的诊断。 |
| `preview_model_profile` | 把一个示例 IR 过一遍档案编译器，**不调用**任何视觉模型 —— 在真正花一次调用之前，先看清这套档案会编译出什么。 |
| `validate_configs` | 对随包配置与用户覆盖配置做静态校验：JSON 语法、schema 版本、必需字段、ID 重复、悬空引用。 |
| `diagnose_knowledge_base` | SQLite 知识库能不能打开、可不可写、schema 版本是什么、里面有多少标签、最近一次导入是什么时候。 |
| `rebuild_knowledge_base` | 把本地标签 CSV 重新导入 SQLite。按 source 幂等 upsert，事务内完成，支持 `dry_run`。 |
| `manage_experiences` | 浏览 / 检索 / 评分 / 导出 / 导入本地经验库。 |

---

## 为什么不用一套通用提示词

Illustrious 的 `very aesthetic` 质量块和 Animagine 的 `$dscore` 评分链不能互换，而且 Animagine 的 Model Card 明确说它读得最好的是标签式提示词。一条对某个模型有效的通用标签串，对另一个模型就是纯噪声。所以这个插件是按模型、按标准分别编译的。

## 先定色彩模式

在问视觉模型任何问题之前，先由像素统计判定这是哪一类图：`greyscale`、`duotone`、`spot_color` 或 `color`（`lib/vision/preflight.js`）。这个结论作为第 0 步写进提示词，也写进 `ir.provenance.color_mode`，编译器据此知道要不要整体压制色相词。

少了这一步，模型就按题材先验作答 —— 一张灰阶的少女肖像仍然会答出 `blonde hair, blue eyes`。两边冲突时以像素结论为准，冲突本身报成 `VISION_COLOR_MODE_MISMATCH`。

`color_mode` 可以在**不改动像素事实**的前提下覆盖输出侧的结论：

| 取值 | 作用 |
| --- | --- |
| `auto`（默认） | 由像素预检决定 —— 无色源的图得到单色提示词，彩色源得到彩色提示词 |
| `monochrome` | 强制黑白的提示词；即使源图是彩色的，色相观察也会被丢掉 |
| `color` | 强制彩色的提示词；`greyscale` / `monochrome` / `black and white` 这类观察会被摘掉，免得它们把渲染器又按回灰阶 |

对无色源的图强行指定 `color` 时，插件不假装有依据：像素模式仍以 `pixel_mode` 留在结果里，同时用 `VISION_COLOR_MODE_FORCED` 提示这些颜色背后没有证据（灰阶文件并不存色相，颜色是生成器按自己的先验填的）。

## 先标签，再谈提示词语言

分析层只产出标签；措辞层决定这些标签怎么变成提示词：

1. **分析** —— 视觉模型把观察填进 IR，关系也算在内（`holding umbrella`、`wearing black coat` 作为实体 + 关系）。
2. **把关系合成标签** —— 关系被转成 booru 合法的复合标签（`holding_umbrella`），绝不生造词。多词的对象宁可原样留着，也不焊成一个不存在的标签。
3. **并排渲染两个版本** —— 每次分析都同时返回：
   - `prompts.positive` —— **只有标签**（`1girl, long hair, left_hand_on_own_chest, masterpiece, best quality`）。只有知识库能确认为真实标签的词才进这里；别的词进来只会稀释那些真标签的权重。
   - `prompts.description` —— **同一批观察写成句子**（`1girl, standing with left hand on own chest, wearing sheer translucent chiffon, lit by blown out white glow behind subject`）。动作、介质（雾、霾、尘）和关系都在这里，因为标签表达不了它们。

用哪一版喂模型是你的事，不是档案替你决定：标签模型吃标签行，句子模型吃描述版，做 img2img 时描述版是更好的起点。`tag_standard.word_style` 只影响默认值：`prose` 把描述版放进 `positive`，`underscored` / `spaced` / `hybrid` 则让标签行留在那儿（只限标签行，所以两者永远不会混在一起）。

标签版与描述版的分流由知识库驱动：一条能对上真实标签的短观察留在标签行，对不上的从标签行移出、保留在描述版里，理由记作 `not_in_vocabulary`。知识库不可用时什么都不摘 —— 标签行宁可长一点，也不丢掉它无法验证的观察。

句子是有接地的：实词必须来自观察本身，违反时报成 `COMPOSE_UNGROUNDED_PROSE`，而不是悄悄发出去。

Animagine XL 4.0 刻意留在标签路径上 —— 它的 Model Card 限定它只能用标签式提示词，并说明自然语言可能无效。把某个档案切到句子路径只改一个字段：

```json
{ "tag_standard": { "word_style": "prose" } }
```

## 成人内容

分析器不做自我审查。裸体与露骨内容照目标模型训练时用的那套 Danbooru 解剖学词汇描述（`nude`、`nipples`、`spread legs`、`sex` 等）；真正破坏还原的恰恰是委婉语和省略 —— 打标器看不到它必须复现的那个概念。

分级跟着画面走，不跟着档案走：

- 全年龄图不写任何分级。`safe` 不写 —— 它占着前排的高权重槽位，什么也没改变。
- 只有观察本身报出了分级，才写 `nsfw` / `explicit`。
- `tag_standard.rating_emit` 是白名单（默认 `["nsfw", "explicit"]`，给 `[]` 就完全关闭分级）；`rating_default` 默认是 `null`，除非某个档案想要固定分级。

被白名单挡下的分级以 `rating_suppressed` 丢弃，且不计入 fidelity 分数 —— 那是策略选择，不是丢失的观察。

## 支持的模型

| 模型 | 档案 ID | 关键标准 |
|---|---|---|
| Illustrious XL | `illustrious` | `masterpiece, best quality, very aesthetic, absurdres`，标签语域 |
| Animagine XL 4.0 | `animagine-xl-4.0` | 只用标签式提示词，`high score` 质量块 |

新增一个模型就是在 `configs/model-profiles/` 里加一个 JSON 文件 —— 不用改代码。

## 特性

- **2 个模型档案** —— 每个都是一份 JSON 配置，声明槽位顺序、固定块、禁用标签、抑制默认值、词的书写风格
- **双版本输出** —— 标签版与描述版，由同一批观察编译而来
- **证据层** —— 观察在进入提示词之前先与像素度量交叉核对；矛盾被报出来，而不是悄悄调和掉
- **阶段留痕** —— 每次分析都可重放：证据层前/后的 IR、模型原始响应，以及一份说明每条观察最终去了哪里的台账
- **纯对话形态** —— 没有侧栏入口与网页工作台，全部能力通过工具调用完成
- **本地知识库** —— 纯 SQLite，CSV 导入，零网络
- **经验库** —— 按档案隔离的历史、评分、导出/导入
- **视觉模型自动发现** —— 从宿主目录里找支持图像的模型，失败时自动回退
- **自动预热** —— DSH 启动后在后台预热关键资源

## 知识库数据

两个标签 CSV **随仓库一起发布**：

| 文件 | 行数 | 大小 |
|---|---|---|
| `res/illustrious_tags_no_artist.csv` | 58,519 | 1.6 MB |
| `res/anima_tags_no_artist.csv` | 66,058 | 1.7 MB |

它们是 Danbooru 风格的导出，格式为 `tag,native_category,aliases,post_count`，已去掉画师行。`configs/knowledge-base.default.json` 把它们列为 `sources[]`；`data/knowledge.sqlite3` 在首次使用时由它们建出来。

新克隆之后，先建一次库：

```
rebuild_knowledge_base
```

或者用命令行只导入单个数据源：

```bash
npm run import-tags
```

想用自己的标签表，把 `sources[].path` 指向包内任意 CSV 再重建一次即可。表里没有的标签不会被当成无效 —— 它们只是留在描述版里，而不会被确认为标签。

## 检查一次编译

`scripts/inspect-prompt.mjs` 把一份存下来的 IR 重新编译一遍，报告四份输出的哈希，或者某一条观察最终去了哪里。它从不调用视觉模型、也不生成图，所以对着一份存好的 IR 想跑多少遍都行。

```bash
node scripts/inspect-prompt.mjs baseline --ir ir.json
node scripts/inspect-prompt.mjs ledger   --ir ir.json --ir-before ir.pre-evidence.json
node scripts/inspect-prompt.mjs explain  --ir ir.json "camera.angle"
node scripts/inspect-prompt.mjs channels --ir ir.json
```

| 子命令 | 回答什么 |
|---|---|
| `baseline` | 输出变了没有？打印标签版、默认描述、抑制提示词、候选描述的哈希与长度。`--expect positive=<hash>,...` 可以把"没变"变成通过/失败的退出码。 |
| `ledger` | 台账里有什么，逐通道的 fidelity 审计怎么说的？ |
| `explain` | 一条观察去了哪里？不带参数就列出全部被丢弃、被改写或部分丢失的。 |
| `channels` | 哪个通道缺了什么，按理由分组 —— "被规则挡掉"和"意外丢失"分开计数。 |

选项：`--profile <id>`（默认 `illustrious`）、`--preset <id>`（默认 `detail-standard`）、`--db <path>`、`--kb-config <path>`、`--no-kb`、`--json`、`--help`。

两条注意事项，都是踩出来的：

- **引用哈希时必须同时写明知识库状态。** 没挂上标签表时输出是完全不同的字符串，所以一个不带 `kb` 标注的哈希不构成基线。`baseline` 每次都会在自己那行把模式打出来。
- **fidelity 的 `score` 是词面保留指标，不是质量分。** `score: 1` 只说明每条被审计的事实至少进了某一个通道；在宣称"都保留了"之前，先看 `channels` 和 `retention_claim`。

## 目录结构

```
├── dsh-image-prompt-analyzer/       # 插件包
│   ├── index.js                     # Host 入口（注册工具 + 预热）
│   ├── configs/
│   │   ├── model-profiles/          # 2 个模型档案
│   │   ├── presets/                 # 3 档细节密度（minimal / standard / high）
│   │   └── knowledge-base.*.json    # 知识库数据源 + 存储 schema
│   ├── lib/
│   │   ├── vision/                  # 视觉管线（两阶段分析 + 证据层）
│   │   ├── compile/                 # 提示词编译器（标签版 + 描述版）
│   │   ├── ir/                      # 观察 IR（schema、构建、合并）
│   │   ├── trace/                   # 阶段快照 + 事实台账
│   │   ├── kb/                      # 标签知识库（SQLite）
│   │   ├── experience/              # 经验库
│   │   ├── input/                   # 解码 + 预处理
│   │   ├── pipeline/                # 阶段编排
│   │   ├── tools/                   # MCP 工具实现
│   │   ├── config/                  # 配置加载 + 校验
│   │   ├── model-profile/           # 档案 schema + 默认值
│   │   ├── runtime/                 # 惰性单例（知识库、配置存储）
│   │   └── comfyui/                 # ComfyUI 接入（扫描、客户端、工作流、补丁、任务）
│   ├── locale/                      # zh / en
│   ├── python/                      # 图片解码辅助（Pillow）
│   ├── res/                         # 标签 CSV（知识库数据源）
│   └── scripts/                     # 命令行辅助（标签导入、经验导出、编译检查）
└── README.md
```

## ComfyUI 接入（可选，默认关闭）

`comfyui` 段默认关闭。不写这一段时，插件行为与 1.0 完全一致：不读模型目录、不连任何端口、不注册额外工具。

```yaml
comfyui:
  enabled: false                        # 默认 false
  baseUrl: http://127.0.0.1:8188        # 只接受本机回环地址，且不能内嵌用户名/密码
  installRoot: D:\ComfyUI               # 绝对路径；指向插件包之外，插件不会替你创建
  extraModelPathsConfigFiles: []        # 额外的 extra_model_paths.yaml，绝对路径
  additionalModelRoots: []              # 额外的模型根目录，绝对路径
  requestTimeoutMs: 30000               # 1000–600000
```

几点约束是硬性的，不是建议：

- `baseUrl` 的主机必须是 `127.0.0.1`、`::1` 或 `localhost`。填了远程地址会得到 `COMFY_TARGET_NOT_LOCAL`，**并且整段 `comfyui` 会被关掉**——不会退回默认地址偷偷连本机。
- 所有路径必须是绝对路径。相对路径无法判断相对谁，插件不会去猜，会报 `COMFY_PATH_UNRESOLVED`。
- 未知字段会被拒并清掉（`COMFY_VALIDATION_FAILED`），因为这一段的 schema 是 `additionalProperties: false`。
- 不在这一段放任何密钥。本版本只连本机，不需要鉴权。

启用后提供六个工具，默认关闭时一个都不注册：

| 工具 | 做什么 |
|---|---|
| `comfyui_status` | 查连接状态与版本；未启用时也回答"为什么没启用" |
| `comfyui_list_models` | 扫本地模型目录，按分类/名称/四态过滤 |
| `comfyui_inspect_workflow` | 读工作流，区分 UI / API 格式，查节点与连接 |
| `comfyui_plan_workflow_patch` | 对 API 工作流生成补丁计划，只改已存在的字段 |
| `comfyui_submit_workflow` | 提交已通过校验的 API Prompt |
| `comfyui_get_job` | 查任务状态、取输出图 |

几条同样硬性的边界：

- 只读文件元数据，不读权重内容；只扫配置里给出的根，不扫整盘。
- 模型状态分四种、互不推导：磁盘存在、运行时可见、Loader 可选、执行成功。运行时没起时，可见性是 `unknown` 而不是 `false`。
- 不覆盖原始工作流文件；UI Workflow 只做识别与结构检查，不转成 API Prompt。
- 提交一旦超时或断连就记为 `unknown`，**不会自动重发**——网络错误不等于服务端没收到。
- 取图只走 `/view` 的合法参数，再把字节交给 Host 的 attachments 服务；不去读 ComfyUI 报出来的本地路径。
- 环境里配了代理、而 `no_proxy` 没排除本机地址时，直接拒绝建客户端（`COMFY_CAPABILITY_UNAVAILABLE`），避免本机请求被代理转出去。

## 技术

| | |
|---|---|
| npm 运行时依赖 | **1** —— `yaml@2.9.1`（纯 JS，ISC）；其余全部内置，纯 ESM |
| Node.js | **≥ 22.5**（内置 `node:sqlite`） |
| Python | **3 且装有 Pillow** —— 所有图片解码都依赖它 |
| Python 可选 | `numpy`（几何度量）、`rawpy`（RAW 格式） |
| 构建步骤 | 无 |
| 类型标注 | JSDoc |
| 网络 | 用户主动提供的图片 URL 下载；启用 ComfyUI 后只连本机 loopback；图片永远不会上传给第三方 |
| 数据 | `data/` 下的本地 SQLite，不入库 |

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `DECODE_FAILED` / "Pillow 不可用" | `PATH` 上的 Python 缺 Pillow | `pip install Pillow`，再跑一遍上面的 `probe` 命令 |
| `PYTHON_UNAVAILABLE` | `python.executable` 解析不到，或 `python.enabled: false` | 把 `python.executable` 设成解释器的绝对路径 |
| `KB_EMPTY` / 标签行异常地长 | 知识库还没建 | 跑一次 `rebuild_knowledge_base` |
| `KB_IMPORT_FILE_UNREADABLE` | `sources[].path` 指向的文件不存在 | 对照 `res/` 检查 `configs/knowledge-base.default.json` |
| `MODEL_PROFILE_NOT_SELECTED` | 没传 `target_profile` | 传 `illustrious` 或 `animagine-xl-4.0` |

## 许可证

Apache-2.0
