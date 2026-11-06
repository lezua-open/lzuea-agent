/**
 * 端到端冒烟：走真实 UI 发一条消息，断言整条链路活着。
 *
 * 覆盖的是「单测覆盖不到的那截」——IPC、运行时、provider 适配层、事件流、落库。
 * 只读 DOM 断言，不截图（隐私约束）。
 *
 * 用法：node scripts/smoke-send.mjs [消息]
 * 前提：应用已用 --remote-debugging-port=9333 启动，且已配好 provider 与工作区。
 */
const PORT = 9333
const TEXT = process.argv[2] ?? '1+1 等于几？只回答数字。'
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000)

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url))
if (!page) {
  console.error('找不到页面 target')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let seq = 0
const pending = new Map()
const listeners = new Map()
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
    return
  }
  if (msg.method && listeners.has(msg.method)) {
    for (const res of listeners.get(msg.method)) res(msg)
    listeners.delete(msg.method)
  }
}
function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res) => pending.set(id, res))
}
/** 等一个一次性 CDP 事件。Page.reload 立刻返回，但导航是异步的 —— 不等加载完就去读 DOM，读到的还是卸载前的旧页面 */
function awaitEvent(method, timeoutMs = 30000) {
  return new Promise((res, rej) => {
    const set = listeners.get(method) ?? new Set()
    const handler = (msg) => {
      set.delete(handler)
      clearTimeout(timer)
      res(msg)
    }
    set.add(handler)
    listeners.set(method, set)
    const timer = setTimeout(() => {
      set.delete(handler)
      rej(new Error(`等 ${method} 超时`))
    }, timeoutMs)
  })
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate 失败')
  }
  return r.result?.result?.value
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Page.bringToFront')
// 测量前强制重载。electron-vite 的 HMR 不总能把组件送进渲染进程 —— 拿着旧代码
// 量出来的结论是确凿而错误的（曾据此判定「慢速滚轮被按住」，其实修早就生效了，
// 只是页面跑的还是上一版）。宁可多花几秒，也不要量到过期的构建。
//
// reload 立刻返回，导航是异步的：不等 load 就去查 DOM，第一轮查到的是还没卸载的
// 旧页面，会误判成「已经启动完」，随后页面被抹掉，前置检查就崩在「输入区不可用」。
await send('Page.enable')
const loaded = awaitEvent('Page.loadEventFired', 60000)
await send('Page.reload', { ignoreCache: true })
await loaded
// 等 composer 挂上来再往下走。ignoreCache 会把 dev server 的模块全重转一遍，
// 冷启动能到十几秒以上 —— 固定睡死秒数会误判成「应用坏了」。
let booted = false
for (let i = 0; i < 180; i++) {
  if (await evaluate(`!!document.querySelector('.composer__textarea')`)) {
    booted = true
    break
  }
  await wait(250)
}
if (!booted) {
  console.error('❌ 重载后 45 秒内没等到输入框，不测了（量到的会是半加载的页面）')
  console.error(await evaluate(`document.body ? document.body.innerHTML.slice(0, 600) : '(no body)'`))
  process.exit(1)
}
// 窗口被最小化或完全遮挡时 document 是 hidden，rAF 彻底归零、定时器被掐到 1 次/秒。
// 跟随循环正是 rAF 驱动的 —— 在隐藏窗口下测出来的「落后」全是可见性假象，
// 不是产品缺陷。强制把页面拉成可见，量的是用户真正盯着窗口时的状态。
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Page.setWebLifecycleState', { state: 'active' })

// ---- 前置：必须能发 --------------------------------------------------------
const pre = await evaluate(`(() => {
  const ta = document.querySelector('.composer__textarea')
  const btn = [...document.querySelectorAll('.composer__bar button')].find((b) => b.textContent.includes('发送'))
  return {
    hasComposer: !!ta,
    blocked: !!document.querySelector('.composer.is-blocked'),
    hint: document.querySelector('.composer__hint')?.textContent.trim() ?? null,
    sendDisabled: btn?.disabled ?? null,
    running: [...document.querySelectorAll('.composer__bar button')].some((b) => b.textContent.includes('停止'))
  }
})()`)
console.log('--- 发送前 ---')
console.log(JSON.stringify(pre, null, 2))

// 页面不可见时 rAF 归零，跟随循环必然冻结 —— 那种状态下量到的滚动滞后全是假象。
// 这里先断言 rAF 真的在跑，否则后面的滚动结论一概不作数。
const rafAlive = await evaluate(`(async () => {
  let frames = 0
  const t0 = performance.now()
  const tick = () => {
    frames++
    if (performance.now() - t0 < 250) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  await new Promise((r) => setTimeout(r, 350))
  return { vis: document.visibilityState, frames }
})()`)
console.log('rAF 存活检查:', JSON.stringify(rafAlive))
if (rafAlive.vis !== 'visible' || rafAlive.frames < 5) {
  console.error('❌ 页面不可见或 rAF 没在跑 —— 滚动跟随的测量不作数')
  ws.close()
  process.exit(1)
}
if (!pre.hasComposer || pre.blocked || pre.running) {
  console.error('前置不满足：输入区不可用/被挡住/正在运行')
  ws.close()
  process.exit(1)
}

// ---- 上一轮可能还在跑：先停掉，否则发送会被「已有任务在执行」弹回 ----------
// 不停的话这一轮根本没发出消息，量到的全是上一轮的尾巴，汇总出来全是缺损值。
for (let i = 0; i < 40; i++) {
  const busy = await evaluate(`[...document.querySelectorAll('.composer__bar button')].some((b) => b.textContent.includes('停止'))`)
  if (!busy) break
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.composer__bar button')].find((x) => x.textContent.includes('停止'))
    if (b) b.click()
    return !!b
  })()`)
  await wait(500)
}
{
  const still = await evaluate(`[...document.querySelectorAll('.composer__bar button')].some((b) => b.textContent.includes('停止'))`)
  if (still) {
    console.error('停不掉上一轮任务，abort')
    ws.close()
    process.exit(1)
  }
}

// ---- 真实输入 + 点击发送 ---------------------------------------------------
await evaluate(`(() => {
  const ta = document.querySelector('.composer__textarea')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, ${JSON.stringify(TEXT)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await wait(200)

const enabled = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.composer__bar button')].find((b) => b.textContent.includes('发送'))
  return btn ? !btn.disabled : null
})()`)
if (!enabled) {
  console.error('输入后发送键仍是灰的，abort')
  ws.close()
  process.exit(1)
}

// 发送前先记下 toast 和消息数。上一轮留下的残影不该算到这一轮头上；
// 「跑完没」也得按**这一轮**新增了消息来判，不能看历史总数 —— 历史一大把的时候，
// 发送被弹回也会立刻满足「有用户消息、有助手消息」，整轮空跑还报 OK。
const toastBeforeSend = await evaluate(`document.querySelector('.toast')?.textContent.trim() ?? null`)
const userBeforeSend = Number(await evaluate(`document.querySelectorAll('.msg--user').length`))
const assistantBeforeSend = Number(await evaluate(`document.querySelectorAll('.msg--assistant').length`))
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.composer__bar button')].find((b) => b.textContent.includes('发送'))
  btn.click()
  return true
})()`)
console.log('已发送:', JSON.stringify(TEXT))

