/**
 * 通用小工具：路径、文本、超时、命名。这里只放与协议无关、可单独测试的纯函数。
 */
import { createHash } from 'node:crypto'

/** DSH 工具名上限（DeepSeek function-name 契约）。 */
export const TOOL_NAME_MAX = 64

/** 允许的工具名字符集。 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * 生成与 `@deepseek-ai/dsh-mcp-client` 同形的公开工具名：
 * 干净名字原样使用，发生替换/截断时追加 12 位哈希，避免不同身份撞名。
 * @param {string} serverName 本地命名空间（如 idea）。
 * @param {string} rawName MCP 服务端原始工具名。
 * @returns {string}
 */
export function publicToolName(serverName, rawName) {
  const identity = `${serverName}__${rawName}`
  const clean = `mcp__${serverName}__${rawName}`
  if (clean.length <= TOOL_NAME_MAX && TOOL_NAME_PATTERN.test(clean)) return clean
  const normalized = clean.replace(/[^A-Za-z0-9_-]/g, '_')
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12)
  const base = normalized.slice(0, TOOL_NAME_MAX - 1 - hash.length)
  return `${base}_${hash}`
}

/**
 * 规范化 URL：去掉末尾斜杠，统一协议与主机小写。
 * @param {string} url
 * @returns {string}
 */
export function normalizeUrl(url) {
  const trimmed = String(url ?? '').trim()
  if (!trimmed) return ''
  try {
    const parsed = new URL(trimmed)
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`
  } catch {
    return trimmed.replace(/\/+$/, '')
  }
}

/**
 * 规范化项目路径，便于跨平台比较：统一分隔符、Windows 路径统一小写、去掉末尾分隔符。
 * 保留 UNC 前缀（`\\server\share` → `//server/share`）。路径只用于比较和传给 IDE，
 * 不会被打开或解析。
 * @param {string} input
 * @returns {string}
 */
export function normalizePath(input) {
  let value = String(input ?? '').trim()
  if (!value) return ''
  const windowsStyle = /^[A-Za-z]:/.test(value) || value.startsWith('\\\\') || value.startsWith('//')
  value = value.replace(/\\/g, '/')
  const unc = value.startsWith('//')
  value = value.replace(/\/{2,}/g, '/')
  if (unc) value = `/${value}`
  if (value.length > 1) value = value.replace(/\/+$/, '')
  if (windowsStyle) value = value.toLowerCase()
  return value
}

/**
 * 判断 child 是否位于 parent 之内（含相等）。
 * Windows 路径不区分大小写，比较前双方都已小写盘符。
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isPathInside(parent, child) {
  const p = normalizePath(parent)
  const c = normalizePath(child)
  if (!p || !c) return false
  if (p === c) return true
  return c.startsWith(p.endsWith('/') ? p : `${p}/`)
}

/**
 * 从完整路径取最后一段（兼容两种分隔符）。
 * @param {string} input
 * @returns {string}
 */
export function baseName(input) {
  const value = String(input ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const index = value.lastIndexOf('/')
  return index < 0 ? value : value.slice(index + 1)
}

/**
 * 截断文本，保留开头并补一行说明。
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateText(text, maxChars) {
  const value = String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) return value
  const omitted = value.length - maxChars
  return `${value.slice(0, maxChars)}\n\n…（结果已截断，省略 ${omitted} 个字符）`
}

/**
 * 带超时的 await。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, message) {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 把调用方 signal 与超时组合成一个 AbortSignal。
 * @param {AbortSignal | undefined} signal
 * @param {number} ms
 * @returns {{ signal: AbortSignal, dispose: () => void }}
 */
export function combineSignal(signal, ms) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  let timer
  if (Number.isFinite(ms) && ms > 0) {
    timer = setTimeout(() => controller.abort(new Error(`请求超时（${ms}ms）`)), ms)
    timer.unref?.()
  }
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * 稳定 JSON：对象按键排序，用于比较两次工具集合是否一致。
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  const seen = new WeakSet()
  const walk = (input) => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input) ?? 'null'
    if (seen.has(input)) return '"[circular]"'
    seen.add(input)
    if (Array.isArray(input)) return `[${input.map(walk).join(',')}]`
    const keys = Object.keys(input).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${walk(input[key])}`).join(',')}}`
  }
  return walk(value)
}

/**
 * 简易通配符匹配（`*` 任意串、`?` 单字符），大小写不敏感。
 * @param {string} pattern
 * @param {string} value
 * @returns {boolean}
 */
export function matchesWildcard(pattern, value) {
  const source = String(pattern ?? '')
  if (!source) return false
  let regex = ''
  for (const char of source) {
    if (char === '*') regex += '.*'
    else if (char === '?') regex += '.'
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${regex}$`, 'i').test(String(value ?? ''))
}

/**
 * 安全解析 JSON，失败返回 undefined。
 * @param {string} text
 * @returns {any}
 */
export function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
