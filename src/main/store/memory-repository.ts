import { eq } from 'drizzle-orm'
import type { MemoryEntry } from '@shared/types'
import type { MemoryRepository } from '@core/ports'
import { ValidationError } from '@core/errors'
import { rankRecall } from '@core/memory/recall'
import type { AppDatabase } from './db'
import { memory } from './schema'

function toEntry(row: {
  id: string
  key: string
  content: string
  tags: string
  createdAt: number
  updatedAt: number
}): MemoryEntry {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(row.tags)
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string')
  } catch {
    // tags 损坏不应该让整条记忆读不出来
  }
  return {
    id: row.id,
    key: row.key,
    content: row.content,
    tags,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

/**
 * 长期记忆的 SQLite 实现。
 *
 * recall() 走 core 的 rankRecall（可解释的关键词打分），不是 SQL LIKE：
 * 中文没有空格，LIKE 匹配不了「沙箱」之于「工作区沙箱」这种包含关系。
 *
 * 目前是「全量取出 + 内存打分」。桌面 agent 的记忆量级（几百条）这样最快也最好调试；
 * 真正的升级路径是 FTS5 或向量索引 —— MemoryRepository 这个端口不变，只换实现。
 */
export class SqliteMemoryRepository implements MemoryRepository {
  constructor(private readonly db: AppDatabase) {}

  async list(): Promise<MemoryEntry[]> {
    const rows = await this.db.select().from(memory).orderBy(memory.updatedAt)
    return rows.map(toEntry)
  }

  async get(key: string): Promise<MemoryEntry | undefined> {
    const rows = await this.db.select().from(memory).where(eq(memory.key, key)).limit(1)
    return rows[0] ? toEntry(rows[0]) : undefined
  }

  async remember(key: string, content: string, tags: string[] = []): Promise<MemoryEntry> {
    const trimmedKey = key.trim()
    if (!trimmedKey) {
      throw new ValidationError('记忆的 key 不能为空', { code: 'MEMORY_KEY_EMPTY' })
    }
    if (!content.trim()) {
      throw new ValidationError('记忆内容不能为空', { code: 'MEMORY_CONTENT_EMPTY' })
    }

    const now = Date.now()
    const cleanTags = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
    const existing = await this.get(trimmedKey)

    if (existing) {
      await this.db
        .update(memory)
        .set({ content, tags: JSON.stringify(cleanTags), updatedAt: now })
        .where(eq(memory.key, trimmedKey))
      return { ...existing, content, tags: cleanTags, updatedAt: now }
    }

    const id = crypto.randomUUID()
    await this.db.insert(memory).values({
      id,
      key: trimmedKey,
      content,
      tags: JSON.stringify(cleanTags),
      createdAt: now,
      updatedAt: now
    })
    return { id, key: trimmedKey, content, tags: cleanTags, createdAt: now, updatedAt: now }
  }

  async forget(key: string): Promise<boolean> {
    const rows = await this.db
      .delete(memory)
      .where(eq(memory.key, key))
      .returning({ id: memory.id })
    return rows.length > 0
  }

  async deleteById(id: string): Promise<boolean> {
    const rows = await this.db.delete(memory).where(eq(memory.id, id)).returning({ id: memory.id })
    return rows.length > 0
  }

  async recall(query: string, limit = 5): Promise<MemoryEntry[]> {
    const all = await this.list()
    return rankRecall(query, all, limit, Date.now())
  }
}
