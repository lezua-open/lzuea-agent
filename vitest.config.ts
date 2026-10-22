import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/**
 * vitest 跑两类测试：
 *
 *  1. **纯逻辑** —— core 层，以及 renderer 里不碰 DOM 的工具函数（例如流式段落切分）。
 *  2. **真 SQLite 的 store 层** —— 临时文件库 + 真迁移，不 mock。
 *
 * 第 2 类是有意加进来的。判据不是「文件在哪个目录」，而是「测它要不要**造假件**」：
 * 造一个假 Drizzle 比被测代码还长、还测不出真实语义，而 better-sqlite3 的
 * 事务契约（事务体必须同步）只有落真库才暴露 —— 这类 bug 曾经直接漏到界面上。
 *
 * 仍然不在这套单测里做的：Electron IPC、审批 UI、渲染层 DOM。
 * 那些要造窗口和事件循环，mock 比被测代码还长，靠集成验证。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['node_modules/**', 'out/**'],
    reporters: ['default'],
    // core 的单测都是纯函数 + 内存端口，不该慢
    testTimeout: 10_000
  }
})
