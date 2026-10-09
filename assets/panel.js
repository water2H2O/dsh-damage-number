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
  // 等 overlay.js 就绪:不再有"最大等待次数" —— 见 whenReady() 里的说明,放弃就等于面板永久失效。

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
  // 曲线采样点曾经用来画面板里的概率曲线;那条曲线已从界面里拿掉了,
  // 所以这里也一并删掉 —— 留着没人调用的实现比删掉更容易误导人。
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
  // 只产出**界面暴露的**那几个键。其余键由 saveConfig 用现有 cfg 兜底合并 ——
  // 这正是"界面瘦身"能安全做的原因:拿掉一个控件,不会顺手把那个配置项清成默认值。
  function buildPatch(v) {
    return {
      enabled: !!v.enabled,
      mode: v.mode === 'working' ? 'working' : 'turnEnd',
      tickSec: Math.max(0.5, Math.min(3600, Number(v.tickSec) || 5)),
      minAmount: yuanOf(v.minFen),
      maxAmount: yuanOf(v.maxFen),
      minProbability: Math.max(0, Math.min(1, Number(v.minPct) / 100)) || 0,
      riseMs: Math.max(200, Number(v.riseMs) || 1800),
      // 界面按百分比填(「横向偏移 18%」比「jitterX 0.18」友好),配置里仍是 0~1 的比例
      jitterX: Math.max(0, Math.min(1, (Number(v.jitterPct) || 0) / 100)),
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
  function checkBox(checked, onChange) {
    var c = mk('input', 'dshwv-check')
    c.type = 'checkbox'
    c.checked = !!checked
    if (onChange) c.addEventListener('change', function () { onChange(!!c.checked) })
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
  function modeSelect(value) {
    var s = mk('select', '', 'font-size:12px;color:#203170;border:1px solid rgba(32,49,112,.4);'
      + 'border-radius:6px;padding:2px 4px;background:#fff;box-sizing:border-box;max-width:180px')
    var o1 = document.createElement('option')
    o1.value = 'turnEnd'
    o1.textContent = '每轮结束时跳一次'
    var o2 = document.createElement('option')
    o2.value = 'working'
    o2.textContent = '工作中每隔一段时间跳'
    s.appendChild(o1)
    s.appendChild(o2)
    s.value = value === 'working' ? 'working' : 'turnEnd'
    return s
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

    // ---------- 1. 开关 / 模式 ----------
    var rOn = rowEl()
    C.enabled = checkBox(base.enabled !== false)
    rOn.appendChild(C.enabled)
    rOn.appendChild(labEl('启用受击提示'))
    card.appendChild(rOn)

    var rMode = rowEl()
    rMode.appendChild(labEl('模式'))
    C.mode = modeSelect(base.mode)
    rMode.appendChild(C.mode)
    card.appendChild(rMode)

    // ---------- 2. 跳动规则(只留真正需要动的三个数) ----------
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
    rP.appendChild(labEl('下限概率'))
    C.minPct = numInput(Math.round(Number(base.minProbability) * 1000) / 10, { min: 0, max: 100, step: 5, width: '56px', title: '刚好达到下限时的触发概率;越接近上限概率越大(上限处必定跳)' })
    rP.appendChild(C.minPct)
    rP.appendChild(labEl('%   →   上限处 100%'))
    card.appendChild(rP)

    var rTick = rowEl()
    rTick.appendChild(labEl('间隔'))
    C.tickSec = numInput(base.tickSec != null ? base.tickSec : 5, { min: 0.5, max: 3600, step: 0.5, width: '60px', title: '「工作中每隔一段时间跳」的间隔秒数' })
    rTick.appendChild(C.tickSec)
    rTick.appendChild(labEl('秒'))
    card.appendChild(rTick)

    C.modeHint = hintEl('')
    card.appendChild(C.modeHint)

    // ---------- 3. 观感(只留最影响手感的两项) ----------

    var rMotion = rowEl()
    rMotion.appendChild(labEl('显示时长'))
    C.riseMs = numInput(base.riseMs, { min: 200, max: 8000, step: 100, width: '66px', title: '整段动画的总时长;调大 = 飘得更慢、看得更久' })
    rMotion.appendChild(C.riseMs)
    rMotion.appendChild(labEl('ms　横向偏移'))
    C.jitterPct = numInput(Math.round(Number(base.jitterX != null ? base.jitterX : 0.18) * 100), { min: 0, max: 100, step: 2, width: '56px', title: '每次跳动相对鲸鱼宽度的左右随机偏移幅度(%)' })
    rMotion.appendChild(C.jitterPct)
    rMotion.appendChild(labEl('%'))
    card.appendChild(rMotion)

    // ---------- 4. 预览(不花一分钱) ----------
    // 只有一个按钮:在中点金额上就地飘一个。三个金额的版本、以及掷骰子试算,都从界面里去掉了 ——
    // 需要的话用控制台 __dshDmgNumber.preview(x) / simulate(x, n)。
    var rPrev = rowEl()
    rPrev.appendChild(btn('预览一下', 'no', function () {
      hook.preview(yuanOf((Number(C.minFen.value) + Number(C.maxFen.value)) / 2))
    }, '就地飘一个数字,只看外观:不发请求、不做判定、不花任何钱'))
    card.appendChild(rPrev)

    // ---------- 底栏 ----------
    var btns = mk('div', 'dshwv-bubbtns')
    btns.appendChild(btn('取消', 'no', function () { closeCard() }))
    btns.appendChild(btn('恢复默认', 'no', function () { fill(hook.DEFAULT_CFG) }, '把本卡片所有项恢复为默认值(仍需点保存才落盘)'))
    C.ok = btn('保存', 'ok', function () { doSave() })
    btns.appendChild(C.ok)
    card.appendChild(btns)
    C.saveMsg = hintEl('')
    card.appendChild(C.saveMsg)

    // 模式不同:说明文字与「间隔」是否可用都要跟着变
    function syncModeEnabled() {
      var isWorking = C.mode.value === 'working'
      C.tickSec.disabled = !isWorking
      if (isWorking) {
        var sec = Number(C.tickSec.value)
        if (!isFinite(sec) || sec < 0.5) sec = 5
        setText(C.modeHint, '干活期间每 ' + sec + ' 秒跳一次(数字 = 上一轮的金额);每轮结束那次仍按区间概率判定。')
      } else {
        setText(C.modeHint, '每轮结束时按区间概率跳一次:到上限必定跳;上下限填一样 = 纯阈值。')
      }
    }
    C.mode.addEventListener('change', syncModeEnabled)
    C.tickSec.addEventListener('input', syncModeEnabled)
    C.tickSec.addEventListener('change', syncModeEnabled)

    // ---------- 取值/回填 ----------
    // ⚠️ 只收集**界面上真实存在的**控件。其余键(描边/前缀/小数位/推送/轮询…)不在界面里,
    //    但 saveConfig 会拿现有 cfg 做底再合并这个补丁,所以它们原样保留、不会被这次保存清掉。
    function collect() {
      return {
        enabled: C.enabled.checked,
        mode: C.mode.value,
        tickSec: Number(C.tickSec.value),
        minFen: Number(C.minFen.value),
        maxFen: Number(C.maxFen.value),
        minPct: Number(C.minPct.value),
        riseMs: Number(C.riseMs.value),
        jitterPct: Number(C.jitterPct.value),
      }
    }
    function fill(c) {
      c = c || {}
      C.enabled.checked = c.enabled !== false
      C.mode.value = c.mode === 'working' ? 'working' : 'turnEnd'
      C.tickSec.value = String(c.tickSec != null ? c.tickSec : 5)
      C.minFen.value = String(fenOf(c.minAmount))
      C.maxFen.value = String(fenOf(c.maxAmount))
      C.minPct.value = String(Math.round(Number(c.minProbability) * 1000) / 10)
      C.riseMs.value = String(c.riseMs != null ? c.riseMs : 1800)
      C.jitterPct.value = String(Math.round(Number(c.jitterX != null ? c.jitterX : 0.18) * 100))
      syncModeEnabled()
    }

    function doSave() {
      setText(C.saveMsg, '保存中…')
      C.ok.disabled = true
      hook.saveConfig(buildPatch(collect())).then(function (next) {
        refreshEntry(next)
        closeCard()
      }).catch(function (err) {
        C.ok.disabled = false
        var msg = String((err && err.message) || err)
        // 「宿主丢键」是版本不匹配,不是权限问题 —— 两种原因不能混成一句话,否则会把人带偏
        if (!(err && err.droppedKeys)) {
          msg += '(宿主只接受本机回环的写请求;在局域网/反代地址下打开页面时保存会被拒)'
        }
        setText(C.saveMsg, '⚠ 保存失败:' + msg)
      })
    }

    fill(base)

    mask.appendChild(card)
    mask.addEventListener('click', function (e) { if (e.target === mask) closeCard() })
    var host = document.body || document.documentElement
    if (!host) return false
    host.appendChild(mask)

    openCard = {
      mask: mask,
      unregister: unregister,
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
  var moRef = null        // MutationObserver 的强引用(保活,见 watch())

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
        var mo = new window.MutationObserver(function (records) {          var relevant = false
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
        moRef = mo   // 强引用保活:MutationObserver 一旦丢掉 JS 引用,某些实现/GC 时机会停止派发
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
        fenOf: fenOf, yuanOf: yuanOf, probAt: probAt,
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
    // ⚠️ 这里**绝不能放弃**。
    // panel.js 与 overlay.js 是两个各自 <script src> 的独立文件,执行顺序不保证;
    // 而入口行、设置卡片全都依赖 overlay 暴露的 window.__dshDmgNumber。
    // 旧实现"等 10 秒就 return"→ 一旦 overlay 慢了或压根没加载成功,面板就**永久失效**,
    // 而且一声不吭 —— 现象正是"点开全局设置什么都没有",极难排查。
    // 现在:一直重试(逐步放慢),并在等不到时把原因明确打到控制台。
    var n = tries || 0
    if (n === 60 && !whenReady.warned) {   // ≈3 秒还没等到
      whenReady.warned = true
      try {
        console.warn('[dsh-damage-number] 还没等到 overlay.js 的 window.__dshDmgNumber,'
          + '设置入口行暂时挂不上。排查顺序:'
          + '① 硬刷新页面(Ctrl+F5);'
          + '② 刷新后在 Network 里看 /dsh-dmg/overlay.js 的状态码(若是 500/404,是宿主侧没读到这个文件);'
          + '③ 在 Console 里输入 window.__dshDmgNumber 看是否 undefined。')
      } catch (err) {}
    }
    var delay = n < 40 ? 50 : (n < 200 ? 250 : 2000)   // 逐步放慢,但永不放弃
    setTimeout(function () { whenReady(n + 1) }, delay)
  }

  whenReady(0)
})()
