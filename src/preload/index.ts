import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentAPI,
  AgentEvent,
  AppConfig,
  ApprovalDecision,
  ChatMessage,
  ConversationSummary,
  MemoryEntry
} from '@shared/types'

/**
 * 渲染进程唯一能用的入口。
 *
 * contextIsolation 开着、nodeIntegration 关着 —— 渲染层拿不到 Node，
 * 也不该拿。所有跨进程调用都收敛在这个对象上，改接口就是改 @shared/types 里的 AgentAPI。
 */

const api: AgentAPI = {
  listConversations: (): Promise<ConversationSummary[]> => ipcRenderer.invoke('conversations:list'),
  createConversation: (title?: string): Promise<ConversationSummary> =>
    ipcRenderer.invoke('conversations:create', title),
  deleteConversation: (id: string): Promise<void> => ipcRenderer.invoke('conversations:delete', id),
  renameConversation: (id: string, title: string): Promise<void> =>
    ipcRenderer.invoke('conversations:rename', id, title),
  getMessages: (conversationId: string): Promise<ChatMessage[]> =>
    ipcRenderer.invoke('messages:get', conversationId),

  send: (conversationId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('agent:send', conversationId, text),
  stop: (conversationId: string): Promise<void> => ipcRenderer.invoke('agent:stop', conversationId),
  respondToApproval: (toolCallId: string, decision: ApprovalDecision): Promise<void> =>
    ipcRenderer.invoke('agent:respondToApproval', toolCallId, decision),

  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Partial<AppConfig>): Promise<AppConfig> =>
    ipcRenderer.invoke('config:set', patch),
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('config:pickWorkspace'),

  listMemory: (): Promise<MemoryEntry[]> => ipcRenderer.invoke('memory:list'),
  deleteMemory: (id: string): Promise<void> => ipcRenderer.invoke('memory:delete', id),

  onAgentEvent: (listener: (event: AgentEvent) => void): (() => void) => {
    const wrapper = (_e: Electron.IpcRendererEvent, event: AgentEvent): void => listener(event)
    ipcRenderer.on('agent:event', wrapper)
    return () => {
      ipcRenderer.removeListener('agent:event', wrapper)
    }
  }
}

contextBridge.exposeInMainWorld('agent', api)
