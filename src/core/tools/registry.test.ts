import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentEvent, ApprovalDecision, ApprovalPreview } from '@shared/types'
import type { ApprovalGate, ApprovalRequest } from '@core/ports'
import { silentLogger } from '@core/logging'
import { defineTool, fail, ok, type ToolExecutionContext, type ToolMiddleware } from './types'
import { permissionMiddleware } from './middleware/permission'
import { timeoutMiddleware } from './middleware/timeout'
import { ToolRegistry } from './registry'

// ---------------------------------------------------------------- 测试替身

class FakeGate implements ApprovalGate {
  readonly requests: ApprovalRequest[] = []
  private pending = new Map<string, (d: ApprovalDecision) => void>()
  private queue: ApprovalDecision[] = []

  /** 预置接下来几次请求的答复 */
  constructor(...decisions: ApprovalDecision[]) {
    this.queue = [...decisions]
  }

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(req)
    const decision = this.queue.shift()
    if (decision) return Promise.resolve(decision)
    return new Promise((resolve) => this.pending.set(req.toolCallId, resolve))
  }

  respond(toolCallId: string, decision: ApprovalDecision): void {
    this.pending.get(toolCallId)?.(decision)
    this.pending.delete(toolCallId)
  }

  cancelAll(): void {
    for (const [, resolve] of this.pending) resolve('deny')
    this.pending.clear()
  }
}

function ctx(over: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    workspaceRoot: '/ws',
    memory: {} as never,
    logger: silentLogger,
    clock: { now: () => 1 },
    ids: { newId: () => 'n' },
    conversationId: 'conv',
    messageId: 'msg',
    toolCallId: 'call',
    ...over
  }
}

const preview: ApprovalPreview = { kind: 'other', title: 't', detail: 'd', paths: [] }

function makeTool(risk: 'read' | 'write' | 'dangerous', handler = async () => ok('did it')) {
  return defineTool({
    name: `tool_${risk}`,
    description: 'x',
    risk,
    schema: z.object({}),
    handler,
    ...(risk === 'read' ? {} : { preview: async () => preview })
  })
}

function build(middlewares: ToolMiddleware[], tools: ReturnType<typeof makeTool>[]): ToolRegistry {
  const reg = new ToolRegistry(middlewares)
  reg.registerAll(tools as never)
  return reg
}

// ---------------------------------------------------------------- 入参校验

describe('ToolRegistry.execute 入参校验', () => {
  const reg = build(
    [],
    [
      defineTool({
        name: 'greet',
        description: '',
        risk: 'read',
        schema: z.object({ name: z.string().min(1) }),
        handler: async ({ name }) => ok(`hi ${name}`)
      })
    ]
  )

  it('校验通过时正常执行', async () => {
    const out = await reg.execute('greet', { name: 'a' }, ctx())
    expect(out).toMatchObject({ content: 'hi a', isError: false })
  })

  it('缺字段返回失败结果而不是抛错', async () => {
    const out = await reg.execute('greet', {}, ctx())
    expect(out.isError).toBe(true)
    expect(out.content).toContain('greet')
  })

  it('未知工具返回带「可用工具」的失败结果', async () => {
    const out = await reg.execute('nope', {}, ctx())
    expect(out.isError).toBe(true)
    expect(out.content).toContain('未知工具')
    expect(out.content).toContain('greet')
  })

  it('handler 抛异常也被转成失败结果（模型要能读到原因）', async () => {
    const boom = build(
      [],
      [
        defineTool({
          name: 'boom',
          description: '',
          risk: 'read',
          schema: z.object({}),
          handler: async () => {
            throw new Error('内部炸了')
          }
        })
      ]
    )
    const out = await boom.execute('boom', {}, ctx())
    expect(out.isError).toBe(true)
    expect(out.content).toContain('内部炸了')
  })
})

// ---------------------------------------------------------------- 审批中间件

