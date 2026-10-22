/**
 * 行内图标。
 *
 * 用内联 SVG 而不是字体图标 / emoji：颜色跟 currentColor 走、能被 CSS 控制、
 * 不会因为字体缺失在不同机器上变成豆腐块。
 * 对齐统一由全局的 `svg { vertical-align: -0.125em }` 处理。
 */

export type IconName =
  | 'plus'
  | 'close'
  | 'edit'
  | 'chevron'
  | 'copy'
  | 'check'
  | 'send'
  | 'stop'
  | 'trash'
  | 'chat'
  | 'settings'
  | 'memory'
  | 'warning'
  | 'refresh'
  | 'file'
  | 'terminal'
  | 'globe'
  | 'sparkle'

const PATHS: Record<IconName, string> = {
  plus: 'M12 5v14M5 12h14',
  close: 'M18 6 6 18M6 6l12 12',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  chevron: 'm9 18 6-6-6-6',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  check: 'm20 6-11 11-5-5',
  send: 'm22 2-7 20-4-9-9-4Z',
  stop: 'M7 7h10v10H7z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  memory: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  warning:
    'M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v5h-5',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  terminal: 'm4 17 6-6-6-6M12 19h8',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z',
  sparkle: 'm12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z'
}

export interface IconProps {
  name: IconName
  size?: number
  className?: string
  /** 填充型图标（stop）用 fill 而不是描边 */
  filled?: boolean
}

export function Icon({ name, size = 16, className, filled }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
