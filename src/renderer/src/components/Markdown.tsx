import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

/**
 * 模型输出的 Markdown 渲染。
 *
 * 只做展示，不给 Markdown 里任何可执行的东西 ——
 * 链接一律交给主进程的 setWindowOpenHandler 用系统浏览器打开。
 * 代码块过 rehype-highlight 上色：只认 ```lang 标注的语言，不瞎猜。
 */
function MarkdownImpl({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownImpl)
