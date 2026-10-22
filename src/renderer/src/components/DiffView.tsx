import { memo } from 'react'

/**
 * unified diff 的着色展示。
 *
 * 不引 diff 渲染库：审批框里要的只是「人能看懂改了什么」，
 * 按行首符号着色已经足够，而且不会引入一堆用不上的依赖。
 */

function classify(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
    return 'diff__line diff__line--meta'
  }
  if (line.startsWith('@@')) return 'diff__line diff__line--hunk'
  if (line.startsWith('+')) return 'diff__line diff__line--add'
  if (line.startsWith('-')) return 'diff__line diff__line--del'
  return 'diff__line'
}

function DiffViewImpl({ text }: { text: string }): React.JSX.Element {
  const lines = text.split('\n')
  return (
    <div className="diff">
      {lines.map((line, i) => (
        <div key={i} className={classify(line)}>
          {line || ' '}
        </div>
      ))}
    </div>
  )
}

export const DiffView = memo(DiffViewImpl)
