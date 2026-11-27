/**
 * IDE MCP 端点发现与连接池。
 *
 * 发现顺序：
 * 1. 配置里的显式端点（`endpoint` / `endpoints`）—— 有则只信配置，便于离线/远程场景；
 * 2. 扫描各 JetBrains 产品的 `idea.log`，取每个产品最近一次 `Responding at` 的端口；
 * 3. 日志里一个都没有时，按 `portProbe`（默认 64342 起步、步长 10）探测本机端口。
 *
 * 所有候选都要通过真正的 MCP `initialize` 握手才算数：普通 Ktor 服务、已关闭的 IDE、
 * 不是 MCP 的端口都会被过滤掉。
 */
import { withStreamPath } from './config.js'
import { defaultLogRoots, scanJetBrainsLogs } from './log-scan.js'
import { McpHttpClient } from './mcp-http.js'
import { normalizeUrl } from './util.js'

/** 同时握手的端点数，避免一次开太多连接。 */
const HANDSHAKE_CONCURRENCY = 4

/**
 * 并发受限的 map。
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * @typedef {Object} IdeaEndpoint
 * @property {string} url 完整 MCP 端点 URL
 * @property {'config' | 'log' | 'probe'} source
 * @property {string} product 产品展示名
 * @property {number | undefined} port
 * @property {string | undefined} logFile
 * @property {string | undefined} token
 * @property {string | undefined} pinnedProjectPath
 * @property {McpHttpClient} client
 * @property {ReturnType<McpHttpClient['info']>} info
 * @property {any[] | undefined} tools
 * @property {number | undefined} toolsFetchedAt
 * @property {number | undefined} toolCount
 * @property {string | undefined} toolsError
 */

/**
 * 端点注册表：负责「发现 + 握手 + 连接复用 + 工具列表缓存」。
 */
export class IdeaEndpointRegistry {
  #config
  #fetchImpl
  #scan
  #clientFactory
  #now
  #logRoots
  /** @type {Map<string, IdeaEndpoint>} */
  #endpoints = new Map()
  /** @type {Array<{ url: string, error: string }>} */
  #errors = []
  /** @type {Promise<void> | undefined} */
  #refreshing
  #lastRefresh = 0
  #closed = false

  /**
   * @param {{
   *   config: ReturnType<typeof import('./config.js').resolveConfig>,
   *   fetchImpl?: typeof fetch,
   *   scan?: typeof scanJetBrainsLogs,
   *   clientFactory?: (options: ConstructorParameters<typeof McpHttpClient>[0]) => McpHttpClient,
   *   now?: () => number,
   *   logRoots?: string[],
   * }} options
   */
  constructor(options) {
    this.#config = options.config
    this.#fetchImpl = options.fetchImpl
    this.#scan = options.scan ?? scanJetBrainsLogs
    this.#clientFactory = options.clientFactory ?? ((clientOptions) => new McpHttpClient(clientOptions))
    this.#now = options.now ?? Date.now
    this.#logRoots = options.logRoots
  }

