import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, ContentBlock } from '@shared/types'
import { openDatabase, type AppDatabase } from './db'
import { SqliteMessageStore } from './message-store'

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url))

/**
 * 真 SQLite（临时文件库 + 真迁移），不 mock。
 *
 * 这一层专测「事务契约」。之前 store 里把 async 函数传给 db.transaction()，
 * better-sqlite3 直接抛 Transaction function cannot return a promise 并回滚，
 * 但 async 函数体剩下的语句会在回滚后作为孤儿微任务继续落库 ——
 * 界面报错、数据却写进去了。纯函数单测抓不到这个，必须落真库。
 */

let dir: string
let db: AppDatabase
let store: SqliteMessageStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lzuea-msg-'))
  db = openDatabase({ dbPath: join(dir, 'data.db'), migrationsFolder: MIGRATIONS })
  store = new SqliteMessageStore(db)
})

afterEach(() => {
  // drizzle 的 $client 就是底层 better-sqlite3 实例，泛型没暴露出来。
  // 不关掉的话 Windows 上删临时目录会失败。
  ;(db as unknown as { $client: { close(): void } }).$client.close()
  rmSync(dir, { recursive: true, force: true })
})

function msg(id: string, role: 'user' | 'assistant', text: string, createdAt = 1000): ChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], createdAt }
}

async function newConversation(title?: string): Promise<string> {
  const c = await store.createConversation(title)
  return c.id
}

describe('appendMessage', () => {
  it('事务体同步化：不再抛 Transaction function cannot return a promise', async () => {
    const id = await newConversation()
    // 旧实现在这里抛 TypeError，正是用户在界面上看到的那句
    await expect(store.appendMessage(id, msg('m1', 'user', '123'))).resolves.toBeUndefined()

    const rows = await store.getMessages(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('m1')
    expect(rows[0].blocks).toEqual([{ type: 'text', text: '123' }])
  })

  it('seq 在会话内从 1 递增', async () => {
    const id = await newConversation()
    await store.appendMessage(id, msg('m1', 'user', 'a', 1000))
    await store.appendMessage(id, msg('m2', 'assistant', 'b', 1000)) // 同毫秒
    await store.appendMessage(id, msg('m3', 'user', 'c', 1000))

    const rows = await store.getMessages(id)
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('blocks 里的 thinking.raw / opaque 原样往返', async () => {
    const id = await newConversation()
    // thinking.raw 带 signature，回传模型时必须一字不改；opaque 同理。
    // 这里存的是「形状会变」的任意 JSON，往返必须逐字节保真。
    const blocks: ContentBlock[] = [
      { type: 'thinking', text: '想一想', raw: { signature: 'sig-abc', data: 'x' } },
      {
        type: 'opaque',
        raw: { server_tool: 'web_search', result: [1, 2, 3] },
        label: 'web_search'
      },
      { type: 'text', text: '答案' }
    ]
    await store.appendMessage(id, { id: 'm1', role: 'assistant', blocks, createdAt: 1 })

    const rows = await store.getMessages(id)
    expect(rows[0].blocks).toEqual(blocks)
    // 不能只比结构化字段 —— raw 里的字段丢了模型就会 400
    expect(JSON.stringify(rows[0].blocks)).toBe(JSON.stringify(blocks))
  })

  it('会话不存在时抛 ValidationError，不静默写入', async () => {
    await expect(store.appendMessage('nope', msg('m1', 'user', 'x'))).rejects.toThrowError(/不存在/)
  })
})

describe('replaceMessages', () => {
  it('整体重写并按传入顺序重排 seq', async () => {
    const id = await newConversation()
    await store.appendMessage(id, msg('m1', 'user', 'a'))
    await store.appendMessage(id, msg('m2', 'assistant', 'b'))
    await store.appendMessage(id, msg('m3', 'user', 'c'))

    await store.replaceMessages(id, [msg('m3', 'user', 'c'), msg('m1', 'user', 'a')])

    const rows = await store.getMessages(id)
    expect(rows.map((r) => r.id)).toEqual(['m3', 'm1'])
  })

  it('清空后会话里不剩消息', async () => {
    const id = await newConversation()
    await store.appendMessage(id, msg('m1', 'user', 'a'))
    await store.replaceMessages(id, [])
    expect(await store.getMessages(id)).toHaveLength(0)
  })

  it('中途失败整体回滚 —— 不会留下「删了但没插入」的半个状态', async () => {
    const id = await newConversation()
    await store.appendMessage(id, msg('m1', 'user', 'a'))
    await store.appendMessage(id, msg('m2', 'assistant', 'b'))

    // m9 重复主键，插入必炸；此时前面的 delete 不能被留下
    await expect(
      store.replaceMessages(id, [msg('m9', 'user', 'x'), msg('m9', 'user', 'y')])
    ).rejects.toThrow()

    const rows = await store.getMessages(id)
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2'])
  })
})

describe('adoptTitleFromFirstMessage', () => {
  it('默认标题被首条消息取代：压缩空白并截断到 40 字', async () => {
    const id = await newConversation()
    // 确实长过 40 字，才测得到截断
    const text =
      '  帮我把   src 目录下所有 TypeScript 文件里的 console.log 清理干净，\n  改完之后跑一遍测试确保没有破坏任何东西  '
    await store.adoptTitleFromFirstMessage(id, text)

    const [c] = await store.listConversations()
    expect(c.title).toBe(text.replace(/\s+/g, ' ').trim().slice(0, 40))
    expect(c.title.length).toBe(40)
  })

  it('短消息保持原样，不补齐也不截断', async () => {
    const id = await newConversation()
    await store.adoptTitleFromFirstMessage(id, '你好')
    const [c] = await store.listConversations()
    expect(c.title).toBe('你好')
  })

  it('用户手改过的标题不被覆盖', async () => {
    const id = await newConversation('我的标题')
    await store.adoptTitleFromFirstMessage(id, '另一句话')
    const [c] = await store.listConversations()
    expect(c.title).toBe('我的标题')
  })
})
