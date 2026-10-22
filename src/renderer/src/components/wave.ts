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
 * 字特别多时压缩错峰（不超过 WAVE_CAP），避免慢动作，但绝不合并。
 */

/** 相邻字的错峰间隔（设计基准）。 */
export const STAGGER = 30

/** 一波最长展开多久。字多时用它反推错峰，保证不拖沓。 */
export const WAVE_CAP = 700

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
 */
export function advanceWave(state: WaveState, count: number, now: number): WaveSchedule {
  if (count <= 0) return { delays: [], state }

  let front = state.front < 0 ? now : state.front

  // 一批里字多就把错峰压小，但始终 > 0 —— 严格递增是「依次显现」的底线
  const stagger = Math.min(STAGGER, WAVE_CAP / count)

  const delays: number[] = []
  for (let i = 0; i < count; i++) {
    const start = Math.max(now, front)
    delays.push(start - now)
    front = start + stagger
  }

  return { delays, state: { front } }
}
