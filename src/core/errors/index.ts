/**
 * 错误分类体系。
 *
 * 分类的意义在于决定「下一步谁来处理」：
 *   user    → 用户能修（参数不对、路径不存在），回传给模型让它自我纠正
 *   tool    → 工具执行失败，回传给模型换方案
 *   model   → 模型侧问题（限流、拒绝、超长），通常可重试或需要降级
 *   network → 连不上，可重试
 *   system  → 本地环境问题，需要人介入
 *
 * 硬规则：任何跨层边界都用 AgentError，不抛裸字符串 / 裸 Error。
 */

export type ErrorCategory = 'user' | 'tool' | 'model' | 'network' | 'system'

export interface AgentErrorOptions {
  /** 稳定的机器可读标识，例如 PATH_OUTSIDE_WORKSPACE */
  code: string
  /** 给人看的下一步该怎么做 */
  hint?: string
  /** 底层错误，保留用于日志 */
  cause?: unknown
  /** 是否值得自动重试 */
  retryable?: boolean
  /** 附加上下文，写进日志但不展示给用户 */
  details?: Record<string, unknown>
}

/** 给子类用：code 有默认值，但允许调用方覆盖 */
export type AgentErrorInit = Omit<AgentErrorOptions, 'code'> & { code?: string }

export abstract class AgentError extends Error {
  abstract readonly category: ErrorCategory
  readonly code: string
  readonly hint?: string
  readonly retryable: boolean
  readonly details: Record<string, unknown>

  constructor(message: string, opts: AgentErrorOptions) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = new.target.name
    this.code = opts.code
    this.hint = opts.hint
    this.retryable = opts.retryable ?? false
    this.details = opts.details ?? {}
  }

  /** 给 UI 看的完整文案，含可行动提示 */
  toUserMessage(): string {
    return this.hint ? `${this.message}\n→ ${this.hint}` : this.message
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      category: this.category,
      code: this.code,
      message: this.message,
      hint: this.hint,
      retryable: this.retryable,
      details: this.details
    }
  }
}

// ---------------------------------------------------------------- user

/** 用户能自己修的问题，不需要重试 */
export class UserError extends AgentError {
  readonly category = 'user' as const
}

/** 入参不合法 */
export class ValidationError extends UserError {
  constructor(message: string, opts: AgentErrorInit = {}) {
    super(message, { ...opts, code: opts.code ?? 'VALIDATION_FAILED' })
  }
}

/** 用户在确认框里点了拒绝 */
export class ApprovalDeniedError extends UserError {
  constructor(toolName: string) {
    super(`用户拒绝执行 ${toolName}`, {
      code: 'APPROVAL_DENIED',
      hint: '换一种做法，或者直接问用户想怎么做。不要重复请求同一个操作。',
      details: { toolName }
    })
  }
}

// ---------------------------------------------------------------- tool

/** 工具执行层的问题 */
export class ToolError extends AgentError {
  readonly category = 'tool' as const
}

/** 路径逃出工作区 */
export class SandboxViolationError extends ToolError {
  constructor(path: string, reason: string) {
    super(`路径被沙箱拒绝：${reason}`, {
      code: 'SANDBOX_VIOLATION',
      hint: '所有路径必须落在工作区内，用相对工作区的写法（例如 src/app.ts）。',
      details: { path, reason }
    })
  }
}

/** 找不到工具 */
export class UnknownToolError extends ToolError {
  constructor(name: string, available: string[]) {
    super(`未知工具「${name}」`, {
      code: 'UNKNOWN_TOOL',
      hint: `可用工具：${available.join('、')}`,
      details: { name, available }
    })
  }
}

/** 工具超时 */
export class ToolTimeoutError extends ToolError {
  constructor(toolName: string, timeoutMs: number) {
    super(`工具 ${toolName} 执行超时（${Math.round(timeoutMs / 1000)}s）`, {
      code: 'TOOL_TIMEOUT',
      retryable: true,
      details: { toolName, timeoutMs }
    })
  }
}

// ---------------------------------------------------------------- model

/** 模型侧问题 */
export class ModelError extends AgentError {
  readonly category = 'model' as const
}

export class ModelAuthError extends ModelError {
  constructor(message: string, opts: AgentErrorInit = {}) {
    super(message, {
      ...opts,
      code: opts.code ?? 'MODEL_AUTH',
      hint: opts.hint ?? '到「设置」里核对 API Key 和 baseUrl。'
    })
  }
}

export class ModelRateLimitError extends ModelError {
  constructor(message: string, retryAfterMs?: number) {
    super(message, {
      code: 'MODEL_RATE_LIMIT',
      retryable: true,
      hint: '触发限流，稍等几秒再试。',
      details: { retryAfterMs }
    })
  }
}

export class ModelBadRequestError extends ModelError {
  constructor(message: string, opts: AgentErrorInit = {}) {
    super(message, { ...opts, code: opts.code ?? 'MODEL_BAD_REQUEST' })
  }
}

export class ModelRefusalError extends ModelError {
  constructor() {
    super('模型拒绝了这次请求', {
      code: 'MODEL_REFUSAL',
      hint: '换个说法描述需求，或者把任务拆小一点。'
    })
  }
}

export class ModelTruncatedError extends ModelError {
  constructor(maxTokens: number) {
    super('输出达到 max_tokens 上限被截断', {
      code: 'MODEL_TRUNCATED',
      hint: '把需求拆细一点，或让工具输出更短（用 offset/limit 分段读取）。',
      details: { maxTokens }
    })
  }
}

// ---------------------------------------------------------------- network

export class NetworkError extends AgentError {
  readonly category = 'network' as const
}

// ---------------------------------------------------------------- system

/** 本地环境问题 */
export class SystemError extends AgentError {
  readonly category = 'system' as const
}

// ---------------------------------------------------------------- 工具函数

/** 把任意异常规整成 AgentError */
export function toAgentError(err: unknown, fallbackCode = 'UNKNOWN'): AgentError {
  if (err instanceof AgentError) return err

  if (err instanceof Error) {
    // Node errno
    const errno = err as NodeJS.ErrnoException
    if (errno.code) {
      const hints: Record<string, string> = {
        ENOENT: '文件或目录不存在，先用 list_dir / glob 确认路径',
        EACCES: '没有访问权限',
        EPERM: '操作被拒绝（权限不足，或文件被其它程序占用）',
        EISDIR: '路径是目录不是文件',
        ENOTDIR: '路径中有一段不是目录',
        EEXIST: '目标已存在',
        ENOSPC: '磁盘空间不足'
      }
      return new ToolError(hints[errno.code] ?? err.message, {
        code: `FS_${errno.code}`,
        cause: err,
        hint: hints[errno.code],
        details: { errno: errno.code }
      })
    }
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return new ToolTimeoutError('操作', 0)
    }
    return new SystemError(err.message, { code: fallbackCode, cause: err })
  }

  return new SystemError(String(err), { code: fallbackCode })
}

/**
 * 回传给模型的错误文案。
 * 要能指导它下一步做什么，而不是只丢一个 stack。
 */
export function toToolResultError(err: unknown): string {
  const e = toAgentError(err)
  return e.hint ? `${e.message}\n下一步：${e.hint}` : e.message
}
