import { describe, expect, it } from 'vitest'
import { splitStreamingText } from './streamSplit'

/**
 * 流式段落切分的边界。
 *
 * 这个函数决定「哪段进 Markdown、哪段逐字对焦」，切错地方会丢字或者把
 * Markdown 语法拆成两半渲染出原文。所以边界都钉死。
 */
describe('splitStreamingText', () => {
  const WINDOW = 320

  it('短文本整段都留给流式尾巴，Markdown 不参与', () => {
    const { settled, fresh, freshStart } = splitStreamingText('你好')
    expect(settled).toBe('')
    expect(fresh).toBe('你好')
    expect(freshStart).toBe(0)
  })

  it('空串不炸', () => {
    expect(splitStreamingText('')).toEqual({ settled: '', fresh: '', freshStart: 0 })
  })

  it('不丢字：settled + fresh 永远等于原文', () => {
    const text = '第一段。\n\n第二段比较长，'.repeat(40) + '结尾'
    const { settled, fresh } = splitStreamingText(text)
    expect(settled + fresh).toBe(text)
    expect(text.length).toBeGreaterThan(WINDOW)
  })

  it('优先切在段落空行之后', () => {
    const head = '甲'.repeat(200)
    const tail = '乙'.repeat(200)
    const { settled, fresh } = splitStreamingText(`${head}\n\n${tail}`)
    expect(settled).toBe(`${head}\n\n`)
    expect(fresh).toBe(tail)
  })

  it('没有空行就退到普通换行', () => {
    const head = '甲'.repeat(200)
    const tail = '乙'.repeat(200)
    const { settled, fresh } = splitStreamingText(`${head}\n${tail}`)
    expect(settled).toBe(`${head}\n`)
    expect(fresh).toBe(tail)
  })

  it('没有换行就退到空格', () => {
    const head = 'a'.repeat(200)
    const tail = 'b'.repeat(200)
    const { settled, fresh } = splitStreamingText(`${head} ${tail}`)
    expect(settled).toBe(`${head} `)
    expect(fresh).toBe(tail)
  })

  it('完全没有分隔符时硬切在窗口边界，不丢字', () => {
    const text = 'x'.repeat(400)
    const { settled, fresh, freshStart } = splitStreamingText(text)
    expect(settled + fresh).toBe(text)
    expect(freshStart).toBe(400 - WINDOW)
    expect(fresh.length).toBe(WINDOW)
  })

  it('切口只往前找，尾巴长度不会超过窗口太多', () => {
    const text = `${'甲'.repeat(319)}\n\n${'乙'.repeat(500)}`
    const { fresh } = splitStreamingText(text)
    // 切口之后是 500 个「乙」，但只该渲染尾部窗口的那部分做动画；
    // 函数返回的 fresh 是完整的未定稿段，由 StreamText 自己再裁窗口。
    expect(fresh.length).toBeLessThanOrEqual(500 + 2)
  })

  it('freshStart 与 settled 的长度对齐，key 才能和全文绝对下标对上', () => {
    const text = 'a'.repeat(100) + '\n\n' + 'b'.repeat(300)
    const { settled, freshStart } = splitStreamingText(text)
    expect(freshStart).toBe(settled.length)
  })
})
