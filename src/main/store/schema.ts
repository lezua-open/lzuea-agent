import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * SQLite 表结构。
 *
 * blocks / tags 这类「结构化但形状会演进」的字段存 JSON 文本，
 * 而不是拆成子表：它们总是整块读写，拆表只会让迁移变多、查询变慢。
 * 会反过来 —— 需要按块内容检索时再拆（那时加 FTS 表即可，不影响这里）。
 */

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** 'user' | 'assistant' */
    role: text('role').notNull(),
    /** ContentBlock[] 的 JSON。含 thinking.raw / opaque，回传模型时要原样带回去 */
    blocks: text('blocks').notNull(),
    createdAt: integer('created_at').notNull(),
    /** 在会话内的顺序，避免只靠时间戳排序出现同毫秒乱序 */
    seq: integer('seq').notNull()
  },
  (t) => [
    index('idx_messages_conversation_seq').on(t.conversationId, t.seq),
    index('idx_messages_conversation_created').on(t.conversationId, t.createdAt)
  ]
)

export const memory = sqliteTable(
  'memory',
  {
    id: text('id').primaryKey(),
    /** 业务键，同 key 覆盖 */
    key: text('key').notNull(),
    content: text('content').notNull(),
    /** string[] 的 JSON */
    tags: text('tags').notNull().default('[]'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [uniqueIndex('idx_memory_key').on(t.key)]
)

export type ConversationRow = typeof conversations.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type MemoryRow = typeof memory.$inferSelect
