import { stat, readdir, mkdir, writeFile, unlink, rm, lstat, readFile } from 'fs/promises'
import { dirname, join, sep } from 'path'
import fg from 'fast-glob'
import ignore from 'ignore'
import { createTwoFilesPatch } from 'diff'
import { z } from 'zod'
import { defineTool, ok, fail, type ToolExecutionContext, type ToolResult } from '../types'
import { resolveRealInsideWorkspace, toRelative } from '../sandbox'

/**
 * 文件增删改查工具集。
 *
 * 每个工具三件事：zod schema（校验 + 给模型的 JSON Schema）、preview（给人看，
 * 用于确认框）、handler（真正干活）。pathParams 声明过的路径会由沙箱中间件统一校验。
 */

// ---------------------------------------------------------------- 公共工具

const MAX_READ_LINES = 4000
const DEFAULT_READ_LINES = 2000

/** 前 8KB 有 NUL 就当二进制 */
async function looksBinary(absPath: string): Promise<boolean> {
  try {
    const buf = await readFile(absPath)
    return buf.subarray(0, 8192).includes(0)
  } catch {
    return false
  }
}

/** 读文本；返回 null 表示不存在 / 二进制 / 非 UTF-8 */
export async function readTextOrNull(absPath: string): Promise<string | null> {
  if (await looksBinary(absPath)) return null
  try {
    const buf = await readFile(absPath)
    let text = buf.toString('utf8')
    if (text.includes('�') && buf.length > 0) return null
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return text
  } catch {
    return null
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function makeDiff(oldText: string | null, newText: string, relPath: string): string {
  return oldText === null
    ? createTwoFilesPatch('/dev/null', '', relPath, newText, '新建', '写入')
    : createTwoFilesPatch(relPath, oldText, relPath, newText, '当前', '写入后')
}

const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/.next/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/target/**',
  '**/*.min.js',
  '**/*.map',
  '**/.DS_Store',
  '**/Thumbs.db'
]

function makeIgnore(): ReturnType<typeof ignore> {
  return ignore().add(DEFAULT_IGNORES)
}

function relPath(ctx: ToolExecutionContext, abs: string): string {
  return toRelative(ctx.workspaceRoot, abs)
}

// ---------------------------------------------------------------- list_dir

const listDirSchema = z.object({
  path: z.string().describe('要列出的目录，相对工作区，例如 "." 或 "src"'),
  depth: z.number().int().min(1).max(8).optional().describe('递归深度，默认 1')
})

export const listDirTool = defineTool({
  name: 'list_dir',
  description:
    '列出目录内容。默认深度 1。自动跳过 node_modules、.git、dist 等常见噪音目录。路径相对工作区。',
  risk: 'read',
  schema: listDirSchema,
  pathParams: ['path'],
  handler: async ({ path, depth = 1 }, ctx) => {
    const abs = await resolveRealInsideWorkspace(ctx.workspaceRoot, path)
    const st = await stat(abs)
    if (!st.isDirectory()) {
      const text = await readTextOrNull(abs)
      return ok(
        `这不是目录，是文件（${formatBytes(st.size)}）。内容：\n${text ?? '（二进制文件，无法显示）'}`
      )
    }

    const ig = makeIgnore()
    const lines: string[] = []
    const walk = async (dir: string, level: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true })
      entries.sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
      )
      for (const e of entries) {
        const full = join(dir, e.name)
        const rel = relPath(ctx, full)
        if (ig.ignores(rel)) continue
        lines.push(`${'  '.repeat(level)}${e.isDirectory() ? '[DIR] ' : '[FIL] '}${rel}`)
        if (e.isDirectory() && level + 1 < depth) await walk(full, level + 1)
      }
    }
    await walk(abs, 0)

    return ok(
      lines.length === 0
        ? `目录 ${relPath(ctx, abs)} 是空的（或全被忽略规则过滤了）`
        : lines.join('\n')
    )
  }
})

// ---------------------------------------------------------------- read_file

