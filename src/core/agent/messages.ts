import type { ChatMessage, ContentBlock } from '@shared/types'
import type { NeutralBlock, NeutralMessage } from '@core/providers/types'

/**
 * 持久化格式（ContentBlock）⇄ 模型格式（NeutralBlock）的转换。
 *
 * 两边形状几乎一样，但刻意分开写转换函数，而不是让类型互相兼容：
 * 持久化格式是长期契约（改了要迁移数据），模型格式随 provider 演进，
 * 耦合在一起以后加字段就得同时改表结构。
 *
 * 转换是全量的 —— thinking.raw / opaque 必须原样带过去，
 * 少了它们 Anthropic 下一轮会 400。
 */

export function contentToNeutral(blocks: readonly ContentBlock[]): NeutralBlock[] {
  return blocks.map((b): NeutralBlock => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text }
      case 'thinking':
        return b.raw !== undefined
          ? { type: 'thinking', text: b.text, raw: b.raw }
          : { type: 'thinking', text: b.text }
      case 'tool_use':
        return b.risk !== undefined
          ? { type: 'tool_use', id: b.id, name: b.name, input: b.input, risk: b.risk }
          : { type: 'tool_use', id: b.id, name: b.name, input: b.input }
      case 'tool_result':
        return {
          type: 'tool_result',
          toolUseId: b.toolUseId,
          content: b.content,
          isError: b.isError
        }
      case 'opaque':
        return { type: 'opaque', raw: b.raw, label: b.label }
    }
  })
}

export function neutralToContent(blocks: readonly NeutralBlock[]): ContentBlock[] {
  return blocks.map((b): ContentBlock => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text }
      case 'thinking':
        return b.raw !== undefined
          ? { type: 'thinking', text: b.text, raw: b.raw }
          : { type: 'thinking', text: b.text }
      case 'tool_use':
        return b.risk !== undefined
          ? { type: 'tool_use', id: b.id, name: b.name, input: b.input, risk: b.risk }
          : { type: 'tool_use', id: b.id, name: b.name, input: b.input }
      case 'tool_result':
        return {
          type: 'tool_result',
          toolUseId: b.toolUseId,
          content: b.content,
          isError: b.isError
        }
      case 'opaque':
        return { type: 'opaque', raw: b.raw, label: b.label }
    }
  })
}

export function toNeutralMessage(m: ChatMessage): NeutralMessage {
  return { role: m.role, blocks: contentToNeutral(m.blocks) }
}

export function toChatMessage(
  id: string,
  role: ChatMessage['role'],
  blocks: readonly NeutralBlock[],
  createdAt: number
): ChatMessage {
  return { id, role, blocks: neutralToContent(blocks), createdAt }
}

/** 只挑出可执行的工具调用 */
export function toolUseBlocks(
  blocks: readonly NeutralBlock[]
): Extract<NeutralBlock, { type: 'tool_use' }>[] {
  return blocks.filter((b): b is Extract<NeutralBlock, { type: 'tool_use' }> => {
    return b.type === 'tool_use'
  })
}
