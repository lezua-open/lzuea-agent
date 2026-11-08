import { useEffect, useRef, useState } from 'react'
import { agentStore, useAgentStore, type View } from '../store/agentStore'
import { Icon, type IconName } from './icons'

/** 侧栏宽度偏好：布局习惯，不进配置文件，localStorage 够了 */
const SIDEBAR_W_KEY = 'lzuea.sidebarWidth'
const SIDEBAR_W_MIN = 220
const SIDEBAR_W_MAX = 480

function clampSidebarW(w: number): number {
  return Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, w))
}

const NAV: Array<{ id: View; label: string; icon: IconName }> = [
  { id: 'chat', label: '对话', icon: 'chat' },
  { id: 'settings', label: '设置', icon: 'settings' },
  { id: 'memory', label: '记忆', icon: 'memory' }
]

/**
 * 左侧导航 + 会话列表。
 * 会话标题就地改名（双击 / 铅笔），不弹额外的对话框。
 */
export function Sidebar(): React.JSX.Element {
  const s = useAgentStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [resizing, setResizing] = useState(false)
  const asideRef = useRef<HTMLElement | null>(null)

  // 恢复上次拖出来的宽度（没存过就用 CSS 里的默认值）
  useEffect(() => {
    const raw = window.localStorage.getItem(SIDEBAR_W_KEY)
    const saved = raw === null ? NaN : Number(raw)
    if (Number.isFinite(saved)) {
      document.documentElement.style.setProperty('--sidebar-w', `${clampSidebarW(saved)}px`)
    }
  }, [])

  /** 右缘拖拽：实时改 --sidebar-w，松手记进 localStorage。pointer capture 保证拖出窗口也收得到松手。 */
  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const handle = e.currentTarget
    const aside = asideRef.current
    if (!aside) return
    const startX = e.clientX
    const startW = aside.offsetWidth

    handle.setPointerCapture(e.pointerId)
    setResizing(true)
    document.body.classList.add('is-resizing')

    const onMove = (ev: PointerEvent): void => {
      document.documentElement.style.setProperty(
        '--sidebar-w',
        `${clampSidebarW(startW + ev.clientX - startX)}px`
      )
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('is-resizing')
      setResizing(false)
      window.localStorage.setItem(SIDEBAR_W_KEY, String(aside.offsetWidth))
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  /** 双击拖拽缝 = 回默认宽度（分隔条的平台惯例），记住的宽度一并清掉 */
  const resetWidth = (): void => {
    document.documentElement.style.removeProperty('--sidebar-w')
    window.localStorage.removeItem(SIDEBAR_W_KEY)
  }

  const beginRename = (id: string, title: string): void => {
    setEditingId(id)
    setDraft(title)
  }

  const commitRename = async (): Promise<void> => {
    const id = editingId
    setEditingId(null)
    if (!id) return
    const next = draft.trim()
    if (!next) return
    await agentStore.renameConversation(id, next)
  }

  return (
    <aside className="sidebar" ref={asideRef}>
      <div className="sidebar__body">
        <button
          type="button"
          className="new-chat-btn"
          onClick={() => void agentStore.createConversation()}
        >
          <Icon name="plus" size={13} />
          新建会话
        </button>

        <div className="sidebar__section-label">最近</div>

        {s.conversations.length === 0 ? (
          <div className="empty-inline" style={{ padding: '24px 8px', fontSize: 12 }}>
            还没有会话
          </div>
        ) : (
          s.conversations.map((c) => (
            <div
              key={c.id}
              className={c.id === s.activeId ? 'conv-item is-active' : 'conv-item'}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (editingId !== c.id) void agentStore.selectConversation(c.id)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && editingId !== c.id)
                  void agentStore.selectConversation(c.id)
              }}
              onDoubleClick={() => beginRename(c.id, c.title)}
            >
              {editingId === c.id ? (
                <input
                  className="rename-input"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <span className="conv-item__title">{c.title}</span>
                  <span className="conv-item__actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="重命名"
                      onClick={(e) => {
                        e.stopPropagation()
                        beginRename(c.id, c.title)
                      }}
                    >
                      <Icon name="edit" size={13} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger"
                      title="删除会话"
                      onClick={(e) => {
                        e.stopPropagation()
                        void agentStore.deleteConversation(c.id)
                      }}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </span>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <nav className="sidebar__nav">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={s.view === item.id ? 'nav-item is-active' : 'nav-item'}
            onClick={() => agentStore.setView(item.id)}
          >
            <span className="nav-item__icon">
              <Icon name={item.icon} size={16} />
            </span>
            {item.label}
          </button>
        ))}
      </nav>

      {/* 右缘拖拽缝：按住左右拖，调侧栏宽度 */}
      <div
        className={resizing ? 'sidebar__resizer is-dragging' : 'sidebar__resizer'}
        onPointerDown={startResize}
        onDoubleClick={resetWidth}
      />
    </aside>
  )
}
