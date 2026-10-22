import type { ApprovalDecision } from '@shared/types'
import type { ApprovalGate, ApprovalRequest } from '@core/ports'
import { UserError } from '@core/errors'

interface PendingEntry {
  resolve: (d: ApprovalDecision) => void
  reject: (e: unknown) => void
  cleanup: () => void
}

function cancelledError(signal: AbortSignal | undefined): unknown {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return new UserError('操作已被取消', { code: 'APPROVAL_CANCELLED' })
}

/**
 * 审批闸门的 IPC 实现。
 *
 * request() 挂起，等渲染进程那边用户点了按钮 → respond() 解开。
 * UI 从哪儿知道要弹框：permission 中间件会 emit `approval_required` 事件，
 * 这里只负责「把人的决定送回去」，不重复发通知。
 *
 * 两个解开挂起的途径，缺一不可：
 *  - signal 中止 —— 用户点了停止，而且能覆盖「cancelAll 跑在 request 注册之前」的竞态
 *  - cancelAll() —— 兜底，一次解开所有还挂着的
 */
export class IpcApprovalGate implements ApprovalGate {
  private readonly pending = new Map<string, PendingEntry>()

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve, reject) => {
      // 已经中止就别再等了，更不要再弹框
      if (req.signal?.aborted) {
        reject(cancelledError(req.signal))
        return
      }

      // 同一 toolCallId 不该出现两次；出现就先把旧的解掉，避免泄漏
      this.respond(req.toolCallId, 'deny')

      const onAbort = (): void => {
        this.settle(req.toolCallId, (e) => e.reject(cancelledError(req.signal)))
      }
      req.signal?.addEventListener('abort', onAbort, { once: true })

      this.pending.set(req.toolCallId, {
        resolve,
        reject,
        cleanup: () => req.signal?.removeEventListener('abort', onAbort)
      })
    })
  }

  respond(toolCallId: string, decision: ApprovalDecision): void {
    // 未知 id 静默忽略：可能已经超时、被取消、或者 UI 重复点了按钮
    this.settle(toolCallId, (e) => e.resolve(decision))
  }

  /**
   * 取消所有待审批项。用 reject 而不是 resolve('deny')：
   * 「用户点了停止」和「用户拒绝了这个操作」对模型来说是不同的事，
   * 前者不该被理解成「换个方案继续做同一件事」。
   */
  cancelAll(reason: string): void {
    const error = new UserError(reason, {
      code: 'APPROVAL_CANCELLED',
      hint: '等用户重新发起再试。'
    })
    for (const toolCallId of [...this.pending.keys()]) {
      this.settle(toolCallId, (e) => e.reject(error))
    }
  }

  /** 当前卡着的审批项数量，用于诊断 */
  get pendingCount(): number {
    return this.pending.size
  }

  private settle(toolCallId: string, action: (entry: PendingEntry) => void): void {
    const entry = this.pending.get(toolCallId)
    if (!entry) return
    this.pending.delete(toolCallId)
    entry.cleanup()
    action(entry)
  }
}
