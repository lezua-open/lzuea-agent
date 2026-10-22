import { ToolTimeoutError } from '@core/errors'
import { DEFAULT_TOOL_TIMEOUT_MS, type ToolMiddleware } from '../types'

/**
 * 超时中间件。
 *
 * 超时不只是抛错 —— 要真正把底层操作掐断，否则后台还在跑。
 * 做法是给本次调用挂一个专属 AbortController，并把 req.ctx.signal 换成它；
 * handler（比如 shell 的 spawn）监听 ctx.signal 就能被及时干掉。
 */
export function timeoutMiddleware(defaultMs = DEFAULT_TOOL_TIMEOUT_MS): ToolMiddleware {
  return async (req, next) => {
    const ms = req.tool.timeoutMs ?? defaultMs
    const outer = req.ctx.signal

    const controller = new AbortController()
    const onOuterAbort = (): void => controller.abort(outer?.reason)
    outer?.addEventListener('abort', onOuterAbort, { once: true })

    const timer = setTimeout(() => controller.abort(new ToolTimeoutError(req.name, ms)), ms)
    // Node 的 timer 不该拖住进程退出
    if (typeof timer.unref === 'function') timer.unref()

    // req 是引用传递，改掉 ctx 后下游 handler 拿到的就是本次调用专属的 signal
    req.ctx = { ...req.ctx, signal: controller.signal }

    try {
      return await next()
    } catch (err) {
      // 超时和用户取消要区分开：只有我们自己触发的 abort 才算超时
      if (controller.signal.aborted && !outer?.aborted) {
        throw new ToolTimeoutError(req.name, ms)
      }
      throw err
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    }
  }
}
