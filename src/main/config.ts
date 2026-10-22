import { readFile, writeFile } from 'node:fs/promises'
import { safeStorage } from 'electron'
import { z } from 'zod'
import type { AppConfig, ProviderConfig, ProviderKind } from '@shared/types'
import type { ConfigProvider } from '@core/ports'
import { SystemError, ValidationError } from '@core/errors'

/**
 * 配置读写。
 *
 * 安全边界在「落盘」这一层：API Key 用 Electron 的 safeStorage 加密后存，
 * 内存里和 IPC 里是明文（设置页要能显示/复制，这是桌面应用的常见取舍）。
 * safeStorage 不可用时（极少数 Linux 环境）退回明文并明确告警，不静默降级。
 */

// ---------------------------------------------------------------- 默认值

const DEFAULT_ANTHROPIC: ProviderConfig = {
  apiKey: '',
  baseUrl: '',
  model: 'claude-opus-5',
  enableWebSearch: true
}

const DEFAULT_OPENAI: ProviderConfig = {
  apiKey: '',
  baseUrl: '',
  model: 'deepseek-chat',
  enableWebSearch: false
}

export const DEFAULT_CONFIG: AppConfig = {
  provider: 'anthropic',
  anthropic: DEFAULT_ANTHROPIC,
  openai: DEFAULT_OPENAI,
  workspaceRoot: '',
  maxToolIterations: 15,
  maxOutputTokens: 8192,
  contextWindowTokens: 200_000
}

// ---------------------------------------------------------------- 校验

const providerConfigSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string(),
  model: z.string(),
  enableWebSearch: z.boolean()
})

const appConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai']),
  // 用完整的默认对象而不是 .default({}) —— zod 4 的 .default() 不会再跑一遍校验，
  // 传个残缺对象进去就会漏掉字段。给完整对象是自洽的。
  anthropic: providerConfigSchema.default(DEFAULT_ANTHROPIC),
  openai: providerConfigSchema.default(DEFAULT_OPENAI),
  workspaceRoot: z.string(),
  maxToolIterations: z.number().int().min(1).max(50),
  maxOutputTokens: z.number().int().min(256).max(64_000),
  contextWindowTokens: z.number().int().min(8_000).max(2_000_000)
})

export function validateConfig(raw: unknown): AppConfig {
  const parsed = appConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError('配置文件格式不对，已按默认值恢复', {
      code: 'CONFIG_INVALID',
      hint: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
        .join('; '),
      details: { issues: parsed.error.issues }
    })
  }
  return parsed.data
}

// ---------------------------------------------------------------- 密钥编解码

const ENC_PREFIX = 'enc:v1:'

export interface SecretCodec {
  /** 明文 → 可落盘的字符串 */
  encrypt(plain: string): string
  /** 落盘的字符串 → 明文；解不开返回空串 */
  decrypt(stored: string): string
  /** 加密是否真的生效（false = 明文落盘） */
  readonly isSecure: boolean
}

/**
 * Electron safeStorage（DPAPI / Keychain / libsecret）。
 *
 * 用工厂方法而不是构造函数：Electron 45 起「加密是否可用」是异步查询，
 * 且要求 app 已 ready。构造函数保持同步，编解码路径才不用每步 await。
 */
export class SafeStorageCodec implements SecretCodec {
  private constructor(readonly isSecure: boolean) {}

  static async create(): Promise<SafeStorageCodec> {
    return new SafeStorageCodec(await safeStorage.isAsyncEncryptionAvailable())
  }

  encrypt(plain: string): string {
    if (!plain) return ''
    if (!this.isSecure) return plain
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
  }

  decrypt(stored: string): string {
    if (!stored) return ''
    if (!stored.startsWith(ENC_PREFIX)) return stored // 明文或历史格式
    if (!this.isSecure) return ''
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
    } catch {
      return ''
    }
  }
}

