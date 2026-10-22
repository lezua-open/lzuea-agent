import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'

export type AppDatabase = BetterSQLite3Database<typeof schema>

export interface OpenDatabaseOptions {
  /** SQLite 文件路径 */
  dbPath: string
  /** drizzle 生成的 SQL 迁移目录 */
  migrationsFolder: string
  /** 只读模式（目前没用上，留给以后的只读备份） */
  readonly?: boolean
}

/**
 * 打开数据库并把迁移到最新。
 *
 * 几个对桌面应用很关键的 PRAGMA：
 *  - WAL：读写不互斥，UI 读历史时不会被 agent 写入卡住
 *  - foreign_keys：外键要显式开，否则 ON DELETE CASCADE 是摆设
 *  - busy_timeout：Electron 主进程可能并发访问，等一会儿比直接报错好
 */
export function openDatabase(opts: OpenDatabaseOptions): AppDatabase {
  mkdirSync(dirname(opts.dbPath), { recursive: true })

  const sqlite = new Database(opts.dbPath, { readonly: opts.readonly ?? false })
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('synchronous = NORMAL')

  const db = drizzle(sqlite, { schema })

  migrate(db, { migrationsFolder: opts.migrationsFolder })

  return db
}