describe('permissionMiddleware', () => {
  it('read 风险自动放行，不弹确认框', async () => {
    const gate = new FakeGate()
    const events: AgentEvent[] = []
    const reg = build(
      [permissionMiddleware({ gate, emit: (e) => events.push(e), alwaysAllow: new Set() })],
      [makeTool('read')]
    )
    const out = await reg.execute('tool_read', {}, ctx())
    expect(out.isError).toBe(false)
    expect(gate.requests).toHaveLength(0)
    expect(events.filter((e) => e.type === 'approval_required')).toHaveLength(0)
  })

  it('write 风险会请求确认，allow-once 只放行一次、不加白名单', async () => {
    const gate = new FakeGate('allow-once', 'allow-once')
    const events: AgentEvent[] = []
    const alwaysAllow = new Set<string>()
    const reg = build(
      [permissionMiddleware({ gate, emit: (e) => events.push(e), alwaysAllow })],
      [makeTool('write')]
    )

    const out = await reg.execute('tool_write', {}, ctx())
    expect(out.isError).toBe(false)
    expect(gate.requests).toHaveLength(1)
    expect(alwaysAllow.has('tool_write')).toBe(false)

    // 第二次仍然要问
    await reg.execute('tool_write', {}, ctx())
    expect(gate.requests).toHaveLength(2)
    expect(alwaysAllow.has('tool_write')).toBe(false)
  })

  it('allow-always 对 write 生效，之后不再问', async () => {
    const gate = new FakeGate('allow-always')
    const alwaysAllow = new Set<string>()
    const reg = build(
      [permissionMiddleware({ gate, emit: () => {}, alwaysAllow })],
      [makeTool('write')]
    )
    await reg.execute('tool_write', {}, ctx())
    expect(alwaysAllow.has('tool_write')).toBe(true)
    await reg.execute('tool_write', {}, ctx())
    expect(gate.requests).toHaveLength(1)
  })

  it('dangerous 每次都要确认 —— allow-always 不加白名单', async () => {
    const gate = new FakeGate('allow-always', 'allow-once')
    const alwaysAllow = new Set<string>()
    const reg = build(
      [permissionMiddleware({ gate, emit: () => {}, alwaysAllow })],
      [makeTool('dangerous')]
    )
    await reg.execute('tool_dangerous', {}, ctx())
    await reg.execute('tool_dangerous', {}, ctx())
    expect(gate.requests).toHaveLength(2)
    expect(alwaysAllow.size).toBe(0)
  })

  it('deny 转成失败结果，handler 不会执行', async () => {
    let ran = false
    const gate = new FakeGate('deny')
    const reg = build(
      [permissionMiddleware({ gate, emit: () => {}, alwaysAllow: new Set() })],
      [
        makeTool('dangerous', async () => {
          ran = true
          return ok('nope')
        })
      ]
    )
    const out = await reg.execute('tool_dangerous', {}, ctx())
    expect(ran).toBe(false)
    expect(out.isError).toBe(true)
    expect(out.content).toContain('拒绝')
    expect(out.content).toContain('下一步')
  })

  it('弹确认框前会 emit approval_required，带完整 preview', async () => {
    const gate = new FakeGate('allow-once')
    const events: AgentEvent[] = []
    const reg = build(
      [permissionMiddleware({ gate, emit: (e) => events.push(e), alwaysAllow: new Set() })],
      [makeTool('write')]
    )
    await reg.execute('tool_write', {}, ctx({ messageId: 'm1', toolCallId: 'c1' }))

    const ev = events.find((e) => e.type === 'approval_required')
    expect(ev).toBeDefined()
    expect(ev).toMatchObject({ messageId: 'm1', toolCallId: 'c1', name: 'tool_write' })
    expect((ev as { preview: ApprovalPreview }).preview).toEqual(preview)
  })

  it('没有 preview 的危险工具退化成展示原始入参，但仍然要人确认', async () => {
    const gate = new FakeGate('deny')
    const reg = build(
      [permissionMiddleware({ gate, emit: () => {}, alwaysAllow: new Set() })],
      [
        defineTool({
          name: 'bare',
          description: '',
          risk: 'dangerous',
          schema: z.object({ cmd: z.string() }),
          handler: async () => ok('ran')
        })
      ]
    )
    const out = await reg.execute('bare', { cmd: 'rm -rf /' }, ctx())
    expect(gate.requests).toHaveLength(1)
    expect(gate.requests[0].preview.kind).toBe('other')
    expect(gate.requests[0].preview.detail).toContain('rm -rf')
    expect(out.isError).toBe(true)
  })
})

