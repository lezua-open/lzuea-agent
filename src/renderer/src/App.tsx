import { useEffect, useRef, useState } from 'react'
import {
  agentStore,
  useAgentStore,
  type ApprovalState,
  type ToastState
} from './store/agentStore'
import { ApprovalDialog } from './components/ApprovalDialog'
import { ChatView } from './components/ChatView'
import { KeepAlive } from './components/KeepAlive'
import { MemoryPanel } from './components/MemoryPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { Icon } from './components/icons'

/** 退场动画时长（ms）= CSS 里对应动画时长 + 余量 —— 动画没跑完就拔节点会闪一下 */
const TOAST_EXIT_MS = 180
const DIALOG_EXIT_MS = 130

/**
 * 离场保持挂载。present 掉了不要立刻拔节点 —— 退场动画还没播，
 * 硬切就是「啪一下没了」。再留 duration 毫秒把出场跑完再真删。
 */
function usePresence(present: boolean, duration: number): boolean {
  const [mounted, setMounted] = useState(present)
  useEffect(() => {
    if (present) {
      setMounted(true)
      return
    }
    const t = window.setTimeout(() => setMounted(false), duration)
    return () => window.clearTimeout(t)
  }, [present, duration])
  return mounted
}

/**
 * 应用外壳：负责装配视图，不放业务。
 * 所有状态都在 agentStore 里，组件只读不写业务逻辑。
 */
export default function App(): React.JSX.Element {
  const s = useAgentStore()

  useEffect(() => {
    void agentStore.init()
    return () => agentStore.dispose()
  }, [])

  // 提示条 / 审批弹窗的离场保持挂载：变 null 后还要播退场动画，节点晚拔一会儿再真删。
  // 倒计时（含悬停暂停）在 ToastBar 里，不在这。
  const toastMounted = usePresence(s.toast !== null, TOAST_EXIT_MS)
  const lastToast = useRef<ToastState | null>(null)
  if (s.toast) lastToast.current = s.toast

  const approvalMounted = usePresence(s.approval !== null, DIALOG_EXIT_MS)
  const lastApproval = useRef<ApprovalState | null>(null)
  if (s.approval) lastApproval.current = s.approval

  // 主题挂到 <html data-theme>，styles/tokens.css 的 [data-theme='dark'] 块据此接管色阶。
  // 'system' 按系统深浅解析并跟着变（matchMedia 监听）—— 解析规则和主进程
  // resolveTheme 是同一份语义，两边不许各说各话。亮色是 :root 的默认值，配置没到时不会闪黑。
  const themeMode = s.config?.theme
  useEffect(() => {
    if (!themeMode) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.dataset.theme =
        themeMode === 'system' ? (media.matches ? 'dark' : 'light') : themeMode
    }
    apply()
    if (themeMode !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [themeMode])

  if (!s.ready) {
    // 加载屏也得有标题栏 —— 否则启动那几秒窗口既拖不动，右上角按钮还浮在加载屏上
    return (
      <div className="app">
        <TitleBar />
        <div className="splash">
          <div className="splash__spinner" />
          <div>正在启动…</div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <TitleBar />

      <div className="app__body">
        <Sidebar />

        <main className="main">
          {s.fatalError && (
            <div className="banner banner--danger" style={{ margin: '12px 16px 0' }}>
              <span>{s.fatalError}</span>
              <button
                type="button"
                className="banner__close"
                onClick={() => agentStore.dismissFatalError()}
                aria-label="关闭"
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )}

          <KeepAlive active={s.view === 'chat'}>
            <ChatView visible={s.view === 'chat'} />
          </KeepAlive>
          {s.view === 'settings' && <SettingsPanel />}
          {s.view === 'memory' && <MemoryPanel />}
        </main>
      </div>

      {approvalMounted && lastApproval.current && (
        <ApprovalDialog approval={lastApproval.current} leaving={!s.approval} />
      )}

      {toastMounted && lastToast.current && (
        <ToastBar toast={lastToast.current} leaving={!s.toast} />
      )}
    </div>
  )
}

/**
 * toast 条。计时（悬停/聚焦暂停）、动作分发、退场动画都收在这一个组件里：
 * 状态里存的是可序列化的动作描述，回调在这里按 kind 分发，不把函数塞进 store。
 */
function ToastBar({ toast, leaving }: { toast: ToastState; leaving: boolean }): React.JSX.Element {
  const action = toast.action
  // 倒计时贴着渲染处放：暂停/恢复要接 DOM 事件，比抽去全局省一层管道
  const timer = useRef<{ remaining: number; start: number; id: number } | null>(null)

  useEffect(() => {
    if (leaving) return
    const state = { remaining: toast.duration, start: Date.now(), id: 0 }
    state.id = window.setTimeout(() => agentStore.dismissToast(), state.remaining)
    timer.current = state
    return () => {
      window.clearTimeout(state.id)
      timer.current = null
    }
  }, [toast, leaving])

  // 悬停/聚焦暂停倒计时，移开接着走 —— 免得鼠标移向「撤销」的半路提示没了
  const pause = (): void => {
    const t = timer.current
    if (!t) return
    window.clearTimeout(t.id)
    t.remaining = Math.max(0, t.remaining - (Date.now() - t.start))
  }
  const resume = (): void => {
    const t = timer.current
    if (!t) return
    t.start = Date.now()
    t.id = window.setTimeout(() => agentStore.dismissToast(), t.remaining)
  }

  const cls = ['toast']
  if (toast.kind === 'error') cls.push('toast--error')
  if (leaving) cls.push('toast--leaving')

  return (
    <div
      className={cls.join(' ')}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocusCapture={pause}
      onBlurCapture={resume}
    >
      <span>{toast.message}</span>
      {action && (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            if (action.kind === 'undoDeleteMemory') void agentStore.undoDeleteMemory(action.targetId)
            else void agentStore.undoDeleteConversation(action.targetId)
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
