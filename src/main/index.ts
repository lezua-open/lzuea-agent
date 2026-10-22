import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import type { ThemeMode } from '@shared/types'
import { AgentRuntime } from '@core/agent/runtime'
import { defaultProviderFactory } from '@core/providers/factory'
import { SystemError } from '@core/errors'
import { StructuredLogger, type Logger } from '@core/logging'
import { ToolRegistry } from '@core/tools/registry'
import { builtinTools } from '@core/tools/impl'
import { permissionMiddleware } from '@core/tools/middleware/permission'
import { sandboxMiddleware } from '@core/tools/middleware/sandbox'
import { telemetryMiddleware } from '@core/tools/middleware/telemetry'
import { timeoutMiddleware } from '@core/tools/middleware/timeout'
import { IpcApprovalGate } from './approval-gate'
import { JsonConfigStore, SafeStorageCodec } from './config'
import { configHealthCheck, createEventSink, registerIpc, type AppServices } from './ipc'
import { openDatabase } from './store/db'
import { SqliteMemoryRepository } from './store/memory-repository'
import { SqliteMessageStore } from './store/message-store'

/**
 * 应用装配层。
 *
 * 这里是唯一 new 具体实现的地方 —— core 的每个依赖都是端口，
 * 换实现（比如把 SQLite 换成 Postgres）只需要改这一个文件。
 */

// ---------------------------------------------------------------- 窗口

/**
 * 窗口底色必须跟主题一致，否则调整窗口大小时边框会露出错误的一层底色。
 *
 * 这两个值只能和 styles.css 里的 `--bg` 重复一遍 —— 主进程读不到 CSS 变量。
 * 改主题色时两处都要改。
 */
const WINDOW_BG: Record<ThemeMode, string> = {
  light: '#f4f4f2',
  dark: '#12161c'
}

function createWindow(logger: Logger): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 920,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'LZUEA Agent',
    // 配置这时候还没读进来，先用默认亮色；buildServices 之后按实际主题纠正
    backgroundColor: WINDOW_BG.light,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 渲染进程拿不到 Node，跨进程只能走 preload 暴露的 AgentAPI
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // 渲染进程的报错必须能从主进程日志里看到 —— 否则用户那边白屏，我们无从查起
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') {
      logger.warn('renderer console', {
        level: e.level,
        message: e.message,
        source: `${e.sourceId}:${e.lineNumber}`
      })
    }
  })

  // 外部链接一律交给系统浏览器，不让页面在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 应用内不允许跳到别的域
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const ok = url.startsWith('file://') || (devUrl !== undefined && url.startsWith(devUrl))
    if (!ok) event.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// ---------------------------------------------------------------- 装配

/**
 * 迁移目录的位置。
 *
 * app.getAppPath() 在「开发时跑 out/main/index.js」和「打包后在 resources 里」
 * 两种情况下指向不同的地方，不能只信它。按候选路径找，找不到就把试过的都写进错误 ——
 * 比 drizzle 那句 "Can't find meta/_journal.json" 有用得多。
 */
function resolveMigrationsFolder(): string {
  const candidates = [
    join(app.getAppPath(), 'drizzle'),
    join(__dirname, '..', '..', 'drizzle'),
    join(__dirname, '..', 'drizzle')
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'meta', '_journal.json'))) return dir
  }
  throw new SystemError(`找不到数据库迁移目录，试过：${candidates.join('  /  ')}`, {
    code: 'MIGRATIONS_NOT_FOUND',
    hint: '确认项目根目录下有 drizzle/ 且包含 meta/_journal.json。'
  })
}

async function buildServices(window: BrowserWindow, logger: Logger): Promise<AppServices> {
  const userData = app.getPath('userData')

  const db = openDatabase({
    dbPath: join(userData, 'data.db'),
    migrationsFolder: resolveMigrationsFolder()
  })

  const store = new SqliteMessageStore(db)
  const memory = new SqliteMemoryRepository(db)
  const config = new JsonConfigStore(join(userData, 'config.json'), await SafeStorageCodec.create())

  const emit = createEventSink(window)
  const gate = new IpcApprovalGate()

  // 中间件顺序即执行顺序，换审批策略只改这一行
  //   telemetry（留痕）→ permission（等人）→ timeout（计时从批完才开始）→ sandbox（路径校验）→ handler
  const registry = new ToolRegistry([
    telemetryMiddleware(),
    permissionMiddleware({ gate, emit, alwaysAllow: new Set() }),
    timeoutMiddleware(),
    sandboxMiddleware()
  ]).registerAll(builtinTools)

  const runtime = new AgentRuntime({
    store,
    memory,
    registry,
    providerFactory: defaultProviderFactory,
    config,
    gate,
    logger,
    clock: { now: () => Date.now() },
    ids: { newId: () => crypto.randomUUID() },
    emit,
    platform: process.platform
  })

  return { store, memory, config, runtime, gate, emit, window }
}

// ---------------------------------------------------------------- 启动

const logger = new StructuredLogger({
  name: 'app',
  level: process.env.NODE_ENV === 'test' ? 'error' : 'info'
})

app
  .whenReady()
  .then(async () => {
    const window = createWindow(logger)
    const services = await buildServices(window, logger)

    registerIpc(services)

    // 窗口底色跟主题走。配置读进来之后纠正一次，
    // 主题在设置里切换时由渲染进程这边的 setBackgroundColor 再跟上。
    void services.config.get().then((cfg) => window.setBackgroundColor(WINDOW_BG[cfg.theme]))

    // 配置缺东西就明确告诉用户，别等请求 401 才发现
    void configHealthCheck(services.config).then((warning) => {
      if (warning) {
        logger.warn('config health check', { warning })
        services.emit({ type: 'error', conversationId: '', message: warning })
      }
    })

    logger.info('app ready', {
      userData: app.getPath('userData'),
      platform: process.platform
    })

    app.on('activate', () => {
      // macOS：dock 点回来但没窗口
      if (BrowserWindow.getAllWindows().length === 0) createWindow(logger)
    })
  })
  .catch((err: unknown) => {
    // 起不来就说清楚然后退出 —— 挂一个空窗口比报错更糟
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    logger.error('app failed to start', { error: detail })
    dialog.showErrorBox('LZUEA Agent 启动失败', `${detail}\n\n数据目录：${app.getPath('userData')}`)
    app.exit(1)
  })

app.on('window-all-closed', () => {
  // macOS 惯例是留着进程；Windows / Linux 关掉就退出
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  logger.info('app quitting')
})