const readFileSchema = z.object({
  path: z.string().describe('文件路径，相对工作区'),
  offset: z.number().int().min(1).optional().describe('起始行号（从 1 开始），默认 1'),
  limit: z.number().int().min(1).max(MAX_READ_LINES).optional().describe('读取行数，默认 2000')
})

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    '读取文本文件内容，带行号。大文件请用 offset/limit 分段读取。行号便于后续用 edit_file 精确定位。',
  risk: 'read',
  schema: readFileSchema,
  pathParams: ['path'],
  handler: async ({ path, offset = 1, limit = DEFAULT_READ_LINES }, ctx) => {
    const abs = await resolveRealInsideWorkspace(ctx.workspaceRoot, path)
    const st = await stat(abs)
    if (st.isDirectory()) return fail('这是目录不是文件，用 list_dir 看内容')

    const text = await readTextOrNull(abs)
    if (text === null)
      return ok(`（二进制或非 UTF-8 文件，${formatBytes(st.size)}，无法作为文本读取）`)

    const all = text.split('\n')
    const slice = all.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join('\n')
    const last = offset + slice.length - 1
    return ok(
      `文件 ${relPath(ctx, abs)}  共 ${all.length} 行  显示第 ${offset}-${last} 行\n${numbered}`
    )
  }
})

// ---------------------------------------------------------------- write_file

const writeFileSchema = z.object({
  path: z.string().describe('文件路径，相对工作区'),
  content: z.string().describe('完整文件内容')
})

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    '创建或整体覆盖文件，自动创建父目录。覆盖已有文件前会展示 diff 并要求确认。' +
    '小改动用 edit_file，只有重写整份文件才用这个。',
  risk: 'write',
  schema: writeFileSchema,
  pathParams: ['path'],
  preview: async ({ path, content }, ctx) => {
    const abs = await resolveRealInsideWorkspace(ctx.workspaceRoot, path)
    const rel = relPath(ctx, abs)
    const existing = await readTextOrNull(abs)
    if (existing === null) {
      return {
        kind: 'other',
        title: `新建文件 ${rel}`,
        detail: `新建 ${rel}（${formatBytes(Buffer.byteLength(content))}）：\n\n${content.slice(0, 4000)}`,
        paths: [rel]
      }
    }
    return {
      kind: 'diff',
      title: `覆盖已有文件 ${rel}`,
      detail: makeDiff(existing, content, rel),
      paths: [rel]
    }
  },
  handler: async ({ path, content }, ctx) => {
    const abs = await resolveRealInsideWorkspace(ctx.workspaceRoot, path)
    const existed = (await readTextOrNull(abs)) !== null
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    return ok(
      `${existed ? '已覆盖' : '已创建'} ${relPath(ctx, abs)}（${formatBytes(Buffer.byteLength(content))}）`,
      { path, bytes: Buffer.byteLength(content), overwritten: existed }
    )
  }
})

// ---------------------------------------------------------------- edit_file

