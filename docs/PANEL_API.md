# 结果面板只读接口规范 v1.1

本文件是 `dsh-image-prompt-analyzer` 结果面板 HTTP 接口的**规范性**说明。实现见
`dsh-image-prompt-analyzer/lib/panel.js`；机器可读契约见
[`panel-api.openapi.yaml`](./panel-api.openapi.yaml)；页面内测试台见
`dsh-image-prompt-analyzer/client.js` 的「调试」区。

本文用 RFC 2119 风格用词：**必须**（MUST）、**不得**（MUST NOT）、**应当**（SHOULD）、
**可以**（MAY）。

---

## 1. 目的与范围

规范解决两个具体问题：

1. **客户端不知道往哪发请求。** 早期验证脚本依赖 `DSH_WEB_URL` 环境变量，该变量在多数
   部署里并不存在，于是脚本连不上、`curl` 报 `000`，失败原因不可判定。
2. **桌面端与 Web 端的访问前提不同。** 桌面端（Electron）的宿主 Web 服务器在路由前有一道
   渲染器能力门禁；Web 端（独立 `dsh web`）没有。两套客户端必然漂移。

因此规范**同时规定**：地址如何发现（§3）、两端如何用同一套判定访问（§4）、失败如何分类并
报告（§6、§7）。规范只覆盖**已存在**的接口，不新增端点。

**非目标**：鉴权协议本身、宿主的门禁实现、插件工具面的契约。

---

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| 面板前缀 | `/dsh-image-prompt-analyzer/api`，固定不可配置（`lib/panel.js:22`） |
| base URL | 协议 + 主机 + 端口，例如 `http://127.0.0.1:43120`；不含面板前缀 |
| 宿主门禁 | 桌面端在路由分发**之前**拒绝无渲染器凭证请求的机制，响应固定为 `403` + `text/plain` + `forbidden` |
| 面板拒绝 | 面板自己的语义化错误：JSON body + `error_code`，例如 `405` / `404` |
| 探测（probe） | 一次方法 + 路径 + 期望值的请求，带判定结果（`verdict`） |

**宿主门禁与面板拒绝必须区分。** 两者都可能表现为"请求失败"，但处置完全不同：
前者是环境/权限问题，后者是接口语义问题。把前者误报成后者，会让人去改插件；
把后者误报成前者，会让人去改环境。

---

## 3. base URL 发现

客户端**必须**按下列顺序发现 base URL，每一级都要在报告里留下命中记录（`discovery_trace`）：

| 级别 | 来源 | 规则 |
| --- | --- | --- |
| 1 | 环境变量 `DSH_WEB_URL` | **必须**是合法的 `http:` / `https:` 绝对 URL；末尾 `/` 应当去掉。非法值不得当作地址使用，但要记录一条失败轨迹 |
| 2 | profile 配置 `<DSH_HOME>/profiles/<DSH_PROFILE>/cordis.patch.yml` 的 `webserver` 行 | 取 `port`；`host` 为 `0.0.0.0` 或 `::` 时**必须**替换为 `127.0.0.1`。`DSH_HOME` 未设置时取 `~/.dsh` |
| 3 | 默认值 | `http://127.0.0.1:43120`（DSH Desktop 的默认端口；与 profile 配置一致） |
| 4 | 全部失败 | 判定为 `DISCOVERY_FAILED` 并**终止**，不得继续发请求 |

约束：

- 客户端**不得**发明端口、不得扫描端口段、不得在失败后静默切换地址。发现结果与命中依据
  **必须**出现在输出里，否则"连不上"依然不可诊断。
- 页面内测试台（`client.js`）是例外：它的请求由页面自己发出，base URL **必须**取
  `window.location.origin`（同源），不使用上述 1–3 级。

---

## 4. 访问模型（桌面端与 Web 端同一套）

### 4.1 两端的差异只有一处

