import { z } from 'zod'
import { defineTool, ok, fail } from '../types'

/**
 * 客户端 web_fetch：抓 URL 并抽出正文。
 *
 * 双通道都能用。web_search 在 Anthropic 通道走服务端工具（见 ToolRegistry.toModelTools），
 * OpenAI 兼容通道没有对应物，所以这里只做抓取、不做搜索。
 */

const MAX_CHARS_DEFAULT = 20_000
const FETCH_TIMEOUT_MS = 20_000

const webFetchSchema = z.object({
  url: z.string().min(1).describe('完整 URL，以 http:// 或 https:// 开头'),
  max_chars: z
    .number()
    .int()
    .min(500)
    .max(100_000)
    .optional()
    .describe(`返回的最大字符数，默认 ${MAX_CHARS_DEFAULT}`)
})

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
}

/** 轻量 HTML → 文本。够喂给模型，不需要完整 DOM。 */
export function htmlToText(html: string): string {
  let s = html
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')

  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : ''

  s = s.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, text: string) => {
      const t = decodeEntities(text).trim()
      return t ? `${t} (${href})` : `(${href})`
    }
  )

  s = s.replace(
    /<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|blockquote)\b[^>]*>/gi,
    '\n'
  )
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)

  s = s.replace(/[ \t\r\u00a0\u3000]+/g, ' ')
  s = s.replace(/\n{3,}/g, '\n\n').trim()

  return title ? `${title}\n\n${s}` : s
}

export const webFetchTool = defineTool({
  name: 'web_fetch',
  description:
    '抓取一个 URL 的正文内容（HTML 会转成纯文本，JSON 原样返回）。用于读文档、博客、API 参考。' +
    '只支持 http/https，不支持需要登录的页面。超时 20 秒。',
  risk: 'read',
  schema: webFetchSchema,
  handler: async ({ url, max_chars = MAX_CHARS_DEFAULT }) => {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return fail(`URL 无法解析：${url}\n下一步：补全协议头，例如 https://example.com`)
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return fail(`只支持 http/https，收到 ${parsedUrl.protocol}`)
    }

    let res: Response
    try {
      res = await fetch(parsedUrl.toString(), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*'
        }
      })
    } catch (e) {
      return fail(`抓取失败：${e instanceof Error ? e.message : e}\n下一步：确认 URL 可公开访问。`)
    }

    if (!res.ok) return fail(`抓取失败：HTTP ${res.status} ${res.statusText}`)

    const contentType = res.headers.get('content-type') ?? ''
    const raw = await res.text()

    let text: string
    if (contentType.includes('html') || raw.trimStart().startsWith('<')) {
      text = htmlToText(raw)
    } else if (contentType.includes('json')) {
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2)
      } catch {
        text = raw
      }
    } else {
      text = raw
    }

    // max_chars 是给模型的显式旋钮，优先于 ok() 里的全局截断
    if (text.length > max_chars) {
      text =
        text.slice(0, max_chars) +
        `\n\n…（已按 max_chars=${max_chars} 截断，正文共 ${text.length} 字符。要看后面请调大 max_chars 或换个更具体的 URL）`
    }

    return ok(
      `URL: ${parsedUrl.toString()}\n状态: ${res.status}\nContent-Type: ${contentType}\n\n${text}`
    )
  }
})

export const webTools = [webFetchTool]
