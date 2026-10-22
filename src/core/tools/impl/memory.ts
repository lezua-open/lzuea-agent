import { z } from 'zod'
import { defineTool, ok, fail } from '../types'

/**
 * 长期记忆工具。让 Agent 能主动记住跨会话有用的东西。
 *
 * 风险定为 write 而不是 dangerous：只动自己的记忆库，不碰工作区文件，
 * 不进危险确认流程 —— 确认框留给真正会破坏东西的操作。
 */

const rememberSchema = z.object({
  key: z.string().min(1).describe('短标识，同一 key 会覆盖更新，例如 "项目构建命令"'),
  content: z.string().min(1).describe('记忆详情'),
  tags: z.array(z.string()).optional().describe('检索用关键词')
})

export const rememberTool = defineTool({
  name: 'remember',
  description:
    '把一条信息存入长期记忆，跨会话保留。适合存：用户偏好、项目约定、已确认的事实、踩过的坑。' +
    '**不要存**能从代码或文件里直接查到的东西。',
  risk: 'write',
  schema: rememberSchema,
  preview: async ({ key, content, tags = [] }) => ({
    kind: 'other',
    title: `记忆 ${key}`,
    detail: `内容：${content}\n标签：${tags.join(', ') || '（无）'}`,
    paths: []
  }),
  handler: async ({ key, content, tags = [] }, ctx) => {
    const entry = await ctx.memory.remember(key, content, tags)
    return ok(
      `已记住「${entry.key}」（${entry.content.length} 字符）${tags.length ? `，标签：${tags.join(', ')}` : ''}`,
      { key, contentLength: content.length }
    )
  }
})

const recallSchema = z.object({
  query: z.string().min(1).describe('检索词，自然语句或关键词'),
  limit: z.number().int().min(1).max(30).optional().describe('最多返回几条，默认 8')
})

export const recallTool = defineTool({
  name: 'recall',
  description: '按关键词检索长期记忆。用户提到"上次"、"之前"、"我说过"时先调这个再回答。',
  risk: 'read',
  schema: recallSchema,
  handler: async ({ query, limit = 8 }, ctx) => {
    const hits = await ctx.memory.recall(query, limit)
    if (hits.length === 0) {
      const total = (await ctx.memory.list()).length
      return ok(
        `没有匹配「${query}」的记忆${total ? `（记忆库共 ${total} 条，换个说法再试）` : '（记忆库为空）'}`
      )
    }
    const lines = hits.map(
      (e, i) =>
        `${i + 1}. ${e.key}\n   ${e.content}${e.tags.length ? `\n   标签: ${e.tags.join(', ')}` : ''}`
    )
    return ok(`找到 ${hits.length} 条：\n\n${lines.join('\n\n')}`, { hits: hits.length })
  }
})

const forgetSchema = z.object({
  key: z.string().min(1).describe('要删除的记忆 key')
})

export const forgetTool = defineTool({
  name: 'forget',
  description: '按 key 删除一条长期记忆。用于清理过期或错误的记忆。',
  risk: 'write',
  schema: forgetSchema,
  preview: async ({ key }) => ({
    kind: 'other',
    title: `删除记忆 ${key}`,
    detail: `将删除记忆「${key}」`,
    paths: []
  }),
  handler: async ({ key }, ctx) => {
    const removed = await ctx.memory.forget(key)
    return removed ? ok(`已删除记忆「${key}」`) : fail(`没有找到 key 为「${key}」的记忆`)
  }
})

export const memoryTools = [rememberTool, recallTool, forgetTool]
