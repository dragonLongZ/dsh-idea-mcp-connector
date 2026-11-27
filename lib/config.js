/**
 * 插件配置解析：所有字段都有安全默认值，非法值降级为默认值并给出 warning。
 * 配置来自 bundle 行 `config:`，因此这里不依赖任何 DSH 包，也不写回配置。
 */
import { normalizeUrl } from './util.js'

/** 默认值集中在这里，README 与测试都以它为准。 */
export const DEFAULTS = Object.freeze({
  serverName: 'idea',
  endpoint: '',
  endpoints: [],
  logRoots: [],
  projects: [],
  streamPath: '/stream',
  portProbe: Object.freeze({ enabled: true, base: 64342, step: 10, count: 4 }),
  connectTimeoutMs: 1500,
  toolCallTimeoutMs: 120000,
  refreshIntervalMs: 30000,
  discoveryCacheMs: 10000,
  toolListTtlMs: 60000,
  mappingTtlMs: 300000,
  includeTools: [],
  excludeTools: [],
  probeTools: ['get_project_modules', 'get_all_open_file_paths'],
  projectPathArg: 'projectPath',
  injectProjectPath: true,
  maxResultChars: 120000,
  debug: false,
})

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number}
 */
function toBoundedNumber(value, fallback, bounds = {}) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number)) return fallback
  const min = bounds.min ?? -Infinity
  const max = bounds.max ?? Infinity
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/**
 * 解析端口配置：非法值回退默认并记录 warning。
 * @param {unknown} value
 * @param {number} fallback
 * @param {string[]} warnings
 * @returns {number}
 */
function toPort(value, fallback, warnings) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0 || number > 65535) {
    if (value !== undefined && value !== null) warnings.push(`portProbe.base「${String(value)}」不是合法端口，已回退为 ${fallback}`)
    return fallback
  }
  return number
}

/**
 * 把字符串或字符串数组统一成去空、去重后的字符串数组。
 * @param {unknown} value
 * @returns {string[]}
 */
function toStringList(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const result = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

/**
 * 规范化显式端点。支持三种写法：
 * - 字符串：`'http://127.0.0.1:64342/stream'`
 * - 对象：`{ url, product?, token?, projectPath? }`
 * @param {unknown} value
 * @param {string} streamPath
 * @returns {Array<{ url: string, product?: string, token?: string, projectPath?: string }>}
 */
function toEndpoints(value, streamPath) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const result = []
  for (const item of list) {
    const raw = typeof item === 'string' ? { url: item } : item && typeof item === 'object' ? item : null
    if (!raw || typeof raw.url !== 'string' || !raw.url.trim()) continue
    const url = withStreamPath(raw.url.trim(), streamPath)
    const endpoint = { url }
    if (typeof raw.product === 'string' && raw.product.trim()) endpoint.product = raw.product.trim()
    if (typeof raw.token === 'string' && raw.token.trim()) endpoint.token = raw.token.trim()
    if (typeof raw.projectPath === 'string' && raw.projectPath.trim()) endpoint.projectPath = raw.projectPath.trim()
    result.push(endpoint)
  }
  return result
}

/**
 * 给裸端点补上 MCP 流式路径；已经带路径的保持原样。
 * @param {string} url
 * @param {string} streamPath
 * @returns {string}
 */
export function withStreamPath(url, streamPath) {
  const normalized = normalizeUrl(url)
  if (!normalized) return ''
  const path = streamPath.startsWith('/') ? streamPath : `/${streamPath}`
  try {
    const parsed = new URL(normalized)
    if (parsed.pathname && parsed.pathname !== '/' && parsed.pathname !== '') return normalized
    return normalizeUrl(`${parsed.origin}${path}`)
  } catch {
    return normalized
  }
}

/**
 * 规范化「项目路径 → 端点」手工映射。
 * 支持 `{ path, url }` 与 `{ path, endpoint }` 两种键名。
 * @param {unknown} value
 * @returns {Array<{ path: string, url: string }>}
 */
function toProjectMappings(value) {
  const list = Array.isArray(value) ? value : []
  const result = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const path = typeof item.path === 'string' ? item.path.trim() : ''
    const url = typeof item.url === 'string' ? item.url.trim() : typeof item.endpoint === 'string' ? item.endpoint.trim() : ''
    if (!path || !url) continue
    result.push({ path, url: normalizeUrl(url) })
  }
  return result
}

