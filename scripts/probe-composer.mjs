/**
 * 输入区状态探针。只读 DOM 断言，不截图（隐私约束）。
 *
 * 用法：node scripts/probe-composer.mjs
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
    throw new Error(
      r.result.exceptionDetails.text +
        ' ' +
        (r.result.exceptionDetails.exception?.description ?? '')
    )
  }
  return r.result?.result?.value
}

// 窗口在后台时 :focus 不生效 —— 这里不测 focus，但要保证布局已渲染
await send('Page.bringToFront')

const report = await evaluate(`(() => {
  const composer = document.querySelector('.composer')
  const hint = document.querySelector('.composer__hint')
  const textarea = document.querySelector('.composer__textarea')
  const bar = document.querySelector('.composer__bar')
  const buttons = [...document.querySelectorAll('.composer__bar button')].map((b) => ({
    text: b.textContent.trim(),
    disabled: b.disabled,
    title: b.title,
    cls: b.className
  }))
  const cs = composer ? getComputedStyle(composer) : null
  return {
    url: location.href,
    ready: !!document.querySelector('.app, .sidebar, #root *'),
    composerClass: composer?.className ?? null,
    hintText: hint?.textContent.trim() ?? null,
    hintClass: hint?.className ?? null,
    hintColor: hint ? getComputedStyle(hint).color : null,
    composerShadow: cs?.boxShadow ?? null,
    textareaDisabled: textarea?.disabled ?? null,
    textareaPlaceholder: textarea?.placeholder ?? null,
    buttons,
    barChildren: bar ? bar.children.length : 0
  }
})()`)

console.log('--- 初始态 ---')
console.log(JSON.stringify(report, null, 2))

// 输入文字后，发送键是否仍被 blocker 压住
await evaluate(`(() => {
  const ta = document.querySelector('.composer__textarea')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '测试一下能不能发送')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await new Promise((r) => setTimeout(r, 150))

const afterType = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('.composer__bar button')].map((b) => ({
    text: b.textContent.trim(),
    disabled: b.disabled
  }))
  return { buttons, hint: document.querySelector('.composer__hint')?.textContent.trim() }
})()`)
console.log('--- 输入后 ---')
console.log(JSON.stringify(afterType, null, 2))

ws.close()
