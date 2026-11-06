import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import type { ThemeMode } from '@shared/types'

/**
 * 窗口外框与主题的对表。
 *
 * 标题栏整个交给渲染进程画（`titleBarStyle: 'hidden'`），原生那条灰条就没了。
 * 但右上角三个窗口按钮**仍然归系统** —— Win11 的贴靠布局、原生缩放边框、
 * 无障碍播报、双击最大化全在那三个按钮上，自己画一套就全丢了。
 *
 * 于是分工是：我们画标题栏，只负责给按钮**让位 + 上色**。按钮的底色、字色
 * 都得跟主题走，否则暗色主题下右上角会浮着一块亮色。
 *
 * 主进程读不到 CSS 变量，所以下面那张色表是 styles.css 设计令牌的**镜像**，
 * 改主题色时两处都得改（见 CHROME 的注释）。
 */

/** 标题栏高度，对齐 styles.css 的 `--titlebar-h` */
export const TITLEBAR_H = 40

/**
 * 这张表是 styles.css 设计令牌的镜像 —— 主进程读不到 CSS 变量，只能抄色值。
 * 三个值各有各的用途，别合并：
 *   canvas = `--bg`          画布。窗口底色（缩放/加载时露出来的就是它），露出来   的多半在右下角，所以取画布而不是外框色
 *   chrome = `--bg-sunken`   应用外框。标题栏那一档，**必须和渲染进程的标题栏同色**，
 *                            否则右上角三个按钮会浮着一块突兀的底
 *   ink    = `--text-muted`  按钮符号
 */
export interface WindowPalette {
  canvas: string
  chrome: string
  ink: string
}

/**
 * 导出来是为了让单测能回头核 —— 这张表和 styles.css 一前一后改，
 * 人一定会忘掉一处，忘掉的后果（右上角浮一块突兀的底）又很难在代码里看出来。
 * window-chrome.test.ts 直接读 styles.css 比对，对不上就红。
 */
export const WINDOW_PALETTE: Record<ThemeMode, WindowPalette> = {
  light: { canvas: '#f4f4f2', chrome: '#ebebe8', ink: '#5a6068' },
  dark: { canvas: '#12161c', chrome: '#0e1216', ink: '#98a2b3' }
}

const CHROME = WINDOW_PALETTE

/** 窗口按钮的配色，和 Electron 的 TitleBarOverlay 选项同形 */
interface CaptionOverlay {
  color: string
  symbolColor: string
  height: number
}

function overlayFor(theme: ThemeMode): CaptionOverlay {
  return { color: CHROME[theme].chrome, symbolColor: CHROME[theme].ink, height: TITLEBAR_H }
}

/** 创建窗口时的外框选项。配色先按默认亮色给，配置读进来后由 applyWindowChrome 纠正。 */
export function windowChrome(): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: 'hidden',
    ...(process.platform === 'win32'
      ? { titleBarOverlay: overlayFor('light') }
      : // macOS 的红绿灯留在这条高度里，别压住标题栏的品牌
        { trafficLightPosition: { x: 14, y: 10 } })
  }
}

/**
 * 主题变了就把窗口外框跟上：缩放/加载时露出来的底色，以及右上角按钮的配色。
 *
 * `setTitleBarOverlay` 只在创建时给过 `titleBarOverlay` 的窗口上有效，
 * 所以非 win32 只调底色。
 */
export function applyWindowChrome(win: BrowserWindow, theme: ThemeMode): void {
  win.setBackgroundColor(CHROME[theme].canvas)
  if (process.platform === 'win32') win.setTitleBarOverlay(overlayFor(theme))
}
