import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TITLEBAR_H, WINDOW_PALETTE } from './window-chrome'

/**
 * 窗口外框配色的**镜像一致性**。
 *
 * 标题栏的颜色要在两个进程各存一份：渲染进程从 styles.css 的设计令牌取，
 * 主进程（window-chrome.ts）读不到 CSS 变量，只能抄一份色值去配右上角的
 * 原生窗口按钮。抄的那份一旦和 CSS 对不上，症状是「按钮浮着一块突兀的底」——
 * 肉眼才看得出来，代码里看不出任何错。
 *
 * 所以这里反过来拿 styles.css 核那张表：对不上就红，不用等人盯着屏幕发现。
 */

const stylesPath = fileURLToPath(new URL('../renderer/src/styles.css', import.meta.url))

/**
 * 取一条规则的声明块。
 *
 * 选择器要**整词 + 后面紧跟 `{`** 才算命中 —— 不能用裸 indexOf：
 * styles.css 文件头的注释里就写着 `:root` 和 `[data-theme='dark']`，
 * 光找子串会先撞上注释，然后把后面那条规则（`:root`）当成暗色块，
 * 于是「暗色镜像一致」会假绿。
 */
function ruleOf(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|[}\\s,])${escaped}\\s*{`).exec(css)
  if (!m) throw new Error(`styles.css 里找不到 ${selector} 规则`)
  return braceBlock(css, css.indexOf('{', m.index), selector)
}

function braceBlock(css: string, open: number, what: string): string {
  if (open < 0) throw new Error(`${what} 后面没有 {`)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  throw new Error(`${what} 的花括号没配对`)
}

/** 取一个声明的值，顺手剥掉尾随注释（`--bg: #f4f4f2; /* 画布 *\/` → `#f4f4f2`） */
function decl(block: string, name: string): string {
  // 前面必须是块首 / 分号 / 空白 —— 否则 `--bg` 会误抓 `--bg-sunken`
  const m = new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+);`).exec(block)
  if (!m) throw new Error(`找不到声明 ${name}`)
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim()
}

/** `#ebebe8` → `rgb(235, 235, 232)`，和 getComputedStyle 的口径一致 */
function hexToRgb(hex: string): string {
  const h = hex.trim().replace(/^#/, '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`不是十六进制色值：${hex}`)
  const n = Number.parseInt(full, 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

describe('window-chrome：主进程的色表是 styles.css 的镜像', () => {
  const css = readFileSync(stylesPath, 'utf8')
  const light = ruleOf(css, ':root')
  const dark = ruleOf(css, "[data-theme='dark']")

  it('亮色三档都能在 :root 里找到同值', () => {
    expect(hexToRgb(WINDOW_PALETTE.light.canvas)).toBe(hexToRgb(decl(light, '--bg')))
    expect(hexToRgb(WINDOW_PALETTE.light.chrome)).toBe(hexToRgb(decl(light, '--bg-sunken')))
    expect(hexToRgb(WINDOW_PALETTE.light.ink)).toBe(hexToRgb(decl(light, '--text-muted')))
  })

  it('暗色三档都能在 [data-theme=dark] 里找到同值', () => {
    expect(hexToRgb(WINDOW_PALETTE.dark.canvas)).toBe(hexToRgb(decl(dark, '--bg')))
    expect(hexToRgb(WINDOW_PALETTE.dark.canvas)).not.toBe(hexToRgb(WINDOW_PALETTE.dark.chrome))
    expect(hexToRgb(WINDOW_PALETTE.dark.chrome)).toBe(hexToRgb(decl(dark, '--bg-sunken')))
    expect(hexToRgb(WINDOW_PALETTE.dark.ink)).toBe(hexToRgb(decl(dark, '--text-muted')))
  })

  it('标题栏高度对齐 --titlebar-h', () => {
    expect(TITLEBAR_H).toBe(parseFloat(decl(light, '--titlebar-h')))
  })

  it('标题栏和侧栏取同一个令牌（右上角按钮也必须是这个色）', () => {
    // 用户要的就是这两块同色。它们同源 --bg-sunken，主进程按钮底色取 chrome ——
    // 三处同源，才不会出现「标题栏和侧栏一个色、按钮却是另一色」。
    expect(decl(ruleOf(css, '.titlebar'), 'background')).toBe('var(--bg-sunken)')
    expect(decl(ruleOf(css, '.sidebar'), 'background')).toBe('var(--bg-sunken)')
    expect(hexToRgb(WINDOW_PALETTE.light.chrome)).toBe(hexToRgb(decl(light, '--bg-sunken')))
    expect(hexToRgb(WINDOW_PALETTE.dark.chrome)).toBe(hexToRgb(decl(dark, '--bg-sunken')))
  })
})