/** 测试用：不加密 */
export class PlainTextCodec implements SecretCodec {
  readonly isSecure = false
  encrypt(plain: string): string {
    return plain
  }
  decrypt(stored: string): string {
    return stored
  }
}

// ---------------------------------------------------------------- 存储

export class JsonConfigStore implements ConfigProvider {
  private cache: AppConfig | null = null

  constructor(
    private readonly filePath: string,
    private readonly codec: SecretCodec
  ) {}

  async get(): Promise<AppConfig> {
    if (this.cache) return structuredClone(this.cache)

    let raw: unknown = {}
    try {
      const text = await readFile(this.filePath, 'utf8')
      raw = text.trim() ? JSON.parse(text) : {}
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') {
        // 文件存在但读不动 —— 明确报错，不要悄悄换一份默认配置盖掉用户的设置
        throw new SystemError(`配置文件无法读取：${this.filePath}`, {
          code: 'CONFIG_UNREADABLE',
          hint: '检查文件是否被占用或损坏，删掉它会重新生成默认配置。',
          cause: err
        })
      }
    }

    let config: AppConfig
    try {
      config = validateConfig(raw)
    } catch {
      // 结构坏了（版本升级、手改错）→ 回落默认值，但保留能认出来的字段
      config = this.merge(DEFAULT_CONFIG, raw as Partial<AppConfig>)
    }

    // 密钥解密
    config = {
      ...config,
      anthropic: { ...config.anthropic, apiKey: this.codec.decrypt(config.anthropic.apiKey) },
      openai: { ...config.openai, apiKey: this.codec.decrypt(config.openai.apiKey) }
    }

    this.cache = config
    return structuredClone(config)
  }

  async set(patch: Partial<AppConfig>): Promise<AppConfig> {
    const current = await this.get()
    const next = this.merge(current, patch)

    // 校验合并结果，拦掉非法的 maxToolIterations 之类
    const validated = validateConfig({
      ...next,
      // 密钥在校验阶段是明文，写盘时才加密
      anthropic: { ...next.anthropic, apiKey: 'x' },
      openai: { ...next.openai, apiKey: 'x' }
    })

    const toStore = {
      ...validated,
      anthropic: { ...validated.anthropic, apiKey: this.codec.encrypt(next.anthropic.apiKey) },
      openai: { ...validated.openai, apiKey: this.codec.encrypt(next.openai.apiKey) }
    }

    try {
      await writeFile(this.filePath, JSON.stringify(toStore, null, 2), 'utf8')
    } catch (err) {
      throw new SystemError(`配置保存失败：${this.filePath}`, {
        code: 'CONFIG_WRITE_FAILED',
        hint: '检查目录是否可写、磁盘是否有空间。',
        cause: err
      })
    }

    this.cache = next
    return structuredClone(next)
  }

  /** 保存时只覆盖 patch 里出现的字段，provider 配置按字段深合并 */
  private merge(base: AppConfig, patch: Partial<AppConfig>): AppConfig {
    return {
      provider: patch.provider ?? base.provider,
      anthropic: { ...base.anthropic, ...(patch.anthropic ?? {}) },
      openai: { ...base.openai, ...(patch.openai ?? {}) },
      workspaceRoot: patch.workspaceRoot ?? base.workspaceRoot,
      maxToolIterations: patch.maxToolIterations ?? base.maxToolIterations,
      maxOutputTokens: patch.maxOutputTokens ?? base.maxOutputTokens,
      contextWindowTokens: patch.contextWindowTokens ?? base.contextWindowTokens
    }
  }
}

/** 当前启用通道的配置 */
export function activeProviderConfig(cfg: AppConfig): {
  kind: ProviderKind
  config: ProviderConfig
} {
  return cfg.provider === 'anthropic'
    ? { kind: 'anthropic', config: cfg.anthropic }
    : { kind: 'openai', config: cfg.openai }
}
