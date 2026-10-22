import { useEffect } from 'react'
import { agentStore, useAgentStore } from './store/agentStore'
import { ApprovalDialog } from './components/ApprovalDialog'
import { ChatView } from './components/ChatView'
import { MemoryPanel } from './components/MemoryPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { Icon } from './components/icons'

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

  useEffect(() => {
    if (!s.toast) return
    // 反馈类提示 2.5 秒后消失。不要拉长 —— 要「欢快地闪一下」，不是常驻通知。
    const t = window.setTimeout(() => agentStore.dismissToast(), 2500)
    return () => window.clearTimeout(t)
  }, [s.toast])

  if (!s.ready) {
    return (
      <div className="splash">
        <div className="splash__spinner" />
        <div>正在启动…</div>
      </div>
    )
  }

  return (
    <div className="app">
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

        {s.view === 'chat' && <ChatView />}
        {s.view === 'settings' && <SettingsPanel />}
        {s.view === 'memory' && <MemoryPanel />}
      </main>

      {s.approval && <ApprovalDialog approval={s.approval} />}

      {s.toast && <div className="toast">{s.toast}</div>}
    </div>
  )
}
