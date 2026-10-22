import { useState } from 'react'
import { agentStore, useAgentStore, type View } from '../store/agentStore'
import { Icon, type IconName } from './icons'

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
    <aside className="sidebar">
      <div className="sidebar__brand">
        <div className="sidebar__logo">A</div>
        <div className="sidebar__title">LZUEA Agent</div>
      </div>

      <div className="sidebar__body">
        <button
          type="button"
          className="new-chat-btn"
          onClick={() => void agentStore.createConversation()}
        >
          <Icon name="plus" size={14} />
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
              <Icon name={item.icon} size={15} />
            </span>
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  )
}