// ---- 发送真的被受理了吗 -----------------------------------------------------
// 「这个会话已经有任务在执行」之类的弹回不会让发送键报错，消息只是没进去。
// 不卡这一道，后面几分钟全是空跑，还会汇总出一堆缺损指标冒充结论。
{
  let accepted = false
  for (let i = 0; i < 12; i++) {
    await wait(250)
    const s = JSON.parse(
      await evaluate(`JSON.stringify({
        user: document.querySelectorAll('.msg--user').length,
        running: [...document.querySelectorAll('.composer__bar button')].some((b) => b.textContent.includes('停止')),
        toast: document.querySelector('.toast')?.textContent.trim() ?? null
      })`)
    )
    if (s.user > userBeforeSend || s.running) {
      accepted = true
      break
    }
    if (s.toast && s.toast !== toastBeforeSend && /已经有任务在执行/.test(s.toast)) {
      console.error('发送被弹回：' + s.toast)
      ws.close()
      process.exit(1)
    }
  }
  if (!accepted) {
    const toast = await evaluate(`document.querySelector('.toast')?.textContent.trim() ?? null`)
    console.error('发送后 3s 内这一跑没起来，toast=' + JSON.stringify(toast) + '，abort')
    ws.close()
    process.exit(1)
  }
}

// ---- 高频采样器：分清「真落后」和「采样落在两次滚动之间」 -------------------
// 250ms 轮询会把滚动之间的瞬时值当成稳态。60fps 连续采才知道页面到底有没有跟住。
await evaluate(`(() => {
  // 上一次跑装的采样器不会自己停 —— 不先叫停就会有两个采样器往同一个数组里灌，
  // 旧那个字段不全，汇总出来全是缺损值。
  if (window.__flowStop) window.__flowStop()
  const stop = { done: false }
  window.__flowStop = () => { stop.done = true }
  window.__flow = []
  window.__clip = 0
  const scroller = document.querySelector('.chat-scroll')
  const step = () => {
    if (stop.done) return
    const all = document.querySelectorAll('.char-in')
    const now = performance.now()
    // 和 follow.visualBottom 一条规则：只在**最后那条流**里倒着找第一个已起跑的字，
    // 绝不跨块回退。全局找会在尾流整体重排（StreamText 卸载重挂、新流刚起还没起跑）
    // 时掉回上面那个块，复刻出来的目标一次性往上抽几千像素 —— 那是复刻自己在抽，
    // 不是应用在抽，指标全被它带偏。尾流一个字都没起跑就原地不动。
    const tailGroup = all.length > 0 ? all[all.length - 1].parentElement : null
    let last = null
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i]
      if (tailGroup && el.parentElement !== tailGroup) break
      if (Number(el.dataset.revealAt ?? 0) <= now) {
        last = el
        break
      }
    }
    if (scroller) {
      const s = scroller.getBoundingClientRect()
      // 沿 overflow 祖先收口 —— 和 follow.visibleBottom 同一条规则。
      // 思考正文是 320px 的内嵌滚动口，字排在它下面几千像素，原始 rect 是幻影位置：
      // 照它算出来的目标超出可滚范围，量到的「落后」全是假的。
      const clipBottom = (c) => {
        let b = c.getBoundingClientRect().bottom
        let windowed = false
        for (let n = c.parentElement; n && n !== scroller; n = n.parentElement) {
          const cs = getComputedStyle(n)
          if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue
          const nb = n.getBoundingClientRect().bottom
          if (!windowed && (cs.overflowY === 'auto' || cs.overflowY === 'scroll')) {
            b = nb
            windowed = true
          }
          if (b > nb) b = nb
        }
        return b
      }
      // 末梢口径 —— 和 follow.endsInChar 同一条规则。末梢还在冒字就跟显现前沿，
      // 末梢是真内容（工具卡片、静态块）就跟排版底。
      const isBlank = (c) => c.childElementCount === 0 && c.textContent === ''
      const endsInChar = (root) => {
        let n = root
        for (;;) {
          let c = n.lastElementChild
          while (c && !c.classList.contains('char-in') && isBlank(c)) c = c.previousElementSibling
          if (!c) return false
          if (c.classList.contains('char-in')) return true
          n = c
        }
      }
      // 尾流整波都还没起跑：可视底就是当前视口底，原地不动（follow.visualBottom 的兜底）
      const vb = last ? clipBottom(last) : s.top + scroller.clientHeight
      const pb = all.length > 0 ? clipBottom(all[all.length - 1]) : vb
      // 复刻 follow.visualBottom（内容坐标）—— 和循环自己的目标对不上就说明两边有分歧
      const litY = scroller.scrollTop + (vb - s.top)
      const frontY = scroller.scrollTop + (pb - s.top)
      const ends = endsInChar(scroller)
      const visual = ends ? litY : scroller.scrollHeight
      const expect = visual - scroller.clientHeight
      // 「字没出来界面先滚了」的正解：还没显形的占位字（显现前沿到末字之间）
      // 有多少被算进了视口。跟到显现前沿时理应是 0 —— 一旦不是 0，就是滚动
      // 在字前面。末字取**最后一个字**而不是最后一个已显现的，否则未起跑的字
      // 会被当成排版尾巴放过去。
      const viewBottom = scroller.scrollTop + scroller.clientHeight
      const ahead = Math.max(0, Math.min(frontY, viewBottom) - Math.max(litY, scroller.scrollTop))
      // 字到滚动容器之间经过了谁 —— 目标超出可滚范围时，靠这个认出是哪一层裁剪的
      const path = []
      for (let n = (last ?? all[all.length - 1])?.parentElement; n && n !== scroller; n = n.parentElement) {
        path.push(n.className || n.tagName)
      }
      window.__flow.push({
        // 屏幕上的锚：最后一条消息的角色标签。它排在所有流式内容上面，内容往下长
        // 不会挪动它 —— 它的 rect.top 一变，就是肉眼看见的那一块像素在动。
        // 这是「到底闪没闪」的唯一直接判据：scrollTop 变了但锚没动，说明是排版
        // 变矮后的隐形补偿；锚往下跳（rect.top 变大）才是真的抽了一下。
        anchorY:
          [...document.querySelectorAll('.msg__role')].pop()?.getBoundingClientRect().top ?? null,
        gap: s.bottom - vb,
        // 未收口的原始值，用来看裁剪到底吃掉了多少
        rawGap: last ? s.bottom - last.getBoundingClientRect().bottom : null,
        ahead,
        ends,
        top: scroller.scrollTop,
        // 显现前沿的身份。revealAt 一旦定下就不变，拿它当字的身份证：
        // 回跳时身份证变小 = 显现前沿掉回了更早的字 = 真抖；
        // 身份证还在往前走而目标变小 = 上方内容变矮，我们跟着滚，屏幕上纹丝不动。
        litId: last ? Number(last.dataset.revealAt ?? 0) : null,
        h: scroller.scrollHeight,
        expect,
        // 循环自己记的：想滚到哪 / 立刻读回来滚到哪 / 当时的 scrollHeight
        target: Number(scroller.dataset.followTarget),
        applied: Number(scroller.dataset.followApplied),
        height: Number(scroller.dataset.followHeight),
        view: scroller.clientHeight,
        chars: all.length,
        path: path.join(' < '),
        // 目标被钳住时，把每一层的盒子尺寸记下来 —— 认出是哪一层把字裁到滚动盒外
        clip:
          Math.abs(Number(scroller.dataset.followApplied) - Number(scroller.dataset.followTarget)) > 1 &&
          (window.__clip ?? 0) < 2
            ? ((window.__clip = (window.__clip ?? 0) + 1),
              (() => {
                const out = []
                for (let n = last; n; n = n.parentElement) {
                  const b = n.getBoundingClientRect()
                  out.push(
                    (n.className || n.tagName) +
                      '|rect=' + Math.round(b.top) + '..' + Math.round(b.bottom) +
                      '|h=' + Math.round(b.height) +
                      '|sh=' + n.scrollHeight +
                      '|ch=' + n.clientHeight +
                      '|ov=' + getComputedStyle(n).overflowY
                  )
                  if (n === scroller) break
                }
                return out.join('\\n')
              })())
            : null
      })
    }
    if (window.__flow.length < 30000) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
  return true
})()`)

