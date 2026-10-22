import { ApprovalDeniedError } from '@core/errors'
import type { ApprovalGate, EventSink } from '@core/ports'
import type { ApprovalDecision, ApprovalPreview } from '@shared/types'
import type { ToolMiddleware } from '../types'

export interface PermissionDeps {
  gate: ApprovalGate
  emit: EventSink
  /**
   * 「总是允许」白名单，key 是工具名。
   * 只对 risk === 'write' 生效 —— 删除和执行命令每次都必须人确认。
   * 白名单由调用方持有（通常是会话级），这样权限策略可以独立演进。
   */
  alwaysAllow: Set<string>
}

const FALLBACK_PREVIEW = (toolName: string, input: unknown): ApprovalPreview => ({
  kind: 'other',
  title: `执行 ${toolName}`,
  detail: JSON.stringify(input, null, 2).slice(0, 4000),
  paths: []
})

/**
 * 权限中间件：危险操作在这里停下来等人。
 *
 * 被拒绝时抛 ApprovalDeniedError，由 registry 统一转成可回传给模型的失败结果 ——
 * 主循环完全不需要知道「拒绝」这件事，保持干净。
 */
export function permissionMiddleware(deps: PermissionDeps): ToolMiddleware {
  return async (req, next) => {
    const { tool, ctx } = req
    const risk = tool.risk

    const autoAllowed = risk === 'read' || (risk === 'write' && deps.alwaysAllow.has(tool.name))
    if (autoAllowed) return next()

    // 没提供 preview 属于定义疏漏：退回原始入参展示，
    // 但仍然必须人来确认 —— 安全上不放水，可用性上不直接判死。
    const preview = tool.preview
      ? await tool.preview(req.validated, ctx)
      : FALLBACK_PREVIEW(tool.name, req.validated)

    deps.emit({
      type: 'approval_required',
      messageId: ctx.messageId,
      toolCallId: ctx.toolCallId,
      name: tool.name,
      input: (req.validated ?? {}) as Record<string, unknown>,
      risk,
      preview
    })

    const decision: ApprovalDecision = await deps.gate.request({
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
      toolCallId: ctx.toolCallId,
      name: tool.name,
      input: (req.validated ?? {}) as Record<string, unknown>,
      risk,
      preview,
      signal: ctx.signal
    })

    if (decision === 'deny') {
      throw new ApprovalDeniedError(tool.name)
    }
    if (decision === 'allow-always' && risk === 'write') {
      deps.alwaysAllow.add(tool.name)
    }

    return next()
  }
}
