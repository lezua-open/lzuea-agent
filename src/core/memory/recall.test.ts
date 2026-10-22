import { describe, expect, it } from 'vitest'
import { rankRecall, scoreRecall, tokenize, type Recallable } from './recall'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function item(over: Partial<Recallable> = {}): Recallable {
  return { key: 'k', content: 'c', tags: [], updatedAt: NOW, ...over }
}

describe('tokenize', () => {
  it('英文按整词切，长度不足 2 的丢掉', () => {
    const t = tokenize('the api key a bb')
    expect(t.has('the')).toBe(true)
    expect(t.has('api')).toBe(true)
    expect(t.has('bb')).toBe(true)
    expect(t.has('a')).toBe(false)
  })

  it('中文切单字 + 2-gram（没有空格边界）', () => {
    const t = tokenize('工作区沙箱')
    expect(t.has('工')).toBe(true)
    expect(t.has('工作')).toBe(true)
    expect(t.has('作区')).toBe(true)
    expect(t.has('沙箱')).toBe(true)
  })

  it('中英混排两边都能切出来', () => {
    const t = tokenize('用 SQLite 存储记忆')
    expect(t.has('sqlite')).toBe(true)
    expect(t.has('存储')).toBe(true)
    expect(t.has('记忆')).toBe(true)
  })

  it('忽略大小写和标点', () => {
    expect(tokenize('API, Key!').has('api')).toBe(true)
    expect(tokenize('API, Key!').has('key')).toBe(true)
  })
})

describe('scoreRecall', () => {
  const tokens = tokenize('工作区 沙箱')

  it('key 整串命中权重最高', () => {
    const byKey = scoreRecall('工作区', item({ key: '工作区' }), tokens, NOW)
    const byContent = scoreRecall('工作区', item({ content: '工作区' }), tokens, NOW)
    expect(byKey).toBeGreaterThan(byContent)
  })

  it('完全不相关得 0 分，很新也不行', () => {
    // 新近性是加分项，不是相关性来源
    expect(
      scoreRecall(
        '部署脚本',
        item({ key: 'z', content: 'x', tags: [], updatedAt: NOW }),
        tokenize('部署脚本'),
        NOW
      )
    ).toBe(0)
  })

  it('tags 命中也算分', () => {
    const withTag = scoreRecall('沙箱', item({ tags: ['沙箱'] }), tokens, NOW)
    const without = scoreRecall('沙箱', item({ tags: [] }), tokens, NOW)
    expect(withTag).toBeGreaterThan(without)
  })

  it('一周内的记忆有轻微加权', () => {
    const q = '沙箱'
    const t = tokenize(q)
    const fresh = scoreRecall(q, item({ key: '沙箱', updatedAt: NOW - DAY }), t, NOW)
    const stale = scoreRecall(q, item({ key: '沙箱', updatedAt: NOW - 30 * DAY }), t, NOW)
    expect(fresh).toBe(stale + 1)
  })
})

describe('rankRecall', () => {
  const items: Recallable[] = [
    { key: 'api-key', content: 'OpenAI key 放在 .env', tags: ['配置'], updatedAt: NOW },
    { key: 'lint', content: '提交前跑 npm run check', tags: ['工程'], updatedAt: NOW },
    { key: 'sandbox', content: '所有文件操作限制在工作区', tags: ['沙箱'], updatedAt: NOW },
    { key: 'unrelated', content: '午餐吃什么', tags: [], updatedAt: NOW }
  ]

  it('按分数倒序，只留命中的', () => {
    const ranked = rankRecall('工作区 沙箱', items, 10, NOW)
    expect(ranked[0].key).toBe('sandbox')
    expect(ranked.map((i) => i.key)).not.toContain('unrelated')
  })

  it('limit 生效', () => {
    expect(rankRecall('工作区 沙箱 配置', items, 1, NOW)).toHaveLength(1)
  })

  it('空查询退化成「取前 N 条」而不是空结果', () => {
    expect(rankRecall('   ', items, 2, NOW)).toHaveLength(2)
    expect(rankRecall('', items, 2, NOW)).toHaveLength(2)
  })
})
