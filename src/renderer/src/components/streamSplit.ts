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
  return { settled: text.slice(0, cut), fresh: text.slice(cut), freshStart: cut }
}
