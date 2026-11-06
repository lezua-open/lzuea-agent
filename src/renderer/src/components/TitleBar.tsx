import { useEffect, useRef } from 'react'

/**
 * 窗口标题栏。
 *
 * 窗口是 `titleBarStyle: 'hidden'`，原生那条灰条整条没了，上沿归这里画。
 * 整条是一块**独立的 chrome**，不跟着下面的面板走 —— 不按侧栏宽度劈开，
 * 也不借侧栏的底色，这样以后才放得下跨面板的东西（标签栏、面包屑、
 * 全局搜索、运行状态）。
 *
 * 三段式，往哪段塞东西看内容归属：
 *   __lead   开头，品牌
 *   __main   中段，弹性占满 —— 以后放标签栏 / 面包屑 / 搜索
 *   __trail  收尾，动作区
 *
 * 系统窗口按钮压在整条的最右边，**不画** —— 它归系统（见 main/window-chrome.ts）。
 * Win11 的贴靠布局、原生缩放边框、无障碍播报、双击最大化全挂在那三个按钮上，
 * 自己画一套就全丢了。我们只负责让位。
 *
 * 让多宽不能猜：按钮宽度随 DPI 走，得问 `windowControlsOverlay` 要准数，
 * 拿不到再退到 3 × 46px 的经验值。量出来挂在 `--caption-w` 上，CSS 据此让开。
 */

/** 标题栏里真正能放东西的那块矩形。拿不到就当没有窗口按钮遮挡 */
function titlebarAreaRect(): { width: number } | null {
  const nav = globalThis.navigator as Navigator & {
    windowControlsOverlay?: { getTitlebarAreaRect: () => { width: number } }
  }
  return nav.windowControlsOverlay?.getTitlebarAreaRect() ?? null
}

export function TitleBar(): React.JSX.Element {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const rect = titlebarAreaRect()
      // 窗口按钮贴右边缘，所以「让开多少」= 整宽 - 系统说能用的那块
      const reserve = rect ? Math.max(0, window.innerWidth - rect.width) : 3 * 46
      el.style.setProperty('--caption-w', `${Math.round(reserve)}px`)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  return (
    <header ref={ref} className="titlebar">
      <div className="titlebar__lead">
        <div className="titlebar__logo">A</div>
        <div className="titlebar__name">LZUEA Agent</div>
      </div>
      {/* 中段/收尾现在是空的，先把槽位铺好 —— 以后标签栏、面包屑、动作按钮直接往里塞 */}
      <div className="titlebar__main" />
      <div className="titlebar__trail" />
    </header>
  )
}
