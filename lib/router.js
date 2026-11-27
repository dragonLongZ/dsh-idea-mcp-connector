/**
 * 按会话工作目录选择 IDE 端点。
 *
 * IDEA 的 MCP 服务可能：
 * - 只有一个（多数情况）：所有会话共用一个端点，但请求头里带项目路径后，
 *   IDE 会把它路由到对应项目窗口 —— 一个进程多开项目也能正确分流；
 * - 有多个（多个 IDE 进程 / 多个产品）：需要判断哪个端点打开了当前会话的项目。
 *
 * 判断方式是「带 `IJ_MCP_SERVER_PROJECT_PATH` 头调一次只读工具」：IDE 在严格模式下
 * 解析 projectPath，项目不存在会返回固定文案；存在则正常执行（即使工具本身报别的错，
 * 也说明项目解析成功）。结果按 cwd 缓存，调用失败时失效重探。
 */
import { isPathInside, normalizePath, normalizeUrl } from './util.js'
import { isProjectNotFoundError } from './mcp-http.js'

/** IDE 项目解析失败时的结构化错误。 */
export class NoProjectError extends Error {
  /**
   * @param {string} message
   * @param {{ cwd: string, probes: Array<{ url: string, hosted: boolean, error?: string }> }} details
   */
  constructor(message, details) {
    super(message)
    this.name = 'NoProjectError'
    this.code = 'idea-project-not-found'
    this.cwd = details.cwd
    this.probes = details.probes
  }
}

/**
 * 给工具参数按需补上 `projectPath`。
 * @param {Record<string, unknown>} args
 * @param {any} tool MCP 工具定义（用于判断 schema 是否声明了该参数）
 * @param {string} projectPath
 * @param {{ projectPathArg: string, injectProjectPath: boolean }} config
 * @returns {Record<string, unknown>}
 */
export function injectProjectPathArgument(args, tool, projectPath, config) {
  if (!config.injectProjectPath || !projectPath) return { ...(args ?? {}) }
  const argName = config.projectPathArg
  const schema = tool?.inputSchema ?? tool?.parameters
  const properties = schema && typeof schema === 'object' ? schema.properties : undefined
  if (!properties || typeof properties !== 'object' || !Object.hasOwn(properties, argName)) {
    return { ...(args ?? {}) }
  }
  return { ...(args ?? {}), [argName]: projectPath }
}

/**
 * 端点是否声明了某个工具。工具列表未知时按「支持」处理（避免误杀）。
 * @param {import('./discovery.js').IdeaEndpoint} endpoint
 * @param {string | undefined} toolName
 * @returns {boolean}
 */
function endpointSupports(endpoint, toolName) {
  if (!toolName) return true
  if (!Array.isArray(endpoint.tools)) return true
  return endpoint.tools.some((tool) => tool?.name === toolName)
}

/**
 * 端点选择器。
 */
export class ProjectRouter {
  #config
  #registry
  #now
  /** @type {Map<string, { url: string, resolution: string, at: number }>} */
  #cache = new Map()

  /**
   * @param {{ config: ReturnType<typeof import('./config.js').resolveConfig>, registry: import('./discovery.js').IdeaEndpointRegistry, now?: () => number }} options
   */
  constructor(options) {
    this.#config = options.config
    this.#registry = options.registry
    this.#now = options.now ?? Date.now
  }

  /** @type {Map<string, Promise<any>>} */
  #inflight = new Map()