// ---- 把思考块点开：用户报的闪烁就是在「展开」状态下看到的 --------------------
// 思考块默认收起，不点开就永远走不到那条「内嵌滚动口 + 外层跟随」的路径，
// 量出来的全是收起态，把 bug 放过去。只点**最后一个**（正在流式的那个），
// 历史里那几十个留着不动，不然整页高度会被撑到没法看。
//
// 同时用 MutationObserver 记一笔「新挂载的思考块是不是默认就开着」——
// 这是「默认关闭」这条需求的判据，靠采样是抓不到挂载那一瞬的。
await evaluate(`(() => {
  if (window.__thinkTimer) clearInterval(window.__thinkTimer)
  window.__thinkSeen = 0
  window.__thinkDefaultOpen = 0
  window.__thinkOpened = 0
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue
        const hits = []
        if (n.classList && n.classList.contains('thinking')) hits.push(n)
        if (n.querySelectorAll) for (const t of n.querySelectorAll('.thinking')) hits.push(t)
        for (const t of hits) {
          window.__thinkSeen++
          if (t.classList.contains('is-open')) window.__thinkDefaultOpen++
        }
      }
    }
  })
  mo.observe(document.body, { childList: true, subtree: true })
  window.__thinkMo = mo
  window.__thinkTimer = setInterval(() => {
    const all = document.querySelectorAll('.thinking')
    const last = all[all.length - 1]
    if (last && !last.classList.contains('is-open')) {
      const b = last.querySelector('.thinking__head')
      if (b) {
        b.click()
        window.__thinkOpened++
      }
    }
  }, 400)
  return true
})()`)

// ---- 静态：CSS 规格必须与设计一致 -------------------------------------------
const cssContract = await evaluate(`(() => {
  const probe = document.createElement('span')
  probe.className = 'char-in'
  probe.textContent = '测'
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  const out = {
    animationName: cs.animationName,
    animationDuration: cs.animationDuration,
    animationTimingFunction: cs.animationTimingFunction,
    animationFillMode: cs.animationFillMode
  }
  probe.remove()

  // 从 CSSOM 里把 char-in 的关键帧读出来，比看 computed 可靠
  let from = null, to = null
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch { continue }
    for (const rule of rules) {
      if (rule instanceof CSSKeyframesRule && rule.name === 'char-in') {
        for (const kf of rule.cssRules) {
          if (kf.keyText === '0%') from = kf.style.cssText
          if (kf.keyText === '100%') to = kf.style.cssText
        }
      }
    }
  }
  out.keyframeFrom = from
  out.keyframeTo = to
  return out
})()`)
console.log('--- CSS 规格 ---')
console.log(JSON.stringify(cssContract, null, 2))

