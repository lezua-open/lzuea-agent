import type {
  AgentEvent,
  AppConfig,
  ApprovalDecision,
  ApprovalPreview,
  ChatMessage,
  ConversationSummary,
  MemoryEntry,
  RiskLevel
} from '@shared/types'

/**
 * 端口（Port）：core 层对外部世界的全部依赖都收敛在这里。
 * platform 层提供实现（SQLite、Electron 对话框、真实时钟），测试里用假实现。
 * 这样 core 可以脱离 Electron 跑单元测试。
 */

// ---------------------------------------------------------------- 会话/消息持久化

export interface MessageStore {
  listConversations(): Promise<ConversationSummary[]>
  createConversation(title?: string): Promise<ConversationSummary>
  deleteConversation(id: string): Promise<void>
  renameConversation(id: string, title: string): Promise<void>
  exists(id: string): Promise<boolean>
  getMessages(conversationId: string): Promise<ChatMessage[]>
  appendMessage(conversationId: string, message: ChatMessage): Promise<void>
  replaceMessages(conversationId: string, messages: ChatMessage[]): Promise<void>
}

// ---------------------------------------------------------------- 长期记忆持久化

export interface MemoryRepository {
  list(): Promise<MemoryEntry[]>
  get(key: string): Promise<MemoryEntry | undefined>
  /** 同 key 覆盖 */
  remember(key: string, content: string, tags?: string[]): Promise<MemoryEntry>
  forget(key: string): Promise<boolean>
  deleteById(id: string): Promise<boolean>
  recall(query: string, limit?: number): Promise<MemoryEntry[]>
}

// ---------------------------------------------------------------- 审批闸门

export interface ApprovalRequest {
  /** 哪一轮对话发起的 */
  conversationId: string
  /** 哪条 assistant 消息里的工具调用 */
  messageId: string
  toolCallId: string
  name: string
  input: Record<string, unknown>
  risk: RiskLevel
  preview: ApprovalPreview
  /**
   * run 被中止时要能解开这个请求。
   * 没有它会有竞态：cancelAll() 在 request() 注册之前跑掉，请求就永远挂着。
   */
  signal?: AbortSignal
}

/**
 * 危险操作确认闸门。
 *
 * request() 会一直等到 respond() 被调用、signal 中止、或 cancelAll()。
 * 实现在 platform 层：发 IPC 给渲染进程弹框，用户点按钮后 respond()。
 */
export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<ApprovalDecision>
  /** 解开某个待审批项；未知 id 时静默忽略 */
  respond(toolCallId: string, decision: ApprovalDecision): void
  /** 取消所有待审批项（用户点了「停止」） */
  cancelAll(reason: string): void
}

// ---------------------------------------------------------------- 事件输出

export type EventSink = (event: AgentEvent) => void

// ---------------------------------------------------------------- 基础设施

export interface Clock {
  now(): number
}

export interface IdGenerator {
  newId(): string
}

// ---------------------------------------------------------------- 配置读取

export interface ConfigProvider {
  get(): Promise<AppConfig>
}
