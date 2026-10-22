# LZUEA Agent

Windows / macOS / Linux 桌面端 AI Agent。工作在你选定的工作区目录里：读写文件、执行命令、检索网络，
把跨会话要用的约定记进长期记忆。每一次写入、删除、执行命令都会先停下来让人确认。

- **运行形态**：Electron 桌面应用（Node.js + React）
- **模型接入**：Anthropic 与 OpenAI 兼容双通道，配置里切换
- **当前版本**：v0.1 —— 骨架 / 工具集 / 审批闸门已跑通，`npm run dev` 可用

---

## 快速开始

```bash
npm install
npm run dev
```

首次启动后需要做两件事，缺一不可：

1. **选工作区** —— 侧边栏「设置 → 工作区 → 选择…」。Agent 的所有文件操作都被限制在这个目录内。
2. **配 API Key** —— 「设置 → 模型接入」。也可以用环境变量 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 代替。

### 可能遇到的环境问题

| 现象                                                        | 原因与处理                                                                                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Error: Electron uninstall`                                 | `electron` 的二进制没下下来。执行 `node node_modules/electron/install.js`。                                                                                                |
| `Cannot read properties of undefined (reading 'whenReady')` | 环境里有 `ELECTRON_RUN_AS_NODE=1`（很多 Node 工具链会设），Electron 会退化成纯 Node 运行。用 `ELECTRON_RUN_AS_NODE= npm run dev` 启动，或先 `unset ELECTRON_RUN_AS_NODE`。 |
| 启动时弹出「找不到数据库迁移目录」                          | `drizzle/` 目录丢失或不含 `meta/_journal.json`。重新生成：`npx drizzle-kit generate`。                                                                                     |

`better-sqlite3` v13 自带 Node-API 预编译产物（`prebuilds/`），**不需要** electron-rebuild，
也不需要本机装 Visual Studio / Xcode。Electron 45 的 Node-API 版本为 10，直接兼容。

---

## 脚本

| 命令                       | 作用                                       |
| -------------------------- | ------------------------------------------ |
| `npm run dev`              | 开发模式：热更新 + 自动拉起 Electron       |
| `npm run build`            | 产出 `out/`（main / preload / renderer）   |
| `npm run check`            | typecheck + lint + test，提交前跑这个      |
| `npm run test`             | 跑核心层单测（vitest）                     |
| `npm run format`           | prettier 格式化                            |
| `npx drizzle-kit generate` | 改完 `src/main/store/schema.ts` 后生成迁移 |

工程基线：TypeScript 严格模式、ESLint 9 扁平配置、Prettier、Vitest、husky + lint-staged（提交时自动跑）。

---

## 架构

六边形架构（端口与适配器）。**`src/core/` 不依赖 Electron、不依赖 SQLite、不读全局状态**，
所有外部能力都通过 `src/core/ports/index.ts` 里定义的端口注入，因此可以脱离桌面环境单测。

```
src/
├─ shared/types.ts        跨进程契约：AgentAPI / AgentEvent / AppConfig / ContentBlock
├─ core/                  领域逻辑，零平台依赖，全部可单测
│  ├─ agent/              runtime.ts  主循环（模型 ↔ 工具）
│  │                      messages.ts 持久化格式 ⇄ 模型格式
│  │                      prompts.ts  系统提示词
│  ├─ providers/          anthropic.ts / openai.ts / factory.ts
│  │                      types.ts    中立契约（ModelProvider）
│  ├─ tools/              registry.ts 工具注册与执行
│  │                      middleware/ permission → timeout → sandbox → handler
│  │                      impl/       fs / shell / web / memory
│  ├─ context/tokens.ts   token 估算与上下文裁剪
│  ├─ memory/recall.ts    长期记忆召回打分（纯函数）
│  ├─ errors/             错误分类学（category / code / hint / retryable）
│  ├─ logging/            结构化日志
│  └─ ports/              MessageStore / MemoryRepository / ApprovalGate / EventSink …
├─ main/                  Electron 适配层 —— 唯一 new 具体实现的地方
│  ├─ index.ts            装配与窗口
│  ├─ ipc.ts              IPC 边界（只翻译，不放业务）
│  ├─ config.ts           配置读写 + API Key 加密
│  ├─ approval-gate.ts    审批闸门的 IPC 实现
│  └─ store/              SQLite + Drizzle
├─ preload/               contextBridge，暴露 AgentAPI
└─ renderer/              React UI（只订阅 AgentEvent + 调 AgentAPI）
```

### 换实现只改一个文件

`src/main/index.ts` 是唯一的组合根。想把 SQLite 换成 Postgres、把内存审批换成别的策略，
换掉 `buildServices()` 里 new 出来的那几个类即可，core 不动。

---

## 关键设计

### 工具调用循环

一次 run = 用户说一句话 → 反复「模型产出 → 执行工具 → 结果喂回去」，直到模型不再要工具或撞上轮数上限
（默认 15 轮，可在设置里调）。

主循环只做编排和事件流。**审批、超时、沙箱全部在工具中间件里**，循环完全不知道「危险操作要确认」这回事：

```
telemetry → permission（等人） → timeout（从批完才开始计时） → sandbox（路径校验） → handler
```

顺序不是随便排的：telemetry 在最外层，连拒绝和超时都留痕；permission 在 timeout 之前，
这样人慢慢斟酌不会吃掉工具自己的超时预算。

### 风险分级与审批

| 分级        | 工具                                                      | 行为                                 |
| ----------- | --------------------------------------------------------- | ------------------------------------ |
| `read`      | `list_dir` `read_file` `glob` `grep` `recall` `web_fetch` | 自动放行                             |
| `write`     | `write_file` `edit_file` `remember` `forget`              | 每次确认，可选「总是允许」           |
| `dangerous` | `delete_path` `run_command`                               | **每次**确认，刻意不提供「总是允许」 |

确认框给出的是可判断的原文 —— 文件写入是 unified diff，命令是完整命令行，删除是文件清单，
而不是一句「要执行 XX」。Esc / 点遮罩 = 拒绝；误拒只损失一次重试，误允不可逆，所以默认偏安全侧。

### 工作区沙箱

Agent 只能读写设置里选定的工作区目录。越界检查有三层，缺一不可：

1. `path.resolve` 之后做前缀比对
2. Windows 大小写归一（`canon()`），避免 `SRC/../Secret` 这类绕过
3. `realpath` 之后再比对一次，防符号链接逃逸（新建文件回溯到最近的已存在的祖先目录）

`../`、绝对路径、符号链接一律拒绝，并把原因回传给模型，让它自己纠正。

### 流式输出与持久化

- 事件流：`message_start` / `text_delta` / `thinking_delta` / `tool_call_*` / `approval_required` / `message_end` / `error` / `done`
- Provider 遵守 **done-before-throw** 约定：失败前先 `yield {type:'done', blocks}` 把已累积的内容交出来，
  所以流中途挂掉也不会出现「UI 显示的内容数据库里没有」
- `thinking` 块带签名、服务端工具产物（`web_search`）走 `opaque` 块，**原样存、原样回传** ——
  少了它们 Anthropic 下一轮会 400
- 消息排序用 `seq` 列而不是时间戳，`tool_use` / `tool_result` 对不会被并发写乱序

### 记忆

两层：

- **会话内**：消息历史，存在 SQLite 的 `messages` 表
- **长期记忆**：`remember` / `recall` / `forget` 三个工具 + 「记忆」面板。召回按 CJK 2-gram +
  英文分词加权打分，只把跟当前问题相关的几条拼进系统提示词。新近性只是**已命中条目**的加分项，
  不会让毫不相关的记忆靠「很新」混进来。

### 配置与密钥

配置存在 `%APPDATA%/lzuea-agent/config.json`。API Key 用 Electron `safeStorage`
（Windows DPAPI / macOS Keychain / Linux libsecret）加密落盘，密文带 `enc:v1:` 前缀；
加密不可用时退回明文并明确告警，不静默降级。内存里和 IPC 里是明文 —— 设置页要能显示，这是桌面应用的常见取舍。

### 上下文管理

token 按字符估算（CJK ÷1.5，其它 ÷4），超出窗口时从最早的**整条消息**开始丢弃。
以整条消息为单位，是为了保证 `tool_use` / `tool_result` 对不被从中间切断 —— 切断下一轮 API 就 400。

---

## 工具一览

| 工具                             | 风险                 | 说明                                |
| -------------------------------- | -------------------- | ----------------------------------- |
| `list_dir`                       | read                 | 列目录，尊重 `.gitignore`           |
| `read_file`                      | read                 | 读文件，带偏移/限量，二进制自动拒绝 |
| `glob`                           | read                 | 按模式匹配路径                      |
| `grep`                           | read                 | 内容搜索                            |
| `write_file`                     | write                | 写文件，覆盖前给 diff               |
| `edit_file`                      | write                | 精确替换，预期不匹配就失败，不瞎猜  |
| `delete_path`                    | dangerous            | 删文件或目录，列出影响面            |
| `run_command`                    | dangerous            | 执行命令，有超时与输出截断          |
| `web_fetch`                      | read                 | 抓网页正文，按 `max_chars` 截断     |
| `remember` / `recall` / `forget` | write / read / write | 长期记忆                            |

联网搜索走 Anthropic 服务端 `web_search` 工具（设置里开关）；OpenAI 兼容通道没有服务端搜索，
会降级成网页抓取，并在抓不到时直接说明，不假装搜过。

---

## 版本规划

**v0.1（当前）** 骨架、工具集、审批闸门、流式对话、长期记忆，`npm run dev` 可用。

**接下来**

- 打包成安装程序（`electron-builder`）；注意把 `drizzle/` 放进 `extraResources`
- 会话内压缩摘要（现在是滑窗丢弃）
- 长期记忆换 FTS5 / 向量检索（`MemoryRepository` 端口不变，只换实现）
- 并行工具执行（`registry.execute` 之间本就互不依赖）
- 多工作区、工具执行历史搜索、导出会话

---

## License

MIT