// ---- 轮询到结束或失败 ------------------------------------------------------
const startedAt = Date.now()
let final = null
/** 每一帧采到的「字 → 真实起跑时刻」。跨帧拼起来才有足够样本判断是否依次 */
const waveSamples = []
/** 每一帧采到的「显现前沿 / 滚动位置」。用来逮住波前积压和滚动跑在字前面 */
const flowSamples = []
while (Date.now() - startedAt < TIMEOUT_MS) {
  await wait(250)
  const snap = await evaluate(`(() => {
    const toast = document.querySelector('.toast')
    const fatal = document.querySelector('.banner, .fatal-error')
    const userMsgs = [...document.querySelectorAll('.msg--user, .bubble--user, [data-role="user"]')]
      .map((n) => n.textContent.trim().slice(0, 40))
    const assistant = [...document.querySelectorAll('.msg--assistant, [data-role="assistant"]')]
      .map((n) => n.textContent.trim().slice(0, 40))
    const live = document.querySelectorAll('.live-turn, [data-live]').length
    const toolCards = document.querySelectorAll('.tool-card').length
    const stopBtn = [...document.querySelectorAll('.composer__bar button')].some((b) => b.textContent.includes('停止'))

    // 流式单字的时序：Web Animations API 给的是时间线上的真实起点，
    // 比读 computed animation-delay 可靠（后者是相对各自挂载时刻的）。
    //
    // 按父容器分段：thinking 和正文是两个独立的 StreamText，各有各的波前
    // （不同视觉区域，本来就该各自起浪）。混在一条序列里比会出假阳性。
    const chars = []
    let group = -1
    let lastParent = null
    for (const el of document.querySelectorAll('.char-in')) {
      if (el.parentElement !== lastParent) {
        group++
        lastParent = el.parentElement
      }
      const a = el.getAnimations()[0]
      if (!a || a.startTime == null) continue
      const delay = a.effect?.getTiming?.().delay ?? 0
      // 两个时间源一起采：
      //   planned —— StreamText 排期时写进 data-reveal-at 的绝对时刻
      //   start   —— 浏览器真正起跑（挂载时刻 + delay），可能比 planned 晚几帧
      // 两者都该各自严格递增。planned 乱序 = 调度器的错；start 乱序而 planned 不乱
      // = 挂载抖动，是测量口径问题，不是「字乱序冒出来」。
      chars.push({
        ch: el.textContent,
        delay,
        start: a.startTime + delay,
        planned: Number(el.dataset.revealAt ?? 0),
        group
      })
    }

    // 显现前沿 / 滚动位置。两件事一起看才能逮住「字没出来界面已经往下滚了」：
    //   lagMs        —— 最晚起跑的字还要多久才对焦。按设计必须被钉在 MAX_LAG 内，
    //                    否则就是波前在积压，越流越欠
    //   hiddenTailPx —— 视口底边比最后一个已显现的字低多少。含排版自带的尾巴，
    //                    所以不能直接当判据；要看下面的 aheadPx
    //   aheadPx      —— 视口里塞进了多少「还没显形的字」。滚动若跟着 scrollHeight
    //                    走，这个数会一路涨，这才是「字没出来界面先滚了」
    const scroller = document.querySelector('.chat-scroll')
    let flow = null
    if (scroller) {
      const now = performance.now()
      const all = [...document.querySelectorAll('.char-in')]
      let maxReveal = 0
      for (const el of all) {
        const t = Number(el.dataset.revealAt ?? 0)
        if (t > maxReveal) maxReveal = t
      }
      // 和 follow.visualBottom 一条规则：只在最后那条流里倒着找，绝不跨块回退。
      // 全局找会在尾流整体重排时掉回上面那个块，量出来的「落后」全是复刻自己抽的。
      const tailGroup = all.length > 0 ? all[all.length - 1].parentElement : null
      let lastRevealed = null
      for (let i = all.length - 1; i >= 0; i--) {
        const el = all[i]
        if (tailGroup && el.parentElement !== tailGroup) break
        if (Number(el.dataset.revealAt ?? 0) <= now) {
          lastRevealed = el
          break
        }
      }
      // 老口径：全局找。留着当对照组，数一数它有多少帧会掉回上面的块
      let globalLit = null
      for (const el of all) if (Number(el.dataset.revealAt ?? 0) <= now) globalLit = el
      // 沿 overflow 祖先收口的「看得见的底」。不收口会量到幻影位置：思考正文
      // 是 320px 的内嵌滚动口，窗口外的字 rect 落在 scrollHeight 之下。
      // 路上撞见内嵌滚动口（overflow-y: auto|scroll）就直接以它的底为准 ——
      // 滚动口对上层是一扇窗，外层该看的是窗框，不是窗里那个会随内层滚动挪的字。
      const clipBottom = (c) => {
        let b = c.getBoundingClientRect().bottom
        let windowed = false
        for (let n = c.parentElement; n && n !== scroller; n = n.parentElement) {
          const cs = getComputedStyle(n)
          if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue
          const nb = n.getBoundingClientRect().bottom
          if (!windowed && (cs.overflowY === 'auto' || cs.overflowY === 'scroll')) {
            b = nb
            windowed = true
          }
          if (b > nb) b = nb
        }
        return b
      }
      const isBlank = (c) => c.childElementCount === 0 && c.textContent === ''
      const endsInChar = (root) => {
        let n = root
        for (;;) {
          let c = n.lastElementChild
          while (c && !c.classList.contains('char-in') && isBlank(c)) c = c.previousElementSibling
          if (!c) return false
          if (c.classList.contains('char-in')) return true
          n = c
        }
      }
      // 复刻 follow.visualBottom 的规则，和实际 scrollTop 对照。
      // 对得上 → 规则本身量偏了；对不上 → 应用根本没按规则滚。
      let expectedScrollTop = null
      let tail = null
      let ahead = null
      let oldBias = null
      if (all.length > 0) {
        const sRect = scroller.getBoundingClientRect()
        // 尾流整波都还没起跑：可视底就是当前视口底，原地不动
        const lb = lastRevealed ? clipBottom(lastRevealed) : sRect.top + scroller.clientHeight
        const pb = clipBottom(all[all.length - 1])
        const litY = scroller.scrollTop + (lb - sRect.top)
        const frontY = scroller.scrollTop + (pb - sRect.top)
        const visual = endsInChar(scroller) ? litY : scroller.scrollHeight
        expectedScrollTop = visual - scroller.clientHeight
        tail = sRect.bottom - lb
        // 「字没出来界面先滚了」的正解：还没显形的占位字（显现前沿到末字之间）
        // 有多少被算进了视口。跟到显现前沿时理应是 0 —— 一旦不是 0，
        // 就是滚动跑在字前面了。末字取**最后一个字**而不是最后一个已显现的，
        // 否则未起跑的字会被当成排版尾巴放过去。
        const viewBottom = scroller.scrollTop + scroller.clientHeight
        ahead = Math.max(0, Math.min(frontY, viewBottom) - Math.max(litY, scroller.scrollTop))
        // 老口径会把目标定到哪。和新口径一比，就知道「跨块回退」那一刀买回了多少像素
        if (globalLit) {
          const oldLitY = scroller.scrollTop + (clipBottom(globalLit) - sRect.top)
          oldBias = oldLitY - scroller.clientHeight - expectedScrollTop
        }
      }
      flow = {
        overflowing: scroller.scrollHeight > scroller.clientHeight,
        pending: maxReveal > now,
        lagMs: maxReveal > 0 ? maxReveal - now : 0,
        hiddenTailPx: tail,
        aheadPx: ahead,
        ruleGapPx:
          expectedScrollTop == null ? null : scroller.scrollTop - expectedScrollTop,
        // 老口径比新口径多抽走的像素。正数 = 老口径把目标定得更靠下
        oldBias,
        // 老口径（全局找最后一个已起跑的字）会落在哪条流上。不是最后那条流，
        // 就是「跨块回退」那一帧 —— 目标会一次性往上抽几千像素，正是上下闪烁。
        // 新口径只在最后那条流里找，这些帧它按住不动。这里数一数老口径会错多少帧。
        sameBlock: globalLit ? globalLit.parentElement === tailGroup : null,
        scrollTop: scroller.scrollTop
      }
    }

    return {
      toast: toast?.textContent.trim() ?? null,
      fatal: fatal?.textContent.trim() ?? null,
      userMsgCount: userMsgs.length,
      assistantCount: assistant.length,
      live,
      toolCards,
      running: stopBtn,
      flow,
      chars
    }
  })()`)
  if (snap.chars.length > 1) waveSamples.push(snap.chars)
  if (snap.flow) flowSamples.push(snap.flow)
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  process.stdout.write(
    `\r[${elapsed}s] running=${snap.running} user=${snap.userMsgCount} assistant=${snap.assistantCount} live=${snap.live} chars=${snap.chars.length}${snap.toast ? ' toast=' + snap.toast : ''}   `
  )

  if (snap.fatal) {
    final = { outcome: 'FATAL', snap }
    break
  }
  if (snap.toast && snap.toast !== toastBeforeSend && /失败|错误|cannot|Error|已经有任务在执行/i.test(snap.toast)) {
    final = { outcome: 'ERROR_TOAST', snap }
    break
  }
  // 这一轮真的新增了消息、且已回到静止 → 成功。
  // 必须按**这一轮**新增的量判：历史一大把时，发送被弹回也会立刻满足
  // 「有用户消息、有助手消息」，整轮空跑还报 OK。
  if (
    !snap.running &&
    snap.userMsgCount > userBeforeSend &&
    snap.assistantCount > assistantBeforeSend
  ) {
    final = { outcome: 'OK', snap }
    break
  }
}
console.log()

