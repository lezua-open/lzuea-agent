import { useSyncExternalStore } from 'react'
import type {
  AgentEvent,
  AppConfig,
  ApprovalDecision,
  ApprovalPreview,
  ChatMessage,
  ContentBlock,
  ConversationSummary,
  MemoryEntry,
  RiskLevel
} from '@shared/types'
import { api } from '../api'

/**
 * 渲染进程的状态中枢。
 *
 * 用一个外部 store + useSyncExternalStore，而不是 Context + useReducer：
 * 流式事件每秒可能来几十条，外部 store 能精确控制什么时候通知 React，
 * 不会因为把 dispatch 塞进事件回调而把整棵树抖散。
 *
 * 运行期的展示状态（liveTurns）和持久化状态（messages）是分开的 ——
 * 前者由事件流驱动，后者在 run 结束时从数据库整体重读，避免两边对账。
 */

// ---------------------------------------------------------------- 状态

export type View = 'chat' | 'settings' | 'memory'

export type ToolStatus = 'streaming' | 'awaiting_approval' | 'running' | 'done' | 'error'

export interface LiveTool {
  toolCallId: string
  name: string
  input: Record<string, unknown>
  risk: RiskLevel
  status: ToolStatus
  jsonBuffer: string
  result?: string
  isError?: boolean
}

export type LiveSegment =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; tool: LiveTool }

export interface LiveTurn {
  messageId: string
  segments: LiveSegment[]
  status: 'streaming' | 'done' | 'error'
  stopReason?: string
}

export interface ApprovalState {
  toolCallId: string
  name: string
  input: Record<string, unknown>
  risk: RiskLevel
  preview: ApprovalPreview
}

export interface StoreState {
  view: View
  conversations: ConversationSummary[]
  activeId: string | null
  messages: ChatMessage[]
  liveTurns: LiveTurn[]
  running: boolean
  approval: ApprovalState | null
  config: AppConfig | null
  memory: MemoryEntry[]
  toast: string | null
  /** 进程级错误（模型鉴权、存储失败），不是工具错误 */
  fatalError: string | null
  ready: boolean
}

const initialState: StoreState = {
  view: 'chat',
  conversations: [],
  activeId: null,
  messages: [],
  liveTurns: [],
  running: false,
  approval: null,
  config: null,
  memory: [],
  toast: null,
  fatalError: null,
  ready: false
}

// ---------------------------------------------------------------- Store

type Listener = () => void

class AgentStore {
  private state: StoreState = initialState
  private listeners = new Set<Listener>()
  private unsubEvents: (() => void) | null = null
  /** init 幂等：StrictMode 会把 effect 跑两遍，不能因此订两次事件 */
  private initPromise: Promise<void> | null = null

