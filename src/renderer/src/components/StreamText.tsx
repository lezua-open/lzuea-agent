import { useRef } from 'react'
import { WINDOW } from './streamSplit'
import { advanceWave, IDLE_WAVE, type WaveState } from './wave'

/**
 * 流式文字的「极速高斯模糊 → 对焦」。
 *
 * 每个字单独一个 span，用 `filter: blur(6px) → blur(0)` + 透明度渐显把它「对上焦」，
 * 相邻字错开约 30ms，整体是一道温柔的浪推过去，而不是一串生硬的闪烁。
 *
 * 时序交给 wave.ts 的**波前**调度（那里写清了为什么不能按「这批」或按绝对下标算）。
 * 这里只负责把调度结果落到 DOM 上。四条约束：
 *
 * 1. **只动画新到的字**。已落地的字必须立刻清晰，否则每次 delta 都整段重播，
 *    长回复会一直糊着。
 * 2. **key 用全文的绝对下标**，不是本段内的下标。段落边界越过之后本段会整体缩短、
 *    位移，用段内下标做 key 会让「同一个 key 对应到不同的字」，新字就不播了。
 * 3. **延迟算一次就锁死**。窗口滑动时不许改 style 里的 animation-delay，
 *    否则浏览器会把进行中的动画进度重排，闪一下。
 * 4. **动画区只保留尾部 WINDOW 个字**。否则一篇几千字的回复会有几千个 span，
 *    合成层直接爆掉。前面的字退化成一整段纯文本节点，排版行为完全一致。
 */

export interface StreamTextProps {
  /** 本段文字 */
  text: string
  /** 本段在整条流式文本里的起始下标。key 和延迟都以它为基准换算成绝对位置 */
  startIndex?: number
  /** 为 false 时直接纯文本输出（已落库的历史不需要再播一遍） */
  animate?: boolean
}

export function StreamText({
  text,
  startIndex = 0,
  animate = true
}: StreamTextProps): React.JSX.Element {
  /** 每个字的 animation-delay，算一次就锁死 */
  const delays = useRef(new Map<number, number>())
  /** 波前状态，跨 delta 持续 */
  const wave = useRef<WaveState>(IDLE_WAVE)

  const end = startIndex + text.length
  const windowStart = Math.max(startIndex, end - WINDOW)

  if (animate) {
    // 排期在 render 里做，因为首帧就得带上 animation-delay —— 挪进 effect 会先画一帧
    // 清晰的文字再跳回模糊，正好是「生硬的闪烁」。
    //
    // 幂等性靠 Map 的存在性判断保证：同一个字只排一次，StrictMode 的双调 render
    // 也只会推进一次波前。这是这段代码唯一允许的 render 副作用。
    const fresh: number[] = []
    for (let abs = windowStart; abs < end; abs++) {
      if (!delays.current.has(abs)) fresh.push(abs)
    }

    if (fresh.length > 0) {
      const schedule = advanceWave(wave.current, fresh.length, performance.now())
      fresh.forEach((abs, i) => delays.current.set(abs, schedule.delays[i]))
      wave.current = schedule.state
    }

    // 滑出窗口的字已经变成纯文本，清掉避免长回复下 Map 无限增长
    for (const abs of delays.current.keys()) {
      if (abs < windowStart) delays.current.delete(abs)
    }
  }

  if (!animate) return <>{text}</>

  const head = text.slice(0, windowStart - startIndex)
  const tail = text.slice(windowStart - startIndex)

  return (
    <>
      {head}
      {Array.from(tail).map((ch, k) => {
        const abs = windowStart + k
        return (
          <span
            key={abs}
            className="char-in"
            style={{ animationDelay: `${delays.current.get(abs) ?? 0}ms` }}
          >
            {ch}
          </span>
        )
      })}
    </>
  )
}
