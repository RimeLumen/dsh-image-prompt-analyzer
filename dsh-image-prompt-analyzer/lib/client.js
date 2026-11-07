// 浏览器半侧：把 comfyui_get_job 的结果画成一张卡片（状态 + 消息 + 缩略图）。
//
// 这个文件不是 ESM。宿主用 window.__ModuleLoader__.load({ id, factory }) 注册工厂，
// 真正执行时才调 factory(require)，所以：不能用 import/export，工厂外不能有副作用，
// require 只认得宿主种子表里的模块（react / react/jsx-runtime / primitives 等）。
//
// 图片不进模型上下文：Host 侧只把附件引用写进 block.meta，这里再用会话授权的
// loadImage 换成可显示的 URL。meta 里的引用字段是驼峰（attachmentId/mediaType/…）。
window.__ModuleLoader__.load({
  id: '@RimeLumen/dsh-image-prompt-analyzer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'comfyui'
    const h = react.createElement

    const zh = {
      'row.title': 'ComfyUI 任务',
      'row.preparing': '准备中',
      'row.details': '详情',
      'row.hide': '收起',
      'state.pending': '查询中',
      'state.prepared': '待提交',
      'state.submitting': '提交中',
      'state.accepted': '已提交',
      'state.running': '执行中',
      'state.completed': '已完成',
      'state.failed': '失败',
      'state.unknown': '未知',
      'image.alt': 'ComfyUI 生成图',
      'image.open': '点击查看大图',
      'image.preview': '图片预览',
      'image.close': '关闭预览',
      'image.loading': '加载中',
      'image.failed': '图片加载失败',
      'image.retry': '重试',
    }

    const en = {
      'row.title': 'ComfyUI job',
      'row.preparing': 'Preparing',
      'row.details': 'Details',
      'row.hide': 'Hide',
      'state.pending': 'Querying',
      'state.prepared': 'Prepared',
      'state.submitting': 'Submitting',
      'state.accepted': 'Accepted',
      'state.running': 'Running',
      'state.completed': 'Completed',
      'state.failed': 'Failed',
      'state.unknown': 'Unknown',
      'image.alt': 'ComfyUI output',
      'image.open': 'Open preview',
      'image.preview': 'Image preview',
      'image.close': 'Close preview',
      'image.loading': 'Loading',
      'image.failed': 'Image failed to load',
      'image.retry': 'Retry',
    }

    const css = [
      '.dlpaCard{flex-direction:column;display:flex;gap:6px;min-width:0}',
      '.dlpaRow{height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;color:var(--dsw-alias-label-tertiary);align-items:center;display:flex;position:relative;overflow:hidden}',
      '.dlpaRow[data-expandable]{cursor:pointer}',
      '.dlpaRow:hover{color:var(--dsw-alias-label-secondary)}',
      '.dlpaLeading{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));flex:none;justify-content:center;align-items:center;margin-right:6px;display:inline-flex}',
      '.dlpaLeading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}',
      '.dlpaTitle{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:none}',
      '.dlpaSeparator{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}',
      '.dlpaSummary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:auto;overflow:hidden}',
      '.dlpaSummary[data-state=failed]{color:var(--dsw-alias-state-error-primary)}',
      '.dlpaSummary[data-state=unknown]{color:var(--dsw-alias-state-warn-label)}',
      '.dlpaGallery{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0 2px 22px}',
      '.dlpaThumb{width:96px;height:96px;padding:0;flex:none;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);cursor:zoom-in;overflow:hidden;display:grid;place-items:center;color:var(--dsw-alias-label-caption);font-size:11px}',
      '.dlpaThumb img{width:100%;height:100%;object-fit:cover;display:block}',
      '.dlpaThumb[data-failed]{cursor:pointer;padding:4px;text-align:center}',
      '.dlpaThumb[data-loading]{cursor:default}',
      '.dlpaSpinner{animation:dlpaSpin .9s linear infinite}',
      '@keyframes dlpaSpin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.dlpaSpinner{animation:none}}',
      '.dlpaRaw{margin:0 0 4px 22px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto}',
      '.dlpaVisuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}',
    ].join('')

    const tagId = '@RimeLumen/dsh-image-prompt-analyzer/client.css'
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@RimeLumen/dsh-image-prompt-analyzer'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // 与 Host 的 ImageMediaType 同集合。多一个少一个都会让引用被判非法。
    const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

    function positiveInteger(value) {
      return typeof value === 'number' && Number.isInteger(value) && value > 0
    }

    // 一条引用只要有一个字段不合规就整条丢掉：宁可少显示一张，
    // 也不能拿半条引用去拼一个可能不存在的图。
    function usableRef(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
      if (typeof value.attachmentId !== 'string' || value.attachmentId === '') return false
      if (typeof value.mediaType !== 'string' || !MEDIA_TYPES.has(value.mediaType)) return false
      return positiveInteger(value.bytes) && positiveInteger(value.width) && positiveInteger(value.height)
    }

    function readMeta(block) {
      const meta = block?.meta
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
      return {
        state: typeof meta.state === 'string' && meta.state !== '' ? meta.state : null,
        message: typeof meta.message === 'string' && meta.message !== '' ? meta.message : null,
        images: Array.isArray(meta.images) ? meta.images.filter(usableRef) : [],
      }
    }

    function textOf(block) {
      const content = Array.isArray(block?.content) ? block.content : []
      const parts = content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
      return parts.length === 0 ? null : parts.join('\n')
    }

    // 宿主只把「会话事件里出现过的图片」授权给浏览器读。生成结果不在事件里，
    // 所以附件读不到时退回 ComfyUI 自己的 /view 地址——只在跑 ComfyUI 的那台机器上有效。
    function directUrlOf(image) {
      const url = image?.url
      if (typeof url !== 'string' || url === '') return null
      // 同源转发路径优先：页面的 CSP 是 default-src 'self'，跨源的 /view 会被直接拦掉。
      if (/^\/comfyui\/image\?[^\s"'<>]*$/u.test(url)) return url
      return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//u.test(url) ? url : null
    }

    function Thumb({ image, loadImage, t }) {
      const key = image.attachmentId
      const direct = directUrlOf(image)
      const [src, setSrc] = react.useState(() =>
        loadImage && typeof loadImage.peek === 'function' ? loadImage.peek(image) ?? direct : direct,
      )
      const [failed, setFailed] = react.useState(false)
      const [open, setOpen] = react.useState(false)

      react.useEffect(() => {
        let alive = true
        const cached = loadImage && typeof loadImage.peek === 'function' ? loadImage.peek(image) ?? null : null
        if (cached !== null) {
          setSrc(cached)
          setFailed(false)
          return () => {
            alive = false
          }
        }
        if (typeof loadImage !== 'function') {
          setSrc(direct)
          setFailed(direct === null)
          return () => {
            alive = false
          }
        }
        setSrc(null)
        setFailed(false)
        Promise.resolve(loadImage(image)).then(
          (url) => {
            if (alive) setSrc(typeof url === 'string' ? url : direct)
          },
          () => {
            if (!alive) return
            if (direct === null) setFailed(true)
            else setSrc(direct)
          },
        )
        return () => {
          alive = false
        }
      }, [key, loadImage])

      if (failed) {
        return h(
          'button',
          {
            type: 'button',
            className: 'dlpaThumb',
            'data-failed': true,
            title: t('image.failed'),
            onClick: () => {
              setFailed(false)
              setSrc(null)
            },
          },
          t('image.retry'),
        )
      }

      if (src === null) {
        return h(
          'div',
          { className: 'dlpaThumb', 'data-loading': true, 'aria-busy': true, 'aria-label': t('image.loading') },
          h(primitives.IconLoadingOutlineRegular, { className: 'dlpaSpinner' }),
        )
      }

      const alt = typeof image.name === 'string' && image.name !== '' ? image.name : t('image.alt')
      return h(
        react.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'dlpaThumb',
            title: t('image.open'),
            onClick: () => setOpen(true),
          },
          h('img', { src, alt, loading: 'lazy' }),
        ),
        open
          ? h(primitives.ImageLightbox, {
              src,
              alt,
              labels: { dialog: t('image.preview'), close: t('image.close') },
              onClose: () => setOpen(false),
            })
          : null,
      )
    }

    function Gallery({ images, loadImage, t }) {
      return h(
        'div',
        { className: 'dlpaGallery' },
        images.map((image) => h(Thumb, { key: image.attachmentId, image, loadImage, t })),
      )
    }

    function stateLabel(t, state) {
      const key = 'state.' + state
      const label = t(key)
      // 字典里没有的状态直接显示原词，不要显示成 "state.foo"。
      return label === key ? state : label
    }

    function ComfyJobRow(props) {
      const { t, phase, block, loadImage, useDisclosure } = props
      const { expanded, toggle } = useDisclosure()
      const meta = readMeta(block)
      const raw = textOf(block)
      const images = meta === null ? [] : meta.images
      const state = meta?.state ?? (phase === 'result' ? 'unknown' : 'pending')
      const summary = meta?.message ?? ''

      if (phase === 'preparing') {
        return h(
          'div',
          { className: 'dlpaCard', 'data-tool': 'comfyui_get_job', 'data-state': 'preparing' },
          h(
            'div',
            { className: 'dlpaRow' },
            h('span', { className: 'dlpaLeading' }, h(primitives.IconSparkleRegular, null)),
            h('span', { className: 'dlpaVisuallyHidden' }, t('row.preparing')),
            h(primitives.TextShimmer, { active: true, className: 'dlpaTitle' }, t('row.title')),
          ),
        )
      }

      const row = h(
        'div',
        {
          className: 'dlpaRow',
          'data-expandable': raw === null ? undefined : true,
          onClick: raw === null ? undefined : toggle,
          role: raw === null ? undefined : 'button',
          tabIndex: raw === null ? undefined : 0,
          onKeyDown:
            raw === null
              ? undefined
              : (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    toggle()
                  }
                },
        },
        h('span', { className: 'dlpaLeading' }, h(primitives.IconSparkleRegular, null)),
        h('span', { className: 'dlpaTitle' }, t('row.title')),
        h('span', { className: 'dlpaSeparator', 'aria-hidden': true }),
        h(
          'span',
          { className: 'dlpaSummary', 'data-state': state, title: summary === '' ? undefined : summary },
          summary === '' ? stateLabel(t, state) : summary,
        ),
        raw === null
          ? null
          : h(
              'span',
              { className: 'dlpaLeading', style: { marginLeft: '6px', marginRight: 0 } },
              expanded ? h(primitives.IconChevronUpOutlineRegular, null) : h(primitives.IconChevronDownOutlineRegular, null),
            ),
      )

      const body = [row]
      if (images.length > 0) body.push(h(Gallery, { key: 'gallery', images, loadImage, t }))
      if (expanded && raw !== null) body.push(h('pre', { key: 'raw', className: 'dlpaRaw' }, raw))

      return h('div', { className: 'dlpaCard', 'data-tool': 'comfyui_get_job', 'data-state': state }, body)
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'comfyui: dictionaries')
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          { name: 'tool.call.toolview', key: 'comfyui_get_job', locale: NS },
          ComfyJobRow,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
