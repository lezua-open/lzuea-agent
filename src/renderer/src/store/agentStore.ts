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
 *
 * **每会话独立的流式状态**：liveTurns / running / approval 都按 conversationId
 * 分别存放。事件按 messageId → conversationId 映射路由到所属会话，切走再切回
 * 不丢流；切到别的会话时旧会话的 run 可以继续在后台跑（或被显式 stop），
 * 不会把别会话的内容串到当前会话上。
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
  /** 当前会话的流式回合（派生自 liveTurnsByConvo） */
  liveTurns: LiveTurn[]
  /** 当前会话是否在运行（派生自 runningByConvo） */
  running: boolean
  /** 当前会话的待审批项（派生自 approvalsByConvo） */
  approval: ApprovalState | null
  config: AppConfig | null
  memory: MemoryEntry[]
  toast: string | null
  /** 进程级错误（模型鉴权、存储失败），不是工具错误 */
  fatalError: string | null
  ready: boolean
}

// ---------------------------------------------------------------- 内部状态形状

interface InternalState {
  view: View
  conversations: ConversationSummary[]
  activeId: string | null
  messages: ChatMessage[]
  /** 按 conversationId 索引的流式回合 */
  liveTurnsByConvo: Map<string, LiveTurn[]>
  /** 正在运行的会话集合 */
  runningByConvo: Set<string>
  /** 按 conversationId 索引的待审批项 */
  approvalsByConvo: Map<string, ApprovalState>
  config: AppConfig | null
  memory: MemoryEntry[]
  toast: string | null
  fatalError: string | null
  ready: boolean
}

const initialInternal: InternalState = {
  view: 'chat',
  conversations: [],
  activeId: null,
  messages: [],
  liveTurnsByConvo: new Map(),
  runningByConvo: new Set(),
  approvalsByConvo: new Map(),
  config: null,
  memory: [],
  toast: null,
  fatalError: null,
  ready: false
}

/** 空会话的 liveTurns 共用一份稳定引用，避免 getState 每次创建新数组 */
const EMPTY_LIVE_TURNS: LiveTurn[] = []

// ---------------------------------------------------------------- Store

type Listener = () => void

class AgentStore {
  private internal: InternalState = initialInternal
  /** messageId → conversationId，用于把只有 messageId 的事件路由到正确会话 */
  private readonly messageConvos = new Map<string, string>()
  private listeners = new Set<Listener>()
  private unsubEvents: (() => void) | null = null
  /** init 幂等：StrictMode 会把 effect 跑两遍，不能因此订两次事件 */
  private initPromise: Promise<void> | null = null
  /**
   * 派生 StoreState 的缓存。useSyncExternalStore 要求 getSnapshot 在两次
   * emit 之间返回引用相等的对象，否则会抛 "getSnapshot should be cached"。
   * 派生 getState 每次都 new 一个对象，引用永远不等 —— 所以缓存起来，
   * 只在 emit（内部状态变了）时失效重算。
   */
  private cachedState: StoreState | null = null

  // ------------------------------------------------------------ 订阅

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 把内部状态投影成 UI 看的 StoreState：liveTurns / running / approval
   * 都派生为「当前会话的」。UI 层只认 StoreState，不感知多会话存储。
   */
  getState = (): StoreState => {
    if (this.cachedState) return this.cachedState
    const i = this.internal
    const activeId = i.activeId
    this.cachedState = {
      view: i.view,
      conversations: i.conversations,
      activeId,
      messages: i.messages,
      liveTurns: activeId
        ? (i.liveTurnsByConvo.get(activeId) ?? EMPTY_LIVE_TURNS)
        : EMPTY_LIVE_TURNS,
      running: activeId ? i.runningByConvo.has(activeId) : false,
      approval: activeId ? (i.approvalsByConvo.get(activeId) ?? null) : null,
      config: i.config,
      memory: i.memory,
      toast: i.toast,
      fatalError: i.fatalError,
      ready: i.ready
    }
    return this.cachedState
  }

  private emit(): void {
    // 失效缓存：下次 getState 会重算
    this.cachedState = null
    for (const l of this.listeners) l()
  }

  private patch(p: Partial<InternalState>): void {
    this.internal = { ...this.internal, ...p }
    this.emit()
  }

