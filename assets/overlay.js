// ============================================================================
// dsh-damage-number —— 浏览器半区(核心)
// ============================================================================
// 每轮对话结束后,按「区间 + 随机」规则在小鲸鱼头顶弹出一个红色伤害数字。
//
// 金额来源(唯一真相):小鲸鱼挂件的 /dsh-whale/last-turn.json → { ok, seq, turn, amount, tokens, ts }
//   seq 每完成一轮递增,所以"seq 变大"就是"又花了一轮钱"的触发信号。
//   挂件没装 / 路由 404 时,这里只是安静地什么都不做(不报错、不刷屏)。
//
// 触发时机(两条通道,谁先到算谁):
//   ① 宿主 SSE /dsh-dmg/events —— 宿主在 turn/end 的**同一刻**广播;收到就立刻取数。
//      延迟 ≈ 一次本机往返(几毫秒)。这是手感的关键:金额是挂件算的,宿主只负责"叫醒"。
//   ② 兜底轮询 cfg.pollMs(默认 2s)—— SSE 断开/不可用/被关掉时才唱主角。
//   SSE 重连成功(onopen)也会立刻取一次,断线期间的缺口由此补上。
//
// 触发规则(与本插件宿主半区的 DEFAULT_CONFIG 必须一致):
//   amount <  minAmount            → 不跳
//   minAmount <= amount < maxAmount → 概率 = minProbability + (1-minProbability) * 区间内进度
//   amount >= maxAmount            → 必定跳
// 这正是"伤害有上下限、多数时候随机、暴击必定触发"的手感。
//
// 设置界面在 assets/panel.js(它等这里的 window.__dshDmgNumber 就绪后再挂上去)。
// ============================================================================