| 部署形态 | 请求来源 | 宿主门禁 |
| --- | --- | --- |
| Web 端（`dsh web`） | 浏览器页面 / 命令行客户端 | 无 |
| 桌面端（DSH Desktop） | Electron 渲染器页面 | 有，要求请求头 `x-dsh-desktop-renderer: <43 字符 base64url 令牌>` |

令牌由宿主每次启动随机生成、不经环境变量与磁盘暴露，**命令行客户端通常拿不到**。
因此规范的策略是：**同一段判定代码，先裸请求，识别门禁，再决定是否重试。**

### 4.2 判定顺序

1. 发一次不带任何自定义凭证的请求。
2. 若响应满足 `status === 403` 且 `content-type` 以 `text/plain` 开头 且 响应体去空白后
   恰为 `forbidden`（大小写敏感）——判定 `HOST_GATE_DENIED`。这是宿主门禁。
3. 若环境变量 `DSH_DESKTOP_RENDERER_TOKEN` 存在且为 43 字符 base64url，客户端**可以**
   带 `x-dsh-desktop-renderer: <令牌>` 重试**一次**；重试仍失败则保留 `HOST_GATE_DENIED`。
4. 其余响应交给 §5 的语义判定。

`HOST_GATE_DENIED` 的报告**必须**附带处置建议，并且**不得**表述为"接口坏了"：

> 桌面端在路由之前拒绝了本请求：需要 Electron 渲染器凭证。可选处置：从 Harness 页面的
> 调试区发起（同源、自带凭证）；或设置 `DSH_DESKTOP_RENDERER_TOKEN` 后重试；或在
> Desktop 设置中允许普通浏览器访问。接口本身没有被调用，不能用它判断接口是否正常。

### 4.3 只读纪律

客户端**不得**发送 `PUT` / `PATCH` / `DELETE`。`POST` **仅**用于验证 `405` 语义，
不得携带请求体。

---

## 5. 端点

所有路径均以 §2 的前缀开头，完整形式为 `<base>/dsh-image-prompt-analyzer/api/<path>`。

| 方法 | 路径 | 成功响应 | 说明 |
| --- | --- | --- | --- |
| `GET` / `HEAD` | `/` | `200` summary | 与 `/summary`、`/tasks` 返回**同一个对象结构** |
| `GET` / `HEAD` | `/summary` | `200` summary | 推荐入口 |
| `GET` / `HEAD` | `/tasks` | `200` summary | 摘要视图；与 `/summary` 等价（实现共用同一分支，`lib/panel.js:215-218`） |
| `GET` / `HEAD` | `/tasks/{task_id}` | `200` `{schema_version, task}` | 单条完整结果；`task_id` 需 `decodeURIComponent` |
| 其他方法 | 任意路径 | `405` | `error_code = PANEL_METHOD_NOT_ALLOWED` |
| `GET` / `HEAD` | 未知路径（未命中任务） | `404` | `error_code = PANEL_TASK_NOT_FOUND` |

**已知实现细节（规范照实记录，不作美化）**：前缀下的**未知路径**也返回
`PANEL_TASK_NOT_FOUND`（`lib/panel.js:236-242`），与"任务不存在"共用同一个错误码。
客户端因此**不得**把 `PANEL_TASK_NOT_FOUND` 直接读成"任务不存在"，必须结合请求路径与
`suggested_fix` 判断。

