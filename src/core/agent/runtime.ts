import type { AppConfig, ProviderConfig, RiskLevel } from '@shared/types'
import {
  ModelError,
  ModelRefusalError,
  ModelTruncatedError,
  UserError,
  type AgentError,
  toAgentError
} from '@core/errors'
import type {
  ApprovalGate,
  Clock,
  ConfigProvider,
  EventSink,
  IdGenerator,
  MemoryRepository,
  MessageStore
} from '@core/ports'
import type { Logger } from '@core/logging'
import { estimateTokens, fitToBudget, type ContextBudget } from '@core/context/tokens'
import type {
  ModelProvider,
  ModelProviderFactory,
  NeutralBlock,
  NeutralMessage,
  StopReason,
  ToolDefinition
} from '@core/providers/types'
import type { ToolRegistry } from '@core/tools/registry'
import type { ToolExecutionContext } from '@core/tools/types'
import { buildSystemPrompt } from './prompts'
import { toChatMessage, toNeutralMessage, toolUseBlocks } from './messages'

/**
 * Agent 主循环。
 *
 * 一次 run = 用户说一句话 → 反复「模型产出 → 执行工具 → 把结果喂回去」，
 * 直到模型不再要工具，或者撞上轮数上限。
 *
 * 职责边界（重要）：
 *  - 这里只做编排和事件流。审批、超时、沙箱都在 ToolRegistry 的中间件里，
 *    循环完全不知道「危险操作要确认」这回事 —— 换审批策略不用动这里。
 *  - 持久化、记忆、配置都是端口，core 不碰 SQLite / Electron。
 *  - Provider 是中立契约，Claude / OpenAI 兼容在适配器里翻译。
 */

// ---------------------------------------------------------------- 依赖

export interface AgentRuntimeDeps {
  store: MessageStore
  memory: MemoryRepository
  registry: ToolRegistry
  providerFactory: ModelProviderFactory
  config: ConfigProvider
  /** 中止一次 run 时要一并解开卡住的审批请求 */
  gate: ApprovalGate
  logger: Logger
  clock: Clock
  ids: IdGenerator
  emit: EventSink
  /** 写进系统提示词，例如 win32 / darwin / linux */
  platform: string
}

export interface RunInput {
  conversationId: string
  text: string
  /** 调用方自带的取消信号（例如窗口关闭） */
  signal?: AbortSignal
}

export interface RunResult {
  /** 最后一条 assistant 消息 */
  messageId: string
  stopReason: StopReason
  /** 本次 run 的模型调用次数 */
  iterations: number
  /** 非空表示以失败收尾；事件流里也已经 emit 过 error */
  error?: AgentError
}

// ---------------------------------------------------------------- 运行时

export class AgentRuntime {
  /** 每个会话同一时刻只允许一个 run，避免历史被两个循环同时改写 */
  private readonly active = new Map<string, AbortController>()

  constructor(private readonly deps: AgentRuntimeDeps) {}

  isRunning(conversationId: string): boolean {
    return this.active.has(conversationId)
  }

  /**
   * 停掉某个会话正在跑的 run。
   * 同时解开等待中的审批请求，否则工具调用会一直卡在确认框上。
   */
  stop(conversationId: string): void {
    const controller = this.active.get(conversationId)
    if (!controller) return
    controller.abort(new UserError('用户停止了本次运行', { code: 'RUN_ABORTED' }))
    this.deps.gate.cancelAll('用户停止了本次运行')
  }