/**
 * 解析并校验配置。
 * @param {Record<string, unknown> | undefined | null} raw
 * @returns {typeof DEFAULTS & { warnings: string[] }}
 */
export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const warnings = []

  let serverName = typeof source.serverName === 'string' ? source.serverName.trim() : DEFAULTS.serverName
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    warnings.push(`serverName「${serverName}」不合法（需 [A-Za-z0-9_-]{1,32}），已回退为 ${DEFAULTS.serverName}`)
    serverName = DEFAULTS.serverName
  }

  const rawProbe = source.portProbe && typeof source.portProbe === 'object' ? source.portProbe : {}
  const portProbe = {
    enabled: rawProbe.enabled === undefined ? DEFAULTS.portProbe.enabled : rawProbe.enabled === true,
    base: toPort(rawProbe.base, DEFAULTS.portProbe.base, warnings),
    step: toBoundedNumber(rawProbe.step, DEFAULTS.portProbe.step, { min: 1, max: 1000 }),
    count: toBoundedNumber(rawProbe.count, DEFAULTS.portProbe.count, { min: 0, max: 32 }),
  }

  const streamPath = typeof source.streamPath === 'string' && source.streamPath.trim().startsWith('/')
    ? source.streamPath.trim()
    : DEFAULTS.streamPath

  const endpoints = toEndpoints(source.endpoints, streamPath)
  const endpoint = typeof source.endpoint === 'string' && source.endpoint.trim()
    ? withStreamPath(source.endpoint.trim(), streamPath)
    : ''
  if (endpoint) endpoints.unshift({ url: endpoint })

  const projectPathArg = typeof source.projectPathArg === 'string' && source.projectPathArg.trim()
    ? source.projectPathArg.trim()
    : DEFAULTS.projectPathArg

  return {
    serverName,
    endpoint,
    endpoints,
    logRoots: toStringList(source.logRoots),
    projects: toProjectMappings(source.projects),
    streamPath,
    portProbe,
    connectTimeoutMs: toBoundedNumber(source.connectTimeoutMs, DEFAULTS.connectTimeoutMs, { min: 100, max: 60000 }),
    toolCallTimeoutMs: toBoundedNumber(source.toolCallTimeoutMs, DEFAULTS.toolCallTimeoutMs, { min: 1000, max: 3600000 }),
    refreshIntervalMs: toBoundedNumber(source.refreshIntervalMs, DEFAULTS.refreshIntervalMs, { min: 0, max: 3600000 }),
    discoveryCacheMs: toBoundedNumber(source.discoveryCacheMs, DEFAULTS.discoveryCacheMs, { min: 0, max: 3600000 }),
    toolListTtlMs: toBoundedNumber(source.toolListTtlMs, DEFAULTS.toolListTtlMs, { min: 0, max: 3600000 }),
    mappingTtlMs: toBoundedNumber(source.mappingTtlMs, DEFAULTS.mappingTtlMs, { min: 0, max: 86400000 }),
    includeTools: toStringList(source.includeTools),
    excludeTools: toStringList(source.excludeTools),
    probeTools: toStringList(source.probeTools).length > 0 ? toStringList(source.probeTools) : [...DEFAULTS.probeTools],
    projectPathArg,
    injectProjectPath: source.injectProjectPath === undefined ? DEFAULTS.injectProjectPath : source.injectProjectPath !== false,
    maxResultChars: toBoundedNumber(source.maxResultChars, DEFAULTS.maxResultChars, { min: 1000, max: 2000000 }),
    debug: source.debug === true,
    warnings,
  }
}

/**
 * 判断工具是否被 include/exclude 配置保留。
 * @param {string} rawName
 * @param {Pick<typeof DEFAULTS, 'includeTools' | 'excludeTools'>} config
 * @param {(pattern: string, value: string) => boolean} matcher
 * @returns {boolean}
 */
export function toolSelected(rawName, config, matcher) {
  if (config.excludeTools.some((pattern) => matcher(pattern, rawName))) return false
  if (config.includeTools.length === 0) return true
  return config.includeTools.some((pattern) => matcher(pattern, rawName))
}