### 5.1 summary 对象

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema_version` | string | 是 | 固定 `"1.1"`；主版本变化即不兼容 |
| `generated_at` | string (ISO 8601) | 是 | **每次请求重新生成**，见 §8 |
| `plugin_version` | string \| null | 是 | 取不到时为 `null` |
| `read_only` | boolean | 是 | 固定 `true`，是契约声明而非装饰 |
| `totals.tasks` | number | 是 | 内存环形缓冲当前条数 |
| `totals.recent_limit` | number | 是 | 上限，`1..200` |
| `totals.experiences` | number \| null | 是 | 经验库总数；库不可用时 `null` |
| `totals.rated_experiences` | number \| null | 是 | 已评分数；库不可用时 `null` |
| `by_profile` | object | 是 | 档案 → 经验条数；空对象表示"还没有经验"，不是"统计失败" |
| `recent_tasks` | array | 是 | 列表视图，见 §5.2 |
| `storage.size` / `storage.limit` | number | 是 | 与 `totals` 同源 |
| `storage.database_path` | string \| null | 是 | 知识库路径；不可用时 `null` |
| `configs` | object \| null | 是 | 配置快照；runtime 未就绪时 `null` |
| `note` | string | 是 | 固定文案，列出可用的工具名，见 §5.4 |

### 5.2 `recent_tasks[]` 一项

`task_id`（string，唯一键）、`created_at`、`image`（对象或 `null`）、`target`（对象或 `null`）、
`target_profile`（string 或 `null`）、`positive_prompt`、`negative_prompt`、
`positive_term_count`、`negative_term_count`、`low_confidence_count`、`dropped_count`、
`knowledge_base_used`（boolean）、`saved_experience_id`（number 或 `null`）、`warning_count`。

### 5.3 `/tasks/{id}` 的 `task`

字段与 §5.2 同源，但为完整形态：`positive_terms` / `negative_terms` / `low_confidence` /
`dropped` 是数组（不是计数），并额外带 `ir`、`stats`、`warnings`、`quality_prefix`。

### 5.4 `note` 的最小内容

`note` **必须**至少包含以下 6 个工具名（数量与拼写都是契约）：

1. `analyze_image_prompt`
2. `validate_configs`
3. `diagnose_knowledge_base`
4. `rebuild_knowledge_base`
5. `preview_model_profile`
6. `manage_experiences`

---

## 6. 错误模型

面板错误响应**必须**是 `application/json; charset=utf-8`，并至少包含
`schema_version`、`error_code`、`message`；可用时带 `error_group`、`suggested_fix`。

| HTTP | `error_code` | 触发条件 |
| --- | --- | --- |
| `405` | `PANEL_METHOD_NOT_ALLOWED` | 方法不是 `GET` / `HEAD` |
| `404` | `PANEL_TASK_NOT_FOUND` | 任务不存在，或前缀下未知路径（见 §5） |
| `500` | `PANEL_INTERNAL_ERROR` | handler 抛异常 |
| （诊断，非 HTTP） | `PANEL_ROUTE_UNAVAILABLE` | 部署没有 `webServer` 服务，路由未注册 |
| `400` | `PANEL_UPLOAD_TOO_LARGE` | 工作台上传 / 下载超过 `image.max_bytes`（v1.1 动作路由） |
| `400` | `PANEL_FETCH_UNSUPPORTED_PROTOCOL` | 工作台 URL 下载只接受 http/https（v1.1 动作路由） |
| `400` | `PANEL_FETCH_FAILED` | 工作台 URL 下载失败：网络错、非 2xx、超时（v1.1 动作路由） |
| `400` | `PANEL_REQUEST_INVALID` | 工作台动作 JSON 体解析失败、根不是对象、含未知字段或缺必填键（v1.1 动作路由） |
| `403` | `PANEL_ORIGIN_REJECTED` | 工作台动作的同源校验不过：缺 `Origin` 或与 Host 不匹配（v1.1 动作路由） |

`403` + `text/plain` + `forbidden` **不是**面板错误，是 §4.2 的宿主门禁。

---

## 7. 客户端判定词汇（`verdict`）

客户端**必须**把每次探测归一成下列词汇之一，并**不得**输出裸的 `000`：

| verdict | 判定依据 | 归类 |
| --- | --- | --- |
| `OK` | `2xx` 且 body 是可解析 JSON | 通过 |
| `VERSION_MISMATCH` | JSON 可解析但 `schema_version` ≠ `"1.1"` | 环境/版本问题 |
| `METHOD_NOT_ALLOWED` | `405`（body 的 `error_code` 应为 `PANEL_METHOD_NOT_ALLOWED`） | 面板语义 |
| `TASK_NOT_FOUND` | `404`（body 的 `error_code` 应为 `PANEL_TASK_NOT_FOUND`） | 面板语义 |
| `HOST_GATE_DENIED` | §4.2 门禁特征 | 环境/权限 |
| `INVALID_JSON` | `2xx` 但 body 不是 JSON | 实现缺陷 |
| `HTTP_ERROR` | 其他 `4xx` / `5xx` | 实现缺陷 |
| `DNS_FAILURE` | `ENOTFOUND` / `EAI_AGAIN` | 环境 |
| `CONNECTION_REFUSED` | `ECONNREFUSED` | 环境 |
| `TIMEOUT` | 超时 / `AbortError` | 环境 |
| `TLS_FAILURE` | 证书/握手类错误 | 环境 |
| `NETWORK_FAILURE` | 兜底网络错误 | 环境 |
| `DISCOVERY_FAILED` | §3 四级全失败，未发请求 | 环境 |

---

## 8. 一致性与比较规则

1. **`generated_at` 每次请求都会变**（`lib/panel.js:177`）。比较 `GET /`、`/summary`、
   `/tasks` 的一致性时**必须**先剔除该字段，否则必然不等。
2. `GET /`、`/summary`、`/tasks` 剔除 `generated_at` 后**必须**逐字段相等。
3. `schema_version` 的主版本不同即视为不兼容；不得尝试部分解析。
4. 面板状态是**内存**的：重启即空。`recent_tasks` 为空是正常状态，不是故障。

---

## 9. 安全约束

- 路由只读：**不得**出现能改变状态的端点；改变状态一律走工具。
- 默认只监听回环。桌面端另有能力门禁（§4.2），规范不要求客户端绕过它。
- 客户端输出**不得**回显任何令牌（`DSH_DESKTOP_RENDERER_TOKEN`、设备 secret），
  只**可以**报告"是否使用了令牌"。

---

## 10. 一致性用例（A–E）

命令行客户端与页面测试台**必须**实现同一组用例；失败项要能定位到具体字段。

| 用例 | 步骤 | 通过条件 |
| --- | --- | --- |
| A | `GET /`、`GET /summary`、`GET /tasks` | 三条都是 `200` + JSON，且剔除 `generated_at` 后逐字段相等 |
| B | 检查 `GET /summary` | 必填字段齐全且类型正确（§5.1），`read_only === true`，`schema_version === "1.1"` |
| C | 取 `note` | 含 §5.4 全部 6 个工具名 |
| D | `POST /summary`（无 body） | `405`，且 `error_code === "PANEL_METHOD_NOT_ALLOWED"`，`content-type` 是 JSON |
| E | `GET /tasks/does-not-exist` | `404`，且 `error_code === "PANEL_TASK_NOT_FOUND"`，`content-type` 是 JSON |

**阻断语义**：若某用例依赖的探测得到 `HOST_GATE_DENIED` 或任一 `*_FAILURE` / `TIMEOUT`，
该用例判 `BLOCKED` 而**不是** `FAIL`。三者必须分开统计：

- `PASS`：接口行为符合本规范；
- `FAIL`：接口被调用到了，但行为不符合规范（实现问题）；
- `BLOCKED`：接口**没有被调用到**（环境/权限问题），不能用它判断接口好坏。

命令行退出码随之定义：`0` 全 PASS；`1` 存在 FAIL；`2` 无 FAIL 但存在 BLOCKED。

---

## 11. 测试台与导出

页面内测试台（`client.js`「调试」区）是 §10 的可视化实现，额外要求：

- **用例按钮**：一次点击跑完 A–E 五条用例，逐条给出 `PASS`/`FAIL`/`BLOCKED` 与
  可定位到字段的说明；`BLOCKED` 时必须同时给出环境侧原因与处置方向。
- **DEBUG 模式**（默认关，开关状态随本次导出一起记录）开启后**必须**额外记录：
  请求头、响应头、`error_code` 与门禁判定依据（`gate_evidence`）。
  `path`、`method`、`status`、`verdict`、`body`、`content_type`、`duration_ms`
  无论开关都记录——`content_type` 参与 D/E 的判定，不能只在 DEBUG 下才有。
- **JSON 导出**：导出的对象**必须**包含
  `spec_version`、`exported_at`、`environment{origin, base_url, discovery_trace, user_agent}`、
  `debug`、`requests[]`、`assertions[]`、`notes[]`；
  `requests[]` 单项含 `id`、`method`、`path`、`started_at`、`duration_ms`、`status`、
  `verdict`、`body`、`content_type`。
  浏览器端只可能走「同源」这一级发现，因此 `discovery_trace` 只有一条
  `level: 0` 记录，`base_url` 由 `window.location.origin` 推出；命令行客户端会给出
  完整的四级轨迹（§3），额外带 `environment.node` 与 `exit_code`，没有 `user_agent`。
  两端共用 `origin` / `base_url` / `discovery_trace` / `requests[]` / `assertions[]` /
  `notes[]` 这套字段名，差异只来自运行环境本身，便于把两份 JSON 并排比较。
  **`base_url` 一律是「服务根」，不含接口前缀**（前缀已包含在 `requests[].path` 里）；
  写成 `…/dsh-image-prompt-analyzer/api` 会让两份日志无法按同一字段对照。
- 导出**不得**包含任何令牌或设备 secret（§9）；`body` 超过 2000 字符时截断并标注。
- 剪贴板不可用（非安全上下文、`file://`）时**必须**仍把 JSON 显示出来供手工复制，
  不能只报一句失败。

