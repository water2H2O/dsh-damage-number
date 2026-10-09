// ============================================================================
// dsh-damage-number —— 设置面板(浏览器半区 2/2)
// ============================================================================
// 做两件事:
//   ① 往小鲸鱼「提示与音效设置」面板里插一行入口「受击提示设置」;
//   ② 点它打开本插件自己的设置卡片。
//
// 为什么不直接改鲸鱼的源码:它的 assets/whale-widget.js 在 node_modules 里,
// 一旦鲸鱼升级就被整包覆盖 —— 我们的改动会静默消失。所以这里用**运行时注入**:
// 鲸鱼换版本我们跟着换锚点,而不是被它覆盖。
//
// 与鲸鱼的两个约定(都取自它自己的公开做法):
//   · 遮罩复用 .dshwv-bubmask —— 鲸鱼的全局 pointerdown 处理器见到这个类会直接 return
//     ("面板内部交给面板自己处理"),所以它不会来干涉我们的卡片;
//   · 卡片内部复用 .dshwv-bubcard / .dshwv-bubtitle / .dshwv-bubsec / .dshwv-bubbtn /
//     .dshwv-number / .dshwv-check / .dshwv-bubhint —— 静态样式类,直接用就能同族观感。
//   · 卡片本体用 window.dshwRegisterMask(el) 登记,让鲸鱼的层级计算把它算进去
//     (这是它 README/注释里明确留给第三方扩展模块的登记口)。
//
// ⚠️ 脆弱点说在前面:「入口行注入」依赖鲸鱼面板的类名与标题文字。鲸鱼大改面板会让入口行消失,
//    但**功能不会坏** —— 控制台里 __dshDmgNumber.openPanel() 永远能打开本卡片。
// ============================================================================

