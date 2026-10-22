import type { ToolMiddleware } from '../types'

/**
 * 遥测中间件：记录每个工具调用的开始/结束/耗时/成败。
 * 放在链的最外层，这样连被拒绝、超时的调用也留痕。
 */
export function telemetryMiddleware(): ToolMiddleware {
  return async (req, next) => {
    const log = req.ctx.logger.child({
      tool: req.name,
      toolCallId: req.ctx.toolCallId,
      conversationId: req.ctx.conversationId
    })
    const startedAt = req.ctx.clock.now()
    log.debug('tool_call.start')

    try {
      const result = await next()
      log.info('tool_call.end', {
        durationMs: req.ctx.clock.now() - startedAt,
        isError: result.isError,
        outputChars: result.content.length,
        ...result.meta
      })
      return result
    } catch (err) {
      log.error('tool_call.failed', {
        durationMs: req.ctx.clock.now() - startedAt,
        err
      })
      throw err
    }
  }
}