---

## 12. 与实现的映射

| 规范条目 | 实现位置 |
| --- | --- |
| 前缀、版本、错误码 | `dsh-image-prompt-analyzer/lib/panel.js:21-29` |
| `/`、`/summary`、`/tasks` 同构 | `dsh-image-prompt-analyzer/lib/panel.js:215-218` |
| `405` 分支 | `dsh-image-prompt-analyzer/lib/panel.js:203-212` |
| `404` 分支（含未知路径） | `dsh-image-prompt-analyzer/lib/panel.js:219-242` |
| `summary` 字段 | `dsh-image-prompt-analyzer/lib/panel.js:166-196` |
| `note` 文案 | `dsh-image-prompt-analyzer/lib/panel.js:194` |
| 列表视图字段 | `dsh-image-prompt-analyzer/lib/panel.js:98-115` |
| 完整条目字段 | `dsh-image-prompt-analyzer/lib/panel.js:32-74` |
| 路由注册 | `dsh-image-prompt-analyzer/lib/panel.js:254-273` |
| 客户端消费 | `dsh-image-prompt-analyzer/client.js`（`API_BASE`、`PANEL_API_VERSION`） |
| 页面测试台（§10/§11） | `dsh-image-prompt-analyzer/client.js`（`runSelfCheck`、`buildExportPayload`、`DebugConsole`） |
| OpenAPI 文档 | `docs/panel-api.openapi.yaml` |
| 宿主门禁 | DSH Desktop `lib/webserver.js`、`lib/desktop-browser-access-*.js`（宿主私有，不在本仓库） |