if (!final) final = { outcome: 'TIMEOUT' }

// ---- 落库确认 --------------------------------------------------------------
const persisted = await evaluate(`(async () => {
  const s = await window.agent.listConversations()
  const active = s[0]
  if (!active) return null
  const msgs = await window.agent.getMessages(active.id)
  return {
    conversationId: active.id,
    title: active.title,
    messageCount: msgs.length,
    roles: msgs.map((m) => m.role),
    blockTypes: msgs.map((m) => m.blocks.map((b) => b.type).join('+'))
  }
})()`)

console.log('--- 结果 ---')
console.log('outcome:', final.outcome)
if (final.snap) {
  const { chars: _chars, ...rest } = final.snap
  console.log('终态:', JSON.stringify(rest, null, 2))
}

// ---- 流式时序：必须「依次显现」 --------------------------------------------
// 判据：同一条流里，DOM 顺序（= 全文下标顺序）的字，起跑时刻必须严格递增。
// 两个时间源分开判 —— 挂载抖动会让真实起跑（start）在极小错峰下偶有交叠，
// 那不是「字乱序冒出来」；真正要守的是排期（planned）的严格递增。
let waveOk = true
const waveReport = []
const inversionDetail = []
for (let f = 0; f < waveSamples.length; f++) {
  const chars = waveSamples[f]
  // 按父容器分组后各自判断 —— 不同流的波前互不相干
  const byGroup = new Map()
  for (const c of chars) {
    if (!byGroup.has(c.group)) byGroup.set(c.group, [])
    byGroup.get(c.group).push(c)
  }
  for (const [g, seq] of byGroup) {
    if (seq.length < 2) continue
    let plannedInversions = 0
    let startInversions = 0
    let minStartGap = Infinity
    for (let i = 1; i < seq.length; i++) {
      const startGap = seq[i].start - seq[i - 1].start
      const plannedGap = seq[i].planned - seq[i - 1].planned
      if (startGap <= 0) startInversions++
      if (plannedGap <= 0) {
        plannedInversions++
        if (inversionDetail.length < 5) {
          inversionDetail.push({
            frame: f,
            stream: g,
            prev: seq[i - 1],
            next: seq[i],
            plannedGap: Number(plannedGap.toFixed(2))
          })
        }
      }
      if (startGap < minStartGap) minStartGap = startGap
    }
    if (plannedInversions > 0) waveOk = false
    waveReport.push({
      frame: f,
      stream: g,
      chars: seq.length,
      plannedInversions,
      startInversions,
      minStartGapMs: minStartGap === Infinity ? null : Number(minStartGap.toFixed(2))
    })
  }
}

console.log('--- 流式时序 ---')
console.log(`采样帧数: ${waveSamples.length}，有效流段: ${waveReport.length}`)
if (waveReport.length === 0) {
  console.log('⚠️  没采到足够的 .char-in 分段 —— 流式没起来，时序无法断言')
  waveOk = false
} else {
  const worstPlanned = waveReport.reduce((a, b) =>
    a.plannedInversions > b.plannedInversions ? a : b
  )
  const startInv = waveReport.reduce((s, r) => s + r.startInversions, 0)
  const smallest = waveReport.reduce((a, b) =>
    (a.minStartGapMs ?? Infinity) < (b.minStartGapMs ?? Infinity) ? a : b
  )
  console.log(
    `排期乱序（判失败）: ${worstPlanned.plannedInversions} 次（第 ${worstPlanned.frame} 帧，流 #${worstPlanned.stream}，${worstPlanned.chars} 字）`
  )
  console.log(`真实起跑交叠（挂载抖动，不判失败）: ${startInv} 次`)
  console.log(`最小相邻真实起跑间隔: ${smallest.minStartGapMs}ms`)
  for (const d of inversionDetail) {
    console.log(
      `  ↳ 帧 ${d.frame} 流 #${d.stream}: 「${d.prev.ch}」planned=${d.prev.planned} → 「${d.next.ch}」planned=${d.next.planned}（差 ${d.plannedGap}ms）`
    )
  }
  console.log(waveOk ? '✅ 严格依次显现' : '❌ 排期出现同时落定/倒序的字')
}

