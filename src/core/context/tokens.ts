import type { NeutralBlock, NeutralMessage } from '@core/providers/types'

/**
 * Token 估算 + 上下文预算。
 *
 * 这里是**估算**，不是精确计数：中英文混排的 token 比例差异很大，
 * 精确值要用模型侧的 count_tokens 接口。估算的用途是「别把上下文撑爆」，
 * 留 20% 余量就够了。
 *
 * v0.1 用字符估算；后续版本可以接 Messages API 的 count_tokens 校准。
 */

/** CJK 字符（中日韩表意 + 假名 + 谚文）按 1.5 字符/token 估算 */
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** 英文约 4 字符/token，中文约 1.5 字符/token，取个保守值 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk / 1.5 + other / 4)
}

export function estimateBlockTokens(block: NeutralBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTokens(block.text) + 4
    case 'thinking':
      return estimateTokens(block.text) + 4
    case 'tool_use':
      return estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input)) + 8
    case 'tool_result':
      return estimateTokens(block.content) + 4
    case 'opaque':
      // 服务端工具产物整体回传，按序列化后的长度估算
      return estimateTokens(JSON.stringify(block.raw)) + 4
  }
}

export function estimateMessagesTokens(messages: readonly NeutralMessage[]): number {
  let total = 0
  for (const m of messages) {
    total += 4
    for (const b of m.blocks) total += estimateBlockTokens(b)
  }
  return total
}

export interface ContextBudget {
  /** 模型上下文窗口 */
  windowTokens: number
  /** 预留给本轮输出的空间 */
  reserveOutputTokens: number
}

export interface TrimResult {
  messages: NeutralMessage[]
  trimmedCount: number
  estimatedTokens: number
}

/**
 * 超预算时从最旧的非首条消息开始丢。
 *
 * 保留第一条用户消息（任务目标）+ 最近的消息（当前上下文）。
 * 这是滑窗策略；更精细的压缩（摘要替换）留给后续版本。
 *
 * 约束：不能在 tool_use / tool_result 中间切断，否则下一轮 API 会 400。
 * 所以以「整条消息」为单位丢弃。
 */
export function fitToBudget(
  messages: readonly NeutralMessage[],
  budget: ContextBudget,
  systemTokens: number,
  toolsTokens: number
): TrimResult {
  const limit = budget.windowTokens - budget.reserveOutputTokens
  let total = systemTokens + toolsTokens + estimateMessagesTokens(messages)
  if (total <= limit) {
    return {
      messages: messages.map((m) => ({ ...m, blocks: [...m.blocks] })),
      trimmedCount: 0,
      estimatedTokens: total
    }
  }

  // 首条保留，其余从旧到新尝试丢弃
  const kept = messages.map((m, i) => ({ m, i }))
  let head = 0
  let trimmed = 0

  while (kept.length - head > 2 && total > limit) {
    // 跳过第一条（保留）
    const victim = kept[head + 1]
    if (!victim) break
    total -= estimateMessagesTokens([victim.m]) + 4
    head++
    trimmed++
  }

  const result = [kept[0]?.m, ...kept.slice(head + 1).map((k) => k.m)].filter(
    (m): m is NeutralMessage => m !== undefined
  )

  return {
    messages: result.map((m) => ({ ...m, blocks: [...m.blocks] })),
    trimmedCount: trimmed,
    estimatedTokens: total
  }
}
