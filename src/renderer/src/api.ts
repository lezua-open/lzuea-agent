import type { AgentAPI } from '@shared/types'

/**
 * 渲染进程访问主进程的唯一入口。
 *
 * preload 通过 contextBridge 把 AgentAPI 挂到 window.agent 上。
 * 这层不做事，只做一件事：preload 没跑起来时给出可读的错误，
 * 而不是满屏 `undefined is not a function`。
 */
function resolveApi(): AgentAPI {
  const injected: AgentAPI | undefined = typeof window === 'undefined' ? undefined : window.agent

  if (!injected) {
    throw new Error(
      'window.agent 未注入：preload 脚本没有执行，或者当前不在 Electron 环境里。' +
        '请通过 `npm run dev` 启动，不要直接用浏览器打开 index.html。'
    )
  }
  return injected
}

export const api: AgentAPI = resolveApi()