// ---- 显现前沿 / 滚动跟随 ---------------------------------------------------
// 两条独立的病，一起才构成「字没出来界面已经往下滚了」：
//   1. 波前积压 —— 错峰比到货慢时，看不见的字越积越多。判据：任何一帧的
//      「最晚起跑时刻 − 现在」都不得超过 MAX_LAG
//   2. 滚动跑在字前面 —— 视口里塞进了还没显形的字。判据：探出末字的长度
//      减掉排版自带的尾巴（下边距、行盒下降）之后，不得超出一行
//
//      不能直接拿「视口探出末字多少」当判据：末字下面那截排版尾巴是内容
//      自己的一部分，本来就该露出来（实测有 44px）。把它算成「跑在字前面」
//      会一直误报。真正的病是占位文字（opacity:0 的 span）被算进了视口。
//
// MAX_LAG 必须和 src/renderer/src/components/wave.ts 里的同名常量一致。
const MAX_LAG = 240
const LINE_SLACK_PX = 24
// 「上下闪烁」的容忍度：流式跟随时页面整体往下走，往回跳超过一行的 1/3 就是肉眼可见的抖。
// 算法算出来的目标（target）单帧回跳过这个数，就是在两种口径之间来回切。
const FLICKER_PX = 8

let flowOk = true
const followFrames = flowSamples.filter((f) => f.overflowing && f.pending)
const maxLag = flowSamples.reduce((m, f) => Math.max(m, f.lagMs), 0)
const maxTail = followFrames.reduce((m, f) => Math.max(m, f.hiddenTailPx ?? 0), 0)
const maxAhead = flowSamples.reduce((m, f) => Math.max(m, f.aheadPx ?? 0), 0)

console.log('--- 显现前沿 / 滚动跟随 ---')
console.log(`采样帧数: ${flowSamples.length}，其中「有字待显现且内容撑高」: ${followFrames.length}`)
console.log(`最晚起跑时刻距采样时刻: ${maxLag.toFixed(1)}ms（上限 ${MAX_LAG}ms）`)
console.log(`视口探出末字最多 ${maxTail.toFixed(1)}px（其中排版尾巴属正常）`)
console.log(`视口里塞进的「还没显形的字」最多 ${maxAhead.toFixed(1)}px（上限 ${LINE_SLACK_PX}px）`)
const ruleGaps = followFrames.map((f) => f.ruleGapPx).filter((v) => v != null)
if (ruleGaps.length > 0) {
  const sorted = [...ruleGaps].sort((a, b) => a - b)
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  const worst = ruleGaps.reduce((a, b) => (Math.abs(a) > Math.abs(b) ? a : b))
  const worstAt = followFrames.findIndex((f) => f.ruleGapPx === worst)
  console.log(
    `相对「看得见的底」的位置分布: 最落后 ${sorted[0].toFixed(0)}px / p50 ${q(0.5).toFixed(0)}px / p90 ${q(0.9).toFixed(0)}px / 最超前 ${sorted[sorted.length - 1].toFixed(0)}px`
  )
  console.log(`  最偏离一帧落在第 ${worstAt}/${followFrames.length} 个采样（0 = 刚起步）`)
}
const wrongBlock = followFrames.filter((f) => f.sameBlock === false)
console.log(
  `老口径（全局找）会跨块回退的帧: ${wrongBlock.length}/${followFrames.length} 帧` +
    `；新口径只在最后那条流里找，这些帧按住不动`
)
if (wrongBlock.length > 0) {
  const biases = wrongBlock.map((f) => f.oldBias).filter((v) => v != null)
  if (biases.length > 0) {
    console.log(
      `  那些帧上老口径会把目标抽走: ${Math.min(...biases).toFixed(0)} ~ ${Math.max(...biases).toFixed(0)}px`
    )
  }
}

if (flowSamples.length === 0) {
  console.log('⚠️  没采到 .char-in —— 流式没起来，无法断言')
  flowOk = false
}
if (maxLag > MAX_LAG + 80) {
  // 80ms 留给采样与调度之间的帧抖动
  console.log(`❌ 显现前沿落后 ${maxLag.toFixed(1)}ms —— 波前在积压，字会越流越欠`)
  flowOk = false
} else {
  console.log('✅ 显现前沿被钉在 MAX_LAG 内')
}
if (followFrames.length === 0) {
  console.log('⚠️  回复没长到撑出滚动条，滚动跟随这条本次没验上（换个长回复的提示词再跑）')
} else if (maxAhead > LINE_SLACK_PX) {
  console.log(`❌ 视口里塞进了 ${maxAhead.toFixed(1)}px 还没显形的字 —— 滚动跑在字前面了`)
  flowOk = false
} else {
  console.log('✅ 滚动跟着「看得见的底」走，没有跑在字前面')
}

// CSS 规格验收
const cssOk =
  cssContract.animationName === 'char-in' &&
  cssContract.animationDuration === '0.12s' &&
  cssContract.animationFillMode === 'backwards' &&
  /blur\(6px\)/.test(cssContract.keyframeFrom ?? '') &&
  /blur\(0(px)?\)/.test(cssContract.keyframeTo ?? '')
console.log(cssOk ? '✅ CSS 规格符合（120ms / blur 6→0 / backwards）' : '❌ CSS 规格不符')
console.log(
  '  timing-function:',
  cssContract.animationTimingFunction,
  '（应为 cubic-bezier(0.16, 1, 0.3, 1)）'
)

console.log('--- 落库 ---')
console.log(JSON.stringify(persisted, null, 2))

