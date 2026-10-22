import { useEffect, useState } from 'react'
import { agentStore, useAgentStore } from '../store/agentStore'

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * 长期记忆面板。
 *
 * v0.1 只提供「查看 / 删除」：写入由 Agent 用 memory_write 工具自己做，
 * 人在这里的职责是清理过时的条目，而不是代笔。
 */
export function MemoryPanel(): React.JSX.Element {
  const s = useAgentStore()
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    void agentStore.refreshMemory()
  }, [])

  return (
    <div className="panel-scroll">
      <div className="panel">
        <div className="panel__header">
          <h2>长期记忆</h2>
          <p>跨会话保留的约定和结论。每次提问时会按相关性召回最相关的几条，拼进系统提示词。</p>
        </div>

        {s.memory.length === 0 ? (
          <div className="empty-inline">
            还没有记忆条目。
            <br />让 Agent「记住……」，或者让它自己调用 memory_write，条目就会出现在这里。
          </div>
        ) : (
          s.memory.map((m) => (
            <article key={m.id} className="memory-item">
              <div className="memory-item__main">
                <div className="memory-item__key">{m.key}</div>
                <p className="memory-item__content">{m.content}</p>
                <div className="memory-item__meta">
                  {m.tags.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                  <span>更新于 {formatTime(m.updatedAt)}</span>
                </div>
              </div>
              <button
                type="button"
                className="btn btn--danger-ghost btn--sm"
                disabled={busyId === m.id}
                onClick={() => {
                  setBusyId(m.id)
                  void agentStore.deleteMemory(m.id).finally(() => setBusyId(null))
                }}
              >
                删除
              </button>
            </article>
          ))
        )}

        <div className="panel__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void agentStore.refreshMemory()}
          >
            刷新
          </button>
        </div>
      </div>
    </div>
  )
}
