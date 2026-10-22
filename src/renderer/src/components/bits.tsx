import type { RiskLevel } from '@shared/types'

/**
 * 风险分级徽章。文案刻意说清后果，不写「危险」这种空话。
 * risk 缺失（老数据）时不渲染，宁可不显示也不能显示错的。
 */
export function RiskBadge({ risk }: { risk?: RiskLevel }): React.JSX.Element | null {
  if (!risk) return null
  const label = risk === 'read' ? '只读' : risk === 'write' ? '写入' : '高危'
  return <span className={`risk risk--${risk}`}>{label}</span>
}

const STATUS_META: Record<string, { text: string; cls: string; spinning?: boolean }> = {
  streaming: { text: '接收参数', cls: 'status--running', spinning: true },
  awaiting_approval: { text: '等待确认', cls: 'status--waiting' },
  running: { text: '执行中', cls: 'status--running', spinning: true },
  done: { text: '已完成', cls: 'status--ok' },
  error: { text: '失败', cls: 'status--error' }
}

export function StatusLabel({ status }: { status: string }): React.JSX.Element {
  const meta = STATUS_META[status] ?? { text: status, cls: '' }
  return (
    <span className={`status ${meta.cls}`}>
      {meta.spinning && <span className="spinner-inline" />}
      {meta.text}
    </span>
  )
}

/** 只截断展示用的入参摘要，不改真实数据 */
export function summarizeInput(input: Record<string, unknown>): string {
  const first =
    typeof input.path === 'string'
      ? input.path
      : typeof input.filePath === 'string'
        ? input.filePath
        : typeof input.command === 'string'
          ? input.command
          : typeof input.url === 'string'
            ? input.url
            : typeof input.query === 'string'
              ? input.query
              : typeof input.key === 'string'
                ? input.key
                : ''
  return first
}
