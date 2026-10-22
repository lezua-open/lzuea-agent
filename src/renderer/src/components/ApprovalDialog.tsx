import { useEffect, useRef, useState } from 'react'
import type { ApprovalDecision, ApprovalPreview } from '@shared/types'
import { agentStore, type ApprovalState } from '../store/agentStore'
import { DiffView } from './DiffView'
import { RiskBadge } from './bits'
import { Icon } from './icons'

const KIND_LABEL: Record<ApprovalPreview['kind'], string> = {
  diff: '文件变更预览',
  command: '将要执行的命令',
  delete: '将要删除的内容',
  other: '操作详情'
}

/**
 * 危险操作确认框。
 *
 * 交互取向是「安全侧」：
 *  - Esc / 点遮罩 / 关闭 = 拒绝。误拒只损失一次重试，误允不可逆。
 *  - 高危操作不提供「总是允许」，没有捷径可按。
 *  - 默认焦点放在弹窗上而不是某个按钮上，避免回车直接触发。
 */
export function ApprovalDialog({ approval }: { approval: ApprovalState }): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [showInput, setShowInput] = useState(false)

  useEffect(() => {
    dialogRef.current?.focus()

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void agentStore.respondToApproval('deny')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const decide = (d: ApprovalDecision): void => {
    void agentStore.respondToApproval(d)
  }

  const canAlwaysAllow = approval.risk === 'write'
  const isDangerous = approval.risk === 'dangerous'

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        // 只在遮罩本身按下才算取消，避免在正文里选中文本时误关
        if (e.target === e.currentTarget) decide('deny')
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        className={isDangerous ? 'dialog dialog--dangerous' : 'dialog'}
      >
        <div className="dialog__header">
          <div
            className={
              isDangerous
                ? 'dialog__icon dialog__icon--dangerous'
                : 'dialog__icon dialog__icon--write'
            }
          >
            <Icon name={isDangerous ? 'warning' : 'file'} size={17} />
          </div>
          <div className="dialog__titles">
            <h2 id="approval-title" className="dialog__title">
              {approval.preview.title}
            </h2>
            <p className="dialog__subtitle">
              <RiskBadge risk={approval.risk} />{' '}
              {isDangerous
                ? '高危操作不可撤销，确认前请看清下面的内容。'
                : '这个操作会改动工作区文件，请确认后再继续。'}
            </p>
          </div>
        </div>

        <div className="dialog__body">
          {approval.preview.paths.length > 0 && (
            <div className="dialog__paths">
              {approval.preview.paths.map((p) => (
                <span key={p} className="path-chip">
                  {p}
                </span>
              ))}
            </div>
          )}

          <div>
            <div className="tool-card__section-label">{KIND_LABEL[approval.preview.kind]}</div>
            {approval.preview.kind === 'diff' ? (
              <DiffView text={approval.preview.detail} />
            ) : (
              <pre className="code">{approval.preview.detail}</pre>
            )}
          </div>

          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setShowInput((v) => !v)}
            style={{ alignSelf: 'flex-start' }}
          >
            {showInput ? '收起工具入参' : '查看工具入参'}
          </button>

          {showInput && <pre className="code">{JSON.stringify(approval.input, null, 2)}</pre>}
        </div>

        <div className="dialog__footer">
          <span className="dialog__footer-note">Esc 拒绝</span>
          <button type="button" className="btn btn--ghost" onClick={() => decide('deny')}>
            拒绝
          </button>
          {canAlwaysAllow && (
            <button type="button" className="btn btn--ghost" onClick={() => decide('allow-always')}>
              总是允许
            </button>
          )}
          <button
            type="button"
            className={isDangerous ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={() => decide('allow-once')}
          >
            {isDangerous ? '确认执行' : '允许一次'}
          </button>
        </div>
      </div>
    </div>
  )
}
