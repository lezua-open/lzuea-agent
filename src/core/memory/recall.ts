/**
 * 记忆召回打分。
 *
 * 纯函数，无 I/O —— 可以直接单测，也方便以后换成向量检索时只替换这个模块。
 *
 * 没用 embedding 是有意的：首版要求可解释、可调试、零外部依赖。
 * 中英文混合的分词在这里处理，中文没有空格，所以额外做 2-gram 滑窗。
 */

export interface Recallable {
  key: string
  content: string
  tags: string[]
  updatedAt: number
}

/** 中文 2-gram + 英文/数字整词 */
export function tokenize(query: string): Set<string> {
  const q = query.toLowerCase()
  const tokens = new Set<string>()

  for (const m of q.matchAll(/[a-z0-9_]+/gi)) {
    if (m[0].length >= 2) tokens.add(m[0])
  }

  const cjk = q.replace(/[^一-鿿]/g, '')
  for (let i = 0; i < cjk.length; i++) {
    tokens.add(cjk[i])
    if (i + 1 < cjk.length) tokens.add(cjk.slice(i, i + 2))
  }

  return tokens
}

export interface ScoredRecall<T extends Recallable> {
  item: T
  score: number
}

export function scoreRecall<T extends Recallable>(
  query: string,
  item: T,
  tokens: Set<string>,
  now: number
): number {
  const q = query.trim().toLowerCase()
  const key = item.key.toLowerCase()
  const content = item.content.toLowerCase()
  const tags = item.tags.join(' ').toLowerCase()

  let score = 0

  // 整串命中权重最高
  if (q && key.includes(q)) score += 12
  if (q && content.includes(q)) score += 8
  if (q && tags.includes(q)) score += 6

  for (const t of tokens) {
    if (key.includes(t)) score += 3
    if (tags.includes(t)) score += 2
    if (content.includes(t)) score += 1
  }

  // 一周内的记忆略加权。只对已经命中过的条目生效 ——
  // 新近性是相关性的加分项，不能让毫不相关的记忆靠「很新」混进结果。
  if (score > 0) {
    const ageDays = (now - item.updatedAt) / (1000 * 60 * 60 * 24)
    if (ageDays < 7) score += 1
  }

  return score
}

export function rankRecall<T extends Recallable>(
  query: string,
  items: readonly T[],
  limit: number,
  now: number
): T[] {
  const trimmed = query.trim()
  if (!trimmed) return items.slice(0, limit)

  const tokens = tokenize(trimmed)
  return items
    .map((item) => ({ item, score: scoreRecall(trimmed, item, tokens, now) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item)
}