  // ------------------------------------------------------------ 订阅

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): StoreState => this.state

  private set(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  /**
   * 提示条。公开是因为复制、点赞这类纯 UI 反馈也要走它 ——
   * 统一入口才能统一「2.5 秒后消失」这条规则（计时在 App 里）。
   */
  showToast(message: string): void {
    this.set({ toast: message })
  }

  // ------------------------------------------------------------ 启动

  init(): Promise<void> {
    this.initPromise ??= this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    try {
      const [conversations, config, memory] = await Promise.all([
        api.listConversations(),
        api.getConfig(),
        api.listMemory()
      ])

      this.unsubEvents = api.onAgentEvent((e) => void this.handleEvent(e))

      const activeId = conversations[0]?.id ?? null
      this.set({ conversations, config, memory, activeId, ready: true })

      if (activeId) await this.loadMessages(activeId)
    } catch (err) {
      // 初始化失败不能停在启动页上转圈，把原因摆出来
      this.set({
        ready: true,
        fatalError: `初始化失败：${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  dispose(): void {
    this.unsubEvents?.()
    this.unsubEvents = null
  }

  // ------------------------------------------------------------ 会话

  async refreshConversations(): Promise<void> {
    const conversations = await api.listConversations()
    this.set({ conversations })
  }

  async selectConversation(id: string): Promise<void> {
    if (id === this.state.activeId) return
    this.set({ activeId: id, liveTurns: [], approval: null })
    await this.loadMessages(id)
  }

  async createConversation(): Promise<void> {
    const created = await api.createConversation()
    await this.refreshConversations()
    this.set({ activeId: created.id, messages: [], liveTurns: [], approval: null, view: 'chat' })
  }

  async deleteConversation(id: string): Promise<void> {
    await api.deleteConversation(id)
    await this.refreshConversations()
    if (this.state.activeId === id) {
      const next = this.state.conversations[0]?.id ?? null
      this.set({ activeId: next, messages: [], liveTurns: [], approval: null })
      if (next) await this.loadMessages(next)
    }
  }

  async renameConversation(id: string, title: string): Promise<void> {
    await api.renameConversation(id, title)
    await this.refreshConversations()
  }

  private async loadMessages(conversationId: string): Promise<void> {
    const messages = await api.getMessages(conversationId)
    if (this.state.activeId !== conversationId) return
    this.set({ messages })
  }

  // ------------------------------------------------------------ Agent

  async send(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || this.state.running) return

    // 没有会话就地开一个。用户是为了说话来的，不该先去点「新建会话」——
    // 那个按钮在空态里很容易被当成装饰，然后发送键灰着，没人知道为什么。
    if (!this.state.activeId) {
      const created = await api.createConversation()
      await this.refreshConversations()
      this.set({
        activeId: created.id,
        messages: [],
        liveTurns: [],
        approval: null,
        view: 'chat'
      })
    }

    const activeId = this.state.activeId
    if (!activeId) return

    // 输入先本地垫一条，不用等数据库回读
    const optimistic: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      role: 'user',
      blocks: [{ type: 'text', text: trimmed }],
      createdAt: Date.now()
    }

    this.set({
      running: true,
      messages: [...this.state.messages, optimistic],
      liveTurns: [],
      approval: null,
      fatalError: null,
      view: 'chat'
    })

    try {
      await api.send(activeId, trimmed)
    } catch (err) {
      this.set({ running: false })
      this.showToast(err instanceof Error ? err.message : String(err))
    }
  }

  stop(): void {
    if (!this.state.activeId) return
    void api.stop(this.state.activeId)
  }

  async respondToApproval(decision: ApprovalDecision): Promise<void> {
    const approval = this.state.approval
    if (!approval) return
    this.set({ approval: null })
    await api.respondToApproval(approval.toolCallId, decision)
  }

  // ------------------------------------------------------------ 配置 / 记忆

  setView(view: View): void {
    this.set({ view })
  }

  async saveConfig(patch: Partial<AppConfig>): Promise<void> {
    const config = await api.setConfig(patch)
    this.set({ config })
    this.showToast('设置已保存')
  }

  /** 打开目录选择框。返回用户选的路径，取消则为 null —— 设置页要据此回填输入框 */
  async pickWorkspace(): Promise<string | null> {
    const picked = await api.pickWorkspace()
    if (!picked) return null
    const config = await api.getConfig()
    this.set({ config })
    return picked
  }

  async refreshMemory(): Promise<void> {
    const memory = await api.listMemory()
    this.set({ memory })
  }

  async deleteMemory(id: string): Promise<void> {
    await api.deleteMemory(id)
    await this.refreshMemory()
  }

  dismissToast(): void {
    this.set({ toast: null })
  }

  dismissFatalError(): void {
    this.set({ fatalError: null })
  }

  // ------------------------------------------------------------ 事件

  private async handleEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'message_start': {
        this.set({
          liveTurns: [
            ...this.state.liveTurns,
            { messageId: event.messageId, segments: [], status: 'streaming' }
          ]
        })
        return
      }

      case 'text_delta':
      case 'thinking_delta': {
        const kind = event.type === 'text_delta' ? 'text' : 'thinking'
        this.appendTextSegment(event.messageId, kind, event.text)
        return
      }

      case 'tool_call_start': {
        this.addToolSegment(event.messageId, {
          toolCallId: event.toolCallId,
          name: event.name,
          input: {},
          risk: event.risk,
          status: 'streaming',
          jsonBuffer: ''
        })
        return
      }

      case 'tool_call_input': {
        this.mutateTool(event.toolCallId, (t) => {
          t.jsonBuffer += event.jsonDelta
        })
        return
      }

      case 'tool_call_ready': {
        this.mutateTool(event.toolCallId, (t) => {
          t.input = event.input
          t.status = 'running'
        })
        return
      }

      case 'approval_required': {
        this.mutateTool(event.toolCallId, (t) => {
          t.status = 'awaiting_approval'
          t.input = event.input
        })
        this.set({
          approval: {
            toolCallId: event.toolCallId,
            name: event.name,
            input: event.input,
            risk: event.risk,
            preview: event.preview
          }
        })
        return
      }

      case 'tool_call_result': {
        this.mutateTool(event.toolCallId, (t) => {
          t.status = 'done'
          t.result = event.result
          t.isError = event.isError
        })
        return
      }

      case 'message_end': {
        this.mutateTurn(event.messageId, (turn) => {
          turn.status = 'done'
          turn.stopReason = event.stopReason
        })
        return
      }

      case 'error': {
        // conversationId 为空 = 进程级提示（配置没配好之类）
        if (!event.conversationId) {
          this.set({ fatalError: event.message })
        } else {
          this.showToast(event.message)
        }
        return
      }

      case 'done': {
        // 先把持久化的内容读回来，再清掉流式状态 —— 中间不会有空窗
        const activeId = this.state.activeId
        if (activeId) await this.loadMessages(activeId)
        await this.refreshConversations()
        this.set({ running: false, liveTurns: [], approval: null })
        return
      }
    }
  }

  private appendTextSegment(messageId: string, kind: 'text' | 'thinking', text: string): void {
    this.mutateTurn(messageId, (turn) => {
      const last = turn.segments[turn.segments.length - 1]
      // 同类增量拼到同一段上，避免每个 token 都生成一个节点
      if (last && last.kind === kind) {
        last.text += text
        return
      }
      turn.segments.push(kind === 'text' ? { kind: 'text', text } : { kind: 'thinking', text })
    })
  }

  private addToolSegment(messageId: string, tool: LiveTool): void {
    this.mutateTurn(messageId, (turn) => {
      turn.segments.push({ kind: 'tool', tool })
    })
  }

  private mutateTurn(messageId: string, fn: (turn: LiveTurn) => void): void {
    const liveTurns = this.state.liveTurns.map((t) => {
      if (t.messageId !== messageId) return t
      const draft: LiveTurn = {
        ...t,
        segments: t.segments.map((s) =>
          s.kind === 'tool' ? { kind: 'tool', tool: { ...s.tool } } : { ...s }
        )
      }
      fn(draft)
      return draft
    })
    this.set({ liveTurns })
  }

  private mutateTool(toolCallId: string, fn: (tool: LiveTool) => void): void {
    const liveTurns = this.state.liveTurns.map((turn) => ({
      ...turn,
      segments: turn.segments.map((s) => {
        if (s.kind !== 'tool' || s.tool.toolCallId !== toolCallId) return s
        const tool = { ...s.tool }
        fn(tool)
        return { kind: 'tool' as const, tool }
      })
    }))
    this.set({ liveTurns })
  }
}

export const agentStore = new AgentStore()

export function useAgentStore(): StoreState {
  return useSyncExternalStore(agentStore.subscribe, agentStore.getState, agentStore.getState)
}

// ---------------------------------------------------------------- 块工具

/** 把消息里的块拼成便于渲染的形态 */
export function summarizeBlocks(blocks: ContentBlock[]): {
  hasText: boolean
  hasThinking: boolean
  toolCount: number
} {
  let hasText = false
  let hasThinking = false
  let toolCount = 0
  for (const b of blocks) {
    if (b.type === 'text' && b.text.trim()) hasText = true
    else if (b.type === 'thinking' && b.text.trim()) hasThinking = true
    else if (b.type === 'tool_use') toolCount++
  }
  return { hasText, hasThinking, toolCount }
}
