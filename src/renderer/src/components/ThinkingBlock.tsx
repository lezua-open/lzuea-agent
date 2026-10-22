import { useState } from 'react'
import { Icon } from './icons'
import { StreamText } from './StreamText'

/**
 * 思考过程折叠块。
 *
 * 展开收起用 `grid-template-rows: 0fr → 1fr`，不去手算高度：
 * 网格行高按内容自适应，`1fr` 在 auto 高度的容器里就等于内容的 max-content，
 * 配合内层 `overflow: hidden` + `min-height: 0` 就能拿到天然可动画的高度。
 * 内容再长也不用测量、不用 ref，改文案也不会算错。
 */
export interface ThinkingBlockProps {
  text: string
  /** 流式中默认展开，且尾部文字带对焦动画 */
  defaultOpen?: boolean
  streaming?: boolean
}

export function ThinkingBlock({
  text,
  defaultOpen = false,
  streaming = false
}: ThinkingBlockProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={`thinking${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="thinking__head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Icon name="chevron" size={13} className="thinking__chevron" />
        <span className="thinking__label">思考过程</span>
      </button>
      <div className="thinking__grid">
        <div className="thinking__grid-inner">
          <div className="thinking__body">
            <StreamText text={text} animate={streaming} />
          </div>
        </div>
      </div>
    </div>
  )
}
