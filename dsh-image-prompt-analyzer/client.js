
window.__ModuleLoader__.load({
  id: '@RimeLumen/dsh-image-prompt-analyzer',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-image-prompt-analyzer'
    const API_BASE = '/dsh-image-prompt-analyzer/api'

    const PANEL_API_VERSION = '1.1'

    const DICT = {
      zh: {
        'panel.versionMismatch': '面板接口版本对不上，页面里的面板是旧的一份。刷新页面即可；仍然不对说明插件需要重装。',
        'panel.tasks': '分析结果',
        'panel.positive': '正向提示词',
        'panel.negative': '抑制提示词',
        'panel.qualityPrefix': '质量前缀',
        'panel.lowConfidence': '低置信度词条',
        'panel.dropped': '被裁掉的词条',
        'panel.terms': '词条',
        'panel.saved': '已存为经验',
        'panel.notSaved': '未存经验',
        'panel.detail': '详情',
        'panel.collapse': '收起',
        'panel.none': '（空）',
        'panel.note': '面板通过一条只读 HTTP 路由取数，不读取会话记录，也不写任何文件。',
        'panel.dbg.title': '调试与接口自检',
        'panel.dbg.hint':
          '对当前页面同源的只读接口跑规范 A–E 用例。BLOCKED 表示请求没有到达接口（环境/权限问题），FAIL 表示接口被调用到了但不符合规范（实现问题）。',
        'panel.dbg.open': '展开调试',
        'panel.dbg.close': '收起调试',
        'panel.dbg.debugOn': 'DEBUG：开',
        'panel.dbg.debugOff': 'DEBUG：关',
        'panel.dbg.debugHint': 'DEBUG 会额外记录响应头、content-type、门禁判定依据与 body 长度；关掉时只留结论。',
        'panel.dbg.run': '运行自检',
        'panel.dbg.running': '正在自检…',
        'panel.dbg.export': '导出 JSON',
        'panel.dbg.clear': '清空',
        'panel.dbg.idle': '还没有跑过自检。点「运行自检」会发出 5 个只读探测（其中一个是故意发的 POST，用来验证 405）。',
        'panel.dbg.copied': 'JSON 已复制到剪贴板',
        'panel.dbg.copyFailed': '剪贴板不可用，请手动复制下面的 JSON',
        'panel.dbg.assertions': '用例结论',
        'panel.dbg.requests': '请求记录',
        'panel.dbg.result': 'JSON 导出',
        'panel.dbg.gate':
          '这次请求被宿主门禁拦下了（403 + text/plain + forbidden）。接口没有被调用，从本页面的调试区发起才会带渲染器凭证，所以请不要据此判断接口好坏。',
        'panel.wb.title': '图像提示词分析',
        'panel.wb.upload': '选择本地图片',
        'panel.wb.drop': '或把图片拖到这里',
        'panel.wb.urlLabel': '图片 URL',
        'panel.wb.fetch': '获取',
        'panel.wb.ready': '图片已就绪',
        'panel.wb.rechoose': '重新选择',
        'panel.wb.previewFallback': '预览加载失败（远程站可能禁止外链）；不影响分析——分析用的是宿主下载的字节。',
        'panel.wb.profileLabel': '目标档案',
        'panel.wb.profilePlaceholder': '选择目标档案',
        'panel.wb.profileHint': '没有默认档案：替你猜一个只会产出词表全错的结果。',
        'panel.wb.detailLabel': '细节档',
        'panel.wb.negativeLabel': '输出抑制提示词',
        'panel.wb.saveLabel': '存入经验库',
        'panel.wb.analyze': '开始分析',
        'panel.wb.busy': '处理中…',
        'panel.wb.cleanup': '清除缓存',
        'panel.wb.cleanupConfirm': '确认清除？已选图片将失效',
        'panel.wb.cleanupDone': '已清理 {files} 个文件，释放 {bytes} 字节',
        'panel.wb.result': '分析结果',
        'panel.wb.actionFailed': '动作失败',
        'panel.wb.copy': '复制',
        'panel.wb.copied': '已复制',
        'panel.wb.stats': '词条 {terms} · 槽位 {slots} · 预算截断 {truncated}',
        'panel.wb.noProfiles': '档案清单还没就绪：先在对话里让模型跑一次工具，或稍后刷新。',
        'panel.wb.modelLabel': '视觉模型',
        'panel.wb.modelAuto': '自动',
        'panel.wb.modelHint': '默认自动发现并降级；显式选择只对本次分析生效。',
        'panel.wb.topLabel': '交互',
        'panel.wb.outputLabel': '输出',
        'panel.wb.history': '最近分析',
        'panel.wb.emptyOutput': '还没有分析结果。上传图片、选好档案后点「开始分析」。',
        'panel.wb.thinking': '模型思考中',
        'panel.wb.exportLog': '导出错误日志',
        'panel.wb.exportJson': '导出错误 JSON',
        'panel.wb.byProfileLine': '按档案分布：{line}',
      },
      en: {
        'panel.versionMismatch':
          'The panel API version does not match this page. Refresh; if it persists the plugin needs reinstalling.',
        'panel.tasks': 'Results',
        'panel.positive': 'Positive prompt',
        'panel.negative': 'Negative prompt',
        'panel.qualityPrefix': 'Quality prefix',
        'panel.lowConfidence': 'Low confidence',
        'panel.dropped': 'Dropped terms',
        'panel.terms': 'terms',
        'panel.saved': 'saved as experience',
        'panel.notSaved': 'not saved',
        'panel.detail': 'Detail',
        'panel.collapse': 'Collapse',
        'panel.none': '(empty)',
        'panel.note': 'The panel reads one read-only HTTP route. It does not read the session log and writes no files.',
        'panel.dbg.title': 'Debug and API self-check',
        'panel.dbg.hint':
          'Runs the spec A–E cases against the read-only API on this page\u2019s origin. BLOCKED means the request never reached the API (environment or permission); FAIL means the API was reached but is off-spec (implementation).',
        'panel.dbg.open': 'Show debug',
        'panel.dbg.close': 'Hide debug',
        'panel.dbg.debugOn': 'DEBUG: on',
        'panel.dbg.debugOff': 'DEBUG: off',
        'panel.dbg.debugHint':
          'DEBUG also records headers, content-type, the gate decision and body length; off keeps only verdicts.',
        'panel.dbg.run': 'Run self-check',
        'panel.dbg.running': 'Running…',
        'panel.dbg.export': 'Export JSON',
        'panel.dbg.clear': 'Clear',
        'panel.dbg.idle':
          'No self-check yet. It sends five read-only probes (one is a deliberate POST that must answer 405).',
        'panel.dbg.copied': 'JSON copied to the clipboard',
        'panel.dbg.copyFailed': 'Clipboard unavailable; copy the JSON below by hand',
        'panel.dbg.assertions': 'Cases',
        'panel.dbg.requests': 'Requests',
        'panel.dbg.result': 'JSON export',
        'panel.dbg.gate':
          'The host gate answered this request (403 + text/plain + forbidden). The API was never called; requests from this page\u2019s debug area carry the renderer credential, so do not judge the API from this.',
        'panel.wb.title': 'Image prompt reverse',
        'panel.wb.upload': 'Choose a local image',
        'panel.wb.drop': 'or drop an image here',
        'panel.wb.urlLabel': 'Image URL',
        'panel.wb.fetch': 'Fetch',
        'panel.wb.ready': 'Image ready',
        'panel.wb.rechoose': 'Choose again',
        'panel.wb.previewFallback':
          'Preview failed (the remote site may block hotlinks); analysis is unaffected — it uses the bytes the host downloaded.',
        'panel.wb.profileLabel': 'Target profile',
        'panel.wb.profilePlaceholder': 'Select a profile',
        'panel.wb.profileHint': 'No default profile: guessing one for you would only produce a wrong vocabulary.',
        'panel.wb.detailLabel': 'Detail level',
        'panel.wb.negativeLabel': 'Include negative prompt',
        'panel.wb.saveLabel': 'Save to experience store',
        'panel.wb.analyze': 'Analyze',
        'panel.wb.busy': 'Working…',
        'panel.wb.cleanup': 'Clear cache',
        'panel.wb.cleanupConfirm': 'Confirm? The chosen image will be invalidated',
        'panel.wb.cleanupDone': 'Cleaned {files} file(s), freed {bytes} bytes',
        'panel.wb.result': 'Result',
        'panel.wb.actionFailed': 'Action failed',
        'panel.wb.copy': 'Copy',
        'panel.wb.copied': 'Copied',
        'panel.wb.stats': '{terms} terms · {slots} slots · budget truncated: {truncated}',
        'panel.wb.noProfiles': 'Profile list not ready yet: let the model run any tool once, or refresh later.',
        'panel.wb.modelLabel': 'Vision model',
        'panel.wb.modelAuto': 'Auto',
        'panel.wb.modelHint': 'Auto discovery with fallback by default; an explicit choice applies to this analysis only.',
        'panel.wb.topLabel': 'Input',
        'panel.wb.outputLabel': 'Output',
        'panel.wb.history': 'Recent analyses',
        'panel.wb.emptyOutput': 'No result yet. Upload an image, pick a profile, then press Analyze.',
        'panel.wb.thinking': 'Model thinking',
        'panel.wb.exportLog': 'Export error log',
        'panel.wb.exportJson': 'Export error JSON',
        'panel.wb.byProfileLine': 'By profile: {line}',
      },
    }

    const S = {
      page: { color: 'var(--dsw-alias-label-primary)', width: '100%', boxSizing: 'border-box' },
      headRow: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '16px', fontWeight: 600, margin: 0 },
      badge: {
        fontSize: '11px',
        padding: '1px 7px',
        borderRadius: '9px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      button: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        padding: '10px 12px',
        marginBottom: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      cardHead: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        userSelect: 'text',
      },
      label: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', margin: '8px 0 2px' },
      meta: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      warn: { fontSize: '12px', color: 'var(--dsw-alias-state-warn-primary)' },
      error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.7 },
      list: { listStyle: 'none', padding: 0, margin: 0 },
      listItem: { fontSize: '12px', padding: '2px 0' },
      dbg: { marginTop: '18px', borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '12px' },
      dbgRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' },
      dbgCase: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
        padding: '6px 8px',
        marginBottom: '4px',
        fontSize: '12px',
      },
      dbgCaseHead: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      dbgOk: {
        fontSize: '11px',
        color: 'var(--dsw-alias-state-success-primary)',
        border: '1px solid var(--dsw-alias-state-success-primary)',
        borderRadius: '9px',
        padding: '0 6px',
      },
      dbgBlocked: {
        fontSize: '11px',
        color: 'var(--dsw-alias-state-warn-primary)',
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        borderRadius: '9px',
        padding: '0 6px',
      },
      dbgFail: {
        fontSize: '11px',
        color: 'var(--dsw-alias-state-error-primary)',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        borderRadius: '9px',
        padding: '0 6px',
      },
      dbgOut: {
        width: '100%',
        minHeight: '160px',
        boxSizing: 'border-box',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11px',
        lineHeight: 1.6,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
        padding: '8px',
      },
      wbRow: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' },
      wbInput: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        flex: 1,
        minWidth: '0',
        boxSizing: 'border-box',
      },
      wbSelect: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      wbPreview: {
        maxWidth: '100%',
        maxHeight: '32vh',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)',
        display: 'block',
        margin: '0 auto',
      },
      wbFooter: {
        marginTop: '16px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '8px',
      },
      wbHero: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '12px',
        border: '1px dashed var(--dsw-alias-border-l2)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      wbHeroIcon: { color: 'var(--dsw-alias-label-secondary)', marginBottom: '4px' },
      wbHeroSub: { fontSize: '12px', margin: 0, color: 'var(--dsw-alias-label-secondary)' },
      wbPrimary: {
        font: 'inherit',
        fontSize: '13px',
        fontWeight: 600,
        padding: '8px 20px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        transition: 'background 150ms ease, border-color 150ms ease, opacity 150ms ease',
      },
      wbGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '12px',
      },
      wbField: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
      wbFieldLabel: {
        fontSize: '11px',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary)',
        letterSpacing: '0.02em',
      },
      wbPrompt: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '13px',
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        padding: '12px',
        margin: 0,
      },
      wbSectionTitle: {
        fontSize: '12px',
        fontWeight: 700,
        color: 'var(--dsw-alias-label-secondary)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        margin: '24px 0 8px',
      },
    }

    const WORKBENCH_STYLE = h('style', null, `
.dsh-ipr-wb { container-type: inline-size; }
.dsh-ipr-page { padding: 20px 24px; overflow-y: auto; max-height: 100%; }
.dsh-ipr-hero { padding: 20px 16px; }
@container (max-width: 520px) {
  .dsh-ipr-page { padding: 16px 12px; overflow-y: auto; max-height: 100%; }
  .dsh-ipr-hero { padding: 16px 10px; }
}
.dsh-ipr-glass {
  position: relative;
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--dsw-alias-bg-layer-1) 50%, transparent),
    color-mix(in srgb, var(--dsw-alias-bg-layer-2) 68%, transparent)
  );
  backdrop-filter: blur(24px) saturate(180%) brightness(1.04);
  -webkit-backdrop-filter: blur(24px) saturate(180%) brightness(1.04);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  border-radius: 16px;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent),
    inset 0 -1px 0 color-mix(in srgb, black 10%, transparent),
    0 4px 24px color-mix(in srgb, black 18%, transparent),
    0 1px 4px color-mix(in srgb, black 12%, transparent);
  overflow: hidden;
}
.dsh-ipr-glass::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent) 0%,
    transparent 35%
  );
  pointer-events: none;
}
.dsh-ipr-wb button {
  position: relative;
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--dsw-alias-bg-layer-2) 45%, transparent),
    color-mix(in srgb, var(--dsw-alias-bg-layer-3) 62%, transparent)
  );
  backdrop-filter: blur(16px) saturate(160%);
  -webkit-backdrop-filter: blur(16px) saturate(160%);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  border-radius: 12px;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent),
    0 2px 10px color-mix(in srgb, black 14%, transparent);
  transition: box-shadow 200ms ease, border-color 200ms ease, background 200ms ease;
}
.dsh-ipr-wb button:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--dsw-alias-label-secondary) 22%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent),
    0 4px 18px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent),
    0 2px 8px color-mix(in srgb, black 16%, transparent);
}
.dsh-ipr-wb select, .dsh-ipr-wb input[type="text"] {
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent);
  backdrop-filter: blur(12px) saturate(140%);
  -webkit-backdrop-filter: blur(12px) saturate(140%);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  border-radius: 10px;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
}
.dsh-ipr-wb .dsh-ipr-zone {
  transition: border-color 200ms ease, background 200ms ease, box-shadow 200ms ease;
  border: 1.5px dashed color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent),
    0 2px 12px color-mix(in srgb, black 8%, transparent);
}
.dsh-ipr-wb .dsh-ipr-zone.dsh-ipr-drag {
  border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 75%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent),
    0 0 0 3px color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent),
    0 4px 20px color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
}
.dsh-ipr-wb button, .dsh-ipr-wb select, .dsh-ipr-wb input[type="text"], .dsh-ipr-wb label.dsh-ipr-click { cursor: pointer; }
.dsh-ipr-wb button:disabled, .dsh-ipr-wb select:disabled { cursor: not-allowed; opacity: 0.4; filter: saturate(0.6); }
.dsh-ipr-wb :focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 60%, transparent); outline-offset: 1px; }
@keyframes dsh-ipr-spin { to { transform: rotate(360deg); } }
.dsh-ipr-spin {
  display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent);
  border-top-color: var(--dsw-alias-label-primary);
  animation: dsh-ipr-spin 0.8s linear infinite; vertical-align: -2px; margin-right: 6px;
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--dsw-alias-label-primary) 15%, transparent));
}
@media (prefers-reduced-motion: reduce) {
  .dsh-ipr-wb button, .dsh-ipr-wb select, .dsh-ipr-wb .dsh-ipr-zone { transition: none; }
  .dsh-ipr-spin { animation-duration: 2s; filter: none; }
}`)
    function formatTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function shortId(value) {
      const text = String(value ?? '')
      return text.length > 18 ? `${text.slice(0, 10)}…${text.slice(-6)}` : text
    }

    function textOf(term) {
      if (term === null || term === undefined) return ''
      if (typeof term === 'string') return term
      return term.display ?? term.text ?? term.description ?? ''
    }

    function joinTerms(terms, t) {
      if (!Array.isArray(terms) || terms.length === 0) return t('panel.none')
      return terms.map(textOf).filter(Boolean).join(', ')
    }
    const VERDICT = {
      OK: 'OK',
      VERSION_MISMATCH: 'VERSION_MISMATCH',
      METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
      TASK_NOT_FOUND: 'TASK_NOT_FOUND',
      HOST_GATE_DENIED: 'HOST_GATE_DENIED',
      INVALID_JSON: 'INVALID_JSON',
      HTTP_ERROR: 'HTTP_ERROR',
      DNS_FAILURE: 'DNS_FAILURE',
      CONNECTION_REFUSED: 'CONNECTION_REFUSED',
      TIMEOUT: 'TIMEOUT',
      TLS_FAILURE: 'TLS_FAILURE',
      NETWORK_FAILURE: 'NETWORK_FAILURE',
    }

    const BLOCKING_VERDICTS = [
      VERDICT.HOST_GATE_DENIED,
      VERDICT.DNS_FAILURE,
      VERDICT.CONNECTION_REFUSED,
      VERDICT.TIMEOUT,
      VERDICT.TLS_FAILURE,
      VERDICT.NETWORK_FAILURE,
    ]

    const CASE_TITLES = {
      A: '/、/summary、/tasks 三个入口返回同一份 summary（剔除 generated_at）',
      B: '/summary 的必需字段齐全且类型正确',
      C: 'summary.note 提到 6 个改变状态的工具',
      D: 'POST /summary 返回 405 PANEL_METHOD_NOT_ALLOWED',
      E: '未知 task_id 返回 404 PANEL_TASK_NOT_FOUND（只读纪律：地址不存在也不能编一条出来）',
    }

    function isGateResponse(status, contentType, body) {
      if (status !== 403) return false
      if (typeof contentType !== 'string' || contentType.toLowerCase().indexOf('text/plain') !== 0) return false
      return String(body ?? '').trim() === 'forbidden'
    }

    function verdictOfResponse({ status, contentType, body }) {
      if (isGateResponse(status, contentType, body)) return VERDICT.HOST_GATE_DENIED
      if (status >= 200 && status < 300) {
        let parsed = null
        try {
          parsed = JSON.parse(body)
        } catch (error) {
          return VERDICT.INVALID_JSON
        }
        if (parsed?.schema_version !== PANEL_API_VERSION) return VERDICT.VERSION_MISMATCH
        return VERDICT.OK
      }
      if (status === 405) return VERDICT.METHOD_NOT_ALLOWED
      if (status === 404) return VERDICT.TASK_NOT_FOUND
      return VERDICT.HTTP_ERROR
    }

    function verdictOfError(error) {
      const name = String(error?.name ?? '')
      if (name === 'AbortError' || name === 'TimeoutError') return VERDICT.TIMEOUT
      return VERDICT.NETWORK_FAILURE
    }

    function stripVolatile(body) {
      if (!body || typeof body !== 'object') return body
      const copy = { ...body }
      delete copy.generated_at
      return copy
    }

    async function probeApi(path, method = 'GET', debugOn, index) {
      const started = Date.now()
      const requestHeaders = { accept: 'application/json' }
      const record = {
        id: `req-${index}`,
        method,
        path: `${API_BASE}${path}`,
        started_at: new Date().toISOString(),
        duration_ms: 0,
        status: null,
        verdict: VERDICT.NETWORK_FAILURE,
        body: null,
        ...(debugOn ? { request_headers: requestHeaders } : {}),
      }
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(8000)
          : undefined
      try {
        const response = await fetch(`${API_BASE}${path}`, {
          method,
          signal,
          headers: requestHeaders,
        })
        const text = await response.text()
        const contentType = response.headers.get('content-type') ?? ''
        record.status = response.status
        record.verdict = verdictOfResponse({ status: response.status, contentType, body: text })
        record.body = text.length > 2000 ? `${text.slice(0, 2000)}…（已截断）` : text
        record.content_type = contentType
        if (debugOn) {
          record.response_headers = Object.fromEntries(response.headers.entries())
          record.body_length = text.length
          record.gate_evidence = {
            status: response.status,
            text_plain: contentType.toLowerCase().indexOf('text/plain') === 0,
            body_equals_forbidden: String(text).trim() === 'forbidden',
          }
          if (record.verdict !== VERDICT.OK) record.error_code = parseBody(record)?.error_code ?? null
        }
      } catch (error) {
        record.verdict = verdictOfError(error)
        record.error = String(error?.message ?? error)
      }
      record.duration_ms = Date.now() - started
      return record
    }

    function verdictOfAssertion(details) {
      return details.length === 0 ? 'PASS' : 'FAIL'
    }

    function assertion(id, status, details) {
      return { id, title: CASE_TITLES[id], status, details }
    }

    function blockedAssertion(id, record) {
      return assertion(id, 'BLOCKED', [
        `${record.path} 的判定是 ${record.verdict}：请求没有到达接口，所以这条用例没有被验证。`,
      ])
    }

    function summaryShapeProblems(body) {
      const problems = []
      if (!body || typeof body !== 'object') return ['响应体不是 JSON 对象']
      if (body.schema_version !== PANEL_API_VERSION) problems.push(`schema_version 应为 ${PANEL_API_VERSION}`)
      if (typeof body.generated_at !== 'string' || body.generated_at.length === 0) {
        problems.push('generated_at 缺失或类型不对')
      }
      if (!('plugin_version' in body)) problems.push('plugin_version 缺失')
      if (body.read_only !== true) problems.push('read_only 必须为 true')
      if (!body.totals || typeof body.totals !== 'object') problems.push('totals 缺失')
      else {
        if (!Number.isInteger(body.totals.tasks) || body.totals.tasks < 0) {
          problems.push('totals.tasks 必须是非负整数')
        }
        const limit = body.totals.recent_limit
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          problems.push('totals.recent_limit 必须是 1..200 的整数')
        }
        const experiences = body.totals.experiences
        if (!(experiences === null || Number.isInteger(experiences))) {
          problems.push('totals.experiences 必须是整数或 null')
        }
        const rated = body.totals.rated_experiences
        if (!(rated === null || Number.isInteger(rated))) {
          problems.push('totals.rated_experiences 必须是整数或 null')
        }
      }
      if (!Array.isArray(body.recent_tasks)) problems.push('recent_tasks 必须是数组')
      if (!body.by_profile || typeof body.by_profile !== 'object' || Array.isArray(body.by_profile)) {
        problems.push('by_profile 必须是对象')
      }
      if (!body.storage || typeof body.storage !== 'object') problems.push('storage 缺失')
      else {
        if (!Number.isInteger(body.storage.size)) problems.push('storage.size 必须是整数')
        if (!Number.isInteger(body.storage.limit)) problems.push('storage.limit 必须是整数')
        const databasePath = body.storage.database_path
        if (!(typeof databasePath === 'string' || databasePath === null)) {
          problems.push('storage.database_path 必须是字符串或 null')
        }
      }
      if (typeof body.note !== 'string') problems.push('note 必须是字符串')
      if (!('configs' in body)) problems.push('configs 缺失（runtime 未就绪时应为 null）')
      return problems
    }

    function requiredToolNames() {
      return [
        'analyze_image_prompt',
        'validate_configs',
        'diagnose_knowledge_base',
        'rebuild_knowledge_base',
        'preview_model_profile',
        'manage_experiences',
      ]
    }

    function parseBody(record) {
      try {
        return JSON.parse(record.body)
      } catch (error) {
        return null
      }
    }

    async function runSelfCheck(debugOn) {
      const requests = []
      const send = async (path, method = 'GET') => {
        const record = await probeApi(path, method, debugOn, requests.length + 1)
        requests.push(record)
        return record
      }

      const root = await send('/', 'GET')
      const summaryProbe = await send('/summary', 'GET')
      const tasksProbe = await send('/tasks', 'GET')
      const blockedBy = [root, summaryProbe, tasksProbe].find((item) => BLOCKING_VERDICTS.indexOf(item.verdict) >= 0)
      const assertions = []

      if (blockedBy) {
        assertions.push(blockedAssertion('A', blockedBy))
        assertions.push(blockedAssertion('B', blockedBy))
        assertions.push(blockedAssertion('C', blockedBy))
      } else {
        const bodies = [root, summaryProbe, tasksProbe].map(parseBody)
        const details = []
        for (let index = 0; index < 3; index += 1) {
          const record = [root, summaryProbe, tasksProbe][index]
          if (record.verdict !== VERDICT.OK) details.push(`${record.path} 判定为 ${record.verdict}（HTTP ${record.status}）`)
          if (bodies[index] === null) details.push(`${record.path} 的响应体不是 JSON`)
        }
        if (details.length === 0) {
          const base = JSON.stringify(stripVolatile(bodies[0]))
          for (let index = 1; index < 3; index += 1) {
            if (JSON.stringify(stripVolatile(bodies[index])) !== base) {
              details.push(`${[root, summaryProbe, tasksProbe][index].path} 与 / 不一致（已剔除 generated_at）`)
            }
          }
        }
        assertions.push(assertion('A', verdictOfAssertion(details), details))

        const shape = summaryShapeProblems(bodies[1])
        assertions.push(assertion('B', verdictOfAssertion(shape), shape))

        const note = typeof bodies[1]?.note === 'string' ? bodies[1].note : ''
        const noteDetails = []
        if (note.length === 0) noteDetails.push('note 为空或缺失')
        const missing = requiredToolNames().filter((name) => note.indexOf(name) === -1)
        if (missing.length > 0) noteDetails.push(`note 里没有提到：${missing.join(', ')}`)
        assertions.push(assertion('C', verdictOfAssertion(noteDetails), noteDetails))
      }

      const postProbe = await send('/summary', 'POST')
      if (BLOCKING_VERDICTS.indexOf(postProbe.verdict) >= 0) {
        assertions.push(blockedAssertion('D', postProbe))
      } else {
        const details = []
        if (postProbe.status !== 405) details.push(`POST /summary 返回 HTTP ${postProbe.status}，应为 405`)
        const code = parseBody(postProbe)?.error_code ?? null
        if (code !== 'PANEL_METHOD_NOT_ALLOWED') details.push(`error_code 为 ${code}，应为 PANEL_METHOD_NOT_ALLOWED`)
        if (String(postProbe.content_type ?? '').indexOf('application/json') !== 0) {
          details.push(`content-type 为 ${postProbe.content_type || '（无）'}，应为 application/json`)
        }
        assertions.push(assertion('D', verdictOfAssertion(details), details))
      }

      const missingTaskProbe = await send('/tasks/panel-debug-does-not-exist')
      if (BLOCKING_VERDICTS.indexOf(missingTaskProbe.verdict) >= 0) {
        assertions.push(blockedAssertion('E', missingTaskProbe))
      } else {
        const details = []
        if (missingTaskProbe.status !== 404) {
          details.push(`未知 task_id 返回 HTTP ${missingTaskProbe.status}，应为 404`)
        }
        const code = parseBody(missingTaskProbe)?.error_code ?? null
        if (code !== 'PANEL_TASK_NOT_FOUND') details.push(`error_code 为 ${code}，应为 PANEL_TASK_NOT_FOUND`)
        if (String(missingTaskProbe.content_type ?? '').indexOf('application/json') !== 0) {
          details.push(`content-type 为 ${missingTaskProbe.content_type || '（无）'}，应为 application/json`)
        }
        assertions.push(assertion('E', verdictOfAssertion(details), details))
      }

      const notes = []
      const blockedTrials = requests.filter((item) => BLOCKING_VERDICTS.indexOf(item.verdict) >= 0)
      if (blockedTrials.length > 0) {
        notes.push(`${blockedTrials.length} 个请求没有到达接口，相关用例记 BLOCKED，不能用它们判断接口好坏。`)
      }
      if (blockedTrials.some((item) => item.verdict === VERDICT.HOST_GATE_DENIED)) {
        notes.push(
          '宿主门禁：Desktop 在路由之前拒绝了请求（403 + text/plain + forbidden）。从 Harness 页面同源发起，或改用渲染器凭证后重试。',
        )
      }

      return { requests, assertions, notes }
    }

    function buildExportPayload(report, debugOn) {
      const origin = typeof window !== 'undefined' && window.location ? String(window.location.origin ?? '') : ''
      return {
        spec_version: PANEL_API_VERSION,
        exported_at: new Date().toISOString(),
        environment: {
          origin,
          base_url: origin.length > 0 ? origin : null,
          discovery_trace: [{ level: 0, source: 'window.location.origin', ok: origin.length > 0, detail: origin || null }],
          user_agent: typeof navigator !== 'undefined' ? String(navigator.userAgent ?? '') : '',
        },
        debug: Boolean(debugOn),
        assertions: report.assertions,
        requests: report.requests,
        notes: Array.isArray(report.notes) ? report.notes : [],
      }
    }

    function DebugConsole({ t }) {
      const [open, setOpen] = React.useState(false)
      const [debugOn, setDebugOn] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [report, setReport] = React.useState(null)
      const [exported, setExported] = React.useState(null)
      const [flash, setFlash] = React.useState(null)

      const run = async () => {
        setBusy(true)
        setFlash(null)
        try {
          const result = await runSelfCheck(debugOn)
          setReport(result)
        } catch (error) {
          setReport({
            requests: [],
            assertions: [{ id: 'ERR', title: t('panel.dbg.title'), status: 'FAIL', details: [String(error?.message ?? error)] }],
          })
        } finally {
          setBusy(false)
        }
      }

      const exportJson = async () => {
        if (!report) return
        const text = JSON.stringify(buildExportPayload(report, debugOn), null, 2)
        setExported(text)
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text)
            setFlash('panel.dbg.copied')
            return
          }
          setFlash('panel.dbg.copyFailed')
        } catch (error) {
          setFlash('panel.dbg.copyFailed')
        }
      }

      const caseStyle = (status) =>
        status === 'PASS' ? S.dbgOk : status === 'BLOCKED' ? S.dbgBlocked : S.dbgFail
      const gated = Array.isArray(report?.requests)
        ? report.requests.some((item) => item.verdict === VERDICT.HOST_GATE_DENIED)
        : false

      const body = []
      if (open) {
        body.push(
          h(
            'div',
            { key: 'controls', style: S.dbgRow },
            h(
              'button',
              {
                key: 'debug',
                type: 'button',
                style: S.button,
                onClick: () => {
                  setDebugOn((prev) => !prev)
                },
              },
              debugOn ? t('panel.dbg.debugOn') : t('panel.dbg.debugOff'),
            ),
            h(
              'button',
              { key: 'run', type: 'button', style: S.button, onClick: run, disabled: busy },
              busy ? t('panel.dbg.running') : t('panel.dbg.run'),
            ),
            h(
              'button',
              { key: 'export', type: 'button', style: S.button, onClick: exportJson, disabled: !report },
              t('panel.dbg.export'),
            ),
            h(
              'button',
              {
                key: 'clear',
                type: 'button',
                style: S.button,
                onClick: () => {
                  setReport(null)
                  setExported(null)
                  setFlash(null)
                },
                disabled: !report && !exported,
              },
              t('panel.dbg.clear'),
            ),
          ),
          h('div', { key: 'hint', style: S.hint }, t('panel.dbg.hint')),
          h('div', { key: 'debugHint', style: S.meta }, t('panel.dbg.debugHint')),
        )

        if (flash) body.push(h('div', { key: 'flash', style: S.meta }, t(flash)))
        if (gated) body.push(h('div', { key: 'gate', style: S.warn }, t('panel.dbg.gate')))
        if (report && Array.isArray(report.notes)) {
          for (let index = 0; index < report.notes.length; index += 1) {
            body.push(h('div', { key: `note-${index}`, style: S.warn }, report.notes[index]))
          }
        }
        if (!report) body.push(h('div', { key: 'idle', style: S.hint }, t('panel.dbg.idle')))

        if (report) {
          body.push(h('div', { key: 'casesLabel', style: S.label }, t('panel.dbg.assertions')))
          for (const item of report.assertions) {
            const lines = [h('div', { key: 'head', style: S.dbgCaseHead },
              h('span', { style: caseStyle(item.status) }, item.status),
              h('span', null, `${item.id} · ${item.title}`),
            )]
            for (let index = 0; index < item.details.length; index += 1) {
              lines.push(h('div', { key: `d${index}`, style: S.mono }, `— ${item.details[index]}`))
            }
            body.push(h('div', { key: `case-${item.id}`, style: S.dbgCase }, lines))
          }

          if (report.requests.length > 0) {
            body.push(h('div', { key: 'reqLabel', style: S.label }, t('panel.dbg.requests')))
            const rows = report.requests.map((item) =>
              h(
                'li',
                { key: item.id, style: S.listItem },
                h(
                  'span',
                  { style: S.mono },
                  `${item.method} ${item.path} → ${item.status ?? '—'} · ${item.verdict} · ${item.duration_ms}ms`,
                ),
              ),
            )
            body.push(h('ul', { key: 'reqs', style: S.list }, rows))
          }
        }

        if (exported) {
          body.push(h('div', { key: 'outLabel', style: S.label }, t('panel.dbg.result')))
          body.push(
            h('textarea', {
              key: 'out',
              style: S.dbgOut,
              readOnly: true,
              spellCheck: false,
              value: exported,
              onFocus: (event) => {
                event.target.select()
              },
            }),
          )
        }
      }

      return h(
        'div',
        { style: S.dbg },
        h(
          'div',
          { style: S.dbgRow },
          h(
            'button',
            {
              type: 'button',
              style: S.button,
              onClick: () => {
                setOpen((prev) => !prev)
              },
            },
            open ? t('panel.dbg.close') : t('panel.dbg.open'),
          ),
          h('span', { style: S.hint }, t('panel.dbg.title')),
        ),
        body,
      )
    }
    function Field({ label, value, style }) {
      return h('div', null, h('div', { style: S.label }, label), h('div', { style: style ?? S.mono }, value))
    }
    function TaskHead({ task, open, onToggle, t }) {
      const target = task.target ?? {}
      const variant = target.variant && target.variant !== 'none' ? ` · ${target.variant}` : ''
      const size = `${task.image?.width ?? '?'}×${task.image?.height ?? '?'} ${task.image?.aspect_ratio ?? ''}`
      return h(
        'div',
        { style: S.cardHead },
        h('span', { style: { ...S.mono, fontSize: '12px' } }, shortId(task.task_id)),
        h('span', { style: S.meta }, formatTime(task.created_at)),
        h('span', { style: S.meta }, `${task.target_profile ?? target.config_id ?? '—'}${variant}`),
        h('span', { style: S.meta }, size),
        h('span', { style: S.meta }, `${task.positive_term_count ?? 0} / ${task.negative_term_count ?? 0} ${t('panel.terms')}`),
        h('span', { style: S.meta }, task.saved_experience_id ? t('panel.saved') : t('panel.notSaved')),
        h(
          'button',
          { type: 'button', style: { ...S.button, marginLeft: 'auto' }, onClick: onToggle },
          open ? t('panel.collapse') : t('panel.detail'),
        ),
      )
    }

    function TaskDetail({ task, t }) {
      const warnings = Array.isArray(task.warnings) && task.warnings.length > 0 ? task.warnings : null
      return h(
        'div',
        { style: { marginTop: '10px', borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '10px' } },
        Array.isArray(task.quality_prefix) && task.quality_prefix.length > 0
          ? h(Field, { label: t('panel.qualityPrefix'), value: task.quality_prefix.join(', ') })
          : null,
        Array.isArray(task.low_confidence) && task.low_confidence.length > 0
          ? h(Field, { label: t('panel.lowConfidence'), value: joinTerms(task.low_confidence, t) })
          : null,
        Array.isArray(task.dropped) && task.dropped.length > 0
          ? h(Field, { label: t('panel.dropped'), value: joinTerms(task.dropped, t) })
          : null,
        warnings ? h('div', { style: { ...S.warn, marginTop: '8px' } }, warnings.join(', ')) : null,
        task.ir ? h(Field, { label: 'IR', value: JSON.stringify(task.ir, null, 2) }) : null,
      )
    }

    function TaskCard({ task, open, onToggle, t }) {
      return h(
        'div',
        { style: S.card, key: task.task_id },
        h(TaskHead, { task, open, onToggle, t }),
        h('div', { style: S.label }, t('panel.positive')),
        h('div', { style: S.mono }, task.positive_prompt || t('panel.none')),
        task.negative_prompt
          ? h('div', null, h('div', { style: S.label }, t('panel.negative')), h('div', { style: S.mono }, task.negative_prompt))
          : null,
        open ? h(TaskDetail, { task, t }) : null,
      )
    }
    function WorkbenchIcon({ size = 16 }) {
      const edge = Number(size) > 0 ? Number(size) : 16
      return h(
        'svg',
        { width: edge, height: edge, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 5.5, cy: 6.5, r: 1.6, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', {
          d: 'M2 11.5L6.2 8.2L9 10.2L12 7.8L14 9.6',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
      )
    }

    function WorkbenchResult({ envelope, t }) {
      const result = envelope?.result ?? null
      const diagnostics = Array.isArray(envelope?.diagnostics) ? envelope.diagnostics : []
      const compileStats = result?.stats?.compile ?? {}
      const slots = Array.isArray(result?.slots) ? result.slots : []
      const [copiedKey, setCopiedKey] = React.useState(null)

      const copyText = async (key, text) => {
        try {
          if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text)
          setCopiedKey(key)
          setTimeout(() => setCopiedKey(null), 2000)
        } catch {
        }
      }

      const promptRow = (key, label, text) =>
        text
          ? h(
              'div',
              { key, style: { marginTop: '8px' } },
              h(
                'div',
                { style: { ...S.wbFieldLabel, marginBottom: '4px', display: 'flex', justifyContent: 'space-between' } },
                h('span', null, label),
                h(
                  'button',
                  { type: 'button', style: S.button, onClick: () => copyText(key, text) },
                  copiedKey === key ? t('panel.wb.copied') : t('panel.wb.copy'),
                ),
              ),
              h('pre', { style: S.wbPrompt }, text),
            )
          : null

      const body = []
      body.push(
        h(
          'div',
          { key: 'head', style: S.cardHead },
          h('span', { style: S.mono }, `${t('panel.wb.result')} · ${envelope?.status ?? '—'}`),
          envelope?.task_id ? h('span', { style: S.meta }, shortId(envelope.task_id)) : null,
        ),
        h(
          'div',
          { key: 'stats', style: S.meta },
          t('panel.wb.stats')
            .replace('{terms}', String(compileStats.terms ?? '—'))
            .replace('{slots}', String(compileStats.slots ?? '—'))
            .replace('{truncated}', String(compileStats.truncated ?? '—')),
        ),
      )

      if (Array.isArray(result?.quality_block) && result.quality_block.length > 0) {
        body.push(h(Field, { key: 'quality', label: t('panel.qualityPrefix'), value: result.quality_block.join(', ') }))
      }

      body.push(promptRow('pos', t('panel.positive'), result?.prompts?.positive))
      body.push(promptRow('neg', t('panel.negative'), result?.prompts?.negative))
      if (slots.length > 0) {
        body.push(h(Field, { key: 'slots', label: t('panel.tasks'), value: slots.map((slot) => `${slot.slot}: ${(slot.terms ?? []).join(', ')}`).join(' | ') }))
      }
      if (Array.isArray(result?.dropped) && result.dropped.length > 0) {
        body.push(h(Field, { key: 'dropped', label: t('panel.dropped'), value: result.dropped.map((item) => `${item.term}（${item.reason}）`).join(', ') }))
      }
      if (result?.ir) {
        body.push(
          h(
            'details',
            { key: 'ir', style: { marginTop: '8px' } },
            h('summary', { style: { ...S.wbFieldLabel, cursor: 'pointer' } }, 'IR'),
            h('pre', { style: { ...S.wbPrompt, marginTop: '4px' } }, JSON.stringify(result.ir, null, 2)),
          ),
        )
      }
      if (diagnostics.length > 0) {
        body.push(
          ...diagnostics.map((item, index) =>
            h('div', { key: `diag-${index}`, style: item.severity === 'error' ? S.error : S.meta }, `${item.error_code}: ${item.message}`),
          ),
        )
      }
      return h('div', { style: S.card }, body)
    }

    function WorkbenchRoot({ t }) {
      const [img, setImg] = React.useState(null)
      const [profiles, setProfiles] = React.useState([])
      const [profile, setProfile] = React.useState('')
      const [models, setModels] = React.useState([])
      const [modelChoice, setModelChoice] = React.useState('')
      const [detail, setDetail] = React.useState('standard')
      const [includeNegative, setIncludeNegative] = React.useState(true)
      const [saveExperience, setSaveExperience] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [envelope, setEnvelope] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [url, setUrl] = React.useState('')
      const [armed, setArmed] = React.useState(false)
      const [armTimer, setArmTimer] = React.useState(null)
      const [dragOver, setDragOver] = React.useState(false)
      const [previewBroken, setPreviewBroken] = React.useState(false)
      const [recentTasks, setRecentTasks] = React.useState([])
      const [byProfileLine, setByProfileLine] = React.useState('')
      const [historyTick, setHistoryTick] = React.useState(0)
      const [thinking, setThinking] = React.useState('')

      React.useEffect(() => {
        let alive = true
        fetch(`${API_BASE}/summary`, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            if (!alive) return
            if (data?.schema_version !== PANEL_API_VERSION) {
              setMessage({ kind: 'error', text: t('panel.versionMismatch') })
              return
            }
            const list = Array.isArray(data?.configs?.model_profiles)
              ? data.configs.model_profiles.map((item) => item.config_id).filter(Boolean)
              : []
            setProfiles(list)
            setRecentTasks(Array.isArray(data.recent_tasks) ? data.recent_tasks : [])
            const byProfile = Object.entries(data.by_profile ?? {})
              .map(([name, count]) => `${name} ${count}`)
              .join(' / ')
            if (byProfile) setByProfileLine(byProfile)
          })
          .catch(() => {
          })
        fetch(`${API_BASE}/workbench/models`, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            if (!alive) return
            const list = Array.isArray(data?.result?.candidates)
              ? data.result.candidates.filter(
                  (item) => typeof item?.provider === 'string' && typeof item?.model === 'string',
                )
              : []
            setModels(list)
          })
          .catch(() => {
          })
        return () => {
          alive = false
        }
      }, [historyTick])

      const failWith = async (response, fallback) => {
        let text = fallback
        try {
          const body = await response.json()
          text = body?.message ?? body?.error_code ?? fallback
        } catch {
        }
        setMessage({ kind: 'error', text: `${t('panel.wb.actionFailed')}：${text}` })
      }

      const uploadFile = async (file) => {
        if (!file) return
        setBusy(true)
        setMessage(null)
        try {
          const bytes = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : null
          const response = await fetch(`${API_BASE}/workbench/image?name=${encodeURIComponent(file.name ?? 'upload')}`, {
            method: 'POST',
            body: bytes ?? file,
          })
          if (!response.ok) {
            await failWith(response, `HTTP ${response.status}`)
            return
          }
          const body = await response.json()
          const result = body?.result
          if (!result?.path) {
            setMessage({ kind: 'error', text: `${t('panel.wb.actionFailed')}：响应缺少 path` })
            return
          }
          let preview = null
          try {
            if (typeof URL.createObjectURL === 'function') preview = URL.createObjectURL(file)
          } catch {
            preview = null
          }
          setImg({ path: result.path, name: result.name ?? file.name, source_url: null, preview, size: result.size_bytes })
          setPreviewBroken(false)
          setEnvelope(null)
        } catch (error) {
          setMessage({ kind: 'error', text: `${t('panel.wb.actionFailed')}：${error?.message ?? error}` })
        } finally {
          setBusy(false)
        }
      }

      const fetchUrl = async () => {
        const target = url.trim()
        if (!target || busy) return
        setBusy(true)
        setMessage(null)
        try {
          const response = await fetch(`${API_BASE}/workbench/fetch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ url: target }),
          })
          if (!response.ok) {
            await failWith(response, `HTTP ${response.status}`)
            return
          }
          const body = await response.json()
          const result = body?.result
          if (!result?.path) {
            setMessage({ kind: 'error', text: `${t('panel.wb.actionFailed')}：响应缺少 path` })
            return
          }
          setImg({ path: result.path, name: null, source_url: result.source_url, preview: target, size: result.size_bytes })
          setPreviewBroken(false)
          setEnvelope(null)
        } catch (error) {
          setMessage({ kind: 'error', text: `${t('panel.wb.actionFailed')}：${error?.message ?? error}` })
        } finally {
          setBusy(false)
        }
      }

      const analyze = async () => {
        if (!img || !profile || busy) return
        setBusy(true)
        setMessage(null)
        setThinking('')
        const progressKey = `wb-${Math.random().toString(36).slice(2, 10)}`
        let polling = true
        const pollProgress = async () => {
          while (polling) {
            try {
              const response = await fetch(`${API_BASE}/workbench/progress/${encodeURIComponent(progressKey)}`, {
                headers: { accept: 'application/json' },
              })
              if (response.ok) {
                const body = await response.json()
                if (typeof body?.result?.text === 'string' && body.result.text) setThinking(body.result.text)
                if (body?.result?.done) break
              }
            } catch {
            }
            await new Promise((resolve) => setTimeout(resolve, 800))
          }
        }
        pollProgress()
        try {
          let chosen = null
          try {
            chosen = modelChoice ? JSON.parse(modelChoice) : null
          } catch {
            chosen = null
          }
          if (chosen && typeof chosen.provider !== 'string') chosen = null
          const payload = {
            image_path: img.path,
            target_profile: profile,
            detail_level: detail,
            include_negative: includeNegative,
            save_experience: saveExperience,
            progress_key: progressKey,
            ...(chosen ? { vision_provider: chosen.provider, vision_model: chosen.model } : {}),
          }
          const sendAnalyze = async (body) =>
            fetch(`${API_BASE}/workbench/analyze`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify(body),
            })
          let response = await sendAnalyze(payload)
          if (response.status === 400) {
            const errorBody = await response.json().catch(() => null)
            const text = String(errorBody?.message ?? '')
            if (text.includes('progress_key') || text.includes('vision_provider') || text.includes('vision_model')) {
              const legacy = { ...payload }
              delete legacy.progress_key
              delete legacy.vision_provider
              delete legacy.vision_model
              response = await sendAnalyze(legacy)
            } else {
              setMessage({ kind: 'error', text: `${t('panel.wb.actionFailed')}：${text || `HTTP 400`}` })
              return
            }
          }
          if (!response.ok) {
            await failWith(response, `HTTP ${response.status}`)
            return
          }
          setEnvelope(await response.json())
          setHistoryTick((n) => n + 1)
        } catch (error) {
          setMessage({ kind: 'error', text: `${t('panel.wb.actionFailed')}：${error?.message ?? error}` })
        } finally {
          polling = false
          setBusy(false)
        }
      }

      const cleanup = async () => {
        if (!armed) {
          clearTimeout(armTimer)
          setArmTimer(setTimeout(() => setArmed(false), 3000))
          setArmed(true)
          return
        }
        clearTimeout(armTimer)
        setArmTimer(null)
        setArmed(false)
        setBusy(true)
        try {
          const response = await fetch(`${API_BASE}/workbench/cleanup`, { method: 'POST' })
          if (!response.ok) {
            await failWith(response, `HTTP ${response.status}`)
            return
          }
          const body = await response.json()
          const result = body?.result ?? { deleted_files: 0, freed_bytes: 0 }
          setMessage({
            kind: 'info',
            text: t('panel.wb.cleanupDone')
              .replace('{files}', String(result.deleted_files))
              .replace('{bytes}', String(result.freed_bytes)),
          })
          setImg(null)
          setEnvelope(null)
        } catch (error) {
          setMessage({ kind: 'error', text: `${t('panel.wb.actionFailed')}：${error?.message ?? error}` })
        } finally {
          setBusy(false)
        }
      }

      const body = []
      body.push(h('div', { key: 'top-label', style: { ...S.wbSectionTitle, marginTop: '12px' } }, t('panel.wb.topLabel')))
      body.push(
        h(
          'div',
          {
            key: 'zone',
            className: `dsh-ipr-zone dsh-ipr-hero${dragOver ? ' dsh-ipr-drag' : ''}`,
            style: S.wbHero,
            onDragOver: (event) => {
              event.preventDefault()
              setDragOver(true)
            },
            onDragLeave: () => setDragOver(false),
            onDrop: (event) => {
              event.preventDefault()
              setDragOver(false)
              const file = event?.dataTransfer?.files?.[0]
              if (file) uploadFile(file)
            },
          },
          h('div', { key: 'heroicon', style: S.wbHeroIcon }, h(WorkbenchIcon, { size: 24 })),
          h(
            'label',
            { key: 'upload', className: 'dsh-ipr-click', style: S.wbPrimary, cursor: 'pointer' },
            t('panel.wb.upload'),
            h('input', {
              type: 'file',
              accept: 'image/*',
              style: { display: 'none' },
              onChange: (event) => {
                const file = event?.target?.files?.[0]
                if (file) uploadFile(file)
              },
            }),
          ),
          h('span', { key: 'drop', style: S.wbHeroSub }, t('panel.wb.drop')),
          h(
            'div',
            { key: 'urlrow', style: { ...S.wbRow, marginTop: '4px', width: '100%' } },
            h('input', {
              type: 'text',
              style: S.wbInput,
              placeholder: t('panel.wb.urlLabel'),
              value: url,
              onChange: (event) => setUrl(event?.target?.value ?? ''),
              onKeyDown: (event) => {
                if (event?.key === 'Enter') {
                  event.preventDefault?.()
                  fetchUrl()
                }
              },
            }),
            h('button', { type: 'button', style: S.button, onClick: fetchUrl, disabled: busy }, t('panel.wb.fetch')),
          ),
        ),
      )

      if (img) {
        body.push(
          h(
            'div',
            { key: 'preview', style: { ...S.card, textAlign: 'center' } },
            h('div', { style: S.meta }, `${t('panel.wb.ready')} · ${img.name ?? img.source_url ?? ''} · ${img.size ?? '?'} 字节`),
            previewBroken
              ? h('div', { style: S.meta }, t('panel.wb.previewFallback'))
              : h('img', {
                  src: img.preview ?? img.source_url,
                  style: S.wbPreview,
                  alt: img.name ?? t('panel.wb.title'),
                  onError: () => setPreviewBroken(true),
                }),
            h('div', { style: S.meta }, img.path),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.button, marginTop: '8px' },
                onClick: () => {
                  setImg(null)
                  setEnvelope(null)
                  setMessage(null)
                },
              },
              t('panel.wb.rechoose'),
            ),
          ),
        )
      }

      body.push(
        h('div', { key: 'params', style: S.card },
          h('div', { key: 'grid', style: S.wbGrid },
            h(
              'div',
              { key: 'profile', style: S.wbField },
              h('span', { style: S.wbFieldLabel }, t('panel.wb.profileLabel')),
              h(
                'select',
                {
                  style: S.wbSelect,
                  value: profile,
                  onChange: (event) => setProfile(event?.target?.value ?? ''),
                },
                h('option', { key: 'placeholder', value: '' }, t('panel.wb.profilePlaceholder')),
                profiles.map((id) => h('option', { key: id, value: id }, id)),
              ),
              h('span', { style: S.meta }, t('panel.wb.profileHint')),
            ),
            h(
              'div',
              { key: 'model', style: S.wbField },
              h('span', { style: S.wbFieldLabel }, t('panel.wb.modelLabel')),
              h(
                'select',
                {
                  style: S.wbSelect,
                  value: modelChoice,
                  onChange: (event) => setModelChoice(event?.target?.value ?? ''),
                },
                h('option', { key: 'auto', value: '' }, t('panel.wb.modelAuto')),
                models.map((item) => {
                  const value = JSON.stringify({ provider: item.provider, model: item.model })
                  return h('option', { key: value, value }, `${item.provider}/${item.model}`)
                }),
              ),
              h('span', { style: S.meta }, t('panel.wb.modelHint')),
            ),
          ),
          profiles.length === 0 ? h('div', { key: 'noprofiles', style: S.meta }, t('panel.wb.noProfiles')) : null,
          h(
            'div',
            { key: 'options', style: { ...S.wbRow, marginTop: '12px' } },
            h(
              'label',
              { key: 'detail', className: 'dsh-ipr-click', style: { ...S.wbRow, gap: '6px' } },
              h('span', { style: S.wbFieldLabel }, `${t('panel.wb.detailLabel')}：`),
              h(
                'select',
                { style: S.wbSelect, value: detail, onChange: (event) => setDetail(event?.target?.value ?? 'standard') },
                h('option', { key: 'minimal', value: 'minimal' }, 'minimal'),
                h('option', { key: 'standard', value: 'standard' }, 'standard'),
                h('option', { key: 'high', value: 'high' }, 'high'),
              ),
            ),
            h(
              'label',
              { key: 'neg', className: 'dsh-ipr-click', style: { ...S.wbRow, gap: '6px' } },
              h('input', {
                type: 'checkbox',
                checked: includeNegative,
                onChange: (event) => setIncludeNegative(event?.target?.checked === true),
              }),
              ` ${t('panel.wb.negativeLabel')}`,
            ),
            h(
              'label',
              { key: 'save', className: 'dsh-ipr-click', style: { ...S.wbRow, gap: '6px' } },
              h('input', {
                type: 'checkbox',
                checked: saveExperience,
                onChange: (event) => setSaveExperience(event?.target?.checked === true),
              }),
              ` ${t('panel.wb.saveLabel')}`,
            ),
          ),
          h(
            'button',
            {
              key: 'analyze',
              type: 'button',
              style: { ...S.wbPrimary, marginTop: '16px', width: '100%' },
              disabled: busy || !img || !profile,
              onClick: analyze,
            },
            busy
              ? h('span', null, h('span', { className: 'dsh-ipr-spin' }), t('panel.wb.busy'))
              : t('panel.wb.analyze'),
          ),
        ),
      )

      body.push(h('div', { key: 'output-label', style: { ...S.wbSectionTitle, marginTop: '20px' } }, t('panel.wb.outputLabel')))
      if (message) {
        body.push(h('div', { key: 'message', style: message.kind === 'error' ? S.error : S.warn }, message.text))
        if (message.kind === 'error') {
          const exportFile = (content, filename, mime) => {
            try {
              const blob = new Blob([content], { type: mime })
              const url = URL.createObjectURL(blob)
              const link = document.createElement('a')
              link.href = url
              link.download = filename
              link.click()
              URL.revokeObjectURL(url)
            } catch {
            }
          }
          const logText = [
            `[${new Date().toISOString()}] dsh-image-prompt-analyzer`,
            `[error] ${message.text}`,
            thinking ? `[thinking]\n${thinking}` : '',
            `[image] ${img?.path ?? '—'}`,
            `[profile] ${profile || '—'}`,
            `[model] ${modelChoice || 'auto'}`,
            `[envelope] ${JSON.stringify(envelope, null, 2)}`,
          ].filter(Boolean).join('\n')
          const jsonText = JSON.stringify(
            {
              exported_at: new Date().toISOString(),
              plugin: 'dsh-image-prompt-analyzer',
              error: message.text,
              image_path: img?.path ?? null,
              target_profile: profile || null,
              vision_model: modelChoice || null,
              thinking: thinking || null,
              envelope,
            },
            null,
            2,
          )
          body.push(
            h(
              'div',
              { key: 'export-buttons', style: { ...S.wbRow, marginTop: '4px', gap: '8px' } },
              h('button', { type: 'button', style: S.button, onClick: () => exportFile(logText, `dsh-ipr-error-${Date.now()}.log`, 'text/plain') }, t('panel.wb.exportLog')),
              h('button', { type: 'button', style: S.button, onClick: () => exportFile(jsonText, `dsh-ipr-error-${Date.now()}.json`, 'application/json') }, t('panel.wb.exportJson')),
            ),
          )
        }
      }
      if (thinking) {
        body.push(
          h(
            'details',
            { key: 'thinking', className: 'dsh-ipr-glass', open: busy, style: { padding: '10px 12px', marginBottom: '8px' } },
            h('summary', { style: { ...S.wbFieldLabel, cursor: 'pointer' } },
              busy ? t('panel.wb.thinking') : `${t('panel.wb.thinking')} · ${t('panel.wb.history')}`),
            h('pre', { style: { ...S.wbPrompt, marginTop: '4px', maxHeight: '240px', overflow: 'auto' } }, thinking),
          ),
        )
      }
      if (envelope) {
        body.push(h(WorkbenchResult, { key: 'result', envelope, t }))
      } else if (!message) {
        body.push(
          h('div', { key: 'empty-output', className: 'dsh-ipr-glass', style: { padding: '20px 16px', textAlign: 'center' } },
            h('div', { style: S.wbHeroSub }, t('panel.wb.emptyOutput')),
          ),
        )
      }
      if (byProfileLine) {
        body.push(h('div', { key: 'by-profile', style: { ...S.meta, marginTop: '8px' } }, t('panel.wb.byProfileLine').replace('{line}', byProfileLine)))
      }
      body.push(
        h(
          'details',
          { key: 'history', className: 'dsh-ipr-glass', style: { padding: '10px 12px', marginTop: '8px' } },
          h('summary', { style: { ...S.wbFieldLabel, cursor: 'pointer' } }, `${t('panel.wb.history')} · ${recentTasks.length}`),
          recentTasks.length === 0
            ? h('div', { style: { ...S.meta, marginTop: '8px' } }, t('panel.wb.emptyOutput'))
            : h(
                'div',
                { style: { marginTop: '8px' } },
                recentTasks.map((task) => h(TaskCard, { key: task.task_id, task, open: false, onToggle: () => {}, t })),
              ),
        ),
        h(
          'details',
          { key: 'debug', className: 'dsh-ipr-glass', style: { padding: '10px 12px', marginTop: '8px' } },
          h('summary', { style: { ...S.wbFieldLabel, cursor: 'pointer' } }, t('panel.dbg.title')),
          h('div', { style: { marginTop: '8px' } }, h(DebugConsole, { t })),
        ),
      )

      return h(
        'div',
        { className: 'dsh-ipr-wb dsh-ipr-page', style: S.page },
        WORKBENCH_STYLE,
        h(
          'div',
          { style: S.headRow },
          h('h2', { style: S.title }, t('panel.wb.title')),
          h('span', { style: S.badge }, t('panel.wb.analyze')),
        ),
        body,
        h(
          'div',
          { style: S.wbFooter },
          h('span', { style: S.meta }, t('panel.note')),
          h(
            'button',
            {
              type: 'button',
              style: armed ? { ...S.button, borderColor: 'var(--dsw-alias-state-warn-primary)' } : S.button,
              disabled: busy,
              onClick: cleanup,
            },
            armed ? t('panel.wb.cleanupConfirm') : t('panel.wb.cleanup'),
          ),
        ),
      )
    }

    function registerWorkbench(ctx, t) {
      const disposers = []
      disposers.push(
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: NS,
              order: 40,
              label: () => t('panel.wb.title'),
              locale: NS,
            },
            function ImagePromptReverseIcon(props) {
              return h(WorkbenchIcon, props ?? {})
            },
          ),
        ),
      )
      disposers.push(
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: NS },
            function ImagePromptReverseWorkbench(props) {
              return h(WorkbenchRoot, { ...props, t })
            },
          ),
        ),
      )
      const stopWaiting = ctx.inject(['betterSidebar'], (scope) => {
        const service = scope?.betterSidebar ?? null
        if (service && typeof service.registerTab === 'function') {
          const disposeTab = service.registerTab({
            id: `${NS}:workbench`,
            title: t('panel.wb.title'),
            component: function BetterSidebarWorkbench() {
              return h(WorkbenchRoot, { t })
            },
          })
          if (typeof disposeTab === 'function') scope.effect(() => disposeTab)
        }
      })
      if (typeof stopWaiting === 'function') disposers.push(stopWaiting)
      return disposers
    }

    function registerLocale(ctx) {
      const disposers = []
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        for (const locale of Object.keys(DICT)) {
          disposers.push(ctx.locale.register(NS, locale, DICT[locale]))
        }
      }
      const translate =
        ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (key) => DICT.zh[key] ?? key
      const t = (key) => {
        const value = translate(key)
        return typeof value === 'string' && value.length > 0 ? value : (DICT.zh[key] ?? key)
      }
      return { t, disposers }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const { t, disposers } = registerLocale(ctx)
        disposers.push(...registerWorkbench(ctx, t))

        ctx.effect(() => () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch (error) {
              console.warn(`[${NS}] 注销面板资源失败`, error)
            }
          }
        })
      },
    }
  },
})
