import type { AnyToolDefinition } from '../types'
import { fsTools } from './fs'
import { shellTools } from './shell'
import { webTools } from './web'
import { memoryTools } from './memory'

/**
 * 全部内置工具的装配点。
 * 新增工具集：写一个 impl/xxx.ts，这里挂上即可，不需要改 core 的其它部分。
 */
export const builtinTools: AnyToolDefinition[] = [
  ...(fsTools as unknown as AnyToolDefinition[]),
  ...(shellTools as unknown as AnyToolDefinition[]),
  ...(webTools as unknown as AnyToolDefinition[]),
  ...(memoryTools as unknown as AnyToolDefinition[])
]

export { fsTools, shellTools, webTools, memoryTools }
export { readTextOrNull, formatBytes } from './fs'
export { htmlToText } from './web'