(function () {
  'use strict'
  if (typeof window === 'undefined') return
  if (window.__dshDmgPanelLoaded) return
  window.__dshDmgPanelLoaded = true

  var ENTRY_ID = 'dsh-dmg-entry'
  var PANEL_TITLE = '受击提示设置'
  var WHALE_TITLE_HINT = '提示与音效'   // 用来认出鲸鱼那一个面板
  var MAX_WAIT_TRIES = 200              // 50ms × 200 = 10s:等 overlay.js 就绪

  var hook = null
  var entryRow = null
  var openCard = null

  // ======================== 纯函数(可测) ========================
  // 配置里金额的单位是「元」(与小鲸鱼账本一致);界面按「分」呈现 ——
  // "消耗几分钱"才是人话,0.01 元这种写法没人愿意敲。
  function fenOf(yuan) {
    var n = Number(yuan)
    if (!isFinite(n)) return 0
    return Math.round(n * 100 * 1000) / 1000
  }
  function yuanOf(fen) {
    var n = Number(fen)
    if (!isFinite(n)) return 0
    return Math.round(n / 100 * 1e6) / 1e6
  }
  // 概率:与 overlay.js 的 rollDamage 同一公式(这里是"理论值",不掷骰子)
  function probAt(amount, lo, hi, base) {
    var a = Number(amount), l = Number(lo), h = Number(hi), b = Number(base)
    if (!isFinite(a) || !isFinite(l) || !isFinite(h)) return 0
    if (!isFinite(b)) b = 0
    if (b < 0) b = 0
    if (b > 1) b = 1
    if (a < l) return 0
    if (h <= l || a >= h) return 1
    var ratio = (a - l) / (h - l)
    if (ratio < 0) ratio = 0
    if (ratio > 1) ratio = 1
    return b + (1 - b) * ratio
  }
  // 曲线采样点:[{x:0..1, p:0..1}] —— x 是区间内进度
  function curvePoints(lo, hi, base, steps) {
    var n = Math.max(2, Math.round(Number(steps) || 24))
    var out = []
    var l = Number(lo), h = Number(hi)
    if (!isFinite(l)) l = 0
    if (!isFinite(h) || h <= l) {
      // 退化成阈值:0 之前必不跳,到阈值直接 100%
      return [{ x: 0, p: 0 }, { x: 0.999, p: 0 }, { x: 1, p: 1 }]
    }
    for (var i = 0; i <= n; i++) {
      var x = i / n
      out.push({ x: x, p: probAt(l + (h - l) * x, l, h, base) })
    }
    return out
  }
  function pct(v) {
    var n = Number(v)
    if (!isFinite(n)) n = 0
    var p = Math.round(n * 1000) / 10
    return (Math.abs(p - Math.round(p)) < 1e-9 ? String(Math.round(p)) : p.toFixed(1)) + '%'
  }
  function fenText(yuan) {
    var f = fenOf(yuan)
    var s = (Math.abs(f - Math.round(f)) < 1e-9) ? String(Math.round(f)) : f.toFixed(1)
    return s + ' 分'
  }
  function summaryText(c) {
    c = c || {}
    if (c.enabled === false) return '已关闭'
    var lo = Number(c.minAmount), hi = Number(c.maxAmount)
    var range = fenText(lo) + '–' + fenText(hi)
    return range + ' · ' + pct(Number(c.minProbability)) + '→100%'
  }
  // 由界面控件值组装出要 PUT 的补丁(单位换算只在这里发生)
  function buildPatch(v) {
    return {
      enabled: !!v.enabled,
      minAmount: yuanOf(v.minFen),
      maxAmount: yuanOf(v.maxFen),
      minProbability: Math.max(0, Math.min(1, Number(v.minPct) / 100)) || 0,
      pushEnabled: !!v.pushEnabled,
      mainSessionOnly: !!v.mainSessionOnly,
      pollMs: Math.max(250, Math.min(60000, Math.round(Number(v.pollMs) || 2000))),
      prefix: String(v.prefix == null ? '-¥' : v.prefix),
      decimals: Math.max(0, Math.min(6, Math.round(Number(v.decimals) || 0))),
      color: String(v.color || '#ff3b30'),
      strokeColor: String(v.strokeColor || '#ffffff'),
      strokeWidth: Math.max(0, Number(v.strokeWidth) || 0),
      fontSizePx: Math.max(8, Number(v.fontSizePx) || 30),
      risePx: Math.max(0, Number(v.risePx) || 0),
      riseMs: Math.max(120, Number(v.riseMs) || 1200),
      jitterX: Math.max(0, Number(v.jitterX) || 0),
      maxStack: Math.max(1, Math.round(Number(v.maxStack) || 1)),
    }
  }

  // ======================== 小控件 ========================
  function mk(tag, cls, css) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (css) e.style.cssText = css
    return e
  }
  function textEl(tag, cls, txt, css) {
    var e = mk(tag, cls, css)
    e.textContent = txt
    return e
  }
  function secTitle(txt) { return textEl('div', 'dshwv-bubsec', txt) }
  function hintEl(txt) { return textEl('div', 'dshwv-bubhint', txt) }

  // ---- 受保护的 DOM 写入(致命 bug 的修复) ----
  // 真实 DOM 里 `el.textContent = x` 就算 x 与当前内容**完全相同**,也会把原文本节点删掉再插一个
  // 新的 —— 所以它永远是一次 childList 变更。而我们的 MutationObserver 回调里会刷新入口行摘要:
  //
  //     回调 → 写 DOM → MutationObserver 再派发 → 回调 → …
  //
  // MutationObserver 的回调是**微任务**:每次回调又造出新的变更,就再排一个微任务,队列永远排不空,
  // 事件循环再也回不到宏任务 —— 整个页面(整个 harness)彻底卡死。
  // 实测触发点就是「点开小鲸鱼的全局设置」:那是入口行第一次被注入、循环被点燃的那一刻。
  //
  // 所以:凡是可能被 observer 回调路径执行到的写入,一律"先比较再写"。
  // 比较式写入 + 回调里的变更类型过滤 + rAF 合并,三者缺一不可。
  function setText(el, txt) {
    if (!el) return false
    var s = String(txt == null ? '' : txt)
    if (el.textContent === s) return false   // 值没变 → 一个字节都不写(否则就是风暴的燃料)
    el.textContent = s
    return true
  }
  function setChecked(el, v) {
    if (!el) return false
    var b = !!v
    if (el.checked === b) return false
    el.checked = b
    return true
  }
  function rowEl(css) {
    return mk('div', '', 'display:flex;align-items:center;gap:6px;justify-content:flex-start;'
      + 'flex-wrap:wrap;margin:5px 0;text-align:left;font-size:12px;color:#203170;' + (css || ''))
  }
  function labEl(txt) { return textEl('span', '', txt, 'font-size:12px;color:#203170;white-space:nowrap') }
  function numInput(value, opts) {
    opts = opts || {}
    var i = mk('input', 'dshwv-number')
    i.type = 'number'
    i.value = String(value)
    if (opts.min != null) i.min = String(opts.min)
    if (opts.max != null) i.max = String(opts.max)
    i.step = String(opts.step != null ? opts.step : 1)
    if (opts.width) i.style.width = opts.width
    if (opts.title) i.title = opts.title
    return i
  }
  function textInput(value, opts) {
    opts = opts || {}
    var i = mk('input', 'dshwv-number')
    i.type = 'text'
    i.value = String(value)
    i.style.width = opts.width || '56px'
    if (opts.title) i.title = opts.title
    return i
  }
  function checkBox(checked, onChange) {
    var c = mk('input', 'dshwv-check')
    c.type = 'checkbox'
    c.checked = !!checked
    if (onChange) c.addEventListener('change', function () { onChange(!!c.checked) })
    return c
  }
  function colorInput(value, opts) {
    opts = opts || {}
    var c = mk('input', '', 'width:34px;height:22px;padding:0;border:1px solid rgba(32,49,112,.4);'
      + 'border-radius:5px;background:#fff;cursor:pointer;box-sizing:border-box')
    c.type = 'color'
    c.value = String(value || '#ff3b30')
    if (opts.title) c.title = opts.title
    return c
  }
  function btn(txt, kind, onClick, title) {
    var b = mk('button', 'dshwv-bubbtn ' + (kind === 'ok' ? 'dshwv-bubbtn-ok' : 'dshwv-bubbtn-no'))
    b.type = 'button'
    b.textContent = txt
    if (title) b.title = title
    b.addEventListener('click', onClick)
    return b
  }

  // ======================== 设置卡片 ========================
  function topZ() {
    // 我们的卡片是从鲸鱼面板里打开的,必须盖在它上面。
    // 鲸鱼自己也是这么算的(dshwLayerUp),但那个函数没导出,所以这里就地读它的实际层号。
    var z = 30500
    try {
      var masks = document.querySelectorAll('.dshwv-bubmask')
      for (var i = 0; i < masks.length; i++) {
        if (masks[i].getAttribute && masks[i].getAttribute('data-dsh-dmg')) continue
        var cz = parseInt(window.getComputedStyle ? window.getComputedStyle(masks[i]).zIndex : masks[i].style.zIndex, 10)
        if (isFinite(cz) && cz + 50 > z) z = cz + 50
      }
    } catch (err) {}
    return z
  }

  function closeCard() {
    if (!openCard) return
    // 先把引用摘掉再动 DOM:移除节点本身是一次 childList 变更,会同步进到 observer 的派发里,
    // 不摘干净就可能被重入(再次 closeCard)。
    var cur = openCard
    openCard = null
    try { if (cur.unregister) cur.unregister() } catch (err) {}
    try { if (cur.timer) clearInterval(cur.timer) } catch (err) {}
    try { if (cur.mask && cur.mask.parentNode) cur.mask.parentNode.removeChild(cur.mask) } catch (err) {}
  }

  function openPanel() {
    if (!hook) return false
    if (openCard) { closeCard(); return true }
    var base = hook.getConfig()

    var C = {}  // 控件引用表
    var mask = mk('div', 'dshwv-bubmask')
    mask.setAttribute('data-dsh-dmg', 'panel')
    mask.style.zIndex = String(topZ())
    var card = mk('div', 'dshwv-bubcard')
    card.style.width = 'min(460px,calc(100vw - 16px))'
    card.appendChild(textEl('div', 'dshwv-bubtitle', PANEL_TITLE))

    var unregister = null
    try {
      if (typeof window.dshwRegisterMask === 'function') unregister = window.dshwRegisterMask(mask)
    } catch (err) {}

    // ---------- 1. 开关与区间 ----------
    card.appendChild(secTitle('触发条件'))
    var rOn = rowEl()
    C.enabled = checkBox(base.enabled !== false)
    rOn.appendChild(C.enabled)
    rOn.appendChild(labEl('启用受击提示'))
    card.appendChild(rOn)

    var rRange = rowEl()
    rRange.appendChild(labEl('区间'))
    C.minFen = numInput(fenOf(base.minAmount), { min: 0, step: 0.5, width: '56px', title: '低于这个消耗不会跳(单位:分)' })
    rRange.appendChild(C.minFen)
    rRange.appendChild(labEl('分 ～'))
    C.maxFen = numInput(fenOf(base.maxAmount), { min: 0, step: 0.5, width: '56px', title: '达到这个消耗必定跳(单位:分)' })
    rRange.appendChild(C.maxFen)
    rRange.appendChild(labEl('分'))
    card.appendChild(rRange)

    var rP = rowEl()
    rP.appendChild(labEl('下限处概率'))
    C.minPct = numInput(Math.round(Number(base.minProbability) * 1000) / 10, { min: 0, max: 100, step: 5, width: '56px', title: '刚好达到下限时的触发概率;越接近上限概率越大' })
    rP.appendChild(C.minPct)
    rP.appendChild(labEl('%   →  上限处 100%'))
    card.appendChild(rP)
    card.appendChild(hintEl('区间内概率线性递增;低于下限不触发;达到/超过上限必定触发。上下限填成一样 = 纯阈值。'))

    // ---------- 2. 概率曲线 ----------
    card.appendChild(secTitle('概率曲线'))
    var svg = document.createElementNS
      ? document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      : mk('div')
    try {
      svg.setAttribute('viewBox', '0 0 400 120')
      svg.setAttribute('width', '100%')
      svg.setAttribute('height', '120')
      svg.style.cssText = 'display:block;background:#fff;border:1px solid rgba(32,49,112,.15);border-radius:8px'
    } catch (err) {}
    card.appendChild(svg)
    C.curve = svg
    var curveInfo = hintEl('')
    card.appendChild(curveInfo)
    C.curveInfo = curveInfo

    function curveValues() {
      return {
        lo: yuanOf(C.minFen.value),
        hi: yuanOf(C.maxFen.value),
        base: Math.max(0, Math.min(1, Number(C.minPct.value) / 100)) || 0,
      }
    }
    function redraw() {
      var v = curveValues()
      var pts = curvePoints(v.lo, v.hi, v.base, 24)
      var W = 400, H = 120, padL = 34, padR = 12, padT = 10, padB = 20
      var iw = W - padL - padR, ih = H - padT - padB
      var seg = []
      for (var i = 0; i < pts.length; i++) {
        var x = padL + iw * pts[i].x
        var y = padT + ih * (1 - pts[i].p)
        seg.push((i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1))
      }
      var grid = ''
      var gl = [0, 0.25, 0.5, 0.75, 1]
      for (var g = 0; g < gl.length; g++) {
        var gy = padT + ih * (1 - gl[g])
        grid += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (padL + iw) + '" y2="' + gy.toFixed(1)
          + '" stroke="rgba(32,49,112,.12)" stroke-width="1"/>'
        grid += '<text x="' + (padL - 5) + '" y="' + (gy + 3.5).toFixed(1)
          + '" font-size="9" fill="#9fb0d9" text-anchor="end">' + Math.round(gl[g] * 100) + '%</text>'
      }
      var lab = '<text x="' + padL + '" y="' + (H - 6) + '" font-size="9.5" fill="#9fb0d9">'
        + fenText(v.lo) + '</text>'
        + '<text x="' + (padL + iw) + '" y="' + (H - 6) + '" font-size="9.5" fill="#9fb0d9" text-anchor="end">'
        + fenText(v.hi) + '</text>'
        + '<line x1="' + padL + '" y1="' + (padT + ih) + '" x2="' + (padL + iw) + '" y2="' + (padT + ih)
        + '" stroke="rgba(32,49,112,.3)" stroke-width="1"/>'
      var path = '<path d="' + seg.join(' ') + '" fill="none" stroke="#e0433f" stroke-width="2.4" '
        + 'stroke-linejoin="round" stroke-linecap="round"/>'
      try { svg.innerHTML = grid + lab + path } catch (err) { svg.textContent = '曲线不可用' }
      var q = Math.max(0, Math.min(1, (curveValues().lo + curveValues().hi) / 2))
      setText(curveInfo, '下限 ' + fenText(v.lo) + ' → ' + pct(v.base)
        + '　中点 ' + fenText(xRound(q)) + ' → ' + pct(probAt(q, v.lo, v.hi, v.base))
        + '　上限 ' + fenText(v.hi) + ' → 100%')
    }
    function xRound(v) { return isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0 }

    // ---------- 3. 预览与试算(不花一分钱) ----------
    card.appendChild(secTitle('预览与试算(不发真实请求、不花钱)'))
    var rPrev = rowEl()
    C.btnLo = btn('预览下限', 'no', function () { hook.preview(yuanOf(C.minFen.value)) }, '在下限金额上直接飘一个,只看外观')
    C.btnMid = btn('预览中点', 'no', function () {
      hook.preview(yuanOf((Number(C.minFen.value) + Number(C.maxFen.value)) / 2))
    }, '在中点金额上直接飘一个')
    C.btnHi = btn('预览上限', 'no', function () { hook.preview(yuanOf(C.maxFen.value)) }, '在上限金额上直接飘一个')
    rPrev.appendChild(C.btnLo)
    rPrev.appendChild(C.btnMid)
    rPrev.appendChild(C.btnHi)
    card.appendChild(rPrev)

    var rSim = rowEl()
    rSim.appendChild(labEl('试算'))
    C.simFen = numInput(fenOf((Number(base.minAmount) + Number(base.maxAmount)) / 2), { min: 0, step: 0.5, width: '56px', title: '要试算的消耗(分)' })
    rSim.appendChild(C.simFen)
    rSim.appendChild(labEl('分 ×'))
    C.simTimes = numInput(2000, { min: 1, max: 20000, step: 100, width: '62px', title: '掷多少次骰子' })
    rSim.appendChild(C.simTimes)
    rSim.appendChild(labEl('次'))
    rSim.appendChild(btn('跑', 'no', function () {
      try {
        var r = hook.simulate(yuanOf(C.simFen.value), C.simTimes.value)
        setText(C.simOut, '命中 ' + r.hits + '/' + r.times + '（实测 ' + pct(r.rate)
          + '，理论 ' + pct(r.expected) + '）')
      } catch (err) {
        setText(C.simOut, '试算失败:' + String((err && err.message) || err))
      }
    }, '按当前区间跑这么多次判定,看实测概率与理论值是否吻合'))
    card.appendChild(rSim)
    C.simOut = hintEl('点「跑」按当前区间掷骰子,验证概率 —— 不需要真的花钱。')
    card.appendChild(C.simOut)

    // ---------- 4. 触发通道 ----------
    card.appendChild(secTitle('触发通道'))
    var rPush = rowEl()
    C.pushEnabled = checkBox(base.pushEnabled !== false)
    rPush.appendChild(C.pushEnabled)
    rPush.appendChild(labEl('宿主推送即时触发(推荐)'))
    card.appendChild(rPush)
    card.appendChild(hintEl('开启后,宿主在每轮结束的同一刻用 SSE 通知页面立刻取数,延迟约几毫秒;关闭则退回下面的轮询。'))

    var rMain = rowEl()
    C.mainSessionOnly = checkBox(base.mainSessionOnly === true)
    rMain.appendChild(C.mainSessionOnly)
    rMain.appendChild(labEl('只对主会话结算'))
    card.appendChild(rMain)
    card.appendChild(hintEl('注意:小鲸鱼的金额是「任意会话的 turn/end」都会刷新的,子代理也会。勾上后子代理轮次不再即时触发,但推送不可用而退回轮询时仍可能被兜底取到。'))

    var rPoll = rowEl()
    rPoll.appendChild(labEl('兜底轮询'))
    C.pollMs = numInput(base.pollMs != null ? base.pollMs : 2000, { min: 250, max: 60000, step: 250, width: '70px' })
    rPoll.appendChild(C.pollMs)
    rPoll.appendChild(labEl('ms'))
    card.appendChild(rPoll)

    C.status = hintEl('')
    card.appendChild(C.status)

    // ---------- 5. 外观 ----------
    card.appendChild(secTitle('外观'))
    var rFont = rowEl()
    rFont.appendChild(labEl('字号'))
    C.fontSizePx = numInput(base.fontSizePx, { min: 8, max: 200, step: 2, width: '56px' })
    rFont.appendChild(C.fontSizePx)
    rFont.appendChild(labEl('px　　颜色'))
    C.color = colorInput(base.color)
    rFont.appendChild(C.color)
    rFont.appendChild(labEl('描边'))
    C.strokeColor = colorInput(base.strokeColor, { title: '描边颜色(保证在任何背景上都看得清)' })
    rFont.appendChild(C.strokeColor)
    C.strokeWidth = numInput(base.strokeWidth, { min: 0, max: 12, step: 1, width: '44px', title: '描边宽度,0 = 无描边' })
    rFont.appendChild(C.strokeWidth)
    rFont.appendChild(labEl('px'))
    card.appendChild(rFont)

    var rTxt = rowEl()
    rTxt.appendChild(labEl('前缀'))
    C.prefix = textInput(base.prefix, { width: '56px', title: '金额前面的文字,例如 -¥' })
    rTxt.appendChild(C.prefix)
    rTxt.appendChild(labEl('小数位'))
    C.decimals = numInput(base.decimals, { min: 0, max: 6, step: 1, width: '44px' })
    rTxt.appendChild(C.decimals)
    card.appendChild(rTxt)

    // ---------- 6. 动效 ----------
    card.appendChild(secTitle('动效'))
    var rAnim = rowEl()
    rAnim.appendChild(labEl('上浮'))
    C.risePx = numInput(base.risePx, { min: 0, max: 600, step: 8, width: '56px' })
    rAnim.appendChild(C.risePx)
    rAnim.appendChild(labEl('px　　时长'))
    C.riseMs = numInput(base.riseMs, { min: 120, max: 6000, step: 100, width: '62px' })
    rAnim.appendChild(C.riseMs)
    rAnim.appendChild(labEl('ms'))
    card.appendChild(rAnim)

    var rAnim2 = rowEl()
    rAnim2.appendChild(labEl('横向抖动'))
    C.jitterX = numInput(base.jitterX, { min: 0, max: 1, step: 0.02, width: '56px', title: '相对鲸鱼宽度的比例,避免多次飘字完全重叠' })
    rAnim2.appendChild(C.jitterX)
    rAnim2.appendChild(labEl('　同屏上限'))
    C.maxStack = numInput(base.maxStack, { min: 1, max: 20, step: 1, width: '44px' })
    rAnim2.appendChild(C.maxStack)
    card.appendChild(rAnim2)

    // ---------- 底栏 ----------
    var btns = mk('div', 'dshwv-bubbtns')
    btns.appendChild(btn('取消', 'no', function () { closeCard() }))
    btns.appendChild(btn('恢复默认', 'no', function () { fill(hook.DEFAULT_CFG) }, '把本卡片所有项恢复为默认值(仍需点保存才落盘)'))
    C.ok = btn('保存', 'ok', function () { doSave() })
    btns.appendChild(C.ok)
    card.appendChild(btns)
    C.saveMsg = hintEl('')
    card.appendChild(C.saveMsg)

    // ---------- 取值/回填 ----------
    function collect() {
      return {
        enabled: C.enabled.checked,
        minFen: Number(C.minFen.value),
        maxFen: Number(C.maxFen.value),
        minPct: Number(C.minPct.value),
        pushEnabled: C.pushEnabled.checked,
        mainSessionOnly: C.mainSessionOnly.checked,
        pollMs: Number(C.pollMs.value),
        prefix: C.prefix.value,
        decimals: Number(C.decimals.value),
        color: C.color.value,
        strokeColor: C.strokeColor.value,
        strokeWidth: Number(C.strokeWidth.value),
        fontSizePx: Number(C.fontSizePx.value),
        risePx: Number(C.risePx.value),
        riseMs: Number(C.riseMs.value),
        jitterX: Number(C.jitterX.value),
        maxStack: Number(C.maxStack.value),
      }
    }
    function fill(c) {
      c = c || {}
      C.enabled.checked = c.enabled !== false
      C.minFen.value = String(fenOf(c.minAmount))
      C.maxFen.value = String(fenOf(c.maxAmount))
      C.minPct.value = String(Math.round(Number(c.minProbability) * 1000) / 10)
      C.pushEnabled.checked = c.pushEnabled !== false
      C.mainSessionOnly.checked = c.mainSessionOnly === true
      C.pollMs.value = String(c.pollMs != null ? c.pollMs : 2000)
      C.prefix.value = String(c.prefix == null ? '-¥' : c.prefix)
      C.decimals.value = String(c.decimals != null ? c.decimals : 2)
      C.color.value = String(c.color || '#ff3b30')
      C.strokeColor.value = String(c.strokeColor || '#ffffff')
      C.strokeWidth.value = String(c.strokeWidth != null ? c.strokeWidth : 3)
      C.fontSizePx.value = String(c.fontSizePx != null ? c.fontSizePx : 30)
      C.risePx.value = String(c.risePx != null ? c.risePx : 96)
      C.riseMs.value = String(c.riseMs != null ? c.riseMs : 1200)
      C.jitterX.value = String(c.jitterX != null ? c.jitterX : 0.18)
      C.maxStack.value = String(c.maxStack != null ? c.maxStack : 6)
      redraw()
    }

    function doSave() {
      setText(C.saveMsg, '保存中…')
      C.ok.disabled = true
      hook.saveConfig(buildPatch(collect())).then(function (next) {
        refreshEntry(next)
        closeCard()
      }).catch(function (err) {
        C.ok.disabled = false
        setText(C.saveMsg, '⚠ 保存失败:' + String((err && err.message) || err)
          + '（宿主只接受本机回环的写请求;在局域网/反代地址下打开页面时保存会被拒）')
      })
    }

    function refreshStatus() {
      try {
        var rt = hook.getRuntime()
        var s;
        if (rt.sseState === 'ready') s = '推送:已连接'
        else if (rt.sseState === 'connecting') s = '推送:连接中'
        else if (rt.sseState === 'reconnecting') s = '推送:重连中(暂时靠轮询)'
        else if (rt.sseState === 'unsupported') s = '推送:浏览器不支持 EventSource(靠轮询)'
        else s = '推送:已关闭'
        setText(C.status, s + '　·　兜底轮询 ' + rt.pollMs + 'ms　·　本次已触发 '
          + rt.triggers + ' 次' + (rt.lastTrigger ? '(最近:' + rt.lastTrigger + ')' : ''))
      } catch (err) { setText(C.status, '') }
    }

    // 区间/概率一变就重画曲线
    var inputs = [C.minFen, C.maxFen, C.minPct]
    for (var k = 0; k < inputs.length; k++) {
      inputs[k].addEventListener('input', redraw)
      inputs[k].addEventListener('change', redraw)
    }

    fill(base)
    refreshStatus()

    mask.appendChild(card)
    mask.addEventListener('click', function (e) { if (e.target === mask) closeCard() })
    var host = document.body || document.documentElement
    if (!host) return false
    host.appendChild(mask)

    openCard = {
      mask: mask,
      unregister: unregister,
      timer: setInterval(refreshStatus, 1000),
    }
    return true
  }

  // ======================== 入口行注入 ========================
  function whalePanelCards() {
    var out = []
    try {
      var masks = document.querySelectorAll('.dshwv-bubmask')
      for (var i = 0; i < masks.length; i++) {
        var m = masks[i]
        if (m.getAttribute && m.getAttribute('data-dsh-dmg')) continue // 我们自己的卡片
        var card = m.querySelector ? m.querySelector('.dshwv-bubcard') : null
        if (!card) continue
        var title = card.querySelector ? card.querySelector('.dshwv-bubtitle') : null
        var t = title && title.textContent ? String(title.textContent) : ''
        if (t.indexOf(WHALE_TITLE_HINT) < 0) continue
        out.push(card)
      }
    } catch (err) {}
    return out
  }

  function refreshEntry(cfg) {
    if (!entryRow) return
    try {
      var c = cfg || hook.getConfig()
      // ⚠️ 必须用受保护的写入:这个函数会被 observer 回调调用,直接赋值会点燃微任务风暴(见 setText 上方注释)
      if (entryRow.__check) setChecked(entryRow.__check, c.enabled !== false)
      if (entryRow.__summary) setText(entryRow.__summary, summaryText(c))
    } catch (err) {}
  }

  function buildEntry(card, cfg) {
    var row = mk('div', '', 'display:flex;align-items:center;gap:8px;margin:10px 0 0;'
      + 'padding:7px 8px;border-top:1px solid rgba(32,49,112,.12);cursor:pointer;'
      + 'text-align:left;font-size:13px;color:#203170')
    row.id = ENTRY_ID
    row.title = '受击提示设置:每轮消耗进入区间后,在鲸鱼头顶弹出红色伤害数字'

    var check = checkBox(cfg.enabled !== false, function (v) {
      // 入口行左侧的勾 = 总开关,和鲸鱼那四个入口行一样**立即生效**
      hook.saveConfig({ enabled: !!v }).then(function (next) {
        refreshEntry(next)
        setText(row.__msg, '')
      }).catch(function (err) {
        setChecked(check, !v)
        setText(row.__msg, '保存失败:' + String((err && err.message) || err))
      })
    })
    row.appendChild(check)
    row.appendChild(textEl('span', '', PANEL_TITLE, 'font-weight:600'))
    var summary = textEl('span', '', summaryText(cfg), 'margin-left:auto;font-size:11.5px;color:#9fb0d9')
    row.appendChild(summary)
    row.appendChild(textEl('span', '', '▸', 'color:#9fb0d9;font-size:12px'))
    var msg = textEl('span', '', '', 'font-size:11px;color:#c0392b')
    var wrap = mk('div', '', '')
    wrap.appendChild(row)
    wrap.appendChild(msg)

    row.__check = check
    row.__summary = summary
    row.__msg = msg

    row.addEventListener('click', function (e) {
      // 点勾选框本身不打开卡片(那是开关)
      if (e && e.target === check) return
      openPanel()
    })

    var btns = card.querySelector ? card.querySelector('.dshwv-bubbtns') : null
    try {
      if (btns && card.insertBefore) card.insertBefore(wrap, btns)
      else card.appendChild(wrap)
    } catch (err) {
      try { card.appendChild(wrap) } catch (e2) { return null }
    }
    return row
  }

  function tryInject() {
    if (!hook) return
    if (entryRow && entryRow.parentNode) { refreshEntry(); return }
    var cards = whalePanelCards()
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i]
      if (card.querySelector && card.querySelector('#' + ENTRY_ID)) continue
      var row = buildEntry(card, hook.getConfig())
      if (row) { entryRow = row; return }
    }
  }

  // ---- 观察鲸鱼面板的出现 / 消失 ----
  // 三道闸门,少一道都会重新点燃微任务风暴:
  //   ① 写入端:setText/setChecked 先比较再写(回调路径里绝不制造无谓变更);
  //   ② 回调只对"鲸鱼面板出现/消失"这类变更作出反应,不理会别的一切变更;
  //   ③ 扫描合并到下一次 rAF,一帧内成百上千次变更只扫一次。
  var scanScheduled = false
  var scanCount = 0
  var panelSeen = false   // 鲸鱼面板是否出现过:只在"曾经在、现在没了"时才自动收起我们的卡片

  function nodeHasPanel(n) {
    try {
      if (!n) return false
      var cls = n.className ? String(n.className) : ''
      if (cls.indexOf('dshwv-bubmask') >= 0) return true
      if (typeof n.querySelector === 'function' && n.querySelector('.dshwv-bubmask')) return true
      return false
    } catch (err) { return false }
  }

  function scheduleScan() {
    if (scanScheduled) return
    scanScheduled = true
    var run = function () {
      scanScheduled = false
      scanCount++
      try {
        tryInject()
        // 鲸鱼的设置面板**从有到无**时,别把我们的卡片孤零零留在屏幕上。
        // 注意判据是"曾经出现过"而不是"现在不在" —— 否则用控制台 openPanel() 在没有鲸鱼面板时
        // 打开卡片,下一次任意变更就会把它自己关掉。
        var hasPanel = whalePanelCards().length > 0
        if (hasPanel) panelSeen = true
        else if (panelSeen) {
          panelSeen = false
          if (openCard) closeCard()
        }
      } catch (err) {}
    }
    try {
      if (typeof window.requestAnimationFrame === 'function') { window.requestAnimationFrame(run); return }
    } catch (err) {}
    setTimeout(run, 16)
  }

  function watch() {
    try {
      if (typeof window.MutationObserver === 'function') {
        var mo = new window.MutationObserver(function (records) {
          var relevant = false
          try {
            var recs = records || []
            for (var i = 0; i < recs.length && !relevant; i++) {
              var r = recs[i]
              var add = (r && r.addedNodes) || []
              var rem = (r && r.removedNodes) || []
              for (var a = 0; a < add.length; a++) { if (nodeHasPanel(add[a])) { relevant = true; break } }
              if (relevant) break
              for (var b = 0; b < rem.length; b++) { if (nodeHasPanel(rem[b])) { relevant = true; break } }
            }
          } catch (err) { relevant = true }   // 判断本身出错时宁可多扫一次,也不要漏掉面板
          if (relevant) scheduleScan()
        })
        mo.observe(document.body || document.documentElement, { childList: true, subtree: true })
      }
    } catch (err) {}
    // MutationObserver 不可用 / 漏事件时的兜底。refreshEntry 已比较后再写,所以这里不会自激。
    setInterval(function () {
      try {
        tryInject()
        if (entryRow && entryRow.parentNode) refreshEntry()
      } catch (err) {}
    }, 1500)
  }

  function whenReady(tries) {
    if (window.__dshDmgNumber) {
      hook = window.__dshDmgNumber
      hook.openPanel = openPanel
      hook.panel = {
        fenOf: fenOf, yuanOf: yuanOf, probAt: probAt, curvePoints: curvePoints,
        pct: pct, fenText: fenText, summaryText: summaryText, buildPatch: buildPatch,
        open: openPanel, close: closeCard, tryInject: tryInject, isOpen: function () { return !!openCard },
        entry: function () { return entryRow },
        scanCount: function () { return scanCount },   // 供测试台验证"扫描被 rAF 合并压住、且不会自激"
      }
      // 配置从别处变了(例如另一个标签页保存)就刷新入口行摘要
      try { hook.onConfigChange(function (c) { refreshEntry(c) }) } catch (err) {}
      tryInject()
      watch()
      return
    }
    if ((tries || 0) > MAX_WAIT_TRIES) return
    setTimeout(function () { whenReady((tries || 0) + 1) }, 50)
  }

  whenReady(0)
})()
