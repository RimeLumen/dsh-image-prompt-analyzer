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
| **Node.js** | **≥ 22.5** | 本地知识库用的是内置的 `node:sqlite`。唯一的 npm 依赖是纯 JS 的 `yaml`（解析 `extra_model_paths.yaml`），随插件一起装好，不需要你单独跑 `npm install`。 |
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
| Anima | `anima` | 正向走自然语言描述版（`word_style: prose`），`high score` 质量块 |

`anima` 曾用名 `animagine-xl-4.0`，`AnimaImage`、`animagine`、`animagine-xl` 也都是它的别名——同一份档案，不是多个模型。旧名写在 `aliases` 里，按旧名查照样解析到 `anima`；忽略大小写与 `- _ . 空白` 的写法（`AnimaImage`、`ANIMAGINE-XL-4.0`）也能查到。别名冲突时不猜，直接报找不到。

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
│   │   ├── client.js                # 浏览器半侧（对话里的任务卡片，单文件 bundle）
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
│   │   └── comfyui/                 # ComfyUI 接入（自动发现、扫描、客户端、工作流、补丁、任务）
│   ├── locale/                      # zh / en
│   ├── python/                      # 图片解码辅助（Pillow）
│   ├── res/                         # 标签 CSV（知识库数据源）
│   └── scripts/                     # 命令行辅助（标签导入、经验导出、编译检查）
└── README.md
```

## ComfyUI 接入（默认开启，自动发现）

装好就能用：不写 `comfyui` 段也会自动找本机的 ComfyUI，**不需要预先填 `installRoot`、YAML 或模型目录**。

```yaml
comfyui:
  enabled: true                         # 默认 true；写 false 就彻底停用
  autoDetect: true                      # 默认 true；写 false 就只用下面手填的路径
  baseUrl: http://127.0.0.1:8188        # 只接受本机回环地址，且不能内嵌用户名/密码
  installRoot: null                     # 留空就走自动发现；填了就以你填的为准
  extraModelPathsConfigFiles: []        # 额外的 extra_model_paths.yaml，绝对路径
  additionalModelRoots: []              # 额外的模型根目录，绝对路径
  workflowDirs: []                      # 额外的工作流目录，绝对路径；默认只看 ComfyUI 自己的
  requestTimeoutMs: 30000               # 1000–600000
  objectInfoTtlMs: 300000               # /object_info 缓存有效期，1000–86400000
