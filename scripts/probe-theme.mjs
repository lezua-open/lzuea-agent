/**
 * 主题色阶探针。只读计算样式断言，不截图（隐私约束）。
 *
 * 校验三件事：
 *   1. 亮色确实是中性米白，且 <html data-theme> 挂对了
 *   2. 切到暗色再切回来，色阶完整跟随、不残留
 *   3. 拨动开关的滑块在两种主题的轨道上都看得见（亮色下 --bg-raised 是纯白，
 *      滑块如果还用白色就会消失 —— 这个坑踩过）
 *
 * 用法：node scripts/probe-theme.mjs
 * 前提：应用已用 --remote-debugging-port=9333 启动。
 */
const PORT = 9333

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

// 窗口在后台时 :focus / 过渡不生效，先把窗口拉到前台
await send('Page.bringToFront')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读当前主题下所有关心的计算样式 */
async function sample(label) {
  const s = await evaluate(`(() => {
    const cs = (sel, prop) => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el)[prop] : null
    }
    const root = getComputedStyle(document.documentElement)

    // 开关的轨道/滑块用临时元素量 —— 当前视图不一定开着设置页，
    // 但 CSS 契约本身是常驻的，注入一个就能读到真实的解析值。
    const probe = document.createElement('button')
    probe.className = 'switch'
    document.body.appendChild(probe)
    const knobTrack = getComputedStyle(probe).backgroundColor
    const knobDot = getComputedStyle(probe, '::after').backgroundColor
    probe.remove()

    return {
      dataTheme: document.documentElement.dataset.theme ?? null,
      colorScheme: root.colorScheme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      sidebarBg: cs('.sidebar', 'backgroundColor'),
      accent: root.getPropertyValue('--accent').trim(),
      onAccent: root.getPropertyValue('--on-accent').trim(),
      hairline: root.getPropertyValue('--hairline').trim(),
      knobTrack,
      knobDot
    }
  })()`)
  return { label, ...s }
}

function show(s) {
  console.log(`--- ${s.label} ---`)
  console.log(JSON.stringify(s, null, 2))
}

const initial = await sample('初始（应为亮色）')
show(initial)

// ---- 断言 1：默认亮色 ------------------------------------------------------
const fails = []
const isRgb = (v, r, g, b) => v === `rgb(${r}, ${g}, ${b})`
if (initial.dataTheme !== 'light') fails.push(`data-theme 应为 light，实际 ${initial.dataTheme}`)
if (initial.colorScheme !== 'light') fails.push(`color-scheme 应为 light，实际 ${initial.colorScheme}`)
// --bg: #f4f4f2
if (!isRgb(initial.bodyBg, 244, 244, 242)) fails.push(`body 背景应为 #f4f4f2，实际 ${initial.bodyBg}`)
// --text: #1f2328
if (!isRgb(initial.bodyColor, 31, 35, 40)) fails.push(`正文色应为 #1f2328，实际 ${initial.bodyColor}`)
if (initial.accent !== '#2f6feb') fails.push(`--accent 应为 #2f6feb，实际 ${initial.accent}`)
if (initial.onAccent !== '#ffffff') fails.push(`--on-accent 应为 #ffffff，实际 ${initial.onAccent}`)

// ---- 断言 2：切到暗色 ------------------------------------------------------
await evaluate(`(() => {
  document.documentElement.dataset.theme = 'dark'
  return true
})()`)
await wait(350) // 色阶切换有过渡，等它落定
const dark = await sample('手动切到暗色')
show(dark)

if (dark.dataTheme !== 'dark') fails.push('切暗色后 data-theme 没跟上')
if (dark.colorScheme !== 'dark') fails.push(`暗色下 color-scheme 应为 dark，实际 ${dark.colorScheme}`)
// --bg: #12161c
if (!isRgb(dark.bodyBg, 18, 22, 28)) fails.push(`暗色 body 背景应为 #12161c，实际 ${dark.bodyBg}`)
if (dark.onAccent !== '#0b0d11') fails.push(`暗色 --on-accent 应为 #0b0d11，实际 ${dark.onAccent}`)

// ---- 断言 3：切回亮色，不留残影 -------------------------------------------
await evaluate(`(() => {
  document.documentElement.dataset.theme = 'light'
  return true
})()`)
await wait(350)
const back = await sample('切回亮色')
if (!isRgb(back.bodyBg, 244, 244, 242)) fails.push(`切回后 body 背景应复原为 #f4f4f2，实际 ${back.bodyBg}`)
if (back.dataTheme !== 'light') fails.push('切回后 data-theme 没复原')

// ---- 断言 4：开关滑块在两种轨道上都要看得见 --------------------------------
// 亮色下关轨是 --switch-off #d5d5d1，滑块 #ffffff —— 明度差必须够
function luminance(rgbStr) {
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(rgbStr ?? '')
  if (!m) return null
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}
const lt = luminance(initial.knobTrack)
const ld = luminance(initial.knobDot)
if (lt == null || ld == null) {
  fails.push(`读不到开关的轨道/滑块色（track=${initial.knobTrack} knob=${initial.knobDot}）`)
} else if (Math.abs(lt - ld) < 0.06) {
  fails.push(
    `开关滑块与轨道明度差只有 ${Math.abs(lt - ld).toFixed(3)}（<0.06），会看不清 —— track=${initial.knobTrack} knob=${initial.knobDot}`
  )
}

console.log('--- 结论 ---')
if (fails.length === 0) {
  console.log('✅ 主题色阶全部符合')
} else {
  console.log(`❌ ${fails.length} 项不符：`)
  for (const f of fails) console.log('   - ' + f)
}

ws.close()
process.exit(fails.length === 0 ? 0 : 1)
