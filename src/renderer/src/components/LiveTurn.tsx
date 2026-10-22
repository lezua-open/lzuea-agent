import type { LiveTurn } from '../store/agentStore'
import { Markdown } from './Markdown'
import { splitStreamingText } from './streamSplit'
import { StreamText } from './StreamText'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallCard } from './ToolCallCard'

/**
 * 正在流式生成的这一轮。
 *
 * 和 Message 的区别：内容是事件增量拼出来的，还没有落库，
 * 所以不能走 ContentBlock 渲染，而是走 LiveSegment。
 * run 结束后 store 会整体重读数据库，这个组件随之被 Message 取代。
 */
export function LiveTurnView({ turn }: { turn: LiveTurn }): React.JSX.Element {
  return (
    <div className="msg msg--assistant">
      <div className="msg__avatar msg__avatar--assistant">A</div>
      <div className="msg__body">
        <div className="msg__role">Agent</div>

        {turn.segments.map((seg, i) => {
          switch (seg.kind) {
            case 'thinking':
              return (
                <ThinkingBlock
                  key={i}
                  text={seg.text}
                  defaultOpen
                  streaming={turn.status === 'streaming'}
                />
              )

            case 'text':
              return (
                <div key={i}>
                  <StreamingMarkdown text={seg.text} />
                  {turn.status === 'streaming' && i === turn.segments.length - 1 && (
                    <span className="caret" />
                  )}
                </div>
              )

            case 'tool':
              return (
                <ToolCallCard
                  key={seg.tool.toolCallId}
                  model={{
                    id: seg.tool.toolCallId,
                    name: seg.tool.name,
                    input: seg.tool.input,
                    risk: seg.tool.risk,
                    status: seg.tool.status,
                    result: seg.tool.result,
                    isError: seg.tool.isError,
                    partialJson: seg.tool.jsonBuffer
                  }}
                />
              )
          }
        })}

        {turn.segments.length === 0 && turn.status === 'streaming' && (
          <div className="status status--running">
            <span className="spinner-inline" />
            正在思考…
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 流式中的 Markdown。
 *
 * 已经定稿的部分交给 Markdown 解析（保住代码块、列表、链接），
 * 还在冒出来的尾巴交给 StreamText 逐字对焦。切口落在段落/空白边界上，
 * 尾巴「毕业」进 Markdown 时排版一致，看不出跳动。
 */
function StreamingMarkdown({ text }: { text: string }): React.JSX.Element {
  const { settled, fresh, freshStart } = splitStreamingText(text)

  return (
    <>
      {settled && <Markdown text={settled} />}
      {fresh && (
        <div className="md md--stream">
          <p className="stream-line">
            <StreamText text={fresh} startIndex={freshStart} />
          </p>
        </div>
      )}
    </>
  )
}
