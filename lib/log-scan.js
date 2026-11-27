/**
 * JetBrains 日志扫描：从 `idea.log` 里找出 MCP 服务当前监听的本地端口。
 *
 * JetBrains 的 MCP Server 插件用 Ktor 起服务，启动时固定打印一行：
 *   `... INFO - io.ktor.server.Application - Responding at http://127.0.0.1:64342`
 * 端口没有持久化配置项（`mcpServer.xml` 只存开关），因此这行日志是唯一可靠的
 * 「端口 → 产品实例」发现来源。插件本身不会写锁文件，也不暴露其他发现接口。
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 产品目录名前缀 → 展示名。 */
const PRODUCT_NAMES = [
  ['IntelliJIdea', 'IntelliJ IDEA'],
  ['IntelliJ', 'IntelliJ IDEA'],
  ['PyCharm', 'PyCharm'],
  ['GoLand', 'GoLand'],
  ['WebStorm', 'WebStorm'],
  ['PhpStorm', 'PhpStorm'],
  ['CLion', 'CLion'],
  ['Rider', 'Rider'],
  ['DataGrip', 'DataGrip'],
  ['RubyMine', 'RubyMine'],
  ['Aqua', 'Aqua'],
  ['RustRover', 'RustRover'],
  ['Writerside', 'Writerside'],
  ['AndroidStudio', 'Android Studio'],
]

/** 每行形如 `2026-11-18 09:15:05,230 [ 190592] INFO - io.ktor.server.Application - Responding at http://127.0.0.1:64342`。 */
const RESPONDING_LINE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?)\s(.*?)\bResponding at (https?:\/\/\S+)/

/** 只认 Ktor / MCP 相关日志，避免其他服务器也打印 `Responding at` 时误判。 */
const KTOR_OR_MCP = /ktor|mcp/i

/** 只要本机回环地址。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'])

/**
 * 默认 JetBrains 日志根目录（按平台）。
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string[]}
 */
export function defaultLogRoots(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return [join(localAppData, 'JetBrains')]
  }
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Logs', 'JetBrains')]
  }
  return [join(home, '.cache', 'JetBrains'), join(home, '.local', 'share', 'JetBrains')]
}

/**
 * 把 `IntelliJIdea2026.2` 变成 `IntelliJ IDEA 2026.2`。
 * @param {string} dirName
 * @returns {string}
 */
export function prettifyProduct(dirName) {
  const match = /^([A-Za-z]+?)(\d{4}\.\d+)$/.exec(dirName)
  if (!match) return dirName
  const prefix = match[1]
  const version = match[2]
  const known = PRODUCT_NAMES.find(([key]) => key.toLowerCase() === prefix.toLowerCase())
  return known ? `${known[1]} ${version}` : `${prefix} ${version}`
}

/** JetBrains 日志文件名：`idea.log`，轮转后是 `idea.1.log`（也可能出现 `idea.log.1`）。 */
const LOG_FILE_PATTERN = /^idea(?:\.\d+)?\.log(?:\.\d+)?$/

/** 每个产品最多回溯几个日志文件（当前 + 轮转）。 */
const MAX_LOG_FILES_PER_PRODUCT = 3

/**
 * 解析结果缓存：文件大小 + mtime 未变时复用上次结果，避免每次周期同步都读 4MB。
 * @type {Map<string, { size: number, mtimeMs: number, endpoints: Array<{ at: number, url: string, port: number }> }>}
 */
const PARSE_CACHE = new Map()

/**
 * 列出各产品目录下存在的 idea.log（含轮转文件），按修改时间从新到旧。
 * @param {string[]} roots
 * @param {{ readdirSync?: typeof readdirSync, statSync?: typeof statSync }} [deps]
 * @returns {Array<{ product: string, productDir: string, logFile: string, mtimeMs?: number }>}
 */
export function listProductLogs(roots, deps = {}) {
  const readdir = deps.readdirSync ?? readdirSync
  const stat = deps.statSync ?? statSync
  const result = []
  const seen = new Set()
  for (const root of roots) {
    let entries
    try {
      entries = readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry?.isDirectory?.()) continue
      const productDir = join(root, entry.name)
      const files = []
      for (const dir of [join(productDir, 'log'), productDir]) {
        let names
        try {
          names = readdir(dir)
        } catch {
          continue
        }
        for (const name of names) {
          if (!LOG_FILE_PATTERN.test(name)) continue
          const file = join(dir, name)
          let mtimeMs
          try {
            const info = stat(file)
            if (!info.isFile()) continue
            mtimeMs = info.mtimeMs
          } catch {
            continue
          }
          if (seen.has(file)) continue
          seen.add(file)
          files.push({ logFile: file, mtimeMs })
        }
      }
      files.sort((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0))
      for (const file of files) {
        result.push({ product: prettifyProduct(entry.name), productDir, logFile: file.logFile, mtimeMs: file.mtimeMs })
      }
    }
  }
  return result
}

