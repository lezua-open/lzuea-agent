import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 模型输出的 Markdown 渲染。
 *
 * 只做展示，不给 Markdown 里任何可执行的东西 ——
 * 链接一律交给主进程的 setWindowOpenHandler 用系统浏览器打开。
 */
function MarkdownImpl({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownImpl)
