import type { ReactNode } from 'react'

/**
 * 视图保活边界。
 *
 * 切走时用 `display: none` 隐藏子树而非卸载——组件实例、ref、effect 状态全部保留。
 * 用于带活动流式状态的视图（如 ChatView）：切到别的视图再切回来，流式渲染连续不中断。
 *
 * `display: none` 下子树不参与渲染，但 React 仍正常 re-render，store 订阅和事件回调照常工作。
 * 活跃时用 `display: contents` 让保活容器自身不生成盒子，子元素直接参与父级布局，
 * 不引入额外的布局层。
 *
 * 只对「有活动状态、卸载会丢东西」的视图用。无状态视图（设置、记忆面板）
 * 继续走条件渲染，不必保活。
 */
interface KeepAliveProps {
  /** 当前是否可见。false 时子树 display:none 但不卸载 */
  active: boolean
  children: ReactNode
}

export function KeepAlive({ active, children }: KeepAliveProps): React.JSX.Element {
  return <div style={active ? { display: 'contents' } : { display: 'none' }}>{children}</div>
}
