import type { z } from 'zod'
import type { ApprovalPreview, RiskLevel } from '@shared/types'
import type { Clock, IdGenerator, MemoryRepository } from '@core/ports'
import type { Logger } from '@core/logging'

/**
 * 工具契约。
 *
 * 一个工具 = zod schema（校验 + 生成 JSON Schema）+ handler（干活）+ 可选 preview（给人看）。
 * 横切关注点（审批、超时、沙箱、日志）不写进 handler，走中间件链。
 *
 * 用 zod 而不是手写 JSON Schema + 手写 parse，是主流做法（Vercel AI SDK、
 * Anthropic 的 betaZodTool 都是这样）：一份定义同时出运行时校验和 API 的 schema，
 * 不会两边写歪。
 */

// ---------------------------------------------------------------- 执行上下文

export interface ToolExecutionContext {
  /** 工作区根，沙箱边界 */
  workspaceRoot: string
  memory: MemoryRepository
  logger: Logger
  clock: Clock
  ids: IdGenerator
  /** 便于 trace 关联 */
  conversationId: string
  messageId: string
  toolCallId: string
  /** 用户点「停止」或超时触发 */
  signal?: AbortSignal
}

// ---------------------------------------------------------------- 结果

export interface ToolResult {
  /** 回传给模型的文本 */
  content: string
  isError: boolean
  /** 只进 trace，不给模型 */
  meta?: Record<string, unknown>
}

/** 输出给模型的字符上限 */
export const MAX_TOOL_OUTPUT_CHARS = 48_000

export function truncateForModel(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text
  return (
    text.slice(0, max) +
    `\n\n…（已截断：全文 ${text.length} 字符，只显示前 ${max}。需要看后面请用 offset/limit 分段读取）`
  )
}

export function ok(content: string, meta?: Record<string, unknown>): ToolResult {
  return { content: truncateForModel(content), isError: false, meta }
}

export function fail(content: string, meta?: Record<string, unknown>): ToolResult {
  return { content: truncateForModel(content), isError: true, meta }
}

// ---------------------------------------------------------------- 工具定义

export interface ToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  name: string
  description: string
  /** 风险分级，决定要不要过审批闸门 */
  risk: RiskLevel
  /** 入参 schema，同时用于运行时校验和导出 JSON Schema 给模型 */
  schema: TSchema
  handler: (input: z.infer<TSchema>, ctx: ToolExecutionContext) => Promise<ToolResult>
  /**
   * 入参里哪些字段是工作区相对路径。
   * 沙箱中间件会统一校验，handler 里可以信任它们没逃出工作区。
   */
  pathParams?: readonly string[]
  /** 确认框预览。risk !== 'read' 时必须提供 */
  preview?: (input: z.infer<TSchema>, ctx: ToolExecutionContext) => Promise<ApprovalPreview>
  /** 覆盖默认超时 */
  timeoutMs?: number
}

/** 让 TS 从 schema 推断 handler 入参 */
export function defineTool<TSchema extends z.ZodType>(
  def: ToolDefinition<TSchema>
): ToolDefinition<TSchema> {
  return def
}

/** 任意工具定义，数组里存放时用 */
export type AnyToolDefinition = ToolDefinition<z.ZodType>

// ---------------------------------------------------------------- 中间件

export interface ToolRequest {
  name: string
  /** 原始入参（未校验） */
  input: unknown
  /** 已校验归一化的入参，由 registry 填充 */
  validated: unknown
  tool: AnyToolDefinition
  ctx: ToolExecutionContext
  /** 中间件之间传递的暂存数据 */
  state: Map<string, unknown>
}

export interface ToolMiddleware {
  (req: ToolRequest, next: () => Promise<ToolResult>): Promise<ToolResult>
}

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000