  /** 提示条。公开是因为复制、点赞这类纯 UI 反馈也要走它 ——
   *  统一入口才能统一「2.5 秒后消失」这条规则（计时在 App 里）。 */
  showToast(message: string): void {
    this.patch({ toast: message })
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
      this.patch({ conversations, config, memory, activeId, ready: true })

      if (activeId) await this.loadMessages(activeId)
    } catch (err) {
      // 初始化失败不能停在启动页上转圈，把原因摆出来
      this.patch({
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
    this.patch({ conversations })
  }

  async selectConversation(id: string): Promise<void> {
    if (id === this.internal.activeId) return
    // 旧会话的 run 在后台继续跑（按会话独立存储 + 事件路由保证不污染当前会话）。
    // 切回时能读到已流出的内容；用户想停可以手动点「停止」。
    this.patch({ activeId: id, messages: [] })
    await this.loadMessages(id)
  }

  async createConversation(): Promise<void> {
    // 同上：不停止旧会话的 run，让它后台继续生成
    const created = await api.createConversation()
    await this.refreshConversations()
    this.patch({ activeId: created.id, messages: [], view: 'chat' })
  }

  async deleteConversation(id: string): Promise<void> {
    await api.deleteConversation(id)
    await this.refreshConversations()
    if (this.internal.activeId === id) {
      const next = this.internal.conversations[0]?.id ?? null
      this.patch({ activeId: next, messages: [] })
      if (next) await this.loadMessages(next)
    }
  }

  async renameConversation(id: string, title: string): Promise<void> {
    await api.renameConversation(id, title)
    await this.refreshConversations()
  }

  private async loadMessages(conversationId: string): Promise<void> {
    const messages = await api.getMessages(conversationId)
    // 异步期间用户可能又切走了，落盘前确认还是当前会话
    if (this.internal.activeId !== conversationId) return
    this.patch({ messages })
  }

  // ------------------------------------------------------------ Agent

  async send(text: string): Promise<void> {
    const trimmed = text.trim()
    const activeId = this.internal.activeId
    if (!trimmed) return
    // 当前会话已在运行就不接新输入
    if (activeId && this.internal.runningByConvo.has(activeId)) return

    // 没有会话就地开一个。用户是为了说话来的，不该先去点「新建会话」——
    // 那个按钮在空态里很容易被当成装饰，然后发送键灰着，没人知道为什么。
    let convoId = activeId
    if (!convoId) {
      const created = await api.createConversation()
      await this.refreshConversations()
      convoId = created.id
      this.patch({ activeId: convoId, messages: [], view: 'chat' })
    }

    // 输入先本地垫一条，不用等数据库回读
    const optimistic: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      role: 'user',
      blocks: [{ type: 'text', text: trimmed }],
      createdAt: Date.now()
    }

    this.internal.runningByConvo.add(convoId)
    this.patch({
      messages: [...this.internal.messages, optimistic],
      fatalError: null,
      view: 'chat'
    })
    // 清掉这个会话的旧 liveTurns（新一轮要开始）
    this.internal.liveTurnsByConvo.delete(convoId)
    this.emit()

    try {
      await api.send(convoId, trimmed)
    } catch (err) {
      this.internal.runningByConvo.delete(convoId)
      this.emit()
      this.showToast(err instanceof Error ? err.message : String(err))
    }
  }

  stop(): void {
    if (!this.internal.activeId) return
    void api.stop(this.internal.activeId)
  }

  async respondToApproval(decision: ApprovalDecision): Promise<void> {
    const activeId = this.internal.activeId
    const approval = activeId ? this.internal.approvalsByConvo.get(activeId) : null
    if (!approval) return
    this.internal.approvalsByConvo.delete(activeId ?? '')
    this.emit()
    await api.respondToApproval(approval.toolCallId, decision)
  }

  // ------------------------------------------------------------ 配置 / 记忆

  setView(view: View): void {
    this.patch({ view })
  }

  async saveConfig(patch: Partial<AppConfig>): Promise<void> {
    const config = await api.setConfig(patch)
    this.patch({ config })
    this.showToast('设置已保存')
  }

  /** 打开目录选择框。返回用户选的路径，取消则为 null —— 设置页要据此回填输入框 */
  async pickWorkspace(): Promise<string | null> {
    const picked = await api.pickWorkspace()
    if (!picked) return null
    const config = await api.getConfig()
    this.patch({ config })
    return picked
  }

  async refreshMemory(): Promise<void> {
    const memory = await api.listMemory()
    this.patch({ memory })
  }

  async deleteMemory(id: string): Promise<void> {
    await api.deleteMemory(id)
    await this.refreshMemory()
  }

  dismissToast(): void {
    this.patch({ toast: null })
  }

  dismissFatalError(): void {
    this.patch({ fatalError: null })
  }

  // ------------------------------------------------------------ 事件

  private async handleEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'message_start': {
        const { conversationId, messageId } = event
        // 记下 messageId → conversationId，后续只有 messageId 的事件靠它路由
        this.messageConvos.set(messageId, conversationId)
        const turns = this.internal.liveTurnsByConvo.get(conversationId) ?? []
        this.internal.liveTurnsByConvo.set(conversationId, [
          ...turns,
          { messageId, segments: [], status: 'streaming' }
        ])
        this.emit()
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
        const convoId = this.messageConvos.get(event.messageId)
        if (!convoId) return
        this.mutateTool(event.toolCallId, (t) => {
          t.status = 'awaiting_approval'
          t.input = event.input
        })
        this.internal.approvalsByConvo.set(convoId, {
          toolCallId: event.toolCallId,
          name: event.name,
          input: event.input,
          risk: event.risk,
          preview: event.preview
        })
        this.emit()
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
          this.patch({ fatalError: event.message })
        } else {
          this.showToast(event.message)
        }
        return
      }

