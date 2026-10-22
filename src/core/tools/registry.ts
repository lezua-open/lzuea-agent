import { z } from 'zod'
import type { JsonSchema, ProviderKind } from '@shared/types'
import type { ToolDefinition as ModelToolDefinition } from '@core/providers/types'
import { UnknownToolError, toToolResultError, ValidationError } from '@core/errors'
import { compose } from './middleware/compose'
import type {
  AnyToolDefinition,
  ToolExecutionContext,
  ToolMiddleware,
  ToolRequest,
  ToolResult
} from './types'
import { fail } from './types'

/**
 * 工具注册表 + 中间件管道。
 *
 * 主循环只跟 execute() 打交道，完全不需要知道审批、超时、沙箱这些事。
 * 加新工具 = register 一个定义；加横切能力 = 插一个中间件。
 */

export interface ModelToolsOptions {
  providerKind: ProviderKind
  enableServerWebSearch: boolean
}

function toJsonSchema(schema: z.ZodType): JsonSchema {
  try {
    const json = z.toJSONSchema(schema) as Record<string, unknown>
    // Anthropic / OpenAI 都不认 $schema 这个键
    delete json.$schema
    if (json.type !== 'object') {
      return { type: 'object', properties: {}, additionalProperties: true, ...json }
    }
    return json as JsonSchema
  } catch {
    // schema 里有 z.lazy / transform 等无法静态导出的情况，退化成开放对象
    return { type: 'object', properties: {}, additionalProperties: true }
  }
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.length ? i.path.join('.') : '(根)'
      return `${path}: ${i.message}`
    })
    .join('; ')
}

export class ToolRegistry {
  private tools = new Map<string, AnyToolDefinition>()
  private readonly pipeline: ReturnType<typeof compose>

  constructor(middlewares: ToolMiddleware[]) {
    this.pipeline = compose(middlewares)
  }

  register(def: AnyToolDefinition): this {
    if (this.tools.has(def.name)) {
      throw new Error(`工具重复注册：${def.name}`)
    }
    this.tools.set(def.name, def)
    return this
  }

  registerAll(defs: readonly AnyToolDefinition[]): this {
    for (const d of defs) this.register(d)
    return this
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()]
  }

  names(): string[] {
    return [...this.tools.keys()]
  }

  /** 生成发给模型的工具定义 */
  toModelTools(opts: ModelToolsOptions): ModelToolDefinition[] {
    const defs: ModelToolDefinition[] = this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toJsonSchema(t.schema)
    }))

    if (opts.providerKind === 'anthropic' && opts.enableServerWebSearch) {
      // Anthropic 服务端工具：不进 executor，只声明给模型
      defs.push({
        name: 'web_search',
        description:
          '搜索互联网并返回结果，自动附带来源链接。用于查找最新资料、API 文档、报错解决方案。',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: '搜索关键词' } },
          required: ['query'],
          additionalProperties: false
        },
        serverSide: true,
        rawServerTool: { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }
      })
    }

    return defs
  }

  /**
   * 校验 + 走中间件 + 执行。
   * 永远返回 ToolResult，不抛异常给调用方 —— 模型需要能读到失败原因。
   */
  async execute(name: string, input: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return fail(new UnknownToolError(name, this.names()).toUserMessage())
    }

    const parsed = tool.schema.safeParse(input)
    if (!parsed.success) {
      const err = new ValidationError(`工具 ${name} 入参不合法`, {
        code: 'TOOL_INPUT_INVALID',
        hint: formatZodError(parsed.error),
        details: { tool: name, issues: parsed.error.issues }
      })
      return fail(`${err.message}\n问题：${err.hint}`)
    }

    const req: ToolRequest = {
      name,
      input,
      validated: parsed.data,
      tool,
      ctx,
      state: new Map()
    }

    try {
      return await this.pipeline(req, () => tool.handler(parsed.data, req.ctx))
    } catch (err) {
      // 审批拒绝、沙箱违规、超时都会走到这里，转成可回传给模型的失败结果
      return fail(toToolResultError(err), { thrown: true })
    }
  }
}
