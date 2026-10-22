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
const TIMEOUT_MS = 60_000

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
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res) => pending.set(id, res))
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

await send('Page.bringToFront')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

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
if (!pre.hasComposer || pre.blocked || pre.running) {
  console.error('前置不满足：输入区不可用/被挡住/正在运行')
  ws.close()
  process.exit(1)
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

await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.composer__bar button')].find((b) => b.textContent.includes('发送'))
  btn.click()
  return true
})()`)
console.log('已发送:', JSON.stringify(TEXT))

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
      chars.push({ ch: el.textContent, delay, start: a.startTime + delay, group })
    }

    return {
      toast: toast?.textContent.trim() ?? null,
      fatal: fatal?.textContent.trim() ?? null,
      userMsgCount: userMsgs.length,
      assistantCount: assistant.length,
      live,
      toolCards,
      running: stopBtn,
      chars
    }
  })()`)
  if (snap.chars.length > 1) waveSamples.push(snap.chars)
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  process.stdout.write(
    `\r[${elapsed}s] running=${snap.running} user=${snap.userMsgCount} assistant=${snap.assistantCount} live=${snap.live} chars=${snap.chars.length}${snap.toast ? ' toast=' + snap.toast : ''}   `
  )

  if (snap.fatal) {
    final = { outcome: 'FATAL', snap }
    break
  }
  if (snap.toast && /失败|错误|cannot|Error/i.test(snap.toast)) {
    final = { outcome: 'ERROR_TOAST', snap }
    break
  }
  // 流式跑起来过、且已回到静止 → 成功
  if (!snap.running && snap.userMsgCount > 0 && snap.assistantCount > 0) {
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
// 判据：同一条流里，DOM 顺序（= 全文下标顺序）的字，真实起跑时刻必须严格递增。
// 旧实现按「这批」算延迟且钳制在 420ms，一批超过 15 个字尾巴就会整块砸下来。
let waveOk = true
const waveReport = []
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
    let inversions = 0
    let minGap = Infinity
    for (let i = 1; i < seq.length; i++) {
      const gap = seq[i].start - seq[i - 1].start
      if (gap <= 0) inversions++
      if (gap < minGap) minGap = gap
    }
    if (inversions > 0) waveOk = false
    waveReport.push({
      frame: f,
      stream: g,
      chars: seq.length,
      inversions,
      minGapMs: minGap === Infinity ? null : Number(minGap.toFixed(2))
    })
  }
}

console.log('--- 流式时序 ---')
console.log(`采样帧数: ${waveSamples.length}，有效流段: ${waveReport.length}`)
if (waveReport.length === 0) {
  console.log('⚠️  没采到足够的 .char-in 分段 —— 流式没起来，时序无法断言')
  waveOk = false
} else {
  const worst = waveReport.reduce((a, b) => (a.inversions > b.inversions ? a : b))
  const smallest = waveReport.reduce((a, b) =>
    (a.minGapMs ?? Infinity) < (b.minGapMs ?? Infinity) ? a : b
  )
  console.log(
    `最大乱序次数: ${worst.inversions}（第 ${worst.frame} 帧，流 #${worst.stream}，${worst.chars} 字）`
  )
  console.log(`最小相邻起跑间隔: ${smallest.minGapMs}ms`)
  console.log(waveOk ? '✅ 严格依次显现' : '❌ 出现同时落定的字（不是依次显现）')
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

ws.close()
process.exit(final.outcome === 'OK' && waveOk && cssOk ? 0 : 1)
