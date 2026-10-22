import { describe, expect, it } from 'vitest'
import {
  type AgentError,
  ApprovalDeniedError,
  ModelAuthError,
  ModelBadRequestError,
  ModelRateLimitError,
  ModelRefusalError,
  ModelTruncatedError,
  NetworkError,
  SandboxViolationError,
  SystemError,
  ToolTimeoutError,
  UserError,
  ValidationError,
  toAgentError,
  toToolResultError
} from './index'

describe('AgentError', () => {
  it('把 code / hint / details 固定在实例上', () => {
    const e = new UserError('坏了', { code: 'BROKEN', hint: '修一下', details: { a: 1 } })
    expect(e.category).toBe('user')
    expect(e.code).toBe('BROKEN')
    expect(e.hint).toBe('修一下')
    expect(e.details).toEqual({ a: 1 })
    expect(e.retryable).toBe(false)
  })

  it('toUserMessage 在有 hint 时附带下一步', () => {
    expect(new UserError('坏了', { code: 'X', hint: '修一下' }).toUserMessage()).toBe(
      '坏了\n→ 修一下'
    )
    expect(new UserError('坏了', { code: 'X' }).toUserMessage()).toBe('坏了')
  })

  it('toJSON 可以安全序列化', () => {
    const e = new SandboxViolationError('/etc/passwd', '路径越出工作区')
    const json = e.toJSON()
    expect(json.category).toBe('tool')
    expect(json.code).toBe('SANDBOX_VIOLATION')
    expect(json.details).toMatchObject({ path: '/etc/passwd' })
  })

  it('每个子类的 category 是固定的', () => {
    const cases: Array<[AgentError, string]> = [
      [new ValidationError('x'), 'user'],
      [new ApprovalDeniedError('delete_path'), 'user'],
      [new SandboxViolationError('p', 'r'), 'tool'],
      [new ToolTimeoutError('run_command', 1000), 'tool'],
      [new ModelAuthError('x'), 'model'],
      [new ModelRateLimitError('x'), 'model'],
      [new ModelBadRequestError('x'), 'model'],
      [new ModelRefusalError(), 'model'],
      [new ModelTruncatedError(100), 'model'],
      [new NetworkError('x', { code: 'N' }), 'network'],
      [new SystemError('x', { code: 'S' }), 'system']
    ]
    for (const [err, category] of cases) {
      expect(err.category, err.name).toBe(category)
    }
  })

  it('retryable 标记对齐「该不该自动重试」', () => {
    expect(new ModelRateLimitError('x').retryable).toBe(true)
    expect(new ToolTimeoutError('t', 1).retryable).toBe(true)
    expect(new ModelAuthError('x').retryable).toBe(false)
    expect(new ModelRefusalError().retryable).toBe(false)
  })
})

describe('toAgentError', () => {
  it('已经是 AgentError 时原样返回', () => {
    const e = new UserError('x', { code: 'X' })
    expect(toAgentError(e)).toBe(e)
  })

  it('把 Node errno 映射成带提示的 ToolError', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' })
    const e = toAgentError(err)
    expect(e.category).toBe('tool')
    expect(e.code).toBe('FS_ENOENT')
    expect(e.hint).toContain('list_dir')
  })

  it('AbortError 映射成超时类错误', () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    expect(toAgentError(err).code).toBe('TOOL_TIMEOUT')
  })

  it('未知错误退化为 SystemError 并带上兜底 code', () => {
    const e = toAgentError(new Error('boom'), 'FALLBACK')
    expect(e.category).toBe('system')
    expect(e.code).toBe('FALLBACK')
  })

  it('非 Error 值也会被规整', () => {
    expect(toAgentError('字符串错误', 'X').message).toBe('字符串错误')
    expect(toAgentError(undefined, 'X').message).toBe('undefined')
  })
})

describe('toToolResultError', () => {
  it('回传给模型的文案带可行动的「下一步」', () => {
    const text = toToolResultError(new SandboxViolationError('../secret', '路径越出工作区'))
    expect(text).toContain('沙箱')
    expect(text).toContain('下一步：')
    expect(text).toContain('相对工作区')
  })

  it('没有 hint 时只给消息本体', () => {
    const text = toToolResultError(new SystemError('磁盘满了', { code: 'X' }))
    expect(text).toBe('磁盘满了')
  })
})