(function () {
  'use strict'
  if (typeof window === 'undefined') return
  if (window.__dshDmgNumberLoaded) return
  window.__dshDmgNumberLoaded = true

  var ENDPOINT_TURN = '/dsh-whale/last-turn.json'
  var ENDPOINT_CFG = '/dsh-dmg/config.json'
  var ENDPOINT_EVENTS = '/dsh-dmg/events'
  var ENDPOINT_ACTIVITY = '/dsh-dmg/activity.json'
  var CFG_REFRESH_MS = 30000
  // 「现在有没有在干活」的可信来源。3 秒一次、请求体极小;SSE 的 activity 帧只是让它反应更快,
  // 这样即使某帧丢了或 SSE 压根没连上,也不会一直以为"还在干活"而空跳。
  var ACTIVITY_POLL_MS = 3000
  // 持续跳动的监督器节拍:每 500ms 看一次是否该跳,间隔改了也能立刻跟上,不用重建定时器
  var TICK_CHECK_MS = 500
  var LAYER_ID = 'dsh-dmg-layer'
  var MIN_POLL_MS = 250
  var MAX_POLL_MS = 60000

  var DEFAULT_CFG = {
    enabled: true,
    mode: 'turnEnd',
    tickSec: 5,
    minAmount: 0.01,
    maxAmount: 0.1,
    minProbability: 0.25,
    pushEnabled: true,
    mainSessionOnly: false,
    pollMs: 2000,
    prefix: '-¥',
    decimals: 2,
    color: '#ff3b30',
    strokeColor: '#ffffff',
    strokeWidth: 3,
    fontSizePx: 30,
    risePx: 96,
    riseMs: 1800,
    headOffsetX: 0.5,
    headOffsetY: 0.12,
    jitterX: 0.18,
    maxStack: 6,
  }

  var cfg = Object.assign({}, DEFAULT_CFG)
  // baseline = "已经结算到哪一个 seq"。
  // 持久化在 localStorage 里(键名与小鲸鱼自己的 dshw-last-seq 区分开):这样**刷新页面/重开客户端
  // 不会漏掉**在页面不在时结束的那一轮 —— 挂件自己也是这个策略(它读 dshw-last-seq)。
  var baseline = null
  var SEQ_KEY = 'dshw-dmg-last-seq'
  var stack = []        // 正在飘的节点,满了就丢掉最旧的
  var timers = []
  var es = null         // EventSource
  var esReady = false
  var pollTimer = null
  var curPollMs = 0
  var configWatchers = []
  var runtime = { lastTickAt: 0, lastTrigger: '', triggers: 0, sseState: 'off' }

  // ---- 「工作中持续跳动」的状态 ----
  // working 的可信来源是 /dsh-dmg/activity.json(3 秒一次);SSE 的 activity 帧让它反应更快。
  var working = false
  var workingSince = null
  var activityTimer = null
  var supervisorTimer = null
  var lastBurstAt = 0
  // 上一次**已完成**那一轮的真实金额。「工作中持续跳动」用的就是它 ——
  // 小鲸鱼没有暴露"本轮进行中的金额",所以这里刻意不做任何估算:宁可重复同一个真实数字,
  // 也不显示一个编出来的数。(页面刚打开、还没读到过任何金额时,先不跳。)
  var lastKnownAmount = null

  function readStoredSeq() {
    try {
      var v = window.localStorage.getItem(SEQ_KEY)
      if (v === null || v === undefined || v === '') return null
      var n = Number(v)
      return isFinite(n) ? n : null
    } catch (err) { return null }   // 隐私模式/存储被禁 → 退化成本次会话内对齐
  }
  function storeSeq(v) {
    try { window.localStorage.setItem(SEQ_KEY, String(v)) } catch (err) {}
  }

  function num(v, fallback) {
    var n = Number(v)
    return isFinite(n) ? n : fallback
  }
  function clamp01(v) {
    if (!isFinite(v)) return 0
    return v < 0 ? 0 : (v > 1 ? 1 : v)
  }
  function clampPollMs(v) {
    var n = Math.round(num(v, 2000))
    if (n < MIN_POLL_MS) n = MIN_POLL_MS
    if (n > MAX_POLL_MS) n = MAX_POLL_MS
    return n
  }

  // ---- 落点:鲸鱼精灵图(.dshwv-img)的头顶 ----
  // 挂件是"根节点方块 + 内部 59.45% 的精灵图",所以必须量图片本身的矩形,
  // 不能量根节点 —— 否则数字会飘在鲸鱼左上方的空气里。
  function headPoint() {
    var el = null
    try {
      el = document.querySelector('.dshwv-root .dshwv-img') || document.querySelector('.dshwv-root')
    } catch (err) { el = null }
    if (!el || typeof el.getBoundingClientRect !== 'function') return null
    var r = null
    try { r = el.getBoundingClientRect() } catch (err) { return null }
    if (!r || !(r.width > 0) || !(r.height > 0)) return null
    return {
      x: r.left + r.width * num(cfg.headOffsetX, 0.5),
      y: r.top + r.height * num(cfg.headOffsetY, 0.12),
      w: r.width,
      h: r.height,
    }
  }

  function ensureLayer() {
    var el = null
    try { el = document.getElementById(LAYER_ID) } catch (err) { el = null }
    if (el) return el
    try {
      el = document.createElement('div')
      el.id = LAYER_ID
      el.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;'
        + 'z-index:9998;pointer-events:none;'
      var host = document.body || document.documentElement
      if (!host || typeof host.appendChild !== 'function') return null
      host.appendChild(el)
    } catch (err) { return null }
    return el
  }

  function fmtAmount(n) {
    var a = num(n, 0)
    var d = num(cfg.decimals, 2)
    d = Math.max(0, Math.min(6, Math.round(d)))
    var s = a.toFixed(d)
    // 2 位小数会把"小于半分钱"显示成 0.00 —— 那看着像故障,补一位
    if (d === 2 && s === '0.00' && a > 0) s = a.toFixed(3)
    return s
  }

  // ---- 核心:区间 + 概率判定(纯函数,便于测试)----
  function rollDamage(amount, c) {
    c = c || cfg
    var a = num(amount, NaN)
    if (!isFinite(a) || a <= 0) return { hit: false, p: 0, reason: 'no-cost' }
    var lo = num(c.minAmount, 0)
    var hi = num(c.maxAmount, lo)
    if (a < lo) return { hit: false, p: 0, reason: 'below-min' }
    var base = clamp01(num(c.minProbability, 0))
    var p
    if (hi <= lo || a >= hi) {
      p = 1 // 区间退化(上下限相等)= 纯阈值;达到/超过上限 = 必定触发
    } else {
      p = base + (1 - base) * clamp01((a - lo) / (hi - lo))
    }
    p = clamp01(p)
    var r = Math.random()
    return { hit: r < p, p: p, roll: r, reason: r < p ? 'hit' : 'miss' }
  }

  function dropOldest() {
    var max = Math.max(1, Math.round(num(cfg.maxStack, 6)))
    while (stack.length >= max) {
      var old = stack.shift()
      try { if (old && old.parentNode) old.parentNode.removeChild(old) } catch (err) {}
    }
  }

  function spawn(amount, opts) {
    opts = opts || {}
    var layerEl = ensureLayer()
    if (!layerEl) return null
    var pt = opts.point || headPoint()

    var fs = Math.max(8, num(cfg.fontSizePx, 30))
    var sw = Math.max(0, num(cfg.strokeWidth, 0))
    var color = String(cfg.color || '#ff3b30')
    var strokeColor = String(cfg.strokeColor || '#ffffff')

    var outer = document.createElement('div')
    outer.className = 'dsh-dmg-num'
    // 外层只负责"钉在头顶这个点上",不参与动画 —— 这样内层动画可以全部用 px,
    // 避免百分比与 calc() 混插带来的插值不可靠。
    outer.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;'
      + 'pointer-events:none;transform:translate(-50%,-50%);'
      + 'font-weight:900;line-height:1;font-family:inherit;'

    var inner = document.createElement('span')
    inner.style.cssText = 'display:inline-block;transform-origin:50% 100%;will-change:transform,opacity;'
      + 'font-size:' + fs + 'px;color:' + color + ';'
    if (sw > 0) {
      inner.style.webkitTextStroke = sw + 'px ' + strokeColor
      inner.style.paintOrder = 'stroke fill'
      inner.style.textShadow = '0 ' + Math.max(1, Math.round(sw * 0.6)) + 'px '
        + Math.max(2, Math.round(sw * 1.6)) + 'px rgba(0,0,0,.30)'
    }
    inner.textContent = String(cfg.prefix == null ? '-¥' : cfg.prefix) + fmtAmount(amount)
    outer.appendChild(inner)

    var jitter = Math.max(0, num(cfg.jitterX, 0)) * (pt ? pt.w : 60)
    var dx = jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0
    var rot = (Math.random() * 2 - 1) * 6
    var baseX = pt ? pt.x : (num(window.innerWidth, 800) - 80)
    var baseY = pt ? pt.y : (num(window.innerHeight, 600) - 140)
    outer.style.left = Math.round(baseX + dx) + 'px'
    outer.style.top = Math.round(baseY) + 'px'
    outer.style.transform = 'translate(-50%,-50%) rotate(' + rot.toFixed(2) + 'deg)'

    dropOldest()
    layerEl.appendChild(outer)
    stack.push(outer)

    var dist = Math.max(0, num(cfg.risePx, 96))
    var dur = Math.max(120, num(cfg.riseMs, 1200))

    function cleanup() {
      var i = stack.indexOf(outer)
      if (i >= 0) stack.splice(i, 1)
      try { if (outer.parentNode) outer.parentNode.removeChild(outer) } catch (err) {}
    }

    // 关键帧(全部用 px,不与 % 混插):
    //   0.00 → 0.10  弹出(缩放过冲)
    //   0.10 → 0.28  落定
    //   0.28 → 0.78  **主可见段**:近乎匀速地缓慢上浮,占总时长的一半
    //   0.78 → 1.00  只负责淡出,几乎不再位移
    // 之所以这么分:用户反馈旧版"滑动太快、显示时间太短"。旧版把 0.68 的时长用来走 0.66 的距离
    // (≈78px/s),可见窗口只有约 0.7 个时长;现在可见窗口占 0.9 个时长,上浮速度 ≈58px/s。
    // 想整体更慢/更久,只需要调大 riseMs —— 也就是面板里的「时长」。
    var frames = [
      { transform: 'translateY(0px) scale(.55)', opacity: 0, offset: 0 },
      { transform: 'translateY(' + (-dist * 0.12).toFixed(1) + 'px) scale(1.28)', opacity: 1, offset: 0.10 },
      { transform: 'translateY(' + (-dist * 0.34).toFixed(1) + 'px) scale(1)', opacity: 1, offset: 0.28 },
      { transform: 'translateY(' + (-dist * 0.88).toFixed(1) + 'px) scale(1)', opacity: 1, offset: 0.78 },
      { transform: 'translateY(' + (-dist).toFixed(1) + 'px) scale(1.04)', opacity: 0, offset: 1 },
    ]
    var timing = { duration: dur, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'forwards' }

    try {
      if (typeof inner.animate === 'function') {
        var anim = inner.animate(frames, timing)
        if (anim && typeof anim.addEventListener === 'function') anim.addEventListener('finish', cleanup)
        else setTimeout(cleanup, dur + 40)
      } else {
        // 没有 Web Animations API:退化成"出现 → 定时移除",至少不残留
        inner.style.opacity = '1'
        setTimeout(cleanup, dur)
      }
    } catch (err) {
      setTimeout(cleanup, dur)
    }
    return outer
  }

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (!r || !r.ok) throw new Error('http ' + (r && r.status))
        return r.json()
      })
  }

  function notifyConfig() {
    for (var i = 0; i < configWatchers.length; i++) {
      try { configWatchers[i](Object.assign({}, cfg)) } catch (err) {}
    }
  }

  function applyConfig(next) {
    cfg = Object.assign({}, DEFAULT_CFG, next || {})
    hook.cfg = cfg
    syncPoll()
    syncPush()
    // 模式/间隔/总开关都可能刚变过:让监督器与活动轮询跟着启停
    syncSupervisor()
    syncActivityPoll()
    notifyConfig()
    return cfg
  }

  function loadConfig() {
    return fetchJson(ENDPOINT_CFG)
      .then(function (d) {
        // 只在拿到**对象**时才应用:404 / 断连 / 畸形载荷一律保留上一次有效配置。
        // 绝不因为一次读失败就把用户调好的区间静默冲回默认值 —— 宿主那边读不到配置时
        // 返回的本来就是"默认值 + 磁盘覆盖"的完整对象,客户端不需要自己兜底重置。
        if (d && typeof d === 'object') applyConfig(d)
      })
      .catch(function () {})
  }

  // 面板保存:写到宿主(宿主只接受本机回环的写请求),成功后立刻在本地生效
  function saveConfig(patch) {
    var sent = Object.assign({}, cfg, patch || {})
    return fetch(ENDPOINT_CFG, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(sent),
    }).then(function (r) {
      if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status))
      return r.json()
    }).then(function (d) {
      if (!d || d.ok !== true) throw new Error((d && d.error) || '保存被拒绝')
      applyConfig(d.config)
      // 宿主可能还没加载新版本:它的 sanitize() 只认**自己那份** DEFAULT_CONFIG 里的键,
      // 遇到不认识的键会静默丢掉 —— 表现就是"点了保存、卡片关了、设置却没变",极难排查。
      // 所以把发出去的每个键跟回来的值逐个比一遍,对不上就明确报错(浏览器半区可以先于宿主半区更新)。
      var got = d.config || {}
      var dropped = []
      for (var k in sent) {
        if (!Object.prototype.hasOwnProperty.call(sent, k)) continue
        if (JSON.stringify(got[k]) !== JSON.stringify(sent[k])) dropped.push(k)
      }
      if (dropped.length) {
        var e = new Error('宿主没接受这些键:' + dropped.join('、')
          + '(宿主半区还是旧版本 —— 重启一次客户端后再保存)')
        e.droppedKeys = dropped
        throw e
      }
      return d.config
    })
  }

  // 取一次数。返回:null = 无事发生;{...} = 本次判定结果(便于测试与调试)
  function tick(source) {
    runtime.lastTickAt = Date.now()
    return fetchJson(ENDPOINT_TURN)
      .then(function (d) {
        if (!d || !d.ok || typeof d.seq !== 'number') return null
        var seq = num(d.seq, 0)

        // 先记"最近一轮的真实金额" —— 「工作中持续跳动」用的就是它。
        // 必须放在下面所有提前 return **之前**:页面刚打开那一次只立基准就 return 了,
        // 如果记录写在后面,持续模式会一直因为"读不到金额"而空等一整轮。
        if (d.amount !== null && d.amount !== undefined) {
          var known = num(d.amount, NaN)
          if (isFinite(known) && known >= 0) lastKnownAmount = known
        }

        if (baseline === null) {
          var stored = readStoredSeq()
          if (stored === null) {
            // 本机第一次运行:只立基准。绝不把历史账本里的旧轮次当成"刚刚花的钱"补弹一遍。
            baseline = seq
            storeSeq(seq)
            return null
          }
          baseline = stored
        }

        if (seq === baseline) return null
        if (seq < baseline) {
          // 挂件重启 / seq 文件丢失 → 拉齐,不弹(否则会拿一个陈旧的比较基准乱跳)
          baseline = seq
          storeSeq(seq)
          return null
        }

        baseline = seq
        storeSeq(seq)
        if (cfg.enabled === false) return null
        var amount = num(d.amount, 0)
        var res = rollDamage(amount)
        res.source = source || 'poll'
        res.amount = amount
        res.seq = seq
        if (!res.hit) return res
        runtime.triggers++
        runtime.lastTrigger = res.source
        spawn(amount)
        return res
      })
      .catch(function () { return null })
  }

  // ---- 兜底轮询 ----
  function syncPoll() {
    var want = clampPollMs(cfg.pollMs)
    if (pollTimer && curPollMs === want) return
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    curPollMs = want
    pollTimer = setInterval(function () { tick('poll') }, want)
    timers.push(pollTimer)
  }

  function wantWorkingMode() {
    return cfg.enabled !== false && cfg.mode === 'working'
  }

  function tickSecMs() {
    var n = num(cfg.tickSec, 5)
    if (!isFinite(n)) n = 5
    if (n < 0.5) n = 0.5
    if (n > 3600) n = 3600
    return Math.round(n * 1000)
  }

  // 工作中间隔跳动:无条件跳(不做概率判定),金额 = 上一轮的真实金额。
  // 之所以不做概率判定:用户要的就是"只要在干活就一直在输出";概率那一层留给每轮结束那一次
  // (那条路径仍走 rollDamage,所以「区间/概率」这些设置依然有意义)。
  function burstTick() {
    if (!wantWorkingMode()) return false
    if (lastKnownAmount === null) return false   // 还没读到过任何真实金额 → 宁可不跳,也不编一个
    runtime.triggers++
    runtime.lastTrigger = 'working'
    spawn(lastKnownAmount)
    return true
  }

  // 该不该来一次间隔跳动。做成纯判断(定时器只是每 TICK_CHECK_MS 调它一次)有三个好处:
  //   · 面板里改间隔/模式立刻生效,不需要重建定时器;
  //   · 它可以直接被测试断言,不用去驱动定时器;
  //   · "什么时候**不**跳"的规则集中在一处,不会散落在回调里。
  function shouldBurst(now) {
    if (cfg.enabled === false) return false
    if (cfg.mode !== 'working') return false
    if (!working) return false
    if (lastKnownAmount === null) return false   // 还没读到过任何真实金额 → 宁可不跳,也不编一个
    if (!lastBurstAt) return false
    return (num(now, Date.now()) - lastBurstAt) >= tickSecMs()
  }

  // 监督器:每 TICK_CHECK_MS 问一次 shouldBurst
  function syncSupervisor() {
    var want = wantWorkingMode()
    if (!want) {
      if (supervisorTimer) { clearInterval(supervisorTimer); supervisorTimer = null }
      lastBurstAt = 0
      return
    }
    if (supervisorTimer) return
    supervisorTimer = setInterval(function () {
      var now = Date.now()
      if (!shouldBurst(now)) return
      lastBurstAt = now
      burstTick()
    }, TICK_CHECK_MS)
    timers.push(supervisorTimer)
  }

  function setWorking(next) {
    var was = working
    working = !!next
    if (working && !was) {
      workingSince = Date.now()
      lastBurstAt = Date.now()   // 第一跳从"开始工作"起算一个完整间隔,不立刻喷一个
    }
    if (!working && was) {
      workingSince = null
      lastBurstAt = 0
    }
    syncSupervisor()
  }

  // ---- 活动状态(「工作中持续跳动」的依据)----
  function syncActivity() {
    if (!wantWorkingMode()) return Promise.resolve(null)
    return fetchJson(ENDPOINT_ACTIVITY)
      .then(function (d) {
        if (!d || d.ok !== true) return null
        // 「只在主会话」时,子代理在跑不算"我在干活"
        var busy = cfg.mainSessionOnly === true ? !!d.mainWorking : !!d.working
        setWorking(busy)
        return d
      })
      .catch(function () { return null })
  }

  function syncActivityPoll() {
    // 只有开着持续模式才需要它;不关心就一个请求都不发
    if (!wantWorkingMode()) {
      if (activityTimer) { clearInterval(activityTimer); activityTimer = null }
      setWorking(false)
      return
    }
    if (activityTimer) return
    activityTimer = setInterval(function () { syncActivity() }, ACTIVITY_POLL_MS)
    timers.push(activityTimer)
    syncActivity()   // 立刻收敛一次:别让刚切到持续模式后白等一个轮询周期
  }

  // ---- SSE:宿主在 turn/end 的同一刻叫醒我们 ----
  function stopPush() {
    if (es) {
      try { es.close() } catch (err) {}
      es = null
    }
    esReady = false
    runtime.sseState = 'off'
  }

  function syncPush() {
    if (cfg.pushEnabled === false) { stopPush(); return }
    if (es) return
    if (typeof window.EventSource !== 'function') {
      runtime.sseState = 'unsupported'
      return
    }
    try {
      es = new window.EventSource(ENDPOINT_EVENTS)
    } catch (err) {
      es = null
      runtime.sseState = 'error'
      return
    }
    runtime.sseState = 'connecting'
    es.addEventListener('hello', function () {
      esReady = true
      runtime.sseState = 'ready'
    })
    // 活动状态帧:只让"开始/结束工作"反应更快;可信来源仍是 activity.json 的 3 秒轮询
    es.addEventListener('activity', function (ev) {
      var d = null
      try { d = JSON.parse(ev.data) } catch (err) { d = null }
      if (!d) return
      setWorking(cfg.mainSessionOnly === true ? !!d.mainWorking : !!d.working)
    })
    es.addEventListener('turn', function (ev) {
      var d = null
      try { d = JSON.parse(ev.data) } catch (err) { d = null }
      // 「只在主会话结算」:子代理的 turn/end 不当成一整轮对话
      if (cfg.mainSessionOnly === true && d && d.isSubagent) return
      tick('push')
    })
    // 重连成功也立刻取一次:断线期间结束的轮次由此补上,不依赖下一次轮询
    es.onopen = function () {
      esReady = true
      runtime.sseState = 'ready'
      tick('push-open')
      syncActivity()
    }
    es.onerror = function () {
      // EventSource 自己会重连;这里只标记状态,让面板能显示"已降级为轮询"
      esReady = false
      runtime.sseState = 'reconnecting'
    }
  }

  // 面板"预览"按钮用:不走判定,直接飘一个
  function preview(amount) {
    return spawn(num(amount, 0.05))
  }

  // 面板"试算"按钮用:按当前区间跑 N 次判定,返回命中次数与理论概率
  function simulate(amount, times) {
    var n = Math.max(1, Math.min(20000, Math.round(num(times, 1000))))
    var a = num(amount, 0)
    var hits = 0
    var p = 0
    for (var i = 0; i < n; i++) {
      var r = rollDamage(a)
      p = r.p
      if (r.hit) hits++
    }
    return { amount: a, times: n, hits: hits, rate: hits / n, expected: p }
  }

  var hook = {
    version: '0.3.0',
    DEFAULT_CFG: DEFAULT_CFG,
    getConfig: function () { return Object.assign({}, cfg) },
    setConfig: function (patch) { return applyConfig(Object.assign({}, cfg, patch || {})) },
    applyConfig: applyConfig,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    onConfigChange: function (fn) {
      if (typeof fn !== 'function') return function () {}
      configWatchers.push(fn)
      return function () {
        var i = configWatchers.indexOf(fn)
        if (i >= 0) configWatchers.splice(i, 1)
      }
    },
    roll: rollDamage,
    spawn: spawn,
    preview: preview,
    simulate: simulate,
    tick: tick,
    burstTick: burstTick,          // 立刻手动来一次"工作中间隔跳动"(便于测试与试看)
    shouldBurst: shouldBurst,      // 该不该跳的纯判断(测试用,不必驱动定时器)
    headPoint: headPoint,
    syncActivity: syncActivity,    // 立刻刷新一次"是否在干活"
    reset: function () { baseline = null; return true },
    clearStoredSeq: function () { try { window.localStorage.removeItem(SEQ_KEY) } catch (err) {} baseline = null; return true },
    getBaseline: function () { return baseline },
    getRuntime: function () {
      return {
        sseReady: esReady,
        sseState: runtime.sseState,
        pollMs: curPollMs,
        lastTickAt: runtime.lastTickAt,
        triggers: runtime.triggers,
        lastTrigger: runtime.lastTrigger,
        baseline: baseline,
        onScreen: stack.length,
        mode: cfg.mode === 'working' ? 'working' : 'turnEnd',
        tickSec: num(cfg.tickSec, 5),
        working: working,
        workingSince: workingSince,
        lastBurstAt: lastBurstAt,
        lastKnownAmount: lastKnownAmount,
        supervisorOn: !!supervisorTimer,
        activityPollOn: !!activityTimer,
      }
    },
    cfg: cfg,
  }
  window.__dshDmgNumber = hook

  function start() {
    ensureLayer()
    loadConfig().then(function () {
      tick('boot')
      syncPoll()
      syncPush()
      syncSupervisor()
      syncActivityPoll()
      syncActivity()
      timers.push(setInterval(loadConfig, CFG_REFRESH_MS))
    })
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start)
    } else {
      start()
    }
  } catch (err) {
    // 页面结构异常时绝不让脚本把宿主页面搞挂
    try { start() } catch (err2) {}
  }
})()
