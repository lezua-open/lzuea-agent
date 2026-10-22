import { resolve, sep, dirname, isAbsolute } from 'path'
import { realpath } from 'fs/promises'
import { SandboxViolationError } from '@core/errors'

/**
 * 工作区沙箱。
 *
 * Agent 给的任何路径都必须落在 workspaceRoot 内。三层校验，缺一不可：
 *   1. 语法归一化后做前缀比较（拦 ../ 和绝对路径）
 *   2. 大小写归一（Windows 文件系统不区分大小写）
 *   3. realpath 复查（拦符号链接 / junction 逃逸）
 *
 * 这里是安全边界，不要在这里放业务逻辑。
 */

/** Windows 路径大小写不敏感，比较前统一小写 */
function canon(p: string): string {
  const abs = resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export function isInside(root: string, candidate: string): boolean {
  const canonRoot = canon(root)
  const canonCandidate = canon(candidate)
  return canonCandidate === canonRoot || canonCandidate.startsWith(canonRoot + sep)
}

/**
 * 把 Agent 给的路径解析成工作区内的绝对路径。
 * 相对路径按工作区根解析；绝对路径必须已经在工作区内。
 */
export function resolveInsideWorkspace(workspaceRoot: string, inputPath: string): string {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new SandboxViolationError(String(inputPath), '路径为空')
  }
  if (inputPath.includes('\0')) {
    throw new SandboxViolationError(inputPath, '路径包含非法字符 NUL')
  }
  // Windows 的 \\?\ 扩展前缀会绕过常规归一化
  if (process.platform === 'win32' && inputPath.startsWith('\\\\?\\')) {
    throw new SandboxViolationError(inputPath, '不支持 Windows 扩展路径前缀')
  }

  const root = resolve(workspaceRoot)
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath)

  if (!isInside(root, candidate)) {
    throw new SandboxViolationError(inputPath, '路径越出工作区')
  }
  return candidate
}

/**
 * 解析后做 realpath 复查，拦符号链接 / junction 逃逸。
 * 目标不存在时退化为检查最近存在的祖先目录（新建文件的场景）。
 */
export async function resolveRealInsideWorkspace(
  workspaceRoot: string,
  inputPath: string
): Promise<string> {
  const candidate = resolveInsideWorkspace(workspaceRoot, inputPath)
  const rootReal = await realpath(resolve(workspaceRoot)).catch(() => resolve(workspaceRoot))

  let probe = candidate
  for (;;) {
    try {
      const real = await realpath(probe)
      if (!isInside(rootReal, real)) {
        throw new SandboxViolationError(inputPath, '符号链接指向工作区外')
      }
      break
    } catch (err) {
      if (err instanceof SandboxViolationError) throw err
      const parent = dirname(probe)
      if (parent === probe) {
        throw new SandboxViolationError(inputPath, '无法解析路径')
      }
      probe = parent
    }
  }
  return candidate
}

/** 工作区内的相对路径，用于展示 */
export function toRelative(workspaceRoot: string, absPath: string): string {
  const root = resolve(workspaceRoot)
  const p = resolve(absPath)
  if (!isInside(root, p)) return p
  const rel = p.slice(root.length).replace(/^[\\/]/, '')
  return rel === '' ? '.' : rel.split(sep).join('/')
}
