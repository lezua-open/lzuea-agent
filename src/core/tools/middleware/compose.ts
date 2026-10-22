import type { ToolMiddleware, ToolRequest, ToolResult } from '../types'

/**
 * 把中间件链包成一个执行函数。洋葱模型：外层的 before 在前，after 在后。
 *
 *   const run = compose([telemetry, permission, timeout, sandbox])
 *   await run({ name, input, ctx, state }, () => tool.handler(input, ctx))
 */
export function compose(middlewares: ToolMiddleware[]) {
  return async function run(
    req: ToolRequest,
    final: () => Promise<ToolResult>
  ): Promise<ToolResult> {
    let index = -1

    const dispatch = async (i: number): Promise<ToolResult> => {
      if (i <= index) {
        throw new Error('next() 被调用了多次，中间件实现有误')
      }
      index = i
      const mw = middlewares[i]
      if (!mw) return final()
      return mw(req, () => dispatch(i + 1))
    }

    return dispatch(0)
  }
}
