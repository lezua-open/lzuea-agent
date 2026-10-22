import { useEffect, useMemo, useRef } from 'react'
import type { ToolResultBlock } from '@shared/types'
import { agentStore, useAgentStore } from '../store/agentStore'
import { Composer } from './Composer'
import { LiveTurnView } from './LiveTurn'
import { Message } from './Message'

const EMPTY_HINTS = [
  '读一下 src/index.ts，告诉我它是干什么的',
  '把 README 里的安装步骤整理成一个清单',
  '看看工作区里有哪些 TODO 还没处理'
]

/**
 * 会话主视图。
 *
 * 展示分两层：持久化的 messages（数据库里读回来的）+ 正在流式的 liveTurns。
 * 两者不在同一时刻出现 —— run 结束时 store 会先把 messages 重读一遍再清 liveTurns，
 * 所以不会出现「内容闪一下消失」。
 */
export function ChatView(): React.JSX.Element {
  const s = useAgentStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 用户有没有往上翻；翻了就不再强行拽回底部 */
  const pinned = useRef(true)

  const active = s.conversations.find((c) => c.id === s.activeId)

  // tool_result 存在下一条 user 消息里，这里按 id 对回到 tool_use 上
  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultBlock>()
    for (const m of s.messages) {
      for (const b of m.blocks) {
        if (b.type === 'tool_result') map.set(b.toolUseId, b)
      }
    }
    return map
  }, [s.messages])

  // 内容变化就滚到底；用一个便宜的签名而不是对象身份
  const signature =
    s.messages.length +
    ':' +
    s.liveTurns.map((t) => t.segments.map((x) => (x.kind === 'tool' ? 1 : x.text.length))).join(',')

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [signature])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96
  }

  const send = (text: string): void => {
    pinned.current = true
    void agentStore.send(text)
  }

  return (
    <>
      <header className="chat-header">
        <div className="chat-header__title">{active?.title ?? '新对话'}</div>
        {s.running ? (
          <span className="pill pill--running">
            <span className="pill__dot" />
            执行中
          </span>
        ) : (
          <span className="pill pill--idle">
            <span className="pill__dot" />
            就绪
          </span>
        )}
        {s.config?.workspaceRoot ? (
          <span className="pill pill--idle" title={s.config.workspaceRoot}>
            工作区：{shortPath(s.config.workspaceRoot)}
          </span>
        ) : (
          <span className="pill pill--warning">未选择工作区</span>
        )}
      </header>

      <div ref={scrollRef} className="chat-scroll" onScroll={onScroll}>
        {s.messages.length === 0 && s.liveTurns.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__logo">A</div>
            <h1 className="empty-state__title">开始一个任务</h1>
            <p className="empty-state__hint">
              Agent 可以读写工作区里的文件、执行命令、检索网络，并把关键约定记进长期记忆。
              每一次写入、删除、执行命令都会先弹出确认框。
            </p>
            <div className="empty-state__hints">
              {EMPTY_HINTS.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="empty-hint"
                  onClick={() => send(h)}
                  disabled={s.running}
                >
                  {h}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat-inner">
            {s.messages.map((m) => (
              <Message key={m.id} message={m} toolResults={toolResults} />
            ))}
            {s.liveTurns.map((t) => (
              <LiveTurnView key={t.messageId} turn={t} />
            ))}
          </div>
        )}
      </div>

      <Composer
        blocker={
          s.config?.workspaceRoot
            ? null
            : {
                reason: 'Agent 被限制在工作区目录内读写文件，选好目录才能开始。',
                action: {
                  label: '选择工作区',
                  run: () => void agentStore.pickWorkspace()
                }
              }
        }
        running={s.running}
        onSend={send}
        onStop={() => agentStore.stop()}
      />
    </>
  )
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`
}
