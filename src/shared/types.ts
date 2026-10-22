/**
 * 主进程 / preload / 渲染进程共用的契约。
 * 改这里等于改三方的接口，改完先跑 npm run typecheck。
 */

// ---------------------------------------------------------------- 风险分级

/**
 * read      只读，自动放行
 * write     新建或覆盖，需一次确认
 * dangerous 删除 / 递归删除 / 执行命令，需二次确认
 */
export type RiskLevel = 'read' | 'write' | 'dangerous'

// ---------------------------------------------------------------- JSON Schema

/** 工具入参的 JSON Schema，直接发给模型 */
export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [k: string]: unknown
}

// ---------------------------------------------------------------- 内容块

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  text: string
  /**
   * 原始 thinking 块（含 signature）。
   * Anthropic 要求下一轮原样回传，否则 400；持久化时必须一起存。
   */
  raw?: unknown
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  /**
   * 执行时的风险分级，落库时由 runtime 从工具注册表上抄一份。
   * UI 要在历史记录里显示「只读 / 写入 / 高危」，但渲染进程看不到注册表；
   * 存一份冗余比让 UI 猜工具风险可靠。发给模型时会被丢掉。
   */
  risk?: RiskLevel
}

export interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError: boolean
}

/**
 * 不透明块：provider 特有内容（Anthropic 的 server_tool_use /
 * web_search_tool_result / redacted_thinking 等）。
 * 不参与语义、不给模型解释，但必须原样存下来并原样回传。
 */
export interface OpaqueBlock {
  type: 'opaque'
  raw: unknown
  /** 给 UI 看的标签，例如 "web_search" */
  label?: string
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | OpaqueBlock

// ---------------------------------------------------------------- 消息 / 会话

export type MessageRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: MessageRole
  blocks: ContentBlock[]
  createdAt: number
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

// ---------------------------------------------------------------- 审批

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny'

/** 确认框里展示的东西 —— 尽量给出可判断的原文，而不是一句「要执行 XX」 */
export interface ApprovalPreview {
  kind: 'diff' | 'command' | 'delete' | 'other'
  /** 一句话标题，例如 "覆盖 src/app.ts" */
  title: string
  /** 给人看的正文：unified diff / 命令行 / 文件清单 */
  detail: string
  /** 涉及的工作区相对路径，便于判断影响面 */
  paths: string[]
}

// ---------------------------------------------------------------- 流式事件

export type AgentEvent =
  | { type: 'message_start'; conversationId: string; messageId: string }
  | { type: 'text_delta'; messageId: string; text: string }
  | { type: 'thinking_delta'; messageId: string; text: string }
  | {
      type: 'tool_call_start'
      messageId: string
      toolCallId: string
      name: string
      risk: RiskLevel
    }
  | { type: 'tool_call_input'; messageId: string; toolCallId: string; jsonDelta: string }
  | {
      type: 'tool_call_ready'
      messageId: string
      toolCallId: string
      name: string
      input: Record<string, unknown>
      risk: RiskLevel
    }
  | {
      type: 'approval_required'
      messageId: string
      toolCallId: string
      name: string
      input: Record<string, unknown>
      risk: RiskLevel
      preview: ApprovalPreview
    }
  | {
      type: 'tool_call_result'
      messageId: string
      toolCallId: string
      result: string
      isError: boolean
    }
  | { type: 'message_end'; messageId: string; stopReason: string }
  | { type: 'error'; conversationId: string; message: string }
  | { type: 'done'; conversationId: string }

// ---------------------------------------------------------------- 配置

export type ProviderKind = 'anthropic' | 'openai'

/** 界面主题。light = 中性米白（默认），dark = 深色 */
export type ThemeMode = 'light' | 'dark'

export interface ProviderConfig {
  /** 可为空，为空时回退到同名环境变量 */
  apiKey: string
  /** 留空 = 官方默认端点；填中转地址即走中转 */
  baseUrl: string
  model: string
  /** 是否走 Web 搜索（仅 anthropic 通道有效，服务端工具） */
  enableWebSearch: boolean
}

export interface AppConfig {
  provider: ProviderKind
  anthropic: ProviderConfig
  openai: ProviderConfig
  /** 工作区根目录，Agent 的沙箱边界 */
  workspaceRoot: string
  /** 单次 run 里「模型 → 工具」的最大循环轮数，防止失控 */
  maxToolIterations: number
  /** 单轮回复的输出 token 上限 */
  maxOutputTokens: number
  /** 模型上下文窗口估算值，用于上下文裁剪 */
  contextWindowTokens: number
  /** 界面主题，切换后立刻生效并落盘 */
  theme: ThemeMode
}

// ---------------------------------------------------------------- 记忆

export interface MemoryEntry {
  id: string
  key: string
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------- 工具调用快照

export interface ToolCallSnapshot {
  id: string
  name: string
  input: Record<string, unknown>
  risk: RiskLevel
  status: 'pending' | 'approved' | 'denied' | 'running' | 'done' | 'error'
  result?: string
  isError?: boolean
}

// ---------------------------------------------------------------- 渲染进程可见的 API

export interface AgentAPI {
  // 会话
  listConversations(): Promise<ConversationSummary[]>
  createConversation(title?: string): Promise<ConversationSummary>
  deleteConversation(id: string): Promise<void>
  renameConversation(id: string, title: string): Promise<void>
  getMessages(conversationId: string): Promise<ChatMessage[]>

  // Agent
  send(conversationId: string, text: string): Promise<void>
  stop(conversationId: string): Promise<void>
  respondToApproval(toolCallId: string, decision: ApprovalDecision): Promise<void>

  // 配置
  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  pickWorkspace(): Promise<string | null>

  // 记忆
  listMemory(): Promise<MemoryEntry[]>
  deleteMemory(id: string): Promise<void>

  // 事件订阅，返回取消订阅函数
  onAgentEvent(listener: (event: AgentEvent) => void): () => void
}
