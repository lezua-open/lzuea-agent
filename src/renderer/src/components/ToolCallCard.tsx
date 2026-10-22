import { useState } from 'react'
import type { RiskLevel } from '@shared/types'
import { RiskBadge, StatusLabel, summarizeInput } from './bits'
import { CopyButton } from './CopyButton'
import { Icon } from './icons'

export interface ToolCardModel {
  id: string
  name: string
  input: Record<string, unknown>
  /** 老数据可能没有；没有就不显示徽章 */
  risk?: RiskLevel
  /** streaming | awaiting_approval | running | done | error */
  status: string
  result?: string
  isError?: boolean
  /** 还没解析完的原始 JSON 片段 */
  partialJson?: string
}

/**
 * 一次工具调用的卡片。
 *
 * 流式过程和历史记录共用同一个组件 —— 前者传 partialJson，
 * 后者传已解析好的 input 和 result，展示逻辑只写一遍。
 */
export function ToolCallCard({ model }: { model: ToolCardModel }): React.JSX.Element {
  const [open, setOpen] = useState(model.isError === true)

  const inputText =
    Object.keys(model.input).length > 0
      ? JSON.stringify(model.input, null, 2)
      : (model.partialJson ?? '')

  const status = model.isError && model.status === 'done' ? 'error' : model.status
  const summary = summarizeInput(model.input)

  return (
    <div
      className={[
        'tool-card',
        open ? 'is-open' : '',
        model.risk === 'dangerous' ? 'tool-card--dangerous' : '',
        model.isError ? 'tool-card--error' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        className="tool-card__header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon name="chevron" size={13} className="tool-card__icon" />
        <span className="tool-card__name">{model.name}</span>
        <RiskBadge risk={model.risk} />
        <span className="tool-card__summary">{summary}</span>
        <StatusLabel status={status} />
      </button>

      {open && (
        <div className="tool-card__body">
          <div>
            <div className="tool-card__section-label">
              入参
              {inputText && <CopyButton text={inputText} label="已复制入参" />}
            </div>
            <pre className="code">{inputText || '（暂无）'}</pre>
          </div>

          {model.result !== undefined && (
            <div>
              <div className="tool-card__section-label">
                {model.isError ? '错误' : '结果'}
                <CopyButton
                  text={model.result}
                  label={model.isError ? '已复制错误信息' : '已复制结果'}
                />
              </div>
              <pre className={model.isError ? 'code code--error' : 'code'}>{model.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
