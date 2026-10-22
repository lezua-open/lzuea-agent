import OpenAI from 'openai'
import type { ProviderConfig } from '@shared/types'
import {
  ModelAuthError,
  ModelBadRequestError,
  ModelRateLimitError,
  NetworkError,
  SystemError,
  toAgentError
} from '@core/errors'
import type {
  GenerateParams,
  ModelProvider,
  NeutralBlock,
  NeutralMessage,
  ProviderStreamEvent,
  StopReason,
  ToolDefinition
} from './types'

/**
 * OpenAI 兼容适配器（DeepSeek / 通义千问 / GLM / Kimi / 各类中转）。
 *
 * 和 Anthropic 的差异都收敛在两个转换函数里：
 *  - tool_result 在 OpenAI 侧是独立的 role:"tool" 消息，不是 user 消息里的块
 *  - assistant 的 tool_calls 必须原样带回去
 *  - thinking 是展示用的（DeepSeek 的 reasoning_content），不参与回传
 *  - opaque 块（Anthropic 服务端工具产物）在这里丢弃 —— OpenAI 没有对应物
 */

interface ApiToolCall {
  index?: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

function toApiMessages(
  system: string,
  messages: NeutralMessage[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (system) out.push({ role: 'system', content: system })

  for (const m of messages) {
    const texts: string[] = []
    const toolResults: Extract<NeutralBlock, { type: 'tool_result' }>[] = []
    const toolUses: Extract<NeutralBlock, { type: 'tool_use' }>[] = []

    for (const b of m.blocks) {
      if (b.type === 'text') texts.push(b.text)
      else if (b.type === 'tool_result') toolResults.push(b)
      else if (b.type === 'tool_use') toolUses.push(b)
      // thinking / opaque 在 OpenAI 侧无对应，丢弃
    }

    if (m.role === 'assistant') {
      const content = texts.join('\n\n')
      if (toolUses.length > 0) {
        out.push({
          role: 'assistant',
          content: content || null,
          tool_calls: toolUses.map((t) => ({
            id: t.id,
            type: 'function' as const,
            function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) }
          }))
        })
      } else if (content) {
        out.push({ role: 'assistant', content })
      }
    } else {
      // tool_result 紧跟带 tool_calls 的 assistant 消息，顺序天然正确
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.toolUseId,
          content: tr.isError ? `错误：${tr.content}` : tr.content
        })
      }
      const content = texts.join('\n\n')
      if (content) out.push({ role: 'user', content })
    }
  }
  return out
}

function toApiTools(tools: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools
    .filter((t) => !t.serverSide)
    .map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>
      }
    }))
}

function mapFinishReason(r: string | null | undefined): StopReason {
  switch (r) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    default:
      return 'other'
  }
}

function classifyError(err: unknown): Error {
  if (err instanceof OpenAI.AuthenticationError) {
    return new ModelAuthError(err.message, { cause: err })
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new ModelRateLimitError(err.message, 30_000)
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new NetworkError(err.message, {
      code: 'PROVIDER_UNREACHABLE',
      retryable: true,
      hint: '连不上接口。检查 baseUrl 是否可达（OpenAI 兼容端点通常以 /v1 结尾）。',
      cause: err
    })
  }
  if (err instanceof OpenAI.BadRequestError) {
    return new ModelBadRequestError(err.message, { cause: err })
  }
  if (err instanceof OpenAI.APIError) {
    return new SystemError(err.message, { code: 'PROVIDER_API_ERROR', cause: err })
  }
  return toAgentError(err, 'PROVIDER_UNKNOWN')
}

function parseToolInput(json: string): Record<string, unknown> {
  const raw = json.trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* 落到下面 */
  }
  return { __invalid_json: raw }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly kind = 'openai' as const
  private client: OpenAI

  constructor(private cfg: ProviderConfig) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey || process.env.OPENAI_API_KEY || 'no-key',
      baseURL: cfg.baseUrl?.trim() ? cfg.baseUrl.trim() : undefined
    })
  }

  async *generate(params: GenerateParams): AsyncIterable<ProviderStreamEvent> {
    // 用 index 归拢并行的 tool_calls 增量
    const toolAcc = new Map<number, { id: string; name: string; json: string }>()
    let textBuf = ''
    let finishReason: StopReason = 'other'

    const buildBlocks = (): NeutralBlock[] => {
      const blocks: NeutralBlock[] = []
      if (textBuf) blocks.push({ type: 'text', text: textBuf })
      for (const t of toolAcc.values()) {
        if (!t.name) continue
        blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: parseToolInput(t.json) })
      }
      return blocks
    }

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.cfg.model,
          max_tokens: params.maxTokens,
          stream: true,
          messages: toApiMessages(params.system, params.messages),
          tools: toApiTools(params.tools)
        },
        { signal: params.signal }
      )

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0]
        if (!choice) continue

        const delta = choice.delta as
          | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
              reasoning_content?: string
              reasoning?: string
            })
          | undefined

        if (delta) {
          const reasoning = delta.reasoning_content ?? delta.reasoning
          if (reasoning) yield { type: 'thinking_delta', text: reasoning }

          if (delta.content) {
            textBuf += delta.content
            yield { type: 'text_delta', text: delta.content }
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls as ApiToolCall[]) {
              const idx = tc.index ?? 0
              let acc = toolAcc.get(idx)
              if (!acc) {
                acc = { id: tc.id ?? `call_${idx}_${Date.now()}`, name: '', json: '' }
                toolAcc.set(idx, acc)
              }
              if (tc.id) acc.id = tc.id
              if (tc.function?.name && !acc.name) {
                acc.name = tc.function.name
                yield { type: 'tool_use_start', id: acc.id, name: acc.name }
              }
              if (tc.function?.arguments) {
                acc.json += tc.function.arguments
                yield {
                  type: 'tool_use_input_delta',
                  id: acc.id,
                  partialJson: tc.function.arguments
                }
              }
            }
          }
        }

        if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason)
      }

      yield { type: 'done', stopReason: finishReason, blocks: buildBlocks() }
    } catch (err) {
      // done-before-throw 约定：先把已累积的内容交出去，再抛错。
      // 这样主循环能把流到一半的文本落库，UI 和存储不会对不上。
      yield { type: 'done', stopReason: finishReason, blocks: buildBlocks() }
      throw classifyError(err)
    }
  }
}
