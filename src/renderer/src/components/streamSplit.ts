/**
 * 流式段落切分：把「已经能定稿的部分」交给 Markdown，把「正在冒出来的尾巴」交给逐字对焦。
 *
 * 为什么要切：Markdown 解析出来的是完整块级元素，没法对里面的单个字插 span；
 * 而整段都用纯文本又会丢掉代码块、列表、链接。折中是按段落边界切一刀 ——
 * 完成语法的段落走 Markdown，末尾那半句走逐字动画。切在段落边界上，
 * 等它「毕业」进 Markdown 时排版完全对齐，肉眼看不出跳动。
 *
 * 抽成独立的纯模块是为了能脱离 React 单测：切错地方会丢字，
 * 或者把 Markdown 语法拆成两半渲染出原文，这种错肉眼很难盯出来。
 */

/** 尾部动画窗口的字符数。超过这个长度的字不再参与动画，纯文本渲染。 */
export const WINDOW = 320

export interface StreamSplit {
  /** 已定稿、交给 Markdown 的部分 */
  settled: string
  /** 还在冒出来、交给逐字对焦的部分 */
  fresh: string
  /** fresh 在整条文本里的起始下标。逐字 span 的 key 要按它换算成绝对位置 */
  freshStart: number
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff
const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/**
 * 按**码点**走一遍 `text` 从 `from` 起的部分，给出每个字的 UTF-16 起点和字本身。
 *
 * 索引一律走 UTF-16，字本身走码点。emoji 占两个 UTF-16 单元：
 * 按码点下标当 key 会让 key 和排期表的绝对下标错位，每帧都在补漏、波前被白白推走；
 * 按 UTF-16 逐单元切又会把一个字劈成两个乱码方块。
 */
export function codePoints(text: string, from: number): Array<[number, string]> {
  const out: Array<[number, string]> = []
  let k = from
  while (k < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(k) as number)
    out.push([k, ch])
    k += ch.length
  }
  return out
}

/**
 * 切口校正：不许劈开代理对，也不许顶到末尾。
 *
 * emoji 之类占两个 UTF-16 单元，切口正好落在中间，两边各拿到半个字，
 * 渲染出来是两个乱码方块。整个字跟着尾巴走 —— 尾巴才是逐字对焦的那一段。
 *
 * 切口也**不能顶到末尾**。fresh 一空 StreamText 就整个卸载，下一个 delta 又挂回来时
 * 排期表跟着重建，已经对上焦的字会重新糊一遍；更要命的是滚动那边「最后一个
 * 已起跑的字」会短暂掉回上一个块，目标一次性往上抽几千像素 —— 上下闪烁。
 * 所以尾巴至少要留住一个完整的字。
 */
function clampCut(text: string, cut: number): number {
  if (cut >= text.length) {
    let c = text.length - 1
    while (c > 0 && isLowSurrogate(text.charCodeAt(c))) c -= 1
    return c
  }
  if (cut <= 0) return 0
  if (isLowSurrogate(text.charCodeAt(cut)) && isHighSurrogate(text.charCodeAt(cut - 1))) {
    const next = cut + 1
    // 挪完正好顶到末尾 —— 退回两格，把整个字留给定稿段
    return next >= text.length ? cut - 1 : next
  }
  return cut
}

export function splitStreamingText(text: string): StreamSplit {
  if (text.length <= WINDOW) return { settled: '', fresh: text, freshStart: 0 }

  const floor = text.length - WINDOW
  // 优先切在段落空行之后；其次是普通换行；再次是空格。都找不到就硬切在窗口边界，
  // 硬切顶多让一个词被拆成两半分别渲染，不会丢字。
  let cut = -1
  for (const sep of ['\n\n', '\n', ' ']) {
    const idx = text.indexOf(sep, floor)
    if (idx !== -1) {
      cut = idx + sep.length
      break
    }
  }
  if (cut === -1) cut = floor
  cut = clampCut(text, cut)
  return { settled: text.slice(0, cut), fresh: text.slice(cut), freshStart: cut }
}