  /**
   * 解析某个工作目录应使用的端点。
   * @param {string} cwd
   * @param {{ signal?: AbortSignal, force?: boolean, toolName?: string }} [options]
   * @returns {Promise<{ endpoint: import('./discovery.js').IdeaEndpoint, projectPath: string, resolution: 'config' | 'cache' | 'single' | 'probe', warning?: string }>}
   */
  async resolve(cwd, options = {}) {
    const key = `${normalizePath(cwd)}|${options.toolName ?? ''}`
    // 并发会话用同一 cwd 时共享一次探测，避免把每个端点打两遍。
    if (!options.force && this.#inflight.has(key)) return this.#inflight.get(key)
    const task = this.#doResolve(cwd, options)
    if (!options.force) {
      this.#inflight.set(key, task)
      task.finally(() => this.#inflight.delete(key)).catch(() => {})
    }
    return task
  }

  /**
   * @param {string} cwd
   * @param {{ signal?: AbortSignal, force?: boolean, toolName?: string }} options
   */
  async #doResolve(cwd, options) {
    const normalizedCwd = normalizePath(cwd)
    if (!normalizedCwd) {
      throw new NoProjectError('当前会话没有可用的工作目录，无法判断该连接哪个 IDEA 项目。', { cwd: '', probes: [] })
    }
    await this.#registry.ensureFresh({ signal: options.signal })
    let endpoints = this.#registry.endpoints()
    if (endpoints.length === 0) {
      throw new NoProjectError(
        '没有发现可用的 IDE MCP 端点。请确认已打开 JetBrains IDE、MCP Server 插件已启用，然后调用 idea_refresh 重试。',
        { cwd, probes: [] },
      )
    }

    // 工具只存在于部分端点时，探测范围收窄到真正提供它的端点，避免把调用发到不支持它的 IDE。
    if (options.toolName) {
      const supporting = endpoints.filter((endpoint) => endpointSupports(endpoint, options.toolName))
      if (supporting.length > 0) {
        endpoints = supporting
      } else if (endpoints.every((endpoint) => Array.isArray(endpoint.tools))) {
        throw new NoProjectError(
          `已发现的 IDE 端点都没有提供工具 ${options.toolName}。可用 idea_status 查看工具列表，或调整 includeTools / IDE 的工具过滤设置。`,
          { cwd, probes: [] },
        )
      }
    }
    const byUrl = new Map(endpoints.map((endpoint) => [endpoint.url, endpoint]))

    // 1) 手工映射优先
    const mapped = this.#matchConfiguredProject(cwd)
    if (mapped) {
      const endpoint = byUrl.get(mapped.url) ?? this.#findByLooseUrl(endpoints, mapped.url)
      if (endpoint && endpointSupports(endpoint, options.toolName)) {
        return { endpoint, projectPath: this.#projectPathFor(endpoint, cwd), resolution: 'config' }
      }
    }

    // 2) 单端点：不需要探测，直接把项目路径交给 IDE 解析
    if (endpoints.length === 1) {
      const endpoint = endpoints[0]
      return { endpoint, projectPath: this.#projectPathFor(endpoint, cwd), resolution: 'single' }
    }

    // 3) 缓存（缓存端点也必须提供本次要调的工具）
    if (!options.force) {
      const cached = this.#cache.get(normalizedCwd)
      const endpoint = cached ? byUrl.get(cached.url) : undefined
      if (cached && endpoint && this.#now() - cached.at <= this.#config.mappingTtlMs && endpointSupports(endpoint, options.toolName)) {
        return { endpoint, projectPath: this.#projectPathFor(endpoint, cwd), resolution: 'cache' }
      }
    }

    // 4) 探测所有端点
    const probes = await Promise.all(
      endpoints.map(async (endpoint) => ({ endpoint, ...(await this.#probe(endpoint, cwd, options.signal)) })),
    )
    const hosted = probes.filter((probe) => probe.hosted)
    if (hosted.length === 0) {
      throw new NoProjectError(
        `没有 IDE 打开当前会话的项目：${cwd}。请在对应的 IDE 窗口里打开这个项目，或用 idea_status 查看当前发现到的端点。`,
        { cwd, probes: probes.map(({ endpoint, hosted: ok, error }) => ({ url: endpoint.url, hosted: ok, error })) },
      )
    }
    const chosen = hosted[0]
    this.#cache.set(normalizedCwd, { url: chosen.endpoint.url, resolution: 'probe', at: this.#now() })
    const warning = hosted.length > 1
      ? `多个端点都能解析该项目（${hosted.map((probe) => probe.endpoint.product || probe.endpoint.url).join('、')}），已选择 ${chosen.endpoint.url}。可用 config.projects 固定映射。`
      : undefined
    return {
      endpoint: chosen.endpoint,
      projectPath: this.#projectPathFor(chosen.endpoint, cwd),
      resolution: 'probe',
      warning,
    }
  }

  /**
   * 让某个 cwd 的缓存失效（真实调用报 project-not-found 时调用）。
   * @param {string} cwd
   */
  invalidate(cwd) {
    this.#cache.delete(normalizePath(cwd))
  }

  /** 清空全部缓存。 */
  clear() {
    this.#cache.clear()
  }

  /** 当前 cwd → 端点的路由缓存，供状态工具展示。 */
  cacheSummary() {
    return [...this.#cache.entries()].map(([cwd, value]) => ({ cwd, url: value.url, at: value.at }))
  }

  /**
   * 端点固定项目路径优先，否则用会话 cwd。
   * @param {import('./discovery.js').IdeaEndpoint} endpoint
   * @param {string} cwd
   * @returns {string}
   */
  #projectPathFor(endpoint, cwd) {
    return endpoint.pinnedProjectPath || cwd
  }

  /**
   * 找到匹配 cwd 的手工映射（最长前缀优先）。
   * @param {string} cwd
   * @returns {{ path: string, url: string } | undefined}
   */
  #matchConfiguredProject(cwd) {
    let best
    for (const mapping of this.#config.projects) {
      if (!isPathInside(mapping.path, cwd)) continue
      if (!best || normalizePath(mapping.path).length > normalizePath(best.path).length) best = mapping
    }
    return best
  }

  /**
   * 配置里的 URL 可能没写全路径，按主机+端口兜底匹配。
   * @param {import('./discovery.js').IdeaEndpoint[]} endpoints
   * @param {string} url
   */
  #findByLooseUrl(endpoints, url) {
    const wanted = normalizeUrl(url)
    return endpoints.find((endpoint) => {
      if (normalizeUrl(endpoint.url) === wanted) return true
      try {
        const a = new URL(endpoint.url)
        const b = new URL(wanted)
        return a.host === b.host
      } catch {
        return false
      }
    })
  }

  /**
   * 判断某个端点是否打开了 cwd 对应的项目。
   * @param {import('./discovery.js').IdeaEndpoint} endpoint
   * @param {string} cwd
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<{ hosted: boolean, error?: string }>}
   */
  async #probe(endpoint, cwd, signal) {
    if (endpoint.pinnedProjectPath && !isPathInside(endpoint.pinnedProjectPath, cwd)) {
      return { hosted: false, error: `端点固定到项目 ${endpoint.pinnedProjectPath}` }
    }
    const projectPath = endpoint.pinnedProjectPath || cwd
    let tools
    try {
      tools = await this.#registry.toolsFor(endpoint, { signal })
    } catch (error) {
      return { hosted: true, error: `无法读取工具列表，暂按可用处理：${messageOf(error)}` }
    }
    const probeTool = this.#pickProbeTool(tools)
    if (!probeTool) return { hosted: true, error: '没有合适的探测工具，暂按可用处理' }
    try {
      // 必须走 projectPath 参数：IDEA 的请求头只是「软提示」，项目不存在时会退回默认项目，
      // 只有参数才会触发严格解析并返回 "doesn't correspond to any open project"。
      const args = injectProjectPathArgument({}, probeTool, projectPath, this.#config)
      await endpoint.client.callTool(probeTool.name, args, {
        signal,
        headers: { IJ_MCP_SERVER_PROJECT_PATH: projectPath },
        timeoutMs: Math.min(this.#config.toolCallTimeoutMs, 15000),
      })
      return { hosted: true }
    } catch (error) {
      if (isProjectNotFoundError(error)) return { hosted: false, error: messageOf(error) }
      return { hosted: true, error: messageOf(error) }
    }
  }

  /**
   * 从可用工具里挑一个只读、轻量的探测工具。
   * @param {any[]} tools
   * @returns {any | undefined}
   */
  #pickProbeTool(tools) {
    for (const candidate of this.#config.probeTools) {
      const found = tools.find((tool) => tool?.name === candidate)
      if (found) return found
    }
    return undefined
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? '')
}
