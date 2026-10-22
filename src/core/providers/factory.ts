import type { ProviderConfig, ProviderKind } from '@shared/types'
import { UserError } from '@core/errors'
import type { ModelProvider, ModelProviderFactory } from './types'
import { AnthropicProvider } from './anthropic'
import { OpenAICompatibleProvider } from './openai'

/**
 * Provider 工厂。
 * 主循环不 new 具体适配器 —— 换通道只改这里的映射表。
 */
export class DefaultProviderFactory implements ModelProviderFactory {
  create(kind: ProviderKind, cfg: ProviderConfig): ModelProvider {
    switch (kind) {
      case 'anthropic':
        return new AnthropicProvider(cfg)
      case 'openai':
        return new OpenAICompatibleProvider(cfg)
      default: {
        const _exhaustive: never = kind
        throw new UserError(`不支持的 provider：${String(_exhaustive)}`, {
          code: 'UNKNOWN_PROVIDER',
          hint: '到「设置」里把 provider 改成 anthropic 或 openai。'
        })
      }
    }
  }
}

export const defaultProviderFactory = new DefaultProviderFactory()
