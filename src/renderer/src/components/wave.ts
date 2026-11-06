/**
 * 流式文字的「对焦波前」调度。
 *
 * 要的视觉是一道连着的浪：相邻字错开约 30ms，每个字用约 120ms 从
 * `blur(6px)` 对焦到清晰。难点在于**字什么时候到不是我们说了算** ——
 * 模型可能一个一个吐，也可能整句整句推。
 *
 * 所以延迟不能按「这一批」算（每批都从 0 起波会碎成一串小闪烁），
 * 也不能按绝对下标算（流得慢时后到的字名义时间全在过去，会一起砸出来）。
 *
 * 用**波前**：下一个字最早能在什么时刻开始对焦。
 * 每个字的起点取 `max(现在, 波前)`，然后把波前推进一个错峰。
 *
 *   逐个到  → 每个字起点 = 现在，延迟 0，跟手
 *   成批到  → 起点依次排开 0, 30, 60…，是一道完整的浪
 *   先慢后快 → 快的那批接着上一个字的波前继续排，不会断层
 *
 * 保证**严格递增**：任意两个字都不会在同一时刻落定，所以永远「依次显现」。
 *
 * 但光有波前还不够 —— 错峰是慢的，到货是快的。模型一秒能吐上百字，
 * 若错峰一律 30ms，一秒最多显现 33 个字，赶不上到达速度，波前就一直往前欠着：
 * 字全都进布局把高度撑起来、滚动跟着跑，人眼却还在看几秒前那段。
 * 所以再加一条**落后上限**（MAX_LAG），见下。
 */

/** 相邻字的错峰间隔上限。流得慢时的「温柔波浪」就按这个基准走。 */
export const STAGGER = 30

/**
 * 显现前沿相对「现在」最多落后多久 —— 这批字从排期到起跑不许拖出这个窗口。
 *
 * 它是错峰的动态预算：`错峰 = min(STAGGER, MAX_LAG / 本批字数)`。
 *
 *   慢流（一次几个字）→ 预算用不完，错峰就是 STAGGER，保持温柔的浪
 *   突发（一次几百字）→ 整波压进 MAX_LAG 扫过去，字还在对焦路上但没被落下
 *
 * 取 240ms 的依据：每个字的对焦动画本身就有 120ms，相邻字高度重叠，
 * 所以压紧了依然连成一道浪，不会退化成「一起砸出来」；同时 240ms 的
 * 未显现文字不超过一行，界面上不会出现「字还没出来就先滚过去」的空档。
 */
export const MAX_LAG = 240

/**
 * 错峰下限。只为守住「严格递增」这条底线 —— 正常碰不到。
 * 真碰到了说明一波字多到不讲道理，宁可稍微超出 MAX_LAG 也不能让字同时落定。
 */
export const MIN_STAGGER = 0.5

export interface WaveState {
  /**
   * 下一个字最早能开始对焦的时刻（performance.now() 同源）。
   * `-1` 表示波还没起。
   */
  front: number
}

export const IDLE_WAVE: WaveState = { front: -1 }

export interface WaveSchedule {
  /** 每个字的 animation-delay，单位 ms，与入参 count 一一对应 */
  delays: number[]
  state: WaveState
}

/**
 * 为刚到的 `count` 个字排期。
 *
 * 纯函数：同样的入参永远出同样的结果。幂等性由调用方用「这个字排过没有」保证，
 * 这里只负责把波往前推。
 *
 * 性质：`delays[count - 1] <= MAX_LAG`（除非被 MIN_STAGGER 顶住）——
 * 一批字的最后一个不许排到 240ms 之后。这条就是「字没有出来界面已经往下滚了」
 * 的回归守卫。
 */
export function advanceWave(state: WaveState, count: number, now: number): WaveSchedule {
  if (count <= 0) return { delays: [], state }

  // 波前已经在跑就接着排，没起波才从现在开始
  const base = Math.max(now, state.front < 0 ? now : state.front)

  // 从 base 起，到 now + MAX_LAG 为止，这是本批能用的总时长。
  // 为负说明波前已经积压过头（理论上不该发生），此时被 MIN_STAGGER 顶住
  // 尽快排空，但顺序绝不能乱 —— 新字插到旧字前面就是「字乱序冒出来」。
  const budget = now + MAX_LAG - base
  const stagger = Math.max(MIN_STAGGER, Math.min(STAGGER, budget / count))

  const delays: number[] = []
  let front = base
  for (let i = 0; i < count; i++) {
    delays.push(front - now)
    front += stagger
  }

  return { delays, state: { front } }
}
