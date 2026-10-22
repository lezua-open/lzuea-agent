import { resolveInsideWorkspace, resolveRealInsideWorkspace } from '../sandbox'
import type { ToolMiddleware } from '../types'

/**
 * 沙箱中间件：在 handler 跑之前，把工具声明过的 pathParams 统一过一遍路径校验。
 *
 * 这是安全边界的**统一入口** —— 不依赖每个工具自己记得去校验。
 * handler 内部仍然可以再 resolve 一次（纵深防御），但漏了也不会逃出去。
 */
export function sandboxMiddleware(): ToolMiddleware {
  return async (req, next) => {
    const params = req.tool.pathParams ?? []
    if (params.length === 0) return next()

    const input = req.validated as Record<string, unknown> | null
    if (!input || typeof input !== 'object') return next()

    const root = req.ctx.workspaceRoot
    for (const key of params) {
      const value = input[key]
      if (value === undefined || value === null) continue
      if (typeof value !== 'string') {
        // 交给 handler 报参数错误，这里不越权
        continue
      }
      // 不存在的路径也要能校验（新建文件场景），所以用 resolveReal 会退化到祖先
      await resolveRealInsideWorkspace(root, value)
    }

    return next()
  }
}

/** 供 handler 内部做纵深防御时用 */
export { resolveInsideWorkspace, resolveRealInsideWorkspace }
