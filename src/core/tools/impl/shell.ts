import { spawn } from 'child_process'
import { z } from 'zod'
import { defineTool, ok, fail, type ToolExecutionContext } from '../types'
import { toRelative } from '../sandbox'

/**
 * 终端命令执行。
 *
 * 风险最高的一档：命令拥有当前用户的全部权限，工作区沙箱限制不了命令本身的行为。
 * 真正的防线是「每条命令都要人确认」+ 确认框把命令原样打出来。
 */

const MAX_TIMEOUT_S = 300
const MAX_OUTPUT_CHARS = 40_000

const shellSchema = z.object({
  command: z.string().min(1).describe('要执行的命令行'),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_S)
    .optional()
    .describe(`超时秒数，默认 60，最大 ${MAX_TIMEOUT_S}`)
})

function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

interface RunOutcome {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  aborted: boolean
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', PYTHONIOENCODING: 'utf-8' }
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    const onAbort = (): void => {
      aborted = true
      killTree(child.pid)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString('utf8')
    })

    const done = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, code, timedOut, aborted })
    }

    child.on('error', (err) => {
      stderr += `\n启动失败：${err.message}`
      done(null)
    })
    child.on('close', (code) => done(code))
  })
}

export const runCommandTool = defineTool({
  name: 'run_command',
  description:
    '在工作区目录下执行 shell 命令（Windows 用 cmd.exe，其它用 /bin/sh）。用于 npm install、构建、测试、git 等。' +
    '每条命令都需要用户确认。注意：命令拥有当前用户的全部系统权限，工作区沙箱限制不了命令本身。' +
    '避免需要交互输入的命令（会卡住直到超时）。',
  risk: 'dangerous',
  schema: shellSchema,
  timeoutMs: MAX_TIMEOUT_S * 1000,
  preview: async ({ command, timeout_seconds = 60 }, ctx) => ({
    kind: 'command',
    title: '执行命令',
    detail:
      `工作目录：${ctx.workspaceRoot}\n` +
      `超时：${timeout_seconds} 秒\n\n` +
      `待执行：\n$ ${command}\n\n` +
      `⚠ 该命令拥有当前用户的全部系统权限。若不确定它会做什么，请拒绝。`,
    paths: [toRelative(ctx.workspaceRoot, ctx.workspaceRoot) || '.']
  }),
  handler: async ({ command, timeout_seconds = 60 }, ctx: ToolExecutionContext) => {
    const result = await runCommand(command, ctx.workspaceRoot, timeout_seconds * 1000, ctx.signal)

    const parts: string[] = [`退出码：${result.code ?? '（被中断）'}`]
    if (result.timedOut) parts.push(`⚠ 已超时（${timeout_seconds}s）并强制终止`)
    if (result.aborted && !result.timedOut) parts.push('⚠ 已被用户中断')
    if (result.stdout) parts.push(`--- stdout ---\n${result.stdout.trim()}`)
    if (result.stderr) parts.push(`--- stderr ---\n${result.stderr.trim()}`)
    if (!result.stdout && !result.stderr) parts.push('（无输出）')

    const content = parts.join('\n\n')
    if (result.aborted) return fail(content, { exitCode: result.code })
    return ok(content, { exitCode: result.code, timedOut: result.timedOut })
  }
})

export const shellTools = [runCommandTool]