```

自动发现按固定顺序尝试，每一步都只查已知位置和这些位置往下几层，**不遍历盘根、不扫用户目录、不扫端口段**：

1. 你手填的 `installRoot`——最优先，自动发现不会覆盖它。
2. 正在运行的 ComfyUI 进程——读它的命令行，取出 `main.py` 所在目录、`--port`、`--listen`、`--models-directory`、`--base-directory`、`--extra-model-paths-config`。只做只读的系统进程查询，不执行 ComfyUI 的 Python，也不启动或停止它。谁把它拉起来的都算：Portable 的 `run_nvidia_gpu.bat`、自己 `git clone` 后敲的 `python main.py`、第三方整合启动器，走的都是这一条。
3. Portable / Git 安装的固定候选位置，用 `main.py` + `folder_paths.py` 两个文件确认是不是真的安装根。
4. 从上面这些候选位置有界下探一层：整合启动器会把 ComfyUI 埋在 `<盘>:\ComfyUI\<启动器>\<启动器>\ComfyUI` 这种地方，固定候选到 `<盘>:\ComfyUI` 就断了。下探只进名字里带 `comfy` 的目录，跳过 `models`、`input`、`output`、`custom_nodes` 这类不会有第二个安装根的目录；深度最多 4 层、每层最多看 200 条、一次最多 240 个目录，并且按盘均分预算，不会让第一块盘把额度吃光。
5. 每个候选自己的 `extra_model_paths.yaml`，以及你显式列出的额外 YAML。
6. 你手填的 `additionalModelRoots`。
7. 最后才用默认 loopback 地址探一下有没有服务在跑——**能连上不代表安装根和模型根是对的**，所以只连上、路径没确认的候选会标 `partial` 而不是 `found`。

发现是惰性的：插件加载时只读配置，不碰磁盘；第一次调用 `comfyui_status` 或 `comfyui_list_models` 才真正开始找，结果缓存在进程内存里。

安装目录与模型目录是两个独立的东西。模型根可以完全不在安装目录下（YAML 里指向别的盘、`--models-directory` 指到别处，都照办）。发现到多个实例时返回候选列表并标 `ambiguous`，**不会替你挑一个**。

几点约束是硬性的，不是建议：

- `enabled: false` 时不发现、不扫描、不连接、**七个工具一个都不注册**。
- `baseUrl` 的主机必须是 `127.0.0.1`、`::1` 或 `localhost`。填了远程地址会得到 `COMFY_TARGET_NOT_LOCAL`，**并且整段 `comfyui` 会被关掉**——不会退回默认地址偷偷连本机。
- 所有手填路径必须是绝对路径。相对路径无法判断相对谁，插件不会去猜，会报 `COMFY_PATH_UNRESOLVED`。
- 未知字段会被拒并清掉（`COMFY_VALIDATION_FAILED`），因为这一段的 schema 是 `additionalProperties: false`。
- 不在这一段放任何密钥。本版本只连本机，不需要鉴权。

**支持**：Windows Portable、`git clone` 后的常规布局、以及第三方整合启动器拉起的 ComfyUI（靠进程命令行认出真实安装位置，不需要知道启动器是谁）。

**不支持**官方 ComfyUI Desktop 的私有配置——`extra_models_config.yaml`、`settings.json`、`installations.json` 之类不做适配，也不参与发现。Desktop 拉起的进程如果确实在跑 ComfyUI 的 `main.py`，通用进程发现照样能认出它的安装根，但会标注这是 Desktop 应用包、不算受支持的安装方式；长期使用请把 `comfyui.installRoot` 指向你自己装的 ComfyUI。

启用后提供十个工具：

| 工具 | 做什么 |
|---|---|
| `comfyui_status` | 查连接状态与版本；未启用时也回答"为什么没启用" |
| `comfyui_list_models` | 扫本地模型目录，按分类/名称/四态过滤 |
| `comfyui_list_workflows` | 列本地工作流名称，可按名字过滤，不带文件内容 |
| `comfyui_build_workflow` | 按模型与参数搭一份基础 API 工作流，逐项过节点定义校验 |
| `comfyui_save_workflow` | 把工作流另存为新文件；只新建，不覆盖 |
| `comfyui_inspect_workflow` | 读工作流，区分 UI / API 格式，查节点与连接 |
| `comfyui_plan_workflow_patch` | 对 API 工作流生成补丁计划，只改已存在的字段 |
| `comfyui_submit_workflow` | 提交已通过校验的 API Prompt |
| `comfyui_get_job` | 查任务状态、取输出图 |
| `comfyui_start` | 打开启动器 / 启动后端 / 打开安装目录 / 打开 Web UI |

### 用本地已有工作流，不用上传文件

生图前只要说一个名字就够了，插件自己去 ComfyUI 的工作流目录里找：

- 目录按 `<安装根>/user/default/workflows` → `<安装根>/workflows` → 配置里 `comfyui.workflowDirs` 的顺序看，不会去扫整块盘。
- 名字可以不带 `.json`，大小写和 `-` `_` 空格之间的差别也认。
- 同名的有多份时报候选（带路径），由你指定用哪份；找不到就报错并列出可用名字，绝不拿别的工作流顶替。
- 只接受 API 格式。UI 格式能读能看结构，但不会自动转换，也不会被当成 API Prompt 提交。
- 修改默认只在内存里的工作副本上做，原始文件不动；要落盘就走 `comfyui_save_workflow`，只新建不覆盖。

改工作流时可以直接说"换成某个 checkpoint""把第一个 LoRA 降到 0.6""步数改成 30"，插件会把这句话翻成具体节点上的具体字段。工作流里有多个同类节点时它不猜，会带着候选回来问。

`/object_info` 按节点名逐个取，命中缓存就不发请求；缓存默认 5 分钟（`comfyui.objectInfoTtlMs` 可调），换 ComfyUI 实例、节点定义对不上、或显式要求刷新时才重取。返回给对话的只有"节点在不在、必填项齐不齐、这次改的字段合不合法"，不把整份定义灌进去。

几条同样硬性的边界：

- 只读文件元数据，不读权重内容；只扫配置里给出的根，不扫整盘。
- 模型状态分四种、互不推导：磁盘存在、运行时可见、Loader 可选、执行成功。运行时没起时，可见性是 `unknown` 而不是 `false`。
- 不覆盖原始工作流文件；UI Workflow 只做识别与结构检查，不转成 API Prompt。
- 提交一旦超时或断连就记为 `unknown`，**不会自动重发**——网络错误不等于服务端没收到。
- 取图只走 `/view` 的合法参数，再把字节交给 Host 的 attachments 服务；不去读 ComfyUI 报出来的本地路径。
- 环境里配了代理、而 `no_proxy` 没排除本机地址时，直接拒绝建客户端（`COMFY_CAPABILITY_UNAVAILABLE`），避免本机请求被代理转出去。

### 磁盘扫描与运行时状态是两件事

`comfyui_list_models` 每一条都带四个状态，四个互不推导：

| 状态 | 来源 | 不知道时 |
|---|---|---|
| `disk_present` | 按配置/发现出来的模型根列目录 | 不会不知道，扫不到就是 `false` |
| `runtime_visible` | `GET /models/<分类>` 返回的文件名列表 | `unknown` |
| `loader_selectable` | `/object_info` 里对应 loader 节点的下拉枚举 | `unknown` |
| `execution_success` | 本进程内真实跑通过一次 | `unknown` |

所以「磁盘上有这个模型」不代表 ComfyUI 认得它（分类目录名和分类名不一定同名，`unet/` 会映射到 `diffusion_models`），「ComfyUI 认得」也不代表某个 loader 的下拉里能选到。反过来，`vae` 的枚举里有 `pixel_space`、`taesd` 这类**虚拟项**，它们不对应任何磁盘文件——这些单独放在 `virtual_entries` 里，不混进模型清单。

分类统计有两套口径，分开给：

- `categories`：磁盘上真实存在的分类目录（别名目录已归并，`clip/` 算 `text_encoders`）。这个字段的语义一直没变。
- `runtime_categories`：`GET /models` 返回的运行时分类全集，可能远多于磁盘（自定义节点会注册自己的分类）。ComfyUI 连不上时是 `null`，不是空数组。
- `category_summary`：两边取并集后逐类给数——`disk_files`、`runtime_files`、`runtime_only`、`empty`、`has_loader`。`runtime_files` 为 `null` 表示**不知道**（没连上、这个分类单独取不到、或者运行时压根没注册它），不是 0；把它写成 0 就等于替 ComfyUI 回答"你没有这个文件"。

`virtual_entries` 相关有几个计数字段，含义不同：`virtual_total` 是本次范围内（受 `category` 过滤影响）的运行时独有条目数，`virtual_truncated` 表示超过 `VIRTUAL_LIMIT` 被截断，`virtual_skipped` 是被过滤规则挡掉的数量（**历史上把扩展名过滤和分类过滤合在一起算**，指定 `category` 时会包含别的分类的条目），`virtual_filtered_out` 只统计**被扩展名等过滤规则排除的数量**，与 `category` 参数无关（`custom_nodes` 这类目录型分类里全是 `.py`/`.pyc`，真机上这个数能上万）——它不代表跳过了多少个分类。四个字段都保留，旧字段语义没改。

`execution_success` 只在 `/history` 明确说完成、没有执行错误、工作流结构和本次提交对得上、且输出里确实有能安全取回的图片时才会写。它**不写进任何本地数据库**：每次查询都从 ComfyUI 的 `/history` 重新推导，记录被 ComfyUI 清掉就没了——**不要把它当历史数据库**。

### 启动与打开

`comfyui_start` 只有四个固定动作，接口里根本没有「命令」这个字段：

| 动作 | 行为 |
|---|---|
| `start_backend` | 先探 `/system_stats`；已经在响应就返回 `started: false, reason: already_running`，一次都不 spawn。没响应才找解释器，argv 写死为 `[python, main.py, --listen, 127.0.0.1, --port, <端口>]`，cwd 是安装根 |
| `open_launcher` | 在安装根和它的上一级里按固定文件名找启动器；零个报 `COMFY_CAPABILITY_UNAVAILABLE` 并列出找过的路径，**多个报 `COMFY_BINDING_AMBIGUOUS` 并列出全部候选，不替你挑** |
| `open_install_folder` | 用 `explorer.exe` 打开安装根 |
| `open_web_ui` | 用系统默认处理程序打开当前地址；非回环地址直接 `COMFY_TARGET_NOT_LOCAL` |

解释器按 `python_embeded/python.exe`、`python/python.exe`、`venv/Scripts/python.exe`、`.venv/Scripts/python.exe` 的顺序在安装根和上一级里找（整合包常把 python 放在 `<包>/python/`，而安装根是 `<包>/ComfyUI`）。找不到时报错里会列出所有找过的路径，**不会去扫盘**。

`dispose()` 只 `terminate()` 本插件自己启动的进程；你自己手动拉起来的 ComfyUI 从不进这条路径，插件卸载也不会把它带走。

### 在对话里看图

`comfyui_get_job` 完成时会往工具结果里写一组最小图片引用（`attachmentId`/`mediaType`/`bytes`/`width`/`height`），对话里的任务卡片据此渲染缩略图，点开是大图。

图片走的是**同源转发**：插件在宿主 `webServer` 上挂一条 `/comfyui/image?filename=…` 的路由，服务端按 `/view` 的规矩重新校验输出引用（文件名不能含 `..` 或路径分隔符、`subfolder` 不能越界、`type` 只能是 `output|input|temp`），再从 ComfyUI 取原始字节原样转发。

这么做有两个原因，都不是可以绕开的：

- 页面 CSP 是 `default-src 'self'`，跨源到 `127.0.0.1:8188/view` 的图片会被浏览器直接拦掉。
- 宿主只授权「会话事件里出现过的图片」给浏览器读。生成结果不在会话事件里，所以走宿主的附件通道拿不到。

路由是懒注册的：第一次需要出图时才挂，`dispose()` 时注销——不注销的话下一次加载会因为路径重复注册而失败。宿主没有 `webServer` 时退回 ComfyUI 的原始地址（只在本机有效），而不是假装能显示。

生成图**不会**变成模型的视觉输入：`render()` 里只有文本，图片引用只进卡片。

### 已知限制

- **Host 会把 PNG 转成 JPEG 再存**。ComfyUI 输出 `image/png`，经宿主 attachments 服务落盘后是 `image/jpeg`（体积明显变小，尺寸不变）。工具返回的 `media_type`/`bytes` 是宿主实际存下的值，不是原始 PNG 的大小——文档和报告里都不该说成"原始 PNG 附件"。卡片显示的图走同源路由取的是 ComfyUI 原始字节，两者不是同一份。
- **`execution_success` 不落盘**，插件自己不写任何历史库。每次 `comfyui_get_job` 都从 ComfyUI 的 `/history` 重新推导：只要 ComfyUI 还留着那条记录，重载插件后仍然查得到；记录被 ComfyUI 清掉（默认只留最近若干条）就查不到了。返回里的 `persistence: process` 标的是**本次 run 的登记**（提交时那份 workflow 副本）只在进程内——重载后再查同一个 `prompt_id`，`workflow` 字段是 `null`，其余字段由 `/history` 还原。
- **`partial_saved` 无法回滚**。多张图逐张保存，中途失败时已经存下的那张仍然交回去，并明确标 `partial_saved: true`——宿主的附件服务没有删除接口，回滚不了。
- **UI 格式工作流只识别不转换**。`comfyui_inspect_workflow` 能读 UI 格式并报结构，但 `comfyui_plan_workflow_patch` 只接受 API 格式。
- **不自动搭图**。补丁只改已存在字段，不新增节点、不改 `class_type`、不覆盖原文件。

### Windows 整合版的坑

秋葉这类整合包会把 ComfyUI 埋在 `<盘>:\ComfyUI\<启动器>\<启动器>\ComfyUI` 这种位置，启动器（`绘世启动器.exe`）和 python 都在**安装根的上一级**。插件对这两样都往上一级找，但如果你把 `installRoot` 指到了内层 `ComfyUI` 目录之外的地方，就会找不到。

诊断顺序：

1. `comfyui_status` 看 `discovery.status`。`found` 但 `runtime_reachable: false` 说明装好了没运行；`not_running` 同理；`ambiguous` 说明发现到多个实例，需要你填 `installRoot` 指定。
2. `comfyui_status` 的 `base_url_source` 三档：`config`（只有配置值）、`discovery_candidate`（发现出来的、还没验证）、`verified`（真的 HTTP 连通过）。
3. `start_backend` 报找不到解释器时，报错里会列出所有找过的路径——照着看是缺 `python_embeded` 还是安装根指错了。
4. 卡片显示「重试」而不是图：先确认 `/comfyui/image` 路由挂上了（宿主没有 `webServer` 时会退回跨源地址，被 CSP 拦掉）。

## 技术

| | |
|---|---|
| npm 运行时依赖 | **1** —— `yaml@2.9.1`（纯 JS，ISC）；其余全部内置，纯 ESM |
| Node.js | **≥ 22.5**（内置 `node:sqlite`） |
| Python | **3 且装有 Pillow** —— 所有图片解码都依赖它 |
| Python 可选 | `numpy`（几何度量）、`rawpy`（RAW 格式） |
| 构建步骤 | 无 |
| 类型标注 | JSDoc |
| 网络 | 用户主动提供的图片 URL 下载；启用 ComfyUI 后只连本机 loopback，生成图经宿主同源路由 `/comfyui/image` 转发；图片永远不会上传给第三方 |
| 数据 | `data/` 下的本地 SQLite，不入库 |

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `DECODE_FAILED` / "Pillow 不可用" | `PATH` 上的 Python 缺 Pillow | `pip install Pillow`，再跑一遍上面的 `probe` 命令 |
| `PYTHON_UNAVAILABLE` | `python.executable` 解析不到，或 `python.enabled: false` | 把 `python.executable` 设成解释器的绝对路径 |
| `KB_EMPTY` / 标签行异常地长 | 知识库还没建 | 跑一次 `rebuild_knowledge_base` |
| `KB_IMPORT_FILE_UNREADABLE` | `sources[].path` 指向的文件不存在 | 对照 `res/` 检查 `configs/knowledge-base.default.json` |
| `MODEL_PROFILE_NOT_SELECTED` | 没传 `target_profile` | 传 `illustrious` 或 `anima` |
| `COMFY_CAPABILITY_UNAVAILABLE`（`comfyui_start`） | 没找到启动器，或没找到 python 解释器，或 Host 没有 `subprocess` 服务 | 看报错里列出的 `scanned_paths`；手填 `comfyui.installRoot` 指向真正的安装根 |
| `COMFY_BINDING_AMBIGUOUS` | 安装根和上一级里找到多个启动器 | 报错里会列出全部候选；手动打开你要用的那个 |
| `COMFY_TARGET_NOT_LOCAL` | `baseUrl` 或 `open_web_ui` 的目标不是回环地址 | 改回 `127.0.0.1` / `localhost` / `::1`；插件不会退回默认地址偷偷连本机 |
| `COMFY_PATH_DENIED` | Host 文件系统服务拒绝了这次读取 | 这是终点，插件不会换 `node:fs` 绕过；检查路径权限或把它移出受保护目录 |
| 卡片显示「重试」 | 同源路由没挂上，退回的跨源地址被 CSP 拦掉 | 确认 profile 里有 `webServer`；重载插件后再查一次任务 |
| `COMFY_SUBMISSION_UNKNOWN` | 提交超时或断连，服务端到底收没收到不知道 | 去 ComfyUI 队列里看一眼；**插件不会自动重发**，重发前先确认队列里没有 |

## 许可证

Apache-2.0