/**
 * 读取文件末尾（日志可能有几十 MB，只扫描尾部足够找到最近一次启动）。
 * @param {string} file
 * @param {number} maxBytes
 * @returns {string}
 */
export function readTail(file, maxBytes = 4 * 1024 * 1024) {
  const stat = statSync(file)
  const size = stat.size
  const start = Math.max(0, size - maxBytes)
  const length = size - start
  if (length <= 0) return ''
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, start + offset)
      if (read <= 0) break
      offset += read
    }
    let text = buffer.subarray(0, offset).toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      if (newline >= 0) text = text.slice(newline + 1)
    }
    return text
  } finally {
    closeSync(fd)
  }
}

/**
 * 从日志文本里解析所有 `Responding at` 端点，按时间升序返回。
 * @param {string} text
 * @returns {Array<{ at: number, url: string, port: number }>}
 */
export function parseRespondingEndpoints(text) {
  const result = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = RESPONDING_LINE.exec(line)
    if (!match || !KTOR_OR_MCP.test(match[2])) continue
    let parsed
    try {
      parsed = new URL(match[3])
    } catch {
      continue
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) continue
    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    const at = Date.parse(match[1].replace(' ', 'T').replace(',', '.'))
    result.push({ at: Number.isFinite(at) ? at : 0, url: `${parsed.protocol}//${parsed.host}`, port })
  }
  return result
}

/**
 * 扫描所有日志根目录，返回每个产品「最后一次启动」记录的 MCP 端点。
 * 每个产品会从最新的日志文件往回看最多 3 个轮转文件，避免 MCP 启动行滚出
 * 当前 `idea.log` 后端点「消失」。
 * @param {{ roots?: string[], maxBytes?: number, maxFilesPerProduct?: number, readFile?: (file: string, maxBytes: number) => string, list?: typeof listProductLogs, stat?: typeof statSync }} [options]
 * @returns {Array<{ url: string, port: number, product: string, productDir: string, logFile: string, at: number, source: 'log' }>}
 */
export function scanJetBrainsLogs(options = {}) {
  const roots = options.roots ?? defaultLogRoots()
  const readFile = options.readFile ?? readTail
  const stat = options.stat ?? statSync
  const maxFiles = options.maxFilesPerProduct ?? MAX_LOG_FILES_PER_PRODUCT
  const products = (options.list ?? listProductLogs)(roots)

  /** @type {Map<string, { product: string, productDir: string, filesRead: number, endpoints: Array<{ at: number, url: string, port: number, logFile: string }> }>} */
  const byProduct = new Map()
  for (const product of products) {
    const group = byProduct.get(product.productDir) ?? { product: product.product, productDir: product.productDir, filesRead: 0, endpoints: [] }
    if (group.filesRead >= maxFiles) continue
    byProduct.set(product.productDir, group)
    group.filesRead += 1

    let endpoints
    if (options.readFile) {
      let text
      try {
        text = readFile(product.logFile, options.maxBytes ?? 4 * 1024 * 1024)
      } catch {
        continue
      }
      endpoints = parseRespondingEndpoints(text)
    } else {
      endpoints = parseCached(product.logFile, product.mtimeMs, stat, options.maxBytes ?? 4 * 1024 * 1024)
    }
    if (endpoints.length === 0) continue
    group.endpoints.push(...endpoints.map((endpoint) => ({ ...endpoint, logFile: product.logFile })))
  }

  const result = []
  for (const group of byProduct.values()) {
    if (group.endpoints.length === 0) continue
    const latest = group.endpoints.reduce((best, item) => (item.at >= best.at ? item : best), group.endpoints[0])
    result.push({
      url: latest.url,
      port: latest.port,
      product: group.product,
      productDir: group.productDir,
      logFile: latest.logFile,
      at: latest.at,
      source: 'log',
    })
  }
  result.sort((a, b) => b.at - a.at)
  return result
}

/**
 * 带文件级缓存的日志解析。
 * @param {string} file
 * @param {number | undefined} knownMtime
 * @param {typeof statSync} stat
 * @param {number} maxBytes
 * @returns {Array<{ at: number, url: string, port: number }>}
 */
function parseCached(file, knownMtime, stat, maxBytes) {
  let size
  let mtimeMs = knownMtime
  try {
    const info = stat(file)
    size = info.size
    mtimeMs = info.mtimeMs
  } catch {
    return []
  }
  const cached = PARSE_CACHE.get(file)
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.endpoints
  let endpoints = []
  try {
    endpoints = parseRespondingEndpoints(readTail(file, maxBytes))
  } catch {
    return cached?.endpoints ?? []
  }
  PARSE_CACHE.set(file, { size, mtimeMs: mtimeMs ?? 0, endpoints })
  return endpoints
}
