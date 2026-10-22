import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit 配置。用法：
 *   npx drizzle-kit generate   —— 改了 schema.ts 之后生成迁移 SQL
 *   npx drizzle-kit studio     —— 本地浏览数据（开发用）
 *
 * 生成的 SQL 在 ./drizzle，应用启动时由 src/main/store/db.ts 执行。
 */
export default defineConfig({
  schema: './src/main/store/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  // 仅 drizzle-kit studio 需要；运行时的库在 Electron userData 目录下
  dbCredentials: { url: './.dev/data.db' },
  verbose: true,
  strict: true
})