  /**
   * 执行一次完整的「用户输入 → 模型/工具循环」。
   *
   * 抛出去的只有前置条件错误（空输入、会话不存在、重复运行）。
   * 运行中的失败（鉴权、限流、模型拒绝…）不抛，走 `result.error` +
   * 事件流里的 `error` —— 渲染层只订阅事件就够。
   */
  async run(input: RunInput): Promise<RunResult> {
    const { conversationId, text } = input
    const deps = this.deps

    if (!text.trim()) {
      throw new UserError('输入内容不能为空', { code: 'EMPTY_INPUT' })
    }
    if (!(await deps.store.exists(conversationId))) {
      throw new UserError('会话不存在或已被删除', {
        code: 'CONVERSATION_NOT_FOUND',
        hint: '重新选一个会话再试。'
      })
    }
    if (this.active.has(conversationId)) {
      throw new UserError('这个会话已经有任务在执行', {
        code: 'RUN_IN_PROGRESS',
        hint: '等它结束，或者先点「停止」。'
      })
    }

    const controller = new AbortController()
    this.active.set(conversationId, controller)

    const onOuterAbort = (): void => {
      controller.abort(new UserError('用户停止了本次运行', { code: 'RUN_ABORTED' }))
      deps.gate.cancelAll('用户停止了本次运行')
    }
    input.signal?.addEventListener('abort', onOuterAbort, { once: true })

    const log = deps.logger.child({ conversationId })
    log.info('run started', { inputChars: text.length })

    try {
      const result = await this.executeRun({ ...input, signal: controller.signal, log })
      if (result.error) {
        log.warn('run finished with error', {
          code: result.error.code,
          iterations: result.iterations
        })
      } else {
        log.info('run finished', {
          iterations: result.iterations,
          stopReason: result.stopReason
        })
      }
      deps.emit({ type: 'done', conversationId })
      return result
    } finally {
      this.active.delete(conversationId)
      input.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  // ------------------------------------------------------------ 内部

  private async executeRun(
    input: RunInput & { signal: AbortSignal; log: Logger }
  ): Promise<RunResult> {
    const deps = this.deps
    const { conversationId, text, signal, log } = input

    let lastMessageId = ''
    let lastStopReason: StopReason = 'other'
    let iterations = 0

    const abortedError = (): UserError =>
      toAgentError(signal.reason) instanceof UserError
        ? (signal.reason as UserError)
        : new UserError('用户停止了本次运行', { code: 'RUN_ABORTED' })

    const fail = (e: AgentError): RunResult => {
      deps.emit({ type: 'error', conversationId, message: e.toUserMessage() })
      return { messageId: lastMessageId, stopReason: lastStopReason, iterations, error: e }
    }

    try {
      const cfg = await deps.config.get()
      const providerCfg = resolveProviderConfig(cfg)
      const provider = deps.providerFactory.create(cfg.provider, providerCfg)

      // 1. 用户消息先落库，历史才完整
      const userMessage = toChatMessage(
        deps.ids.newId(),
        'user',
        [{ type: 'text', text }],
        deps.clock.now()
      )
      await deps.store.appendMessage(conversationId, userMessage)

      // 2. 从存储载入全量历史（含刚写入的这条）
      const stored = await deps.store.getMessages(conversationId)
      const history: NeutralMessage[] = stored.map(toNeutralMessage)

      // 3. 长期记忆召回 —— 和会话历史是两回事，只取跟当前问题相关的几条
      const memories = await deps.memory.recall(text, 5)

      // 4. 系统提示词
      const system = buildSystemPrompt({
        workspaceRoot: cfg.workspaceRoot,
        platform: deps.platform,
        providerKind: cfg.provider,
        memories,
        today: new Date(deps.clock.now()).toISOString().slice(0, 10)
      })
      const systemTokens = estimateTokens(system)

      // 5. 发给模型的工具定义
      const modelTools = deps.registry.toModelTools({
        providerKind: cfg.provider,
        enableServerWebSearch: providerCfg.enableWebSearch
      })
      const toolsTokens = estimateTokens(JSON.stringify(modelTools))

      const budget: ContextBudget = {
        windowTokens: cfg.contextWindowTokens,
        reserveOutputTokens: cfg.maxOutputTokens
      }

      // 6. 模型 ↔ 工具 循环
      for (;;) {
        if (iterations >= cfg.maxToolIterations) {
          return fail(
            new ModelError(`工具调用轮数达到上限（${cfg.maxToolIterations} 轮）仍未完成`, {
              code: 'MAX_TOOL_ITERATIONS',
              hint: '把任务拆小一点再试，或者在设置里调高 maxToolIterations。'
            })
          )
        }
        iterations++

        const messageId = deps.ids.newId()
        lastMessageId = messageId
        const turnLog = log.child({ messageId, iteration: iterations })

        deps.emit({ type: 'message_start', conversationId, messageId })

        const { messages: toSend, trimmedCount } = fitToBudget(
          history,
          budget,
          systemTokens,
          toolsTokens
        )
        if (trimmedCount > 0) {
          turnLog.warn('context trimmed to fit budget', { trimmedCount })
        }

        const turn = await this.streamTurn({
          provider,
          system,
          messages: toSend,
          tools: modelTools,
          maxTokens: cfg.maxOutputTokens,
          signal,
          messageId
        })
        lastStopReason = turn.stopReason

        // 风险分级抄到 tool_use 上再落库：UI 要在历史里显示，但它看不到工具注册表。
        // provider 序列化时会把这个字段丢掉，不会发给模型。
        const blocks: NeutralBlock[] = turn.blocks.map((b): NeutralBlock =>
          b.type === 'tool_use' ? { ...b, risk: deps.registry.get(b.name)?.risk ?? 'read' } : b
        )

        // assistant 消息整体落库（含 thinking.raw / opaque，缺了下一轮会 400）
        if (blocks.length > 0) {
          const assistantMessage = toChatMessage(messageId, 'assistant', blocks, deps.clock.now())
          await deps.store.appendMessage(conversationId, assistantMessage)
          history.push({ role: 'assistant', blocks })
        }

        deps.emit({ type: 'message_end', messageId, stopReason: turn.stopReason })

        // 流中途挂了：部分内容已落库，直接收尾
        if (turn.error) return fail(turn.error)

        if (turn.stopReason === 'refusal') return fail(new ModelRefusalError())

        const toolUses = toolUseBlocks(blocks)

        if (toolUses.length === 0) {
          // pause_turn：模型在自然停顿点，把内容原样喂回去让它接着说
          if (turn.stopReason === 'pause_turn') continue
          if (turn.stopReason === 'max_tokens') {
            return fail(new ModelTruncatedError(cfg.maxOutputTokens))
          }
          return { messageId, stopReason: turn.stopReason, iterations }
        }

        // 执行工具。v0.1 串行 —— 一次只弹一个确认框，比并行更可预测；
        // registry.execute 之间互不依赖，以后要并行是局部改动。
        const results: NeutralBlock[] = []
        for (const tu of toolUses) {
          if (signal.aborted) return fail(abortedError())

          const tool = deps.registry.get(tu.name)
          const risk: RiskLevel = tool?.risk ?? 'read'

          deps.emit({
            type: 'tool_call_ready',
            messageId,
            toolCallId: tu.id,
            name: tu.name,
            input: tu.input,
            risk
          })

          const ctx: ToolExecutionContext = {
            workspaceRoot: cfg.workspaceRoot,
            memory: deps.memory,
            logger: turnLog.child({ toolCallId: tu.id, tool: tu.name }),
            clock: deps.clock,
            ids: deps.ids,
            conversationId,
            messageId,
            toolCallId: tu.id,
            signal
          }

          // execute 永远返回 ToolResult，不抛 —— 失败原因回传给模型自己纠正
          const result = await deps.registry.execute(tu.name, tu.input, ctx)

          deps.emit({
            type: 'tool_call_result',
            messageId,
            toolCallId: tu.id,
            result: result.content,
            isError: result.isError
          })

          results.push({
            type: 'tool_result',
            toolUseId: tu.id,
            content: result.content,
            isError: result.isError
          })
        }

        if (signal.aborted) return fail(abortedError())

        const resultMessage = toChatMessage(deps.ids.newId(), 'user', results, deps.clock.now())
        await deps.store.appendMessage(conversationId, resultMessage)
        history.push({ role: 'user', blocks: results })
      }
    } catch (err) {
      return fail(toAgentError(err, 'RUN_FAILED'))
    }
  }

  /**
   * 消费一次模型流，把中立事件翻译成 AgentEvent 发给 UI。
   *
   * Provider 保证无论成败最后都会 yield 一条 done（失败时带已累积的内容），
   * 所以这里不抛 —— 部分内容照样能落库，UI 和存储不会对不上。
   */
  private async streamTurn(args: {
    provider: ModelProvider
    system: string
    messages: NeutralMessage[]
    tools: ToolDefinition[]
    maxTokens: number
    signal: AbortSignal
    messageId: string
  }): Promise<{ blocks: NeutralBlock[]; stopReason: StopReason; error?: AgentError }> {
    const { provider, messageId } = args
    const { emit, registry } = this.deps

    const blocks: NeutralBlock[] = []
    let stopReason: StopReason = 'other'

    try {
      for await (const ev of provider.generate({
        system: args.system,
        messages: args.messages,
        tools: args.tools,
        maxTokens: args.maxTokens,
        signal: args.signal
      })) {
        switch (ev.type) {
          case 'text_delta':
            emit({ type: 'text_delta', messageId, text: ev.text })
            break
          case 'thinking_delta':
            emit({ type: 'thinking_delta', messageId, text: ev.text })
            break
          case 'tool_use_start':
            emit({
              type: 'tool_call_start',
              messageId,
              toolCallId: ev.id,
              name: ev.name,
              risk: registry.get(ev.name)?.risk ?? 'read'
            })
            break
          case 'tool_use_input_delta':
            emit({
              type: 'tool_call_input',
              messageId,
              toolCallId: ev.id,
              jsonDelta: ev.partialJson
            })
            break
          case 'done':
            blocks.push(...ev.blocks)
            stopReason = ev.stopReason
            break
        }
      }
      return { blocks, stopReason }
    } catch (err) {
      return { blocks, stopReason, error: toAgentError(err, 'MODEL_STREAM_FAILED') }
    }
  }
}

// ---------------------------------------------------------------- 工具

function resolveProviderConfig(cfg: AppConfig): ProviderConfig {
  return cfg.provider === 'anthropic' ? cfg.anthropic : cfg.openai
}
