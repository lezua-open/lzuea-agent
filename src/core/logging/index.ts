/**
 * 结构化日志。
 *
 * 设计要点：
 *  - 纯接口（Logger port），core 层不绑实现，测试可以注入静默 logger
 *  - child() 派生带固定字段的子 logger，让 runId / turnId / toolCallId 自动贯穿
 *  - 不拼字符串模板 —— 字段结构化，便于后续接文件/遥测
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** 派生带固定字段的子 logger */
  child(fields: LogFields): Logger
  /** 当前生效级别，用于在昂贵的字段计算前短路 */
  readonly level: LogLevel
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LoggerOptions {
  level?: LogLevel
  /** 每行前缀 */
  name?: string
  /** 输出到哪里；默认 console */
  sink?: (line: string) => void
  /** 固定字段 */
  base?: LogFields
}

function serialize(level: LogLevel, name: string | undefined, fields: LogFields): string {
  const time = new Date().toISOString()
  const payload = { time, level, ...(name ? { name } : {}), ...fields }
  try {
    return JSON.stringify(payload, replacer)
  } catch {
    return JSON.stringify({ time, level, name, message: 'LOG_SERIALIZE_FAILED' })
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const code = (value as unknown as { code?: unknown }).code
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(typeof code === 'string' ? { code } : {})
    }
  }
  if (typeof value === 'bigint') return value.toString()
  return value
}

export class StructuredLogger implements Logger {
  readonly level: LogLevel
  private readonly threshold: number
  private readonly name?: string
  private readonly sink: (line: string) => void
  private readonly base: LogFields

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? 'info'
    this.threshold = LEVEL_ORDER[this.level]
    this.name = opts.name
    this.sink = opts.sink ?? ((line) => process.stdout.write(line + '\n'))
    this.base = opts.base ?? {}
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.threshold) return
    this.sink(serialize(level, this.name, { ...this.base, message, ...(fields ?? {}) }))
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields)
  }
  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields)
  }
  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields)
  }
  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields)
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger({
      level: this.level,
      name: this.name,
      sink: this.sink,
      base: { ...this.base, ...fields }
    })
  }
}

/** 测试用：什么都不打 */
export const silentLogger: Logger = {
  level: 'error',
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this
  }
}
