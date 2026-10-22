import { useMemo, useState } from 'react'
import type { AppConfig, ProviderConfig, ProviderKind } from '@shared/types'
import { agentStore, useAgentStore } from '../store/agentStore'

interface Draft {
  provider: ProviderKind
  anthropic: ProviderConfig
  openai: ProviderConfig
  workspaceRoot: string
  maxToolIterations: string
  maxOutputTokens: string
  contextWindowTokens: string
}

function toDraft(cfg: AppConfig): Draft {
  return {
    provider: cfg.provider,
    anthropic: { ...cfg.anthropic },
    openai: { ...cfg.openai },
    workspaceRoot: cfg.workspaceRoot,
    maxToolIterations: String(cfg.maxToolIterations),
    maxOutputTokens: String(cfg.maxOutputTokens),
    contextWindowTokens: String(cfg.contextWindowTokens)
  }
}

/**
 * 设置页。
 *
 * 表单在本地维护一份 draft，点保存才写回 ——
 * 每敲一个字就走 IPC 存盘会让输入卡顿，也会把半成品配置写进磁盘。
 */
export function SettingsPanel(): React.JSX.Element {
  const s = useAgentStore()
  const [draft, setDraft] = useState<Draft | null>(() => (s.config ? toDraft(s.config) : null))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty = useMemo(() => {
    if (!draft || !s.config) return false
    return JSON.stringify(toDraft(s.config)) !== JSON.stringify(draft)
  }, [draft, s.config])

  if (!draft || !s.config) {
    return (
      <div className="panel-scroll">
        <div className="panel">
          <div className="empty-inline">正在读取配置…</div>
        </div>
      </div>
    )
  }

  const pc = draft.provider === 'anthropic' ? draft.anthropic : draft.openai
  // 上面的早退已经保证非空，但 s.config 是对象属性、跨语句会丢收窄 —— 抓一份局部常量
  const cfg = s.config

  const patchProvider = (patch: Partial<ProviderConfig>): void => {
    setDraft({
      ...draft,
      [draft.provider]: { ...pc, ...patch }
    })
  }

  const save = async (): Promise<void> => {
    setError(null)

    const maxToolIterations = Number(draft.maxToolIterations)
    const maxOutputTokens = Number(draft.maxOutputTokens)
    const contextWindowTokens = Number(draft.contextWindowTokens)

    for (const [name, v] of [
      ['工具调用轮数上限', maxToolIterations],
      ['输出 token 上限', maxOutputTokens],
      ['上下文窗口', contextWindowTokens]
    ] as const) {
      if (!Number.isFinite(v) || v <= 0) {
        setError(`${name} 必须是大于 0 的数字。`)
        return
      }
    }

    setSaving(true)
    try {
      await agentStore.saveConfig({
        provider: draft.provider,
        anthropic: draft.anthropic,
        openai: draft.openai,
        workspaceRoot: draft.workspaceRoot,
        maxToolIterations,
        maxOutputTokens,
        contextWindowTokens
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="panel-scroll">
      <div className="panel">
        <div className="panel__header">
          <h2>设置</h2>
          <p>改动只在点「保存」后生效。API Key 存在系统密钥库（DPAPI）里，不会明文写进配置文件。</p>
        </div>

        {error && (
          <div className="banner banner--danger">
            <span>{error}</span>
          </div>
        )}

        <section className="card">
          <div className="card__header">
            <div className="card__title">外观</div>
          </div>
          <p className="card__desc">主题切换立刻生效并记住，不走下面的「保存」。</p>
          <div className="card__body">
            <div className="field">
              <div className="field__label">主题</div>
              <div className="segmented">
                {(['light', 'dark'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={cfg.theme === t ? 'segmented__item is-active' : 'segmented__item'}
                    onClick={() => void agentStore.saveConfig({ theme: t })}
                  >
                    {t === 'light' ? '亮色' : '暗色'}
                  </button>
                ))}
              </div>
              <p className="field__hint">
                {cfg.theme === 'light'
                  ? '中性米白，适合白天和长时间阅读。'
                  : '深色，弱光环境下更省眼。'}
              </p>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card__header">
            <div className="card__title">模型接入</div>
          </div>
          <p className="card__desc">两个通道随时切换，历史记录不受影响。</p>
          <div className="card__body">
            <div className="field">
              <div className="field__label">当前通道</div>
              <div className="segmented">
                {(['anthropic', 'openai'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={
                      draft.provider === k ? 'segmented__item is-active' : 'segmented__item'
                    }
                    onClick={() => setDraft({ ...draft, provider: k })}
                  >
                    {k === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <div className="field__label">API Key</div>
              <input
                className="input input--mono"
                type="password"
                autoComplete="off"
                placeholder="留空则回退到同名环境变量"
                value={pc.apiKey}
                onChange={(e) => patchProvider({ apiKey: e.target.value })}
              />
            </div>

            <div className="field">
              <div className="field__label">Base URL</div>
              <input
                className="input input--mono"
                placeholder={
                  draft.provider === 'anthropic'
                    ? 'https://api.anthropic.com'
                    : 'https://api.openai.com/v1'
                }
                value={pc.baseUrl}
                onChange={(e) => patchProvider({ baseUrl: e.target.value })}
              />
              <p className="field__hint">留空 = 官方默认端点；填中转地址即走中转。</p>
            </div>

            <div className="field">
              <div className="field__label">模型</div>
              <input
                className="input input--mono"
                placeholder={draft.provider === 'anthropic' ? 'claude-opus-5' : 'deepseek-chat'}
                value={pc.model}
                onChange={(e) => patchProvider({ model: e.target.value })}
              />
            </div>

            {draft.provider === 'anthropic' && (
              <div className="switch-row">
                <div>
                  <div className="field__label">联网搜索</div>
                  <p className="field__hint" style={{ marginTop: 4 }}>
                    走 Anthropic 服务端 web_search 工具，结果以不透明块原样保留。
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={pc.enableWebSearch}
                  className={pc.enableWebSearch ? 'switch is-on' : 'switch'}
                  onClick={() => patchProvider({ enableWebSearch: !pc.enableWebSearch })}
                />
              </div>
            )}

            {draft.provider === 'openai' && (
              <div className="banner banner--warn">
                OpenAI 兼容通道没有服务端搜索，联网能力会降级为「网页抓取」；抓不到就直接说明。
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card__header">
            <div className="card__title">工作区</div>
          </div>
          <p className="card__desc">
            Agent 只能读写这个目录里的内容。任何越界路径（<code>../</code>
            、绝对路径、符号链接）都会被拒绝。
          </p>
          <div className="card__body">
            <div className="field">
              <div className="field__label">工作区根目录</div>
              <div className="row">
                <input
                  className="input input--mono"
                  readOnly
                  value={draft.workspaceRoot}
                  placeholder="尚未选择"
                />
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    void agentStore.pickWorkspace().then((picked) => {
                      if (picked) setDraft((d) => (d ? { ...d, workspaceRoot: picked } : d))
                    })
                  }}
                >
                  选择…
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card__header">
            <div className="card__title">运行限制</div>
          </div>
          <p className="card__desc">防止一次任务失控跑很久，或者把上下文撑爆。</p>
          <div className="card__body">
            <div className="grid-3">
              <div className="field">
                <div className="field__label">工具调用轮数上限</div>
                <input
                  className="input"
                  inputMode="numeric"
                  value={draft.maxToolIterations}
                  onChange={(e) => setDraft({ ...draft, maxToolIterations: e.target.value })}
                />
              </div>
              <div className="field">
                <div className="field__label">输出 token 上限</div>
                <input
                  className="input"
                  inputMode="numeric"
                  value={draft.maxOutputTokens}
                  onChange={(e) => setDraft({ ...draft, maxOutputTokens: e.target.value })}
                />
              </div>
              <div className="field">
                <div className="field__label">上下文窗口（估算）</div>
                <input
                  className="input"
                  inputMode="numeric"
                  value={draft.contextWindowTokens}
                  onChange={(e) => setDraft({ ...draft, contextWindowTokens: e.target.value })}
                />
              </div>
            </div>
            <p className="field__hint">
              超出上下文窗口时会从最早的整条消息开始丢弃，保证工具调用对不会被拆开。
            </p>
          </div>
        </section>

        <div className="panel__actions">
          {dirty && <span className="status status--waiting">有未保存的改动</span>}
          <button
            type="button"
            className="btn btn--ghost"
            disabled={!dirty || saving}
            onClick={() => {
              if (s.config) setDraft(toDraft(s.config))
            }}
          >
            还原
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
