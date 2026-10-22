import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@shared/types'
import type { NeutralBlock } from '@core/providers/types'
import {
  contentToNeutral,
  neutralToContent,
  toChatMessage,
  toNeutralMessage,
  toolUseBlocks
} from './messages'

describe('contentToNeutral / neutralToContent', () => {
  it('text / tool_use / tool_result 往返一致', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false }
    ]
    expect(neutralToContent(contentToNeutral(blocks))).toEqual(blocks)
  })

  it('thinking.raw（signature）往返必须保留', () => {
    const raw = { type: 'thinking', thinking: 'hmm', signature: 'sig-abc' }
    const blocks: ContentBlock[] = [{ type: 'thinking', text: 'hmm', raw }]
    const round = neutralToContent(contentToNeutral(blocks))
    expect(round[0]).toEqual({ type: 'thinking', text: 'hmm', raw })
    // 关键：raw 是同一个对象内容，不能被丢掉
    expect((round[0] as { raw?: unknown }).raw).toEqual(raw)
  })

  it('没有 raw 的 thinking 也能往返（OpenAI 通道存的展示用思考）', () => {
    const blocks: ContentBlock[] = [{ type: 'thinking', text: '展示用' }]
    const round = neutralToContent(contentToNeutral(blocks))
    expect(round[0]).toEqual({ type: 'thinking', text: '展示用' })
    expect('raw' in round[0]).toBe(false)
  })

  it('opaque 块（服务端工具产物）原样保留', () => {
    const raw = {
      type: 'web_search_tool_result',
      tool_use_id: 'srv_1',
      content: [{ type: 'web_search_result', url: 'https://example.com' }]
    }
    const blocks: ContentBlock[] = [{ type: 'opaque', raw, label: 'web_search_tool_result' }]
    const round = neutralToContent(contentToNeutral(blocks))
    expect(round[0]).toEqual({ type: 'opaque', raw, label: 'web_search_tool_result' })
  })
})

describe('toNeutralMessage / toChatMessage', () => {
  it('保留 role 和块顺序', () => {
    const msg = toChatMessage(
      'm1',
      'assistant',
      [
        { type: 'text', text: '先看看' },
        { type: 'tool_use', id: 't1', name: 'list_dir', input: {} }
      ],
      123
    )
    expect(msg.id).toBe('m1')
    expect(msg.createdAt).toBe(123)
    expect(msg.blocks.map((b) => b.type)).toEqual(['text', 'tool_use'])

    const neutral = toNeutralMessage(msg)
    expect(neutral.role).toBe('assistant')
    expect(neutral.blocks.map((b) => b.type)).toEqual(['text', 'tool_use'])
  })
})

describe('toolUseBlocks', () => {
  it('只挑 tool_use，忽略其它', () => {
    const blocks: NeutralBlock[] = [
      { type: 'text', text: 'a' },
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
      { type: 'opaque', raw: {} },
      { type: 'tool_use', id: 't2', name: 'y', input: {} }
    ]
    expect(toolUseBlocks(blocks).map((b) => b.id)).toEqual(['t1', 't2'])
  })

  it('没有工具调用时返回空数组', () => {
    expect(toolUseBlocks([{ type: 'text', text: 'hi' }])).toEqual([])
  })
})