// ---- 60fps 连续采样：区分「真落后」和「采样落在两次滚动之间」 -------------
// 上面的 250ms 轮询只能看稳态。这里按帧连采，能看见每一次滚动本身：
//   真落后   → gap 全程压在很大的负值上，scrollTop 几乎不动
//   采样假象 → gap 在 0 附近振荡（滚动之间短暂掉下去又弹回来），
//              而且 scrollTop 一路在涨
// 汇总在页面里算：几万帧原始数据走 CDP returnByValue 会被截断，字段缺损。
const dense = await evaluate(`(() => {
  const d = window.__flow
  if (!d || d.length < 20) return null
  const q = (arr, p) => {
    const s = arr.filter(Number.isFinite).sort((a, b) => a - b)
    return s.length === 0 ? null : s[Math.min(s.length - 1, Math.floor(p * s.length))]
  }
  const dist = (arr) => ({
    min: arr.filter(Number.isFinite).length ? Math.min(...arr.filter(Number.isFinite)) : null,
    p50: q(arr, 0.5),
    p90: q(arr, 0.9),
    max: arr.filter(Number.isFinite).length ? Math.max(...arr.filter(Number.isFinite)) : null,
    n: arr.filter(Number.isFinite).length
  })
  const steps = d.slice(1).map((x, i) => x.top - d[i].top)
  const moved = steps.filter((v) => Math.abs(v) > 0.5).length
  // 「上下闪烁」：流式跟随时页面整体是往下走的，往回走的每一帧都是闪。
  // target 那路是纯算法算出来的目标（不受滚动锚定/重排噪声影响），
  // 它抖就是公式本身在两种口径之间来回切 —— 正是「思考块离视口底的距离一直在闪烁」。
  const back = (arr) => {
    const ups = arr.slice(1).map((x, i) => arr[i] - x).filter((v) => v > 0.5)
    return {
      n: ups.length,
      total: ups.reduce((a, b) => a + b, 0),
      max: ups.length ? Math.max(...ups) : 0
    }
  }
  // 「算错了」vs「滚对了又被推回来」：
  //   target − expect   循环的目标 vs 复刻算法的目标。≠0 → 两边算法有分歧
  //   applied − target  设完立刻读回的差。≠0 → 浏览器当场就钳了
  //   top    − applied  下一帧实况。≠0 → 滚完之后被滚动锚定/布局推走了
  const worst = d
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 3)
  // 回跳帧的定性。目标变小有两种，长得一模一样，治法完全相反：
  //   真抖   显现前沿的身份证（revealAt）变小了 —— 掉回了更早的字，页面真的抽了一下。
  //          这是口径在两个块之间来回切，必须修。
  //   补偿   身份证还在往前走，只是上方内容变矮了（段落「毕业」进 Markdown 后排版
  //          更紧）。循环跟着往上滚同样多，屏幕上网格一格不动，肉眼根本看不见。
  //          这不是闪，判它失败只会逼着人去修没病的地方。
  const revs = d
    .map((x, i) => ({
      i,
      delta: i > 0 ? x.target - d[i - 1].target : 0,
      dh: i > 0 ? x.h - d[i - 1].h : 0,
      dAnchor: i > 0 ? x.anchorY - d[i - 1].anchorY : 0,
      litBack: i > 0 && x.litId != null && d[i - 1].litId != null && x.litId < d[i - 1].litId,
      ...x
    }))
    .filter((x) => x.delta < -0.5)
  const jump = (a) => ({
    n: a.length,
    total: a.reduce((s, x) => s - x.delta, 0),
    max: a.length ? Math.max(...a.map((x) => -x.delta)) : 0
  })
  const realBack = jump(revs.filter((x) => x.litBack))
  const compBack = jump(revs.filter((x) => !x.litBack))
  // 肉眼判据。正常跟随时内容整体往屏幕上方走（锚的 rect.top 一路变小），
  // 所以只有**变大**的台阶才是肉眼看得见的抽动。锚一跳，那一块像素就是真的动了。
  const down = (arr) => {
    const ups = arr.slice(1).map((x, i) => x - arr[i]).filter((v) => v > 0.5)
    return {
      n: ups.length,
      total: ups.reduce((a, b) => a + b, 0),
      max: ups.length ? Math.max(...ups) : 0
    }
  }
  const screenJerk = down(d.map((x) => x.anchorY))
  return {
    frames: d.length,
    moved,
    still: d.length - 1 - moved,
    net: d[d.length - 1].top - d[0].top,
    perFrame: steps.reduce((a, b) => a + b, 0) / steps.length,
    gap: dist(d.map((x) => x.gap)),
    rawGap: dist(d.map((x) => x.rawGap)),
    ahead: dist(d.map((x) => x.ahead)),
    targetMinusExpect: dist(d.map((x) => x.target - x.expect)),
    appliedMinusTarget: dist(d.map((x) => x.applied - x.target)),
    topMinusApplied: dist(d.map((x) => x.top - x.applied)),
    chars: dist(d.map((x) => x.chars)),
    // 目标被钳在最大可滚位置的帧数 —— 说明算出来的目标跑出滚动盒了
    clamped: d.filter((x) => Math.abs(x.applied - x.target) > 1).length,
    // 上下闪烁：往回走的次数 / 总位移 / 单帧最大回跳
    topBack: back(d.map((x) => x.top)),
    targetBack: back(d.map((x) => x.target)),
    // 末梢口径分布 —— 一直为 true 说明尾部始终在冒字，中途翻成 false 是
    // 真内容（工具卡片）接管，属正常
    ends: d.filter((x) => x.ends).length,
    // 往回跳的每一帧都摊开：到底是哪个字被当成了「显现前沿」。
    realBack,
    compBack,
    screenJerk,
    reversals: revs
      .map((x) => ({
        i: x.i,
        delta: Math.round(x.delta),
        dh: Math.round(x.dh),
        dAnchor: Math.round(x.dAnchor),
        litBack: x.litBack,
        target: Math.round(x.target),
        top: Math.round(x.top),
        chars: x.chars,
        ends: x.ends,
        path: x.path
      }))
      .slice(0, 12),
    paths: Object.entries(
      d.reduce((m, x) => ((m[x.path] = (m[x.path] ?? 0) + 1), m), {})
    ).sort((a, b) => b[1] - a[1]),
    clips: d.filter((x) => x.clip).map((x) => x.clip),
    worst: worst.map((w) => ({
      i: w.i,
      gap: w.gap,
      top: w.top,
      expect: w.expect,
      target: w.target,
      applied: w.applied,
      height: w.height,
      view: w.view,
      chars: w.chars,
      path: w.path
    }))
  }
})()`)

