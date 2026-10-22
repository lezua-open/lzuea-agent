import { useRef, useState, type KeyboardEvent, type ChangeEvent } from 'react'
import { Icon } from './icons'

/**
 * 发送被真正卡住的原因。
 *
 * 为什么不直接传 `disabled: boolean`：灰按钮本身不解释任何事。
 * 「还没输入」和「工作区没配」在旧版里长得一模一样，用户只能猜。
 * 把原因带上，输入区才有能力说清「为什么发不了、怎么解」。
 */
export interface ComposerBlocker {
  /** 一句话说清后果，不要写「不可用」这种空话 */
  reason: string
  /** 可以立刻解决的，给个按钮；解决不了的（例如模型没配）就不给 */
  action?: { label: string; run: () => void }
}

export interface ComposerProps {
  /** 为 null 表示可以发送（还受「必须有内容」约束） */
  blocker: ComposerBlocker | null
  running: boolean
  onSend: (text: string) => void
  onStop: () => void
}

/**
 * 输入区。
 *
 * Enter 发送、Shift+Enter 换行 —— 和主流聊天应用一致；
 * 输入法组合中的回车不能被当成发送，否则中文输入会发一半。
 */
export function Composer({ blocker, running, onSend, onStop }: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  /** 输入法是否正在组合（中文/日文候选期） */
  const composing = useRef(false)

  const blocked = blocker !== null

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed || blocked) return
    onSend(trimmed)
    setText('')
    // 高度回弹
    if (ref.current) ref.current.style.height = 'auto'
  }

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    setText(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (composing.current || e.nativeEvent.isComposing) return
    e.preventDefault()
    submit()
  }

  return (
    <div className="composer-wrap">
      <div className={blocked ? 'composer is-blocked' : 'composer'}>
        <textarea
          ref={ref}
          className="composer__textarea"
          rows={1}
          placeholder="给 Agent 发消息，Enter 发送，Shift+Enter 换行"
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          disabled={running}
        />
        <div className="composer__bar">
          {/* 发不了的时候这里必须说清原因和出路，不能只留一个灰按钮让人猜 */}
          <span className={blocked ? 'composer__hint composer__hint--blocked' : 'composer__hint'}>
            {running
              ? '任务执行中，可随时停止'
              : blocked
                ? blocker.reason
                : '所有文件操作都会先经过确认'}
          </span>

          {blocked && blocker.action && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={blocker.action.run}>
              {blocker.action.label}
            </button>
          )}

          {running ? (
            <button type="button" className="btn btn--danger-ghost" onClick={onStop}>
              <Icon name="stop" size={13} filled />
              停止
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={submit}
              disabled={blocked || text.trim().length === 0}
              title={blocked ? blocker.reason : '发送'}
            >
              <Icon name="send" size={14} />
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