## 13. 变更策略

- `schema_version` 主版本变化 = 不兼容变更，页面必须显式报"版本对不上"而不是显示空面板。
- 新增可选字段属兼容变更，**不得**改变现有字段的类型与语义。
- 前缀与错误码枚举**不得**变更；如需新增错误码，必须同时更新本文件、OpenAPI 与
  客户端的 verdict 映射表。

## 14. 工作台动作路由（v1.1 新增）

v1.1 在同一前缀下新增 `/api/workbench/*` 动作子命名空间。**查询路由（§5）与只读语义
一字不变**；动作路由是仅有的写面，约束如下（本节即权威契约）：

### 14.1 通用规则

- **仅 POST**：GET/HEAD 打到动作路径 → `405` + `PANEL_METHOD_NOT_ALLOWED`。
- **同源校验**：动作要求 `Origin` 头存在且与 `Host` 匹配；缺失或不匹配 →
  `403` + `PANEL_ORIGIN_REJECTED`。浏览器同源 fetch 必带 `Origin`，此规则挡跨站表单
  与命令行直打。
- 所有失败都是 `application/json` 结构化错误（§6 的错误模型）。
- 每个动作执行前做**机会式清扫**：删除工作台目录（`<dataDir>/tmp/workbench/`）里
  mtime 超过 `panel.workbench_temp_ttl_minutes`（默认 10 分钟）的文件；清扫失败只记
  日志、不阻断动作。工作台没有常驻定时器。

