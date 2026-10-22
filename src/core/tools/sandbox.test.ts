import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { SandboxViolationError } from '@core/errors'
import { isInside, resolveInsideWorkspace, resolveRealInsideWorkspace, toRelative } from './sandbox'

let root: string
let outside: string

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'lzuea-sandbox-'))
  root = join(base, 'workspace')
  outside = join(base, 'outside')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.txt'), 'top secret')
  await writeFile(join(root, 'src', 'app.ts'), 'export {}')
})

afterAll(async () => {
  await rm(resolve(root, '..'), { recursive: true, force: true })
})

describe('isInside', () => {
  it('自己等于自己也算在内', () => {
    expect(isInside(root, root)).toBe(true)
  })

  it('子路径在内，兄弟目录不在', () => {
    expect(isInside(root, join(root, 'src', 'app.ts'))).toBe(true)
    expect(isInside(root, join(root, '..', 'outside'))).toBe(false)
  })

  it('同前缀但不同目录不算（防 "/foo" 放过 "/foobar"）', () => {
    expect(isInside('/work', '/workevil')).toBe(false)
    expect(isInside('/work', '/work/evil')).toBe(true)
  })
})

describe('resolveInsideWorkspace', () => {
  it('相对路径按工作区根解析', () => {
    expect(resolveInsideWorkspace(root, 'src/app.ts')).toBe(resolve(root, 'src', 'app.ts'))
  })

  it('工作区内的绝对路径放行', () => {
    const abs = join(root, 'src')
    expect(resolveInsideWorkspace(root, abs)).toBe(resolve(abs))
  })

  it('拒绝 .. 上跳', () => {
    expect(() => resolveInsideWorkspace(root, '../outside/secret.txt')).toThrow(
      SandboxViolationError
    )
    expect(() => resolveInsideWorkspace(root, 'src/../../outside')).toThrow(SandboxViolationError)
  })

  it('拒绝工作区外的绝对路径', () => {
    expect(() => resolveInsideWorkspace(root, join(outside, 'secret.txt'))).toThrow(
      SandboxViolationError
    )
    expect(() => resolveInsideWorkspace(root, sep + 'etc' + sep + 'passwd')).toThrow(
      SandboxViolationError
    )
  })

  it('拒绝空路径和 NUL 字节', () => {
    expect(() => resolveInsideWorkspace(root, '')).toThrow(SandboxViolationError)
    expect(() => resolveInsideWorkspace(root, '   ')).toThrow(SandboxViolationError)
    expect(() => resolveInsideWorkspace(root, 'a\0b')).toThrow(SandboxViolationError)
  })

  it('错误里带上原始路径，便于排查', () => {
    try {
      resolveInsideWorkspace(root, '../escape')
      expect.unreachable('应该抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxViolationError)
      expect((e as SandboxViolationError).details.path).toBe('../escape')
    }
  })
})

describe('resolveRealInsideWorkspace', () => {
  it('普通文件通过', async () => {
    await expect(resolveRealInsideWorkspace(root, 'src/app.ts')).resolves.toContain('app.ts')
  })

  it('新建文件允许（最近存在的祖先在工作区内）', async () => {
    await expect(resolveRealInsideWorkspace(root, 'src/brand/new/file.ts')).resolves.toContain(
      join('brand', 'new')
    )
  })

  it('指向工作区外的符号链接被拦下', async () => {
    const link = join(root, 'escape-link')
    await symlink(outside, link, 'junction').catch(() => symlink(outside, link))
    await expect(resolveRealInsideWorkspace(root, 'escape-link/secret.txt')).rejects.toThrow(
      SandboxViolationError
    )
  })

  it('工作区内部的符号链接放行', async () => {
    const link = join(root, 'inside-link')
    await symlink(join(root, 'src'), link, 'junction').catch(() => symlink(join(root, 'src'), link))
    await expect(resolveRealInsideWorkspace(root, 'inside-link/app.ts')).resolves.toContain(
      'app.ts'
    )
  })
})

describe('toRelative', () => {
  it('工作区内转成带 / 的相对路径', () => {
    expect(toRelative(root, join(root, 'src', 'app.ts'))).toBe('src/app.ts')
    expect(toRelative(root, root)).toBe('.')
  })

  it('工作区外原样返回绝对路径（不假装安全）', () => {
    const abs = join(outside, 'secret.txt')
    expect(toRelative(root, abs)).toBe(resolve(abs))
  })
})
