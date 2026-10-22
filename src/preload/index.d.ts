import type { AgentAPI } from '@shared/types'

declare global {
  interface Window {
    /** 由 src/preload/index.ts 通过 contextBridge 注入 */
    agent: AgentAPI
  }
}

export {}
