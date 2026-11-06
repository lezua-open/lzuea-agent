import { describe, expect, it } from 'vitest'
import { codePoints, splitStreamingText } from './streamSplit'

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

  it('有字就非得有尾巴：fresh 只在原文为空时才为空', () => {
    // 尾巴一空 StreamText 就卸载，下个 delta 重挂时排期表重建，已经清晰的字
    // 会重新糊一遍，滚动的显现前沿还会短暂掉回上一个块（上下闪烁）。
    // 最容易踩的是原文刚好停在分隔符上 —— 切口正好顶到末尾。
    for (const text of [
      'x'.repeat(400) + '\n\n',
      'x'.repeat(400) + '\n',
      'x'.repeat(400) + ' ',
      'x'.repeat(400),
      'x'.repeat(WINDOW + 1),
      'x'.repeat(WINDOW),
      'x'
    ]) {
      expect(splitStreamingText(text).fresh).not.toBe('')
    }
    expect(splitStreamingText('').fresh).toBe('')
  })

  it('切口不劈开代理对：emoji 两边都得是完整的字', () => {
    // emoji 占两个 UTF-16 单元，硬切在窗口边界时正好会压在中间，两边各拿半个字，
    // 渲染出来是两个乱码方块。调尾巴长度把切口从 emoji 一侧扫到另一侧，
    // 中间那一格（后半个单元）就是会劈开的那一刀。
    for (let m = 315; m <= 325; m++) {
      const text = 'x'.repeat(320) + '🎉' + 'y'.repeat(m)
      const { settled, fresh } = splitStreamingText(text)
      expect(settled + fresh).toBe(text)
      expect(settled).not.toMatch(/[\uD800-\uDBFF]$/)
      expect(fresh).not.toMatch(/^[\uDC00-\uDFFF]/)
      expect(fresh).not.toBe('')
    }
  })

  it('任意形状都不劈字、不丢字', () => {
    for (const mid of ['', '🎉', '🎉🎉', '\n\n', '🎉\n\n', '\n\n🎉', '🎉\n\n🎉']) {
      for (let m = 300; m <= 340; m++) {
        const text = 'x'.repeat(320) + mid + 'y'.repeat(m)
        const { settled, fresh } = splitStreamingText(text)
        expect(settled + fresh).toBe(text)
        expect(settled).not.toMatch(/[\uD800-\uDBFF]$/)
        expect(fresh).not.toMatch(/^[\uDC00-\uDFFF]/)
        expect(fresh).not.toBe('')
      }
    }
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

/**
 * 逐字 span 的下标换算。
 *
 * key 和排期表都按 UTF-16 绝对下标走，字本身必须按码点切。两边一旦错位，
 * 排期表每帧都在补漏、波前被白白推走，字越流越欠 —— 而且只在回复里出现
 * emoji 时才炸，肉眼极难盯出来。
 */
describe('codePoints', () => {
  it('纯 BMP：下标就是逐单元推进', () => {
    expect(codePoints('abc', 0)).toEqual([
      [0, 'a'],
      [1, 'b'],
      [2, 'c']
    ])
  })

  it('emoji 占两个 UTF-16 单元，后面的下标要跟着跳过去', () => {
    expect(codePoints('a🎉b', 0)).toEqual([
      [0, 'a'],
      [1, '🎉'],
      [3, 'b']
    ])
  })

  it('from 之后才开始编号，且起点仍是 UTF-16 绝对下标', () => {
    expect(codePoints('a🎉b', 1)).toEqual([
      [1, '🎉'],
      [3, 'b']
    ])
    expect(codePoints('a🎉b', 3)).toEqual([[3, 'b']])
    expect(codePoints('a🎉b', 4)).toEqual([])
  })

  it('拼回去就是原文：不丢字、不劈字', () => {
    for (const text of ['', '纯中文', 'a🎉b', '🎉'.repeat(5), '甲🎉乙\n\n丙']) {
      expect(
        codePoints(text, 0)
          .map(([, ch]) => ch)
          .join('')
      ).toBe(text)
    }
  })

  it('每段的起点加字长，正好是下一段的起点', () => {
    const text = '甲🎉乙x'
    const spans = codePoints(text, 0)
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i][0]).toBe(spans[i - 1][0] + spans[i - 1][1].length)
    }
    expect(spans[spans.length - 1][0] + spans[spans.length - 1][1].length).toBe(text.length)
  })
})