      case 'done': {
        const { conversationId } = event
        this.internal.runningByConvo.delete(conversationId)
        this.internal.liveTurnsByConvo.delete(conversationId)
        this.internal.approvalsByConvo.delete(conversationId)
        // 清理这个会话的 messageId 映射（防止 Map 无限增长）
        for (const [msgId, convo] of this.messageConvos) {
          if (convo === conversationId) this.messageConvos.delete(msgId)
        }
        this.emit()

        // 只有当前会话才需要重读持久化消息；非当前会话下次切回时 loadMessages 会读
        if (this.internal.activeId === conversationId) {
          await this.loadMessages(conversationId)
          await this.refreshConversations()
        } else {
          // 非当前会话结束也要刷新会话列表（标题、updatedAt、messageCount 变了）
          void this.refreshConversations()
        }
        return
      }
    }
  }

  // ------------------------------------------------------------ 内部：按 messageId 定位会话再改

  /** 找到 messageId 所属会话，对其 liveTurns 做修改 */
  private mutateTurn(messageId: string, fn: (turn: LiveTurn) => void): void {
    const convoId = this.messageConvos.get(messageId)
    if (!convoId) return
    const turns = this.internal.liveTurnsByConvo.get(convoId)
    if (!turns) return
    const next = turns.map((t) => {
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
    this.internal.liveTurnsByConvo.set(convoId, next)
    this.emit()
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

  /** 找到 toolCallId 所属会话再改工具状态 */
  private mutateTool(toolCallId: string, fn: (tool: LiveTool) => void): void {
    // 工具调用属于哪个会话要靠遍历 liveTurnsByConvo 找
    let foundConvo: string | null = null
    for (const [convoId, turns] of this.internal.liveTurnsByConvo) {
      for (const t of turns) {
        for (const s of t.segments) {
          if (s.kind === 'tool' && s.tool.toolCallId === toolCallId) {
            foundConvo = convoId
            break
          }
        }
        if (foundConvo) break
      }
      if (foundConvo) break
    }
    if (!foundConvo) return

    const turns = this.internal.liveTurnsByConvo.get(foundConvo) ?? []
    const next = turns.map((turn) => ({
      ...turn,
      segments: turn.segments.map((s) => {
        if (s.kind !== 'tool' || s.tool.toolCallId !== toolCallId) return s
        const tool = { ...s.tool }
        fn(tool)
        return { kind: 'tool' as const, tool }
      })
    }))
    this.internal.liveTurnsByConvo.set(foundConvo, next)
    this.emit()
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
