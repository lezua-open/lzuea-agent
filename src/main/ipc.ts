import { dialog, ipcMain, type BrowserWindow } from 'electron'
import type {
  AgentEvent,
  AppConfig,
  ApprovalDecision,
  ChatMessage,
  ConversationSummary,
  MemoryEntry,
  ProviderConfig
} from '@shared/types'
import type { AgentRuntime } from '@core/agent/runtime'
import type { ApprovalGate, EventSink, MemoryRepository, MessageStore } from '@core/ports'
import { toAgentError } from '@core/errors'
import type { JsonConfigStore } from './config'
import { activeProviderConfig } from './config'

/**
 * IPC 边界。
 *
 * 只做「把渲染进程的调用翻译成 core 的调用」，不放业务逻辑 ——
 * 业务在 core，数据在 store，这里只是接线。
 *
 * 错误处理约定：handler 抛 Error，渲染进程收到 reject，读 err.message 展示。
 * 运行中的失败（模型报错、工具失败）不走这里，走 agent:event 的 error 事件。
 */

export interface AppServices {
  store: MessageStore & { adoptTitleFromFirstMessage(id: string, text: string): Promise<void> }
  memory: MemoryRepository
  config: JsonConfigStore
  runtime: AgentRuntime
  gate: ApprovalGate
  emit: EventSink
  window: BrowserWindow
}

export const CHANNELS = {
  conversationsList: 'conversations:list',
  conversationsCreate: 'conversations:create',
  conversationsDelete: 'conversations:delete',
  conversationsRename: 'conversations:rename',
  messagesGet: 'messages:get',
  agentSend: 'agent:send',
  agentStop: 'agent:stop',
  agentRespond: 'agent:respondToApproval',
  configGet: 'config:get',
  configSet: 'config:set',
  configPickWorkspace: 'config:pickWorkspace',
  memoryList: 'memory:list',
  memoryDelete: 'memory:delete',
  event: 'agent:event'
} as const

export function registerIpc(services: AppServices): void {
  const { store, memory, config, runtime, gate, emit, window } = services

  // ------------------------------------------------------------ 会话

  ipcMain.handle(CHANNELS.conversationsList, async (): Promise<ConversationSummary[]> => {
    return store.listConversations()
  })

  ipcMain.handle(
    CHANNELS.conversationsCreate,
    async (_e, title?: string): Promise<ConversationSummary> => {
      return store.createConversation(title)
    }
  )

  ipcMain.handle(CHANNELS.conversationsDelete, async (_e, id: string): Promise<void> => {
    runtime.stop(id)
    await store.deleteConversation(id)
  })

  ipcMain.handle(
    CHANNELS.conversationsRename,
    async (_e, id: string, title: string): Promise<void> => {
      await store.renameConversation(id, title)
    }
  )

  ipcMain.handle(CHANNELS.messagesGet, async (_e, id: string): Promise<ChatMessage[]> => {
    return store.getMessages(id)
  })

  // ------------------------------------------------------------ Agent

  ipcMain.handle(
    CHANNELS.agentSend,
    async (_e, conversationId: string, text: string): Promise<void> => {
      // 标题随首条消息定下来，先做这一步再开跑，会话列表立刻就有意义
      await store.adoptTitleFromFirstMessage(conversationId, text)

      // 刻意不 await：一次 run 可能跑好几分钟，
      // 完成与否由 agent:event 的 done 表达，这里只是「投递成功」。
      void runtime.run({ conversationId, text }).catch((err: unknown) => {
        // 前置条件错误（会话不存在、重复运行）由 run() 抛出，没进事件流，在这里补上
        const e = toAgentError(err, 'SEND_FAILED')
        emit({ type: 'error', conversationId, message: e.toUserMessage() })
        emit({ type: 'done', conversationId })
      })
    }
  )

  ipcMain.handle(CHANNELS.agentStop, async (_e, conversationId: string): Promise<void> => {
    runtime.stop(conversationId)
  })

  ipcMain.handle(
    CHANNELS.agentRespond,
    async (_e, toolCallId: string, decision: ApprovalDecision): Promise<void> => {
      gate.respond(toolCallId, decision)
    }
  )

  // ------------------------------------------------------------ 配置

  ipcMain.handle(CHANNELS.configGet, async (): Promise<AppConfig> => {
    return config.get()
  })

  ipcMain.handle(CHANNELS.configSet, async (_e, patch: Partial<AppConfig>): Promise<AppConfig> => {
    return config.set(patch)
  })

  ipcMain.handle(CHANNELS.configPickWorkspace, async (): Promise<string | null> => {
    const current = await config.get()
    const result = await dialog.showOpenDialog(window, {
      title: '选择工作区',
      properties: ['openDirectory', 'createDirectory'],
      ...(current.workspaceRoot ? { defaultPath: current.workspaceRoot } : {})
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const picked = result.filePaths[0]
    await config.set({ workspaceRoot: picked })
    return picked
  })

  // ------------------------------------------------------------ 记忆

  ipcMain.handle(CHANNELS.memoryList, async (): Promise<MemoryEntry[]> => {
    return memory.list()
  })

  ipcMain.handle(CHANNELS.memoryDelete, async (_e, id: string): Promise<void> => {
    await memory.deleteById(id)
  })
}

/** 主动校验一下当前配置是否可用，供启动时提示用户 */
export async function configHealthCheck(config: JsonConfigStore): Promise<string | null> {
  const cfg = await config.get()
  const { kind, config: pc }: { kind: string; config: ProviderConfig } = activeProviderConfig(cfg)

  if (!cfg.workspaceRoot) return '还没有选择工作区，Agent 无法读写文件。'
  if (!pc.apiKey && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return `${kind} 通道没有配置 API Key，请求会失败。`
  }
  if (kind === 'openai' && !pc.model) return 'OpenAI 兼容通道没有填模型名称。'
  return null
}

/** 把事件推给渲染进程 */
export function createEventSink(window: BrowserWindow): EventSink {
  return (event: AgentEvent) => {
    if (window.isDestroyed()) return
    window.webContents.send(CHANNELS.event, event)
  }
}
