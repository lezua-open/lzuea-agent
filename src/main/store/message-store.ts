import { asc, count, desc, eq, max } from 'drizzle-orm'
import type { ChatMessage, ConversationSummary, ContentBlock } from '@shared/types'
import type { MessageStore } from '@core/ports'
import { SystemError, ValidationError } from '@core/errors'
import type { AppDatabase } from './db'
import { conversations, messages } from './schema'

const DEFAULT_TITLE = '新对话'

function parseBlocks(json: string, messageId: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) throw new Error('blocks 字段不是数组')
    return parsed as ContentBlock[]
  } catch (err) {
    // 数据损坏要看得见，不要静默丢消息 —— 否则模型上下文会缺一块还查不出来
    throw new SystemError(`消息 ${messageId} 的内容已损坏，无法加载`, {
      code: 'MESSAGE_CORRUPT',
      hint: '可以删掉这个会话重建，或者从备份恢复数据库文件。',
      cause: err,
      details: { messageId }
    })
  }
}

/**
 * MessageStore 的 SQLite 实现。
 *
 * 顺序用 `seq` 而不是 `created_at`：同一毫秒内的多条消息（tool_result 就是）
 * 靠时间戳排序会随机打乱，而 tool_use / tool_result 的相对顺序是硬约束。
 */
export class SqliteMessageStore implements MessageStore {
  /**
   * 事务体必须是**同步**的 —— 这是 better-sqlite3 的硬约束，不是风格偏好。
   *
   * 传 async 函数进去，它会在第一个 await 处返回 Promise，better-sqlite3 立刻抛
   * `Transaction function cannot return a promise` 并 ROLLBACK。更坑的是函数体并没死：
   * 剩下的语句会作为孤儿微任务在回滚之后继续执行、独立提交。表现就是
   * 「界面报错了，数据却写进去了」，而且没有任何原子性。
   *
   * 所以事务体里所有语句都走同步执行器（`.all()` / `.run()`），绝不 await。
   * 方法签名仍返回 Promise —— MessageStore 端口是异步契约，同步实现也满足它。
   */
  constructor(private readonly db: AppDatabase) {}

  async listConversations(): Promise<ConversationSummary[]> {
    const rows = await this.db
      .select({
        id: conversations.id,
        title: conversations.title,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
        messageCount: count(messages.id)
      })
      .from(conversations)
      .leftJoin(messages, eq(messages.conversationId, conversations.id))
      .groupBy(conversations.id)
      .orderBy(desc(conversations.updatedAt))

    return rows.map((r) => ({ ...r, messageCount: r.messageCount ?? 0 }))
  }

  async createConversation(title?: string): Promise<ConversationSummary> {
    const now = Date.now()
    const id = crypto.randomUUID()
    await this.db.insert(conversations).values({
      id,
      title: title?.trim() || DEFAULT_TITLE,
      createdAt: now,
      updatedAt: now
    })
    return {
      id,
      title: title?.trim() || DEFAULT_TITLE,
      createdAt: now,
      updatedAt: now,
      messageCount: 0
    }
  }

  async deleteConversation(id: string): Promise<void> {
    await this.db.delete(conversations).where(eq(conversations.id, id))
  }

  async renameConversation(id: string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed) {
      throw new ValidationError('标题不能为空', { code: 'TITLE_EMPTY' })
    }
    await this.db
      .update(conversations)
      .set({ title: trimmed, updatedAt: Date.now() })
      .where(eq(conversations.id, id))
  }

  async exists(id: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1)
    return rows.length > 0
  }

  async getMessages(conversationId: string): Promise<ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.seq))

    return rows.map((r) => ({
      id: r.id,
      role: r.role as ChatMessage['role'],
      blocks: parseBlocks(r.blocks, r.id),
      createdAt: r.createdAt
    }))
  }

  async appendMessage(conversationId: string, message: ChatMessage): Promise<void> {
    if (!(await this.exists(conversationId))) {
      throw new ValidationError(`会话 ${conversationId} 不存在`, {
        code: 'CONVERSATION_NOT_FOUND'
      })
    }

    // seq 在同一次事务里取 max+1，避免并发写入撞号
    this.db.transaction((tx) => {
      const [{ value: lastSeq } = { value: 0 }] = tx
        .select({ value: max(messages.seq) })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .all()

      tx.insert(messages)
        .values({
          id: message.id,
          conversationId,
          role: message.role,
          blocks: JSON.stringify(message.blocks),
          createdAt: message.createdAt,
          seq: (lastSeq ?? 0) + 1
        })
        .run()

      tx.update(conversations)
        .set({ updatedAt: Date.now() })
        .where(eq(conversations.id, conversationId))
        .run()
    })
  }

  async replaceMessages(conversationId: string, next: ChatMessage[]): Promise<void> {
    if (!(await this.exists(conversationId))) {
      throw new ValidationError(`会话 ${conversationId} 不存在`, {
        code: 'CONVERSATION_NOT_FOUND'
      })
    }

    this.db.transaction((tx) => {
      tx.delete(messages).where(eq(messages.conversationId, conversationId)).run()
      if (next.length > 0) {
        tx.insert(messages)
          .values(
            next.map((m, i) => ({
              id: m.id,
              conversationId,
              role: m.role,
              blocks: JSON.stringify(m.blocks),
              createdAt: m.createdAt,
              seq: i + 1
            }))
          )
          .run()
      }
      tx.update(conversations)
        .set({ updatedAt: Date.now() })
        .where(eq(conversations.id, conversationId))
        .run()
    })
  }

  /**
   * 首条用户消息自动成为会话标题（用户没手动起过名的前提下）。
   * 放在这里而不是渲染层：标题是数据完整性的一部分，重启后也该是对的。
   */
  async adoptTitleFromFirstMessage(conversationId: string, text: string): Promise<void> {
    const rows = await this.db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
    if (rows.length === 0 || rows[0].title !== DEFAULT_TITLE) return

    const title = text.replace(/\s+/g, ' ').trim().slice(0, 40) || DEFAULT_TITLE
    await this.db.update(conversations).set({ title }).where(eq(conversations.id, conversationId))
  }
}