const editFileSchema = z.object({
  path: z.string().describe('文件路径，相对工作区'),
  old_string: z.string().min(1).describe('要被替换的原文，必须与文件完全一致（含缩进）'),
  new_string: z.string().describe('替换后的新文本'),
  replace_all: z.boolean().optional().describe('是否替换所有匹配，默认 false')
})

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    '精确替换文件中的一段文本。old_string 必须在文件中唯一出现（除非 replace_all=true）。' +
    '匹配不到或多处匹配会报错且不改动文件。**改已有文件优先用这个**而不是 write_file。',
  risk: 'write',
  schema: editFileSchema,
  pathParams: ['path'],
  preview: async ({ path, old_string, new_string, replace_all }, ctx) => {
    const abs = await resolveRealInsideWorkspace(ctx.workspaceRoot, path)
    const rel = relPath(ctx, abs)
    const existing = await readTextOrNull(abs)
    if (existing === null) {
      return {
        kind: 'other',
        title: `编辑 ${rel}`,
        detail: '文件不存在或不是文本文件，无法编辑',
        paths: [rel]
      }
    }
    const count = existing.split(old_string).length - 1
    if (count === 0) {
      return {
        kind: 'other',
        title: `编辑 ${rel}`,
        detail: 'old_string 在文件中找不到匹配，不会改动',
        paths: [rel]
      }
    }
    const next = replace_all
      ? existing.split(old_string).join(new_string)
      : existing.replace(old_string, new_string)
    return {
      kind: 'diff',
      title: `编辑 ${rel}（${replace_all ? `替换 ${count} 处` : '替换 1 处'}）`,
      detail: makeDiff(existing, next, rel),
      paths: [rel]
    }
  },
  handler: async ({ path, old_string, new_string, replace_all }, ctx) => {
    const abs = await resolveRealInsideWorkspace(ctx.workspaceRoot, path)
    const existing = await readTextOrNull(abs)
    if (existing === null) return fail('文件不存在或不是文本文件，无法编辑')

    const count = existing.split(old_string).length - 1
    if (count === 0) {
      return fail(
        `没有找到匹配的 old_string，文件未改动。\n下一步：old_string 必须逐字符一致（含缩进和行尾）。先用 read_file 看准确内容。`
      )
    }
    if (count > 1 && !replace_all) {
      return fail(
        `old_string 出现 ${count} 次，无法确定改哪一处，文件未改动。\n下一步：把 old_string 扩大到包含更多上下文使其唯一，或设 replace_all=true。`
      )
    }

    const next = replace_all
      ? existing.split(old_string).join(new_string)
      : existing.replace(old_string, new_string)
    await writeFile(abs, next, 'utf8')
    return ok(`已更新 ${relPath(ctx, abs)}，替换了 ${replace_all ? count : 1} 处`, {
      replaced: count
    })
  }
})

// ---------------------------------------------------------------- delete_path

const deleteSchema = z.object({
  path: z.string().describe('要删除的路径，相对工作区'),
  recursive: z.boolean().optional().describe('删除非空目录时必须为 true')
})

export const deletePathTool = defineTool({
  name: 'delete_path',
  description:
    '删除文件或目录。**不可逆操作**，每次都需要用户明确确认。删除非空目录必须设 recursive=true。',
  risk: 'dangerous',
  schema: deleteSchema,
  pathParams: ['path'],
  preview: async ({ path, recursive }, ctx) => {
    const abs = await resolveRealInsideWorkspace(ctx.workspaceRoot, path)
    const rel = relPath(ctx, abs)
    let st
    try {
      st = await lstat(abs)
    } catch {
      return { kind: 'delete', title: `删除 ${rel}`, detail: '目标不存在', paths: [rel] }
    }

    if (!st.isDirectory()) {
      const text = await readTextOrNull(abs)
      return {
        kind: 'delete',
        title: `删除文件 ${rel}`,
        detail: `大小 ${formatBytes(st.size)}，**不可逆**。\n\n将被删除的内容预览：\n${(text ?? '（二进制文件）').slice(0, 3000)}`,
        paths: [rel]
      }
    }

    const ig = makeIgnore()
    const found: string[] = []
    const walk = async (dir: string): Promise<void> => {
      if (found.length > 300) return
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        const r = relPath(ctx, full)
        if (ig.ignores(r)) continue
        found.push(r + (e.isDirectory() ? '/' : ''))
        if (e.isDirectory()) await walk(full)
      }
    }
    await walk(abs)

    return {
      kind: 'delete',
      title: `删除目录 ${rel}/${recursive ? '（递归）' : ''}`,
      detail:
        `将删除目录 ${rel} 及其中 ${found.length} 个条目，**不可逆**。\n` +
        (recursive ? '' : '注意：recursive=false，只允许删除空目录。\n') +
        `\n清单（最多 300 条）：\n${found.slice(0, 300).join('\n')}` +
        (found.length > 300 ? `\n…另有 ${found.length - 300} 条` : ''),
      paths: [rel]
    }
  },
  handler: async ({ path, recursive }, ctx) => {
    const abs = await resolveRealInsideWorkspace(ctx.workspaceRoot, path)
    const rel = relPath(ctx, abs)
    const st = await lstat(abs)

    if (st.isDirectory()) {
      const entries = await readdir(abs)
      if (entries.length > 0 && !recursive) {
        return fail(
          `目录 ${rel} 非空（${entries.length} 项），未删除。\n下一步：确认要删请设 recursive=true。`
        )
      }
      await rm(abs, { recursive: true, force: true })
      return ok(`已删除目录 ${rel}${recursive ? '（递归）' : ''}`, { path, kind: 'dir' })
    }
    await unlink(abs)
    return ok(`已删除文件 ${rel}`, { path, kind: 'file' })
  }
})