if (!dense) {
  console.log('⚠️  高频采样没采到足够帧，跳过')
} else {
  const f = (v) => (v == null ? 'n/a' : v.toFixed(0))
  const show = (name, s) =>
    console.log(
      `  ${name}: 最小 ${f(s.min)}px / p50 ${f(s.p50)}px / p90 ${f(s.p90)}px / 最大 ${f(s.max)}px（${s.n} 帧有效）`
    )
  console.log('--- 60fps 连续采样 ---')
  console.log(
    `帧数 ${dense.frames}，scrollTop 动了 ${dense.moved} 帧、没动 ${dense.still} 帧；总位移 ${f(dense.net)}px，平均每帧 ${dense.perFrame.toFixed(2)}px`
  )
  show('gap（视口底 − 看得见的底，已收口）', dense.gap)
  show('  ↳ 未收口的原始字底', dense.rawGap)
  show('视口里塞进的「还没显形的字」', dense.ahead)
  console.log('--- 目标诊断 ---')
  show('循环目标 − 复刻目标', dense.targetMinusExpect)
  show('设完读回 − 目标', dense.appliedMinusTarget)
  show('下一帧实况 − 读回', dense.topMinusApplied)
  show('屏上 .char-in 数', dense.chars)
  console.log(`  目标被钳在最大可滚位置: ${dense.clamped}/${dense.frames} 帧`)
  console.log(
    `  上下闪烁（往回走）: 实况 ${dense.topBack.n} 次 / 共 ${f(dense.topBack.total)}px / 单帧最大 ${f(dense.topBack.max)}px` +
      `；算法目标 ${dense.targetBack.n} 次 / 共 ${f(dense.targetBack.total)}px / 单帧最大 ${f(dense.targetBack.max)}px`
  )
  console.log(
    `  ↳ 其中真抖（显现前沿掉回更早的字）: ${dense.realBack.n} 次 / 共 ${f(dense.realBack.total)}px / 单帧最大 ${f(dense.realBack.max)}px` +
      `；隐形补偿（上方变矮，跟着滚，屏幕不动）: ${dense.compBack.n} 次 / 共 ${f(dense.compBack.total)}px / 单帧最大 ${f(dense.compBack.max)}px`
  )
  console.log(
    `  ↳ 肉眼判据（屏幕上的锚往下跳才算闪）: ${dense.screenJerk.n} 次 / 共 ${f(dense.screenJerk.total)}px / 单帧最大 ${f(dense.screenJerk.max)}px`
  )
  console.log(`  末梢还在冒字的帧: ${dense.ends}/${dense.frames}`)
  if (dense.reversals.length > 0) {
    console.log('  回跳帧（target 变小的那一刻，被当成显现前沿的字挂在谁下面）:')
    for (const r of dense.reversals) {
      console.log(
        `    帧 ${r.i}: target ${r.delta}px → ${r.target}  ΔscrollHeight=${r.dh}px  Δ屏幕锚=${r.dAnchor}px  ` +
          `${r.litBack ? '🔴 真抖' : '⚪ 补偿'}  top=${r.top} chars=${r.chars} ends=${r.ends}`
      )
      console.log(`      path: ${r.path}`)
    }
  }
  if (dense.clips.length > 0) {
    console.log('--- 被钳帧的逐层盒子（top..bottom | h | scrollHeight | clientHeight | overflow-y）---')
    for (const c of dense.clips) {
      console.log(c.split('\n').map((l) => '  ' + l).join('\n'))
      console.log('  ---')
    }
  }
  console.log('  已显现字的挂载路径（帧数）:')
  for (const [p, n] of dense.paths.slice(0, 6)) console.log(`    ${n} × ${p}`)
  console.log('--- 最差 3 帧 ---')
  for (const w of dense.worst) {
    console.log(
      `  帧 ${w.i}: gap=${f(w.gap)} top=${f(w.top)} expect=${f(w.expect)} target=${f(w.target)} applied=${f(w.applied)} height=${f(w.height)} view=${f(w.view)} chars=${w.chars}`
    )
    console.log(`    path: ${w.path}`)
  }
  // 高频那路是主判据：250ms 采样会漏掉 delta 边界上只持续一帧的瞬态
  if ((dense.ahead.max ?? 0) > LINE_SLACK_PX) {
    console.log(`❌ 高频采样：视口里塞进了 ${dense.ahead.max.toFixed(1)}px 还没显形的字`)
    flowOk = false
  }
  // 「上下闪烁」两道判据，都得过：
  //   真抖     显现前沿掉回更早的字 —— 公式在两种口径之间来回切，必须修
  //   肉眼判据 屏幕上的锚往下跳 —— 不管什么原因，那块像素真的动了
  // 隐形补偿（上方内容变矮，循环跟着滚）屏幕上纹丝不动，判它失败是逼人修没病的地方。
  if (dense.realBack.max > FLICKER_PX) {
    console.log(
      `❌ 高频采样：显现前沿掉回更早的字，目标单帧往回跳 ${dense.realBack.max.toFixed(1)}px（上下闪烁，上限 ${FLICKER_PX}px）`
    )
    flowOk = false
  } else if (dense.screenJerk.max > FLICKER_PX) {
    console.log(
      `❌ 高频采样：屏幕上的锚单帧往下跳 ${dense.screenJerk.max.toFixed(1)}px（肉眼看得见的抽动，上限 ${FLICKER_PX}px）`
    )
    flowOk = false
  } else {
    console.log(
      `✅ 没有上下闪烁（真抖 ${f(dense.realBack.max)}px / 屏幕锚下跳 ${f(dense.screenJerk.max)}px，上限 ${FLICKER_PX}px；隐形补偿 ${dense.compBack.n} 次不计）`
    )
  }
}

// ---- 思考块：默认收起，展开态的闪烁上面已经量过 ------------------------------
const think = await evaluate(`(() => {
  if (window.__thinkTimer) clearInterval(window.__thinkTimer)
  if (window.__thinkMo) window.__thinkMo.disconnect()
  return {
    seen: window.__thinkSeen ?? 0,
    defaultOpen: window.__thinkDefaultOpen ?? 0,
    opened: window.__thinkOpened ?? 0,
    stillOpen: document.querySelectorAll('.thinking.is-open').length,
    total: document.querySelectorAll('.thinking').length
  }
})()`)
let thinkOk = true
console.log('--- 思考块 ---')
console.log(
  `  本次新挂载 ${think.seen} 个，其中默认就展开 ${think.defaultOpen} 个；冒烟点开了 ${think.opened} 次`
)
console.log(`  跑完后屏上 ${think.total} 个思考块，还开着的 ${think.stillOpen} 个`)
if (think.seen === 0) {
  console.log('⚠️  本轮没挂出思考块，「默认关闭」这条没验上')
} else if (think.defaultOpen > 0) {
  console.log(`❌ 有 ${think.defaultOpen} 个思考块一挂载就是展开的 —— 违反「默认关闭」`)
  thinkOk = false
} else {
  console.log('✅ 思考块默认关闭，用户点开才展开')
}
if (think.opened === 0) {
  console.log('⚠️  本轮没把思考块点开，展开态的闪烁那条没验上')
}

ws.close()
process.exit(final.outcome === 'OK' && waveOk && flowOk && cssOk && thinkOk ? 0 : 1)