### 14.2 端点

| 方法与路径 | 请求体 | 成功响应 |
| --- | --- | --- |
| `POST /api/workbench/image?name=<文件名>` | 原始图片字节（octet-stream；`name` 会被净化成 basename） | `200 {schema_version, status:"ok", result:{path, size_bytes, name}}` |
| `POST /api/workbench/fetch` | `{url}`（JSON；`additionalProperties: false`；仅 http/https） | `200 {schema_version, status:"ok", result:{path, size_bytes, source_url}}` |
| `POST /api/workbench/analyze` | `{image_path, target_profile, detail_level?, include_negative?, save_experience?}`（未知键拒绝；缺 `target_profile` 不拦，由管线信封给 `MODEL_PROFILE_NOT_SELECTED`） | `200`，与 `analyze_image_prompt` 工具逐字段一致的 2.0 信封 |
| `POST /api/workbench/cleanup` | 无 | `200 {schema_version, status:"ok", result:{deleted_files, freed_bytes}}` |

### 14.3 限制与失败

- 上传 / 下载字节上限：`image.max_bytes`（默认 32 MiB），流式累计执行 →
  `400` + `PANEL_UPLOAD_TOO_LARGE`，且**不留半写文件**。`fetch` / `analyze` 的
  JSON 请求体另有 **1 MiB** 上限（动作参数都很小，防荒谬输入），超限同码。
- URL 下载：Node 内置 `fetch`，30 秒超时、跟随重定向、协议白名单 http/https；
  失败 → `400` + `PANEL_FETCH_FAILED` / `PANEL_FETCH_UNSUPPORTED_PROTOCOL`。
- 清除缓存只删工作台目录内容，绝不越界。
- 工作台上传文件即「缓存」：10 分钟 TTL + 显式清除，双保险防滞留。

### 14.4 与 §1 范围的关系

§1 的"只读"指**结果查询面**；工作台动作面是显式、白名单化的例外，spec 已把它写进
插件的边界修订（README「已知限制」同步）。调试区（§11）的自检用例 A–E 仍然只测
查询面，不动作。

### 14.5 v1.2 增量

- **`GET /api/workbench/models`（查询端点，走只读区，不受动作区的同源/POST 约束）**：
  返回视觉模型候选 `{schema_version, status:"ok", result:{current, candidates[{provider, model}], diagnostics}}`。
  读 DSH 模型目录筛 image 模型，不调模型、不耗配额；目录不可用时 200 + 空候选 + 诊断。
- **`analyze` 新增可选键 `vision_provider` / `vision_model`**（两键独立可选，须为字符串；
  空串视同未选）：请求级模型选择，语义等于一次性钉死——校验（`MODEL_NOT_FOUND`）、
  候选排序、失败降级全部复用 `vision.provider`/`vision.model` 配置钉死的既有行为。
- **URL 下载代理**：宿主读 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（含小写变体，
  按目标协议取对应变量），有代理时 http 目标走代理绝对 URI、https 目标走 CONNECT
  隧道；未设代理时行为与 v1.1 逐字节一致。