// ---------------------------------------------------------------- glob

const globSchema = z.object({
  pattern: z.string().min(1).describe('glob 模式，例如 "src/**/*.ts" 或 "**/*.md"'),
  path: z.string().optional().describe('在哪个目录下找，默认工作区根')
})

export const globTool = defineTool({
  name: 'glob',
  description: '按 glob 模式查找文件。返回相对路径列表。自动跳过 node_modules 等噪音目录。',
  risk: 'read',
  schema: globSchema,
  pathParams: ['path'],
  handler: async ({ pattern, path = '.' }, ctx) => {
    const abs = await resolveRealInsideWorkspace(ctx.workspaceRoot, path)
    const matches = await fg(pattern, {
      cwd: abs,
      ignore: DEFAULT_IGNORES,
      dot: false,
      onlyFiles: true,
      suppressErrors: true
    })
    if (matches.length === 0) return ok(`没有匹配 ${pattern} 的文件`)

    return ok(
      `共 ${matches.length} 个匹配：\n` +
        matches
          .slice(0, 300)
          .map((m) => m.split(sep).join('/'))
          .join('\n') +
        (matches.length > 300 ? `\n…另有 ${matches.length - 300} 个` : '')
    )
  }
})

// ---------------------------------------------------------------- grep

const grepSchema = z.object({
  pattern: z.string().min(1).describe('JS 正则表达式，例如 "function\\s+foo"'),
  path: z.string().optional().describe('搜索起点，默认工作区根'),
  glob: z.string().optional().describe('限定文件类型，例如 "**/*.{ts,tsx}"'),
  case_insensitive: z.boolean().optional().describe('忽略大小写，默认 false')
})

export const grepTool = defineTool({
  name: 'grep',
  description:
    '在文件内容里搜索正则表达式，返回 `文件:行号:内容`。适合找函数定义、变量引用、字符串位置。pattern 是 JS 正则语法。',
  risk: 'read',
  schema: grepSchema,
  pathParams: ['path'],
  handler: async ({ pattern, path = '.', glob = '**/*', case_insensitive }, ctx) => {
    const abs = await resolveRealInsideWorkspace(ctx.workspaceRoot, path)
    const re = new RegExp(pattern, case_insensitive ? 'i' : '')
    const files = await fg(glob, {
      cwd: abs,
      ignore: DEFAULT_IGNORES,
      onlyFiles: true,
      suppressErrors: true
    })

    const hits: string[] = []
    let scanned = 0
    for (const rel of files) {
      if (hits.length >= 200) break
      const text = await readTextOrNull(join(abs, rel))
      if (text === null) continue
      scanned++
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= 200) break
        if (re.test(lines[i])) hits.push(`${rel.split(sep).join('/')}:${i + 1}: ${lines[i].trim()}`)
      }
    }

    if (hits.length === 0) {
      return ok(`在 ${scanned} 个文件里没有找到匹配 /${pattern}/${case_insensitive ? 'i' : ''}`)
    }
    return ok(
      `找到 ${hits.length} 处${hits.length >= 200 ? '（已达上限，建议缩小范围）' : ''}：\n` +
        hits.join('\n')
    )
  }
})

export const fsTools = [
  listDirTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  deletePathTool,
  globTool,
  grepTool
]

export type { ToolResult }
