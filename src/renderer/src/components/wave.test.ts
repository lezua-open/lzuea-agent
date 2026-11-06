import { describe, expect, it } from 'vitest'
import { advanceWave, IDLE_WAVE, MAX_LAG, MIN_STAGGER, STAGGER, type WaveState } from './wave'

/**
 * 这套调度是流式观感的地基，专测四条硬性质：
 *
 *  1. 严格递增 —— 任意两个字不同时落定（否则就是「一起砸出来」）
 *  2. 批内连续 —— 成批到货时是一道完整的浪，不是碎波
 *  3. 跨批连续 —— 先慢后快不断层，快的那批接着上一个字的波前排
 *  4. 落后有上限 —— 显现前沿相对「现在」不许越欠越多，否则字没出来
 *                   界面已经滚过去了
 */

function expectStrictlyIncreasing(delays: number[]): void {
  for (let i = 1; i < delays.length; i++) {
    expect(delays[i], `第 ${i} 个字的延迟必须大于第 ${i - 1} 个`).toBeGreaterThan(delays[i - 1])
  }
}

describe('advanceWave', () => {
  it('空批不推波前', () => {
    const s: WaveState = { front: 100 }
    const out = advanceWave(s, 0, 500)
    expect(out.delays).toEqual([])
    expect(out.state.front).toBe(100)
  })

  it('首字立刻对焦', () => {
    const out = advanceWave(IDLE_WAVE, 1, 1000)
    expect(out.delays).toEqual([0])
  })

  it('成批到货：一道完整的浪，相邻字错开 STAGGER', () => {
    const out = advanceWave(IDLE_WAVE, 5, 1000)
    expect(out.delays).toEqual([0, STAGGER, 2 * STAGGER, 3 * STAGGER, 4 * STAGGER])
    expectStrictlyIncreasing(out.delays)
  })

  it('逐个到货（流得比错峰慢）：每个字跟手，不排队', () => {
    let state = IDLE_WAVE
    const all: number[] = []
    for (let i = 0; i < 5; i++) {
      // 每 200ms 到一个字 —— 比 30ms 的错峰慢得多
      const out = advanceWave(state, 1, i * 200)
      state = out.state
      all.push(...out.delays)
    }
    expect(all).toEqual([0, 0, 0, 0, 0])
  })

  it('先慢后快：快的那批接着上一个字的波前继续排，不断层', () => {
    // 0~1800ms 逐个到了 10 个字
    let state = IDLE_WAVE
    for (let i = 0; i < 10; i++) {
      state = advanceWave(state, 1, i * 200).state
    }

    // 2000ms 一口气到了 20 个字
    const out = advanceWave(state, 20, 2000)

    // 这批必须是依次的浪，绝不能全是 0
    expectStrictlyIncreasing(out.delays)
    expect(out.delays[0]).toBe(0) // 紧接上一个字，第一个不额外等
    // 但整波不许拖出预算 —— 慢到快的切换不该让字落到屏幕外
    expect(out.delays[19]).toBeLessThanOrEqual(MAX_LAG + 1)
    expect(out.delays[19]).toBeGreaterThan(STAGGER) // 确实排开了，不是压成一点
  })

  it('大批量压缩错峰但仍严格递增 —— 这是「一起砸出来」的回归守卫', () => {
    const out = advanceWave(IDLE_WAVE, 200, 1000)
    expectStrictlyIncreasing(out.delays)
    expect(out.delays[199]).toBeLessThanOrEqual(MAX_LAG + 1)
    // 40 个字（下面那条）和 200 个字都不能出现重复时刻
    expect(new Set(out.delays).size).toBe(out.delays.length)
  })

  it('旧实现的钳制会把尾巴压平 —— 这里不允许', () => {
    // 旧代码：min(k * 30, 420)，第 15 个之后全是 420
    const out = advanceWave(IDLE_WAVE, 40, 1000)
    const distinct = new Set(out.delays)
    expect(distinct.size).toBe(out.delays.length) // 40 个字，40 个不同时刻
  })

  it('波前持续推进：第二批接着第一批的尾巴', () => {
    const first = advanceWave(IDLE_WAVE, 3, 1000)
    // 100ms 后又到 3 个字，此时第一批最后一个字还在对焦（60ms 起，120ms 长）
    const second = advanceWave(first.state, 3, 1100)

    expect(first.delays).toEqual([0, STAGGER, 2 * STAGGER])
    // 第一批波前推到 1000+60+30 = 1090，早于 1100 → 第二批第一个字立刻起
    expect(second.delays).toEqual([0, STAGGER, 2 * STAGGER])
  })

  it('同一批内起点不早于 now，延迟永不为负', () => {
    const first = advanceWave(IDLE_WAVE, 50, 1000)
    // 波前被推到未来；10ms 后再来一批，它们得排队
    const second = advanceWave(first.state, 4, 1010)
    for (const d of second.delays) expect(d).toBeGreaterThanOrEqual(0)
    expectStrictlyIncreasing(second.delays)
  })

  /**
   * 这条是「字没有出来界面已经往下滚了」的直接回归守卫。
   *
   * 旧实现在这里会一路欠下去：错峰只在批内压缩（WAVE_CAP / count），
   * 但波前跨批累积。100 字/秒的流速下，2 秒后显现前沿落后 1 秒多，
   * 越流越远 —— 字全都进了布局，人眼却还在看几秒前那段。
   */
  it('持续快流时显现不许越欠越多：每批末字都在 MAX_LAG 内起跑', () => {
    let state = IDLE_WAVE
    // 100 字/秒：每 30ms 到 3 个字，连跑 3 秒
    for (let i = 0; i < 100; i++) {
      const now = i * 30
      const out = advanceWave(state, 3, now)
      state = out.state

      expectStrictlyIncreasing(out.delays)
      // delays[末] 就是「末字起跑时刻 − 现在」，也就是这批的落后量
      expect(out.delays[2], `第 ${i} 批的落后量必须被钉在 MAX_LAG 内`).toBeLessThanOrEqual(
        MAX_LAG + 1
      )
    }
    // 跑完 3 秒波前也没飘走 —— 停下来后 240ms 内就追平了
    expect(state.front - 99 * 30).toBeLessThanOrEqual(MAX_LAG + 1)
  })

  it('错峰下限只在字多到离谱时顶上来，且仍严格递增', () => {
    const out = advanceWave(IDLE_WAVE, 4000, 1000)
    expectStrictlyIncreasing(out.delays)
    // 4000 * MIN_STAGGER = 2000ms，远超 MAX_LAG —— 宁可超时也不能同时落定
    expect(out.delays[1] - out.delays[0]).toBeCloseTo(MIN_STAGGER, 5)
  })
})