  /** 当前已握手的端点。 */
  endpoints() {
    return [...this.#endpoints.values()]
  }

  /** 最近一次刷新时间（毫秒时间戳）。 */
  get lastRefresh() {
    return this.#lastRefresh
  }

  /** 最近一次刷新中失败/被排除的候选。 */
  get errors() {
    return [...this.#errors]
  }

  /**
   * 缓存未过期就不刷新。
   * @param {{ force?: boolean, signal?: AbortSignal }} [options]
   */
  async ensureFresh(options = {}) {
    await this.refresh(options)
  }

  /**
   * 重新发现并握手全部候选端点。
   * @param {{ force?: boolean, signal?: AbortSignal }} [options]
   * @returns {Promise<void>}
   */
  async refresh(options = {}) {
    if (this.#closed || options.signal?.aborted) return
    if (this.#refreshing) return this.#refreshing
    const age = this.#now() - this.#lastRefresh
    if (!options.force && this.#lastRefresh > 0 && age >= 0 && age < this.#config.discoveryCacheMs) return
    this.#refreshing = this.#doRefresh(options).finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  /**
   * @param {{ signal?: AbortSignal }} options
   */
  async #doRefresh(options) {
    const candidates = this.#collectCandidates()
    const errors = []
    /** @type {Map<string, IdeaEndpoint>} */
    const next = new Map()

    await mapLimit(candidates, HANDSHAKE_CONCURRENCY, async (candidate) => {
      if (this.#closed) return
      if (options.signal?.aborted) return
      const existing = this.#endpoints.get(candidate.url)
      if (existing?.client.connected) {
        next.set(candidate.url, existing)
        return
      }
      let client
      try {
        client = this.#clientFactory({
          url: candidate.url,
          headers: candidate.token ? { IJ_MCP_AUTH_TOKEN: candidate.token } : {},
          timeoutMs: this.#config.toolCallTimeoutMs,
          fetchImpl: this.#fetchImpl,
        })
        const info = await client.connect({ signal: options.signal, timeoutMs: this.#config.connectTimeoutMs })
        // 换了一个新连接对象时关掉旧连接，避免泄漏 IDE 侧 session。
        if (existing && existing.client !== client) existing.client.close().catch(() => {})
        next.set(candidate.url, {
          url: candidate.url,
          source: candidate.source,
          product: candidate.product,
          port: candidate.port,
          logFile: candidate.logFile,
          token: candidate.token,
          pinnedProjectPath: candidate.projectPath,
          client,
          info,
          // 工具列表不跨连接继承：工具 TTL 到期后会重新 listTools
        })
      } catch (error) {
        client?.close().catch(() => {})
        errors.push({ url: candidate.url, error: error instanceof Error ? error.message : String(error) })
      }
    })

    if (this.#closed || options.signal?.aborted) {
      // 刷新期间插件卸载或调用被取消：关闭这一轮新建的连接，不要把结果写回注册表
      for (const [url, endpoint] of next) {
        if (!this.#endpoints.has(url) || this.#endpoints.get(url) !== endpoint) {
          endpoint.client.close().catch(() => {})
        }
      }
      return
    }

    // 关闭已经消失的端点
    for (const [url, endpoint] of this.#endpoints) {
      if (next.has(url)) continue
      endpoint.client.close().catch(() => {})
    }

    this.#endpoints = next
    this.#errors = errors.slice(0, 10)
    this.#lastRefresh = this.#now()
  }

  /**
   * 汇总候选端点（未验证）。
   * @returns {Array<{ url: string, source: IdeaEndpoint['source'], product: string, port?: number, logFile?: string, token?: string, projectPath?: string }>}
   */
  #collectCandidates() {
    const candidates = []
    const seen = new Set()
    const push = (candidate) => {
      const url = normalizeUrl(candidate.url)
      if (!url || seen.has(url)) return
      seen.add(url)
      candidates.push({ ...candidate, url })
    }

    if (this.#config.endpoints.length > 0) {
      for (const endpoint of this.#config.endpoints) {
        push({
          url: endpoint.url,
          source: 'config',
          product: endpoint.product ?? 'JetBrains IDE',
          token: endpoint.token,
          projectPath: endpoint.projectPath,
        })
      }
      return candidates
    }

    let logged = []
    try {
      // 默认根目录 + 用户追加的根目录；测试可以用 deps.logRoots 整体替换。
      const roots = this.#logRoots ?? [...new Set([...defaultLogRoots(), ...this.#config.logRoots])]
      logged = this.#scan({ roots })
    } catch {
      logged = []
    }
    for (const item of logged) {
      push({
        url: withStreamPath(item.url, this.#config.streamPath),
        source: 'log',
        product: item.product,
        port: item.port,
        logFile: item.logFile,
      })
    }

    if (candidates.length === 0 && this.#config.portProbe.enabled) {
      const { base, step, count } = this.#config.portProbe
      for (let index = 0; index < count; index += 1) {
        const port = base + index * step
        if (port <= 0 || port > 65535) continue
        push({
          url: `http://127.0.0.1:${port}${this.#config.streamPath}`,
          source: 'probe',
          product: 'JetBrains IDE',
          port,
        })
      }
    }
    return candidates
  }

  /**
   * 取某个端点的工具列表（带 TTL 缓存；失败保留上一份，由上层决定是否沿用）。
   * @param {IdeaEndpoint} endpoint
   * @param {{ signal?: AbortSignal, force?: boolean, maxAgeMs?: number }} [options]
   * @returns {Promise<any[]>}
   */
  async toolsFor(endpoint, options = {}) {
    const maxAgeMs = options.maxAgeMs ?? this.#config.toolListTtlMs
    const fetchedAt = endpoint.toolsFetchedAt ?? 0
    if (!options.force && Array.isArray(endpoint.tools) && this.#now() - fetchedAt < maxAgeMs) {
      return endpoint.tools
    }
    try {
      const tools = await endpoint.client.listTools({ signal: options.signal })
      endpoint.tools = tools
      endpoint.toolsFetchedAt = this.#now()
      endpoint.toolCount = tools.length
      endpoint.toolsError = undefined
      return tools
    } catch (error) {
      // 保留上一份工具列表：一次 tools/list 抖动不应该让模型面前的工具消失
      endpoint.toolsError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /** 关闭所有连接。 */
  async close() {
    this.#closed = true
    const closing = [...this.#endpoints.values()].map((endpoint) => endpoint.client.close().catch(() => {}))
    this.#endpoints.clear()
    await Promise.all(closing)
  }

  /**
   * 把某个端点标记为不可用（真实调用发现连接已断时使用），
   * 下次 ensureFresh 会重新扫描、重新握手。
   * @param {string} url
   */
  markDisconnected(url) {
    const normalized = normalizeUrl(url)
    const endpoint = this.#endpoints.get(normalized)
    if (!endpoint) return
    this.#endpoints.delete(normalized)
    this.#lastRefresh = 0
    endpoint.client.close().catch(() => {})
  }
}
