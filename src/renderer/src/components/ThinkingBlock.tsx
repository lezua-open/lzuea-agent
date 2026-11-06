import { useEffect, useRef, useState } from 'react'
import { useFollowToVisualBottom } from './follow'
import { Icon } from './icons'
import { StreamText } from './StreamText'

/**
 * 思考过程折叠块。
 *
 * 展开收起用 `grid-template-rows: 0fr → 1fr`，不去手算高度：
 * 网格行高按内容自适应，`1fr` 在 auto 高度的容器里就等于内容的 max-content，
 * 配合内层 `overflow: hidden` + `min-height: 0` 就能拿到天然可动画的高度。
 * 内容再长也不用测量、不用 ref，改文案也不会算错。
 *
 * 正文被 `max-height` 限成一个内嵌滚动口，所以流式时**它自己得跟到显现前沿**。
 * 不跟的话新字会流到 320px 窗口外面去：外层跟着「字的底」滚，会把这个盒子切一半；
 * 跟着「盒子的底」滚，又是字没出来界面先掉下去。让它跟到底边，两者才重合。
 * 历史消息里是静态的，不接管滚动，一挂载就拽到末尾会让人看不见开头。
 */
export interface ThinkingBlockProps {
  text: string
  /** 尾部文字带对焦动画（流式中） */
  streaming?: boolean
  /** 所在视图是否可见。保活场景下切走时为 false，停掉内嵌滚动跟随省 CPU */
  visible?: boolean
}

export function ThinkingBlock({
  text,
  streaming = false,
  visible = true
}: ThinkingBlockProps): React.JSX.Element {
  // 默认收起。思考过程是可选的旁路信息，不该一开跑就占掉半屏；
  // 想看的人点头一下就能展开，展开后内嵌滚动口自己跟到显现前沿。
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // visible=false 时停转 rAF（视图不可见时没必要跟滚动）
  const follow = useFollowToVisualBottom(bodyRef, streaming && visible)

  // 保险丝：跟随时循环只在还有字在对焦时跑，内容变了再叫一次
  useEffect(() => {
    follow.rearm()
  }, [text, follow])

  return (
    <div className={`thinking${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="thinking__head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Icon name="chevron" size={13} className="thinking__chevron" />
        <span className="thinking__label">{streaming && !open ? '思考中' : '思考过程'}</span>
        {streaming && !open && <span className="thinking__live" role="img" aria-label="正在思考" />}
      </button>
      <div className="thinking__grid">
        <div className="thinking__grid-inner">
          <div
            ref={bodyRef}
            className="thinking__body"
            tabIndex={-1}
            onScroll={follow.handlers.onScroll}
            onWheel={follow.handlers.onWheel}
            onTouchMove={follow.handlers.onTouchMove}
            onPointerDown={follow.handlers.onPointerDown}
            onKeyDown={follow.handlers.onKeyDown}
          >
            <StreamText text={text} animate={streaming} />
          </div>
        </div>
      </div>
    </div>
  )
}
