import Anthropic from '@anthropic-ai/sdk'
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
 * Claude 适配器。
 *
 * 几个容易踩的点都收在这里：
 *  - thinking 块带 signature，必须原样回传，否则下一轮 400
 *  - 服务端工具（web_search）的 server_tool_use / web_search_tool_result 要当 opaque 原样回传
 *  - stop_reason 要分清 end_turn / tool_use / max_tokens / pause_turn / refusal
 */

function mapStopReason(r: string | null | undefined): StopReason {
  switch (r) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'pause_turn':
    case 'refusal':
      return r
    default:
      return 'other'
  }
}

function toApiMessages(messages: NeutralMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    const content: Anthropic.ContentBlockParam[] = []
    for (const b of m.blocks) {
      switch (b.type) {
        case 'text':
          content.push({ type: 'text', text: b.text })
          break
        case 'thinking':
          // 没有原始块（例如 OpenAI 通道存的展示用思考）就丢掉，不参与对话
          if (b.raw) content.push(b.raw as Anthropic.ContentBlockParam)
          break
        case 'opaque':
          content.push(b.raw as Anthropic.ContentBlockParam)
          break
        case 'tool_use':
          content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
          break
        case 'tool_result':
          content.push({
            type: 'tool_result',
            tool_use_id: b.toolUseId,
            content: b.content,
            is_error: b.isError
          })
          break
      }
    }
    return { role: m.role, content }
  })
}

function toApiTools(tools: ToolDefinition[]): Anthropic.Messages.ToolUnion[] {
  return tools.map((t) => {
    if (t.serverSide && t.rawServerTool) {
      return t.rawServerTool as Anthropic.Messages.ToolUnion
    }
    return {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema
    }
  })
}

function classifyError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new ModelAuthError(err.message, { cause: err })
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ModelRateLimitError(err.message, 30_000)
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new NetworkError(err.message, {
      code: 'PROVIDER_UNREACHABLE',
      retryable: true,
      hint: '连不上接口。检查网络，或确认 baseUrl 是否可达。',
      cause: err
    })
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ModelBadRequestError(err.message, { cause: err })
  }
  if (err instanceof Anthropic.APIError) {
    return new SystemError(err.message, { code: 'PROVIDER_API_ERROR', cause: err })
  }
  return toAgentError(err, 'PROVIDER_UNKNOWN')
}

/** 累积中的块 */
type Pending =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; raw: Record<string, unknown> }
  | { kind: 'tool_use'; id: string; name: string; json: string }
  | { kind: 'opaque'; label: string; raw: Record<string, unknown>; json: string }

export class AnthropicProvider implements ModelProvider {
  readonly kind = 'anthropic' as const
  private client: Anthropic

  constructor(private cfg: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey || process.env.ANTHROPIC_API_KEY || '',
      baseURL: cfg.baseUrl?.trim() ? cfg.baseUrl.trim() : undefined
    })
  }

  async *generate(params: GenerateParams): AsyncIterable<ProviderStreamEvent> {
    // 从原始事件自行累积，不依赖 finalMessage() —— 避免「先遍历后取结果」的语义歧义
    const blocks: NeutralBlock[] = []
    let current: Pending | null = null
    let stopReason: StopReason = 'other'

    const flush = (): void => {
      if (!current) return
      switch (current.kind) {
        case 'text':
          if (current.text) blocks.push({ type: 'text', text: current.text })
          break
        case 'thinking':
          blocks.push({ type: 'thinking', text: current.text, raw: current.raw })
          break
        case 'tool_use':
          blocks.push({
            type: 'tool_use',
            id: current.id,
            name: current.name,
            input: parseToolInput(current.json)
          })
          break
        case 'opaque':
          if (current.json.trim()) {
            try {
              current.raw.input = JSON.parse(current.json)
            } catch {
              current.raw.input = { __invalid_json: current.json }
            }
          }
          blocks.push({ type: 'opaque', raw: current.raw, label: current.label })
          break
      }
      current = null
    }

    try {
      const stream = this.client.messages.stream(
        {
          model: this.cfg.model || 'claude-opus-5',
          max_tokens: params.maxTokens,
          system: params.system,
          messages: toApiMessages(params.messages),
          tools: toApiTools(params.tools),
          thinking: { type: 'adaptive', display: 'summarized' }
        },
        { signal: params.signal }
      )

      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_start': {
            flush()
            const cb = event.content_block as {
              type: string
              text?: string
              thinking?: string
              id?: string
              name?: string
            }
            if (cb.type === 'text') {
              current = { kind: 'text', text: cb.text ?? '' }
            } else if (cb.type === 'thinking') {
              current = {
                kind: 'thinking',
                text: cb.thinking ?? '',
                raw: { ...(cb as unknown as Record<string, unknown>) }
              }
            } else if (cb.type === 'tool_use') {
              const id = cb.id ?? `toolu_${Date.now()}`
              current = { kind: 'tool_use', id, name: cb.name ?? 'unknown', json: '' }
              yield { type: 'tool_use_start', id, name: current.name }
            } else {
              // server_tool_use / web_search_tool_result / redacted_thinking 等
              current = {
                kind: 'opaque',
                label: cb.type,
                raw: { ...(cb as unknown as Record<string, unknown>) },
                json: ''
              }
            }
            break
          }
          case 'content_block_delta': {
            const d = event.delta as {
              type: string
              text?: string
              thinking?: string
              partial_json?: string
            }
            if (d.type === 'text_delta' && current?.kind === 'text') {
              current.text += d.text ?? ''
              yield { type: 'text_delta', text: d.text ?? '' }
            } else if (d.type === 'thinking_delta' && current?.kind === 'thinking') {
              const t = d.thinking ?? ''
              current.text += t
              current.raw.thinking = String(current.raw.thinking ?? '') + t
              yield { type: 'thinking_delta', text: t }
            } else if (d.type === 'input_json_delta') {
              const partial = d.partial_json ?? ''
              if (current?.kind === 'tool_use') {
                current.json += partial
                yield { type: 'tool_use_input_delta', id: current.id, partialJson: partial }
              } else if (current?.kind === 'opaque') {
                current.json += partial
              }
            }
            break
          }
          case 'content_block_stop':
            flush()
            break
          case 'message_delta':
            if ((event.delta as { stop_reason?: string }).stop_reason) {
              stopReason = mapStopReason((event.delta as { stop_reason?: string }).stop_reason)
            }
            break
          case 'message_stop':
            flush()
            yield { type: 'done', stopReason, blocks }
            return
          default:
            break
        }
      }
      flush()
      yield { type: 'done', stopReason, blocks }
    } catch (err) {
      // done-before-throw 约定：先把已累积的内容交出去，再抛错。
      // 这样主循环能把流到一半的文本落库，UI 和存储不会对不上。
      flush()
      yield { type: 'done', stopReason, blocks: [...blocks] }
      throw classifyError(err)
    }
  }
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
  // 输入被截断或畸形；保留原文，registry 的 schema 校验会拦下
  return { __invalid_json: raw }
}
