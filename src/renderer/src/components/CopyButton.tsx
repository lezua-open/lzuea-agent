import { useEffect, useRef, useState } from 'react'
import { agentStore } from '../store/agentStore'
import { Icon } from './icons'

/**
 * 复制按钮。
 *
 * 反馈类动效走「Q 弹」曲线（`--ease-spring`，带回弹），和拖拽/缩放那类
 * 雷厉风行、不许回弹的曲线是两套，不要混用。图标从 copy 弹成 check，
 * 2.5 秒后提示消失（见 App 里的 toast 计时）。
 *
 * 剪贴板先走 `navigator.clipboard`，失败再退回隐藏 textarea + execCommand。
 * 退回这条路不是过度设计：Electron 在非安全上下文下 navigator.clipboard 会是
 * undefined，而这是个桌面工具，复制必须永远能用。
 */
export interface CopyButtonProps {
  text: string
  /** toast 文案，默认「已复制」 */
  label?: string
  className?: string
}

export function CopyButton({
  text,
  label = '已复制',
  className
}: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copy(): Promise<void> {
    const ok = await writeClipboard(text)
    agentStore.showToast(ok ? label : '复制失败，剪贴板不可用')
    if (!ok) return

    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <button
      type="button"
      className={`icon-btn copy-btn${copied ? ' is-copied' : ''}${className ? ` ${className}` : ''}`}
      onClick={() => void copy()}
      title={copied ? '已复制' : '复制'}
      aria-label={copied ? '已复制' : '复制'}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} className="copy-btn__icon" />
    </button>
  )
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到下面的兜底 */
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
