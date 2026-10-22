import { describe, expect, it } from 'vitest'
import type { NeutralMessage } from '@core/providers/types'
import { estimateMessagesTokens, estimateTokens, fitToBudget } from './tokens'

function msg(role: 'user' | 'assistant', text: string): NeutralMessage {
  return { role, blocks: [{ type: 'text', text }] }
}

function toolPair(id: string, size: number): NeutralMessage[] {
  return [
    {
      role: 'assistant',
      blocks: [{ type: 'tool_use', id, name: 'read_file', input: { path: 'x' } }]
    },
    {
      role: 'user',
      blocks: [{ type: 'tool_result', toolUseId: id, content: 'y'.repeat(size), isError: false }]
    }
  ]
}

describe('estimateTokens', () => {
  it('空串是 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('中文比英文「更贵」（字符/token 比更小）', () => {
    const same = 100
    expect(estimateTokens('中'.repeat(same))).toBeGreaterThan(estimateTokens('a'.repeat(same)))
  })

  it('纯英文约 4 字符/token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  it('中英混排落在两端之间', () => {
    const mixed = estimateTokens('hello 你好 world 世界')
    const latin = estimateTokens('hello  world ')
    const han = estimateTokens('你好世界')
    expect(mixed).toBeGreaterThan(latin)
    expect(mixed).toBeLessThan(han + 20)
  })
})

describe('estimateMessagesTokens', () => {
  it('多条消息是各自之和（含每条的固定开销）', () => {
    const one = estimateMessagesTokens([msg('user', 'hi')])
    const two = estimateMessagesTokens([msg('user', 'hi'), msg('assistant', 'hi')])
    expect(two).toBeGreaterThan(one)
  })

  it('opaque 块按序列化后的长度算', () => {
    const small = estimateMessagesTokens([
      { role: 'assistant', blocks: [{ type: 'opaque', raw: { a: 1 } }] }
    ])
    const big = estimateMessagesTokens([
      { role: 'assistant', blocks: [{ type: 'opaque', raw: { a: 'x'.repeat(200) } }] }
    ])
    expect(big).toBeGreaterThan(small)
  })
})

describe('fitToBudget', () => {
  const budget = { windowTokens: 1000, reserveOutputTokens: 200 }

  it('不超预算时原样返回，什么都不丢', () => {
    const msgs = [msg('user', 'hi'), msg('assistant', 'hello')]
    const out = fitToBudget(msgs, budget, 10, 10)
    expect(out.trimmedCount).toBe(0)
    expect(out.messages).toHaveLength(2)
  })

  it('超预算时从最旧的非首条开始丢', () => {
    const msgs = [
      msg('user', '任务目标'),
      msg('assistant', 'a'.repeat(2000)),
      msg('user', 'b'.repeat(2000)),
      msg('assistant', 'c'.repeat(2000))
    ]
    const out = fitToBudget(msgs, budget, 10, 10)
    expect(out.trimmedCount).toBeGreaterThan(0)
    // 首条（任务目标）一定在
    expect(out.messages[0].blocks[0]).toMatchObject({ text: '任务目标' })
    // 最近的一定在
    expect(out.messages.at(-1)?.blocks[0]).toMatchObject({ text: 'c'.repeat(2000) })
    expect(out.messages.length).toBeLessThan(msgs.length)
  })

  it('永远不会把 tool_use 和 tool_result 拆开', () => {
    // 每一对都是「assistant 带 tool_use + user 带 tool_result」两条消息
    const msgs = [
      msg('user', 'go'),
      ...toolPair('t1', 1500),
      ...toolPair('t2', 1500),
      ...toolPair('t3', 1500)
    ]
    const out = fitToBudget(msgs, budget, 10, 10)

    for (let i = 0; i < out.messages.length; i++) {
      const m = out.messages[i]
      for (const b of m.blocks) {
        if (b.type === 'tool_use') {
          const next = out.messages[i + 1]
          const hasResult = next?.blocks.some(
            (x) => x.type === 'tool_result' && x.toolUseId === b.id
          )
          expect(hasResult, `tool_use ${b.id} 的结果必须还在`).toBe(true)
        }
      }
    }
  })

  it('返回的是副本，不改动入参', () => {
    const msgs = [msg('user', 'a'.repeat(5000))]
    const out = fitToBudget(msgs, budget, 0, 0)
    expect(msgs[0].blocks).toHaveLength(1)
    expect(out.messages[0]).not.toBe(msgs[0])
    expect(out.messages[0].blocks).not.toBe(msgs[0].blocks)
  })
})