// ---------------------------------------------------------------- 超时中间件

describe('timeoutMiddleware', () => {
  it('超时返回失败结果并携带超时提示', async () => {
    const reg = build(
      [timeoutMiddleware(20)],
      [
        defineTool({
          name: 'slow',
          description: '',
          risk: 'read',
          schema: z.object({}),
          timeoutMs: 20,
          handler: async (_input, c) =>
            new Promise((_, reject) => {
              c.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            })
        })
      ]
    )
    const out = await reg.execute('slow', {}, ctx())
    expect(out.isError).toBe(true)
    expect(out.content).toMatch(/超时|timeout/i)
  })

  it('没有超时就正常返回', async () => {
    const reg = build(
      [timeoutMiddleware(5000)],
      [
        defineTool({
          name: 'fast',
          description: '',
          risk: 'read',
          schema: z.object({}),
          handler: async () => ok('ok')
        })
      ]
    )
    expect((await reg.execute('fast', {}, ctx())).content).toBe('ok')
  })
})

// ---------------------------------------------------------------- 模型侧 schema

describe('toModelTools', () => {
  const reg = build(
    [],
    [
      defineTool({
        name: 'read_file',
        description: '读文件',
        risk: 'read',
        schema: z.object({ path: z.string().describe('工作区相对路径') }),
        handler: async () => ok('')
      })
    ]
  )

  it('把 zod schema 导出成 JSON Schema，并去掉 $schema', () => {
    const tools = reg.toModelTools({ providerKind: 'openai', enableServerWebSearch: false })
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('read_file')
    expect(tools[0].inputSchema.type).toBe('object')
    expect(tools[0].inputSchema.properties).toHaveProperty('path')
    expect(tools[0].inputSchema.$schema).toBeUndefined()
    expect(tools[0].serverSide).toBeUndefined()
  })

  it('只在 anthropic + 开启搜索时追加服务端 web_search', () => {
    const on = reg.toModelTools({ providerKind: 'anthropic', enableServerWebSearch: true })
    expect(on).toHaveLength(2)
    const server = on.find((t) => t.serverSide)
    expect(server?.name).toBe('web_search')
    expect(server?.rawServerTool).toMatchObject({ type: 'web_search_20260209' })

    expect(
      reg.toModelTools({ providerKind: 'anthropic', enableServerWebSearch: false })
    ).toHaveLength(1)
    expect(reg.toModelTools({ providerKind: 'openai', enableServerWebSearch: true })).toHaveLength(
      1
    )
  })
})

// ---------------------------------------------------------------- 注册表

describe('ToolRegistry 注册', () => {
  it('重复注册同一个名字会抛错', () => {
    const reg = build([], [makeTool('read')])
    expect(() => reg.register(makeTool('read') as never)).toThrow(/重复注册/)
  })

  it('names() / list() / get() 一致', () => {
    const reg = build([], [makeTool('read'), makeTool('write')])
    expect(reg.names().sort()).toEqual(['tool_read', 'tool_write'])
    expect(reg.list()).toHaveLength(2)
    expect(reg.get('tool_read')?.name).toBe('tool_read')
    expect(reg.get('missing')).toBeUndefined()
  })
})

// ---------------------------------------------------------------- 工具结果

describe('ok / fail / truncateForModel', () => {
  it('超长输出被截断并说明怎么看后面', () => {
    const out = ok('x'.repeat(60_000))
    expect(out.content.length).toBeLessThan(60_000)
    expect(out.content).toContain('已截断')
    expect(out.content).toContain('offset/limit')
  })

  it('短输出原样保留', () => {
    expect(ok('短').content).toBe('短')
    expect(fail('错了').isError).toBe(true)
  })
})
