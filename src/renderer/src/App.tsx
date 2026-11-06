import { useEffect } from 'react'
import { agentStore, useAgentStore } from './store/agentStore'
import { ApprovalDialog } from './components/ApprovalDialog'
import { ChatView } from './components/ChatView'
import { KeepAlive } from './components/KeepAlive'
import { MemoryPanel } from './components/MemoryPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
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

  // 主题挂到 <html data-theme>，styles.css 的 [data-theme='dark'] 块据此接管色阶。
  // 亮色是 :root 的默认值，所以配置还没到时也不至于闪黑。
  const theme = s.config?.theme
  useEffect(() => {
    if (!theme) return
    document.documentElement.dataset.theme = theme
  }, [theme])

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

      {s.approval && <ApprovalDialog approval={s.approval} />}

      {s.toast && <div className="toast">{s.toast}</div>}
    </div>
  )
}
