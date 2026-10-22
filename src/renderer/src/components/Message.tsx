import { memo } from 'react'
import type { ChatMessage, ToolResultBlock } from '@shared/types'
import { CopyButton } from './CopyButton'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallCard } from './ToolCallCard'

export interface MessageProps {
  message: ChatMessage
  /** toolUseId → 结果块。结果存在下一条 user 消息里，渲染时按 id 对回来 */
  toolResults: Map<string, ToolResultBlock>
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * 一条历史消息。
 *
 * 存储上工具结果是独立的 user 消息（模型要求的 role 顺序），
 * 展示上不该出现「用户说了一段 JSON」—— 所以纯 tool_result 的 user 消息
 * 整条跳过，结果直接并进对应的工具卡片里。
 */
function MessageImpl({ message, toolResults }: MessageProps): React.JSX.Element | null {
  const isUser = message.role === 'user'
  const textBlocks = message.blocks.filter((b) => b.type === 'text' && b.text.trim())
  const resultOnly = isUser && message.blocks.every((b) => b.type === 'tool_result')

  if (resultOnly) return null

  if (isUser) {
    const plain = textBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n\n')
    return (
      <div className="msg msg--user">
        <div className="msg__body">
          <div className="msg__bubble">{plain}</div>
          <div className="msg__timestamp" style={{ textAlign: 'right' }}>
            {formatTime(message.createdAt)}
          </div>
          <div className="msg__actions" style={{ justifyContent: 'flex-end' }}>
            <CopyButton text={plain} label="已复制这条消息" />
          </div>
        </div>
      </div>
    )
  }

  const plain = textBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n\n')

  return (
    <div className="msg msg--assistant">
      <div className="msg__avatar msg__avatar--assistant">A</div>
      <div className="msg__body">
        <div className="msg__role">Agent</div>

        {message.blocks.map((block, i) => {
          switch (block.type) {
            case 'thinking':
              return block.text.trim() ? <ThinkingBlock key={i} text={block.text} /> : null

            case 'text':
              return block.text.trim() ? <Markdown key={i} text={block.text} /> : null

            case 'tool_use':
              return (
                <ToolCallCard
                  key={block.id}
                  model={{
                    id: block.id,
                    name: block.name,
                    input: block.input,
                    risk: block.risk,
                    status: 'done',
                    result: toolResults.get(block.id)?.content,
                    isError: toolResults.get(block.id)?.isError
                  }}
                />
              )

            // 服务端工具产物（web_search 等）：只留个记号，原文不给用户看
            case 'opaque':
              return block.label ? (
                <div key={i} className="status" style={{ marginBottom: 12 }}>
                  · {block.label}
                </div>
              ) : null

            case 'tool_result':
              return null
          }
        })}

        <div className="msg__timestamp">{formatTime(message.createdAt)}</div>
        <div className="msg__actions">
          {plain && <CopyButton text={plain} label="已复制这条回复" />}
        </div>
      </div>
    </div>
  )
}

export const Message = memo(MessageImpl)
