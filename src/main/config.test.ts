import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, validateConfig } from './config'

/**
 * 配置升级路径。
 *
 * v0.1.x 的 config.json 里没有 theme 字段。加字段时给的是 .default('light')，
 * 老文件必须能直接读进来并补上默认值，不能要求用户手改 JSON。
 * 这条路径一旦回归，用户升级后就会被「配置文件格式不对」挡在门外。
 */

/** 只带必填项的配置 —— 刻意不写 theme，模拟 v0.1.x 的老文件 */
const LEGACY_CONFIG = {
  provider: 'openai',
  workspaceRoot: 'D:/proj',
  maxToolIterations: 15,
  maxOutputTokens: 8192,
  contextWindowTokens: 200_000
}

describe('validateConfig 主题字段的升级兼容', () => {
  it('老配置没有 theme 时补成亮色，而不是报错', () => {
    const cfg = validateConfig(LEGACY_CONFIG)
    expect(cfg.theme).toBe('light')
  })

  it('显式写 dark 就保留 dark', () => {
    const cfg = validateConfig({ ...LEGACY_CONFIG, theme: 'dark' })
    expect(cfg.theme).toBe('dark')
  })

  it('theme 只接受 light / dark，别的值直接拒掉', () => {
    expect(() => validateConfig({ ...LEGACY_CONFIG, theme: 'sepia' })).toThrowError(/格式不对/)
  })

  it('默认值来自 DEFAULT_CONFIG，两处不许各说各话', () => {
    expect(DEFAULT_CONFIG.theme).toBe('light')
  })
})
