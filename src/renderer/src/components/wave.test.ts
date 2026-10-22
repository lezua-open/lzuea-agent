import { describe, expect, it } from 'vitest'
import { advanceWave, IDLE_WAVE, STAGGER, WAVE_CAP, type WaveState } from './wave'

/**
 * 这套调度是流式观感的地基，专测三条硬性质：
 *
 *  1. 严格递增 —— 任意两个字不同时落定（否则就是「一起砸出来」）
 *  2. 批内连续 —— 成批到货时是一道完整的浪，不是碎波
 *  3. 跨批连续 —— 先慢后快不断层，快的那批接着上一个字的波前排
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
    expect(out.delays[1]).toBe(STAGGER)
    expect(out.delays[19]).toBe(19 * STAGGER)
  })

  it('大批量压缩错峰但仍严格递增 —— 这是「一起砸出来」的回归守卫', () => {
    const out = advanceWave(IDLE_WAVE, 200, 1000)
    expectStrictlyIncreasing(out.delays)
    // 错峰被压到 WAVE_CAP / 200，整波不超过 WAVE_CAP
    expect(out.delays[199]).toBeLessThanOrEqual(WAVE_CAP + 1)
    expect(out.delays[199]).toBeCloseTo(199 * (WAVE_CAP / 200), 5)
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

    expect(first.delays).toEqual([0, 30, 60])
    // 第一批波前推到 1000+60+30 = 1090，早于 1100 → 第二批第一个字立刻起
    expect(second.delays).toEqual([0, 30, 60])
  })

  it('同一批内起点不早于 now，延迟永不为负', () => {
    const first = advanceWave(IDLE_WAVE, 50, 1000)
    // 波前被推到未来；10ms 后再来一批，它们得排队
    const second = advanceWave(first.state, 4, 1010)
    for (const d of second.delays) expect(d).toBeGreaterThanOrEqual(0)
    expectStrictlyIncreasing(second.delays)
  })
})
