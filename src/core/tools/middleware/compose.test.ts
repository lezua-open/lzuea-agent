import { describe, expect, it } from 'vitest'
import { compose } from './compose'
import type { ToolMiddleware, ToolRequest, ToolResult } from '../types'

function req(): ToolRequest {
  return {
    name: 'noop',
    input: {},
    validated: {},
    tool: {
      name: 'noop',
      description: '',
      risk: 'read',
      schema: {} as never,
      handler: async (): Promise<ToolResult> => ({ content: 'ok', isError: false })
    },
    ctx: {
      workspaceRoot: '/',
      memory: {} as never,
      logger: {} as never,
      clock: { now: () => 0 },
      ids: { newId: () => 'id' },
      conversationId: 'c',
      messageId: 'm',
      toolCallId: 't'
    },
    state: new Map()
  }
}

describe('compose', () => {
  it('洋葱顺序：外层先进、后出', async () => {
    const order: string[] = []
    const a: ToolMiddleware = async (_r, next) => {
      order.push('a:in')
      const out = await next()
      order.push('a:out')
      return out
    }
    const b: ToolMiddleware = async (_r, next) => {
      order.push('b:in')
      const out = await next()
      order.push('b:out')
      return out
    }
    const pipeline = compose([a, b])
    await pipeline(req(), async () => {
      order.push('handler')
      return { content: '', isError: false }
    })
    expect(order).toEqual(['a:in', 'b:in', 'handler', 'b:out', 'a:out'])
  })

  it('空中间件链等价于直接调 handler', async () => {
    const pipeline = compose([])
    const out = await pipeline(req(), async () => ({ content: 'done', isError: false }))
    expect(out.content).toBe('done')
  })

  it('外层可以改写返回值', async () => {
    const wrap: ToolMiddleware = async (_r, next) => {
      const out = await next()
      return { ...out, content: out.content + '!' }
    }
    const pipeline = compose([wrap])
    const out = await pipeline(req(), async () => ({ content: 'x', isError: false }))
    expect(out.content).toBe('x!')
  })

  it('外层可以短路，完全不进 handler', async () => {
    let called = false
    const deny: ToolMiddleware = async () => ({ content: '拒绝', isError: true })
    const pipeline = compose([deny])
    const out = await pipeline(req(), async () => {
      called = true
      return { content: '', isError: false }
    })
    expect(called).toBe(false)
    expect(out.isError).toBe(true)
  })

  it('next() 调两次会被拦下（防止状态错乱）', async () => {
    const twice: ToolMiddleware = async (_r, next) => {
      await next()
      return next()
    }
    const pipeline = compose([twice])
    await expect(pipeline(req(), async () => ({ content: '', isError: false }))).rejects.toThrow(
      /调用了多次/
    )
  })

  it('handler 抛错会往外冒，不被静默吞掉', async () => {
    const pipeline = compose([])
    await expect(
      pipeline(req(), async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
  })
})
