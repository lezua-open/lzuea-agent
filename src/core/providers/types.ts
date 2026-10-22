import type { JsonSchema, ProviderConfig, ProviderKind, RiskLevel } from '@shared/types'

/**
 * 模型适配层的中立契约。
 *
 * 主循环只认这套形状，具体是 Claude 还是 OpenAI 兼容接口由 adapter 自己翻译。
 * 加第三家（本地 Ollama、Azure）= 多写一个 adapter，不动循环。
 */

// ---------------------------------------------------------------- 工具定义

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
  /**
   * Anthropic 的服务端工具（web_search / web_fetch）不进本地 executor，
   * 标记出来让主循环知道结果会直接出现在响应内容里。
   */
  serverSide?: boolean
  /** 传给 provider 的原始定义（服务端工具用） */
  rawServerTool?: unknown
}

// ---------------------------------------------------------------- 中立消息

export interface NeutralText {
  type: 'text'
  text: string
}

export interface NeutralThinking {
  type: 'thinking'
  text: string
  /** 原始 thinking 块（含 signature），必须原样回传；OpenAI 通道忽略 */
  raw?: unknown
}

export interface NeutralToolUse {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  /** 只用于本地展示，provider 序列化时会丢掉，绝不发给模型 */
  risk?: RiskLevel
}

export interface NeutralToolResult {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError: boolean
}

/**
 * 不透明块：provider 特有内容，原样回传、不参与语义。
 * 典型是 Anthropic 的 server_tool_use / web_search_tool_result / redacted_thinking ——
 * 必须原样带回去，否则下一轮 400；UI 只看 label。
 */
export interface NeutralOpaque {
  type: 'opaque'
  raw: unknown
  label?: string
}

export type NeutralBlock =
  NeutralText | NeutralThinking | NeutralToolUse | NeutralToolResult | NeutralOpaque

export interface NeutralMessage {
  role: 'user' | 'assistant'
  blocks: NeutralBlock[]
}

// ---------------------------------------------------------------- 流式事件

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'pause_turn' | 'refusal' | 'other'

export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input_delta'; id: string; partialJson: string }
  | {
      type: 'done'
      stopReason: StopReason
      /** 完整 assistant 回合内容，含 tool_use，直接入历史 */
      blocks: NeutralBlock[]
    }

// ---------------------------------------------------------------- Provider

export interface GenerateParams {
  system: string
  messages: NeutralMessage[]
  tools: ToolDefinition[]
  maxTokens: number
  signal?: AbortSignal
}

export interface ModelProvider {
  readonly kind: ProviderKind
  /**
   * 流式产出。
   *
   * 约定（done-before-throw）：
   *  - 成功时最后一条是 `done`，然后正常结束
   *  - 失败时**先 yield 一条 `done`**（blocks 是已累积的部分内容）再抛错
   *
   * 这样调用方即使中途断线，也能拿到已经流出来的文本去落库，
   * 不会出现「UI 显示了内容、存储里却没有」的不一致。
   */
  generate(params: GenerateParams): AsyncIterable<ProviderStreamEvent>
  /** 清理连接 / 定时器 */
  dispose?(): void
}

export interface ModelProviderFactory {
  create(kind: ProviderKind, cfg: ProviderConfig): ModelProvider
}
