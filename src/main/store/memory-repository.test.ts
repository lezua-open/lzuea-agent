import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from './db'
import { SqliteMemoryRepository } from './memory-repository'

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url))

/**
 * 真 SQLite（临时文件库 + 真迁移），同 message-store.test.ts。
 * 这里专测删除回收站 —— 撤销是「刚删完就反悔」的交互契约，假实现测不出来。
 */

let dir: string
let db: AppDatabase
let repo: SqliteMemoryRepository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lzuea-mem-'))
  db = openDatabase({ dbPath: join(dir, 'data.db'), migrationsFolder: MIGRATIONS })
  repo = new SqliteMemoryRepository(db)
})

afterEach(() => {
  ;(db as unknown as { $client: { close(): void } }).$client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('deleteById / undoDeleteById', () => {
  it('删除后撤销：条目（含 tags）原样回来', async () => {
    const saved = await repo.remember('工作区约定', '沙箱边界是 workspaceRoot', ['约定'])
    await repo.deleteById(saved.id)
    expect(await repo.get('工作区约定')).toBeUndefined()

    await expect(repo.undoDeleteById(saved.id)).resolves.toBe(true)
    const back = await repo.get('工作区约定')
    expect(back?.content).toBe('沙箱边界是 workspaceRoot')
    expect(back?.tags).toEqual(['约定'])
    expect(back?.id).toBe(saved.id)
  })

  it('回收站没有这份就返回 false；撤销两次第二次不生效', async () => {
    // 从来没删过的 id：不能凭空造一条记忆出来
    await expect(repo.undoDeleteById('never-deleted')).resolves.toBe(false)

    // 删 → 撤销 → 再撤销：第二下已经没东西可撤
    const saved = await repo.remember('k', 'v')
    await repo.deleteById(saved.id)
    await expect(repo.undoDeleteById(saved.id)).resolves.toBe(true)
    await expect(repo.undoDeleteById(saved.id)).resolves.toBe(false)
    expect(await repo.get('k')).toBeDefined() // 第二次撤销不能把刚恢复的又弄没
  })
})
