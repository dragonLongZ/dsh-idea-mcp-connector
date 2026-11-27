/**
 * 连接器运行时：把「端点发现 → 工具同步 → 按会话路由」串起来。
 *
 * 这里不引用任何 DSH 包：
 * - 只用到 `ctx.tools` / `ctx.sessions` / `ctx.workingDirectory` 三个服务；
 * - 工具注册返回 disposer，运行时自己管理重注册，插件卸载时由 ctx 兜底。
 */
import { IdeaEndpointRegistry } from './discovery.js'
import { isProjectNotFoundError } from './mcp-http.js'
import { ProjectRouter, injectProjectPathArgument } from './router.js'
import { IdeaToolError, createMetaTools, createProxyTool, modelFacingParameters } from './tools.js'
import { toolSelected } from './config.js'
import { matchesWildcard, stableStringify, truncateText } from './util.js'

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? '')
}

/**
 * 连接器运行时。
 */
export class IdeaConnectorRuntime {
  /**
   * @param {any} ctx cordis Host 上下文
   * @param {ReturnType<typeof import('./config.js').resolveConfig>} config
   * @param {{
   *   registry?: IdeaEndpointRegistry,
   *   router?: ProjectRouter,
   *   now?: () => number,
   *   fetchImpl?: typeof fetch,
   *   logRoots?: string[],
   *   scan?: typeof import('./log-scan.js').scanJetBrainsLogs,
   * }} [deps]
   */
  constructor(ctx, config, deps = {}) {
    this.ctx = ctx
    this.config = config
    this.registry = deps.registry ?? new IdeaEndpointRegistry({
      config,
      fetchImpl: deps.fetchImpl,
      logRoots: deps.logRoots,
      scan: deps.scan,
      now: deps.now,
    })
    this.router = deps.router ?? new ProjectRouter({ config, registry: this.registry, now: deps.now })
    this.#now = deps.now ?? Date.now
    this.#meta = createMetaTools(this)
  }

  #now
  #meta
  #disposed = false
  #ready
  #state = {
    syncing: undefined,
    lastSyncAt: 0,
    syncError: '',
    /** @type {Map<string, { publicName: string, rawName: string, key: string, dispose: () => void }>} */
    registrations: new Map(),
    /** @type {Map<string, { tool: any, endpoints: string[] }>} */
    tools: new Map(),
    /** 上一份成功的工具列表（按端点 URL），tools/list 抖动时兜底 */
    /** @type {Map<string, any[]>} */
    endpointTools: new Map(),
    /** @type {Array<{ name: string, error: string }>} */
    conflicts: [],
    warnings: [],
  }

  /** 常驻元工具定义（由插件入口注册）。 */
  metaTools() {
    return this.#meta
  }

  /** 首次同步完成的 Promise；测试与入口都用它等待初始发现。 */
  get ready() {
    return this.#ready ?? Promise.resolve()
  }

  /** 启动：首次发现 + 工具注册（失败不抛，状态里可见）。 */
  start() {
    if (!this.#ready) {
      this.#ready = this.sync({ force: true }).catch((error) => {
        this.#state.syncError = messageOf(error)
        if (this.config.debug) console.warn('[dsh-idea-mcp-connector] 初始同步失败:', error)
      })
    }
    return this.#ready
  }

  /**
   * 重新发现端点并同步工具集合。同名工具只注册一次（跨端点共享，调用时再路由）。
   * 注册是增量的：schema 未变的工具保持原注册，避免模型的工具声明反复抖动。
   * @param {{ force?: boolean, signal?: AbortSignal }} [options]
   * @returns {Promise<{ changed: boolean, endpointCount: number, toolCount: number, registered: number, conflicts: Array<{ name: string, error: string }>, errors: Array<{ url: string, error: string }> }>}
   */
  async sync(options = {}) {
    if (this.#disposed) return { changed: false, endpointCount: 0, toolCount: 0, registered: 0, conflicts: [], errors: [] }
    if (this.#state.syncing) return this.#state.syncing
    this.#state.syncing = this.#doSync(options.force === true, options.signal).finally(() => {
      this.#state.syncing = undefined
    })
    return this.#state.syncing
  }

  /**
   * @param {boolean} force
   * @param {AbortSignal | undefined} signal
   */
  async #doSync(force, signal) {
    /** @type {Array<{ url: string, error: string }>} */
    const toolErrors = []
    try {
      await this.registry.refresh({ force, signal })
    } catch (error) {
      this.#state.syncError = messageOf(error)
      return { changed: false, endpointCount: this.registry.endpoints().length, toolCount: 0, registered: 0, conflicts: [], errors: [] }
    }
    if (signal?.aborted) {
      return { changed: false, endpointCount: this.registry.endpoints().length, toolCount: 0, registered: this.#state.registrations.size, conflicts: this.#state.conflicts, errors: [] }
    }

    const endpoints = this.registry.endpoints()
    /** @type {Map<string, { tool: any, endpoints: string[] }>} */
    const collected = new Map()
    /** @param {any[]} tools @param {string} url */
    const collect = (tools, url) => {
      for (const tool of tools) {
        if (!tool || typeof tool.name !== 'string' || !tool.name) continue
        const entry = collected.get(tool.name)
        if (entry) entry.endpoints.push(url)
        else collected.set(tool.name, { tool, endpoints: [url] })
      }
    }
    await Promise.all(endpoints.map(async (endpoint) => {
      try {
        const tools = await this.registry.toolsFor(endpoint, { force, signal })
        this.#state.endpointTools.set(endpoint.url, tools)
        collect(tools, endpoint.url)
      } catch (error) {
        // tools/list 抖动时沿用该端点上一份工具列表，避免模型面前工具整体消失
        const previous = this.#state.endpointTools.get(endpoint.url)
        if (previous) {
          collect(previous, endpoint.url)
          toolErrors.push({ url: endpoint.url, error: `${messageOf(error)}（沿用上次的工具列表）` })
        } else {
          toolErrors.push({ url: endpoint.url, error: messageOf(error) })
        }
      }
    }))
    for (const url of [...this.#state.endpointTools.keys()]) {
      if (!endpoints.some((endpoint) => endpoint.url === url)) this.#state.endpointTools.delete(url)
    }
    this.#state.tools = collected

    const selected = [...collected.values()]
      .filter(({ tool }) => toolSelected(tool.name, this.config, matchesWildcard))
      .sort((left, right) => left.tool.name.localeCompare(right.tool.name))

    /** @type {Map<string, { tool: any, key: string }>} */
    const desired = new Map()
    for (const { tool } of selected) {
      desired.set(tool.name, {
        tool,
        key: stableStringify({
          name: tool.name,
          description: tool.description ?? '',
          parameters: modelFacingParameters(tool, this.config),
        }),
      })
    }

    let changed = false
    // 移除不再需要的注册
    for (const [rawName, registration] of [...this.#state.registrations]) {
      const wanted = desired.get(rawName)
      if (wanted && wanted.key === registration.key) continue
      try {
        registration.dispose()
      } catch {
        // 已被 ctx 释放
      }
      this.#state.registrations.delete(rawName)
      if (!wanted) changed = true
    }

    /** @type {Array<{ name: string, error: string }>} */
    const conflicts = []
    for (const [rawName, { tool, key }] of desired) {
      if (this.#state.registrations.has(rawName)) continue
      let definition
      try {
        definition = createProxyTool(this, tool)
        const dispose = this.ctx.tools.register(definition)
        this.#state.registrations.set(rawName, { publicName: definition.name, rawName, key, dispose })
        changed = true
      } catch (error) {
        conflicts.push({ name: definition?.name ?? rawName, error: messageOf(error) })
      }
    }
    const conflictsChanged = stableStringify(conflicts) !== stableStringify(this.#state.conflicts)
    this.#state.conflicts = conflicts

    this.#state.lastSyncAt = this.#now()
    this.#state.syncError = ''
    this.#state.warnings = toolErrors.map(({ url, error }) => `端点 ${url} 读取工具失败：${error}`)

    if (this.config.debug && (changed || conflictsChanged)) {
      console.warn(
        `[dsh-idea-mcp-connector] 同步完成：端点 ${endpoints.length}，工具 ${selected.length}，注册 ${this.#state.registrations.size}，冲突 ${conflicts.length}`,
      )
    }
    return {
      changed: changed || conflictsChanged,
      endpointCount: endpoints.length,
      toolCount: selected.length,
      registered: this.#state.registrations.size,
      conflicts,
      errors: toolErrors,
    }
  }

  /**
   * 调一个 IDE 工具：按会话 cwd 选端点，注入项目路径与请求头；
   * 项目不匹配 / 连接断开时失效缓存并重试一次。超时与用户取消绝不重试。
   * @param {string} rawName IDE 原始工具名
   * @param {Record<string, unknown>} args
   * @param {any} exec ToolRunContext（可缺省，便于测试）
   * @param {{ tool?: any, projectPath?: string }} [options]
   * @returns {Promise<{ result: { content: any[], structuredContent?: any, isError?: boolean }, routing: { endpoint: any, projectPath: string, resolution: string, warning?: string } }>}
   */
  async callRouted(rawName, args, exec, options = {}) {
    if (exec?.signal?.aborted) throw exec.signal.reason ?? new Error('调用已取消')
    const projectPath = (options.projectPath || this.sessionCwd(exec) || '').trim()
    if (!projectPath) {
      throw new IdeaToolError(
        '无法确定当前会话的工作目录，因此不知道该路由到哪个 IDE 项目。请用 idea_call 的 projectPath 参数显式指定绝对路径。',
        { code: 'idea-no-session-cwd' },
      )
    }
    let routing = await this.router.resolve(projectPath, { signal: exec?.signal, toolName: rawName })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.#invoke(rawName, args, routing, exec, options.tool)
        return { result, routing }
      } catch (error) {
        if (exec?.signal?.aborted) throw exec.signal.reason ?? error
        if (attempt > 0) throw this.#wrapCallError(error, routing, projectPath)

        if (isProjectNotFoundError(error)) {
          this.router.invalidate(projectPath)
          if (this.registry.endpoints().length > 1) {
            const next = await this.router.resolve(projectPath, { force: true, signal: exec?.signal, toolName: rawName })
            // 重新解析后仍是同一个端点，说明没有别的端点能接这个项目，重试只会再失败一次
            if (next.endpoint.url !== routing.endpoint.url) {
              routing = next
              continue
            }
          }
          throw new IdeaToolError(
            `${messageOf(error)}\n\nIDE 没有打开会话项目 ${projectPath}。请在对应的 IDE 窗口里打开该项目后重试（可用 idea_status 查看当前端点）。`,
            { code: 'idea-project-not-found', cause: error },
          )
        }

        // 只有「确定请求没送达」的连接错误才重试；超时可能已在 IDE 侧执行，重试会导致非幂等工具执行两次
        if (error && typeof error === 'object' && error.kind === 'transport' && error.retryable === true) {
          this.registry.markDisconnected(routing.endpoint.url)
          this.router.clear()
          routing = await this.router.resolve(projectPath, { force: true, signal: exec?.signal, toolName: rawName })
          continue
        }

        throw this.#wrapCallError(error, routing, projectPath)
      }
    }
    throw new IdeaToolError(`调用 ${rawName} 失败：重试后仍未成功。`, { code: 'idea-call-failed' })
  }

  /**
   * @param {string} rawName
   * @param {Record<string, unknown>} args
   * @param {{ endpoint: any, projectPath: string }} routing
   * @param {any} exec
   * @param {any} tool
   */
  async #invoke(rawName, args, routing, exec, tool) {
    const rawTool = tool ?? this.findTool(rawName)
    const injected = injectProjectPathArgument(args ?? {}, rawTool, routing.projectPath, this.config)
    return routing.endpoint.client.callTool(rawName, injected, {
      signal: exec?.signal,
      headers: { IJ_MCP_SERVER_PROJECT_PATH: routing.projectPath },
      timeoutMs: this.config.toolCallTimeoutMs,
    })
  }

  /**
   * @param {unknown} error
   * @param {{ endpoint: any, projectPath: string }} routing
   * @param {string} projectPath
   */
  #wrapCallError(error, routing, projectPath) {
    if (error instanceof IdeaToolError) return error
    if (error && typeof error === 'object' && error.kind === 'timeout') {
      return new IdeaToolError(
        `${messageOf(error)}\n\nIDE 工具可能仍在执行；为避免非幂等工具执行两次，连接器不会自动重试。可以调大 toolCallTimeoutMs，或稍后用 idea_status 确认结果。`,
        { code: 'idea-call-timeout', cause: error },
      )
    }
    return new IdeaToolError(
      `${messageOf(error)}\n\n（IDE 端点：${routing?.endpoint?.url ?? '未知'}，会话项目：${projectPath}）`,
      { code: 'idea-call-failed', cause: error },
    )
  }

  /**
   * 某个原始工具名在已发现端点中的定义（即使被 include/exclude 过滤也能用于参数注入）。
   * @param {string} rawName
   */
  findTool(rawName) {
    return this.#state.tools.get(rawName)?.tool
  }

  /**
   * 从 ToolRunContext 解析会话工作目录。
   * @param {any} exec
   * @returns {string}
   */
  sessionCwd(exec) {
    const id = exec?.agent?.id ?? exec?.agent?.session?.id
    if (!id) return ''
    const session = this.ctx.sessions?.get?.(id)
    if (!session) return ''
    try {
      const cwd = this.ctx.workingDirectory?.get?.(session)
      if (typeof cwd === 'string' && cwd) return cwd
    } catch {
      // 落到 header.cwd
    }
    const headerCwd = session.header?.cwd
    return typeof headerCwd === 'string' ? headerCwd : ''
  }

  /**
   * 状态快照。`refresh: true` 会强制重扫端点并重新同步工具。
   * @param {{ exec?: any, refresh?: boolean }} [options]
   */
  async status(options = {}) {
    const signal = options.exec?.signal
    if (options.refresh) {
      await this.sync({ force: true, signal })
    } else {
      await this.registry.ensureFresh({ signal })
      if (this.registry.endpoints().length > 0 && this.#state.registrations.size === 0) {
        await this.sync({ force: false, signal })
      }
    }
    const endpoints = this.registry.endpoints().map((endpoint) => ({
      url: endpoint.url,
      product: endpoint.product,
      source: endpoint.source,
      port: endpoint.port,
      logFile: endpoint.logFile,
      protocolVersion: endpoint.info?.protocolVersion,
      serverName: endpoint.info?.serverInfo?.name,
      serverVersion: endpoint.info?.serverInfo?.version,
      toolCount: endpoint.toolCount,
      toolsError: endpoint.toolsError,
    }))
    return {
      serverName: this.config.serverName,
      endpoints,
      endpointErrors: this.registry.errors,
      toolCount: this.#state.registrations.size,
      registeredNames: [...this.#state.registrations.values()].map((registration) => registration.publicName).sort(),
      discoveredToolCount: this.#state.tools.size,
      discoveredToolNames: [...this.#state.tools.keys()].sort(),
      sessionCwd: this.sessionCwd(options.exec),
      routes: this.router.cacheSummary(),
      lastRefresh: this.registry.lastRefresh,
      lastSyncAt: this.#state.lastSyncAt,
      conflicts: this.#state.conflicts,
      syncError: this.#state.syncError,
      warnings: [...this.config.warnings, ...this.#state.warnings],
      refreshIntervalMs: this.config.refreshIntervalMs,
    }
  }

  /**
   * 把状态渲染成一段给模型看的文本。
   * @param {Awaited<ReturnType<IdeaConnectorRuntime['status']>>} status
   * @returns {string}
   */
  renderStatus(status) {
    const lines = [`JetBrains IDE MCP 连接器（工具前缀 mcp__${status.serverName}__）`]
    if (status.endpoints.length === 0) {
      lines.push('', '未发现可用的 IDE MCP 端点。')
      lines.push('  1. 确认 JetBrains IDE 已启动，且 Settings → Tools → MCP Server 里勾选了启用；')
      lines.push('  2. 确认 IDE 日志里有 "Responding at http://127.0.0.1:<port>" 这一行；')
      lines.push('  3. 处理完后调用 idea_refresh 重新扫描（连接器也会按间隔自动重扫）。')
    } else {
      lines.push('', `端点：${status.endpoints.length} 个`)
      for (const endpoint of status.endpoints) {
        const product = endpoint.product || 'JetBrains IDE'
        const toolText = typeof endpoint.toolCount === 'number' ? `${endpoint.toolCount} 个工具` : '工具未同步'
        lines.push(`  • ${product} · ${endpoint.url}（来源 ${endpoint.source}，${toolText}）`)
      }
      lines.push('', `已注册 mcp__${status.serverName}__* 工具：${status.toolCount} 个 / 发现 ${status.discoveredToolCount} 个`)
      if (status.registeredNames.length > 0) {
        const preview = status.registeredNames.slice(0, 12).join('、')
        lines.push(`  ${preview}${status.registeredNames.length > 12 ? ' 等' : ''}`)
      }
    }
    if (status.sessionCwd) {
      lines.push('', `本会话项目：${status.sessionCwd}`)
    } else {
      lines.push('', '本会话项目：无法读取（没有 agent 或工作目录）')
    }
    if (status.routes.length > 0) {
      lines.push(`路由缓存：${status.routes.map((route) => `${route.cwd} → ${route.url}`).join('；')}`)
    }
    if (status.endpointErrors.length > 0) {
      lines.push('', '本次扫描被排除的候选：')
      for (const item of status.endpointErrors.slice(0, 5)) lines.push(`  • ${item.url}：${item.error}`)
    }
    for (const conflict of status.conflicts.slice(0, 5)) {
      lines.push(`工具名冲突：${conflict.name}（${conflict.error}）`)
    }
    if (status.syncError) lines.push(`同步错误：${status.syncError}`)
    if (status.warnings.length > 0) {
      lines.push('', '提示：')
      for (const warning of status.warnings.slice(0, 6)) lines.push(`  • ${warning}`)
    }
    lines.push('', `最近刷新：${formatTime(status.lastRefresh)}；最近同步：${formatTime(status.lastSyncAt)}`)
    return truncateText(lines.join('\n'), 8000)
  }

  /**
   * 系统提示用的极简摘要；没有工具时返回空串，避免提示不存在的工具。
   * @returns {{ endpointCount: number, toolCount: number, products: string[] }}
   */
  promptSummary() {
    const endpoints = this.registry.endpoints()
    return {
      endpointCount: endpoints.length,
      toolCount: this.#state.registrations.size,
      products: [...new Set(endpoints.map((endpoint) => endpoint.product).filter(Boolean))],
    }
  }

  /** 释放运行时资源（插件卸载时调用；工具注册由 ctx 兜底释放）。 */
  dispose() {    if (this.#disposed) return
    this.#disposed = true
    for (const registration of this.#state.registrations.values()) {
      try {
        registration.dispose()
      } catch {
        // 忽略重复释放
      }
    }
    this.#state.registrations.clear()
    this.#state.tools.clear()
    this.#state.endpointTools.clear()
    this.registry.close().catch(() => {})
  }
}

/**
 * @param {number} timestamp
 * @returns {string}
 */
function formatTime(timestamp) {
  if (!timestamp || !Number.isFinite(timestamp)) return '从未'
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 创建运行时。
 * @param {any} ctx
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} config
 * @param {ConstructorParameters<typeof IdeaConnectorRuntime>[2]} [deps]
 * @returns {IdeaConnectorRuntime}
 */
export function createRuntime(ctx, config, deps) {
  return new IdeaConnectorRuntime(ctx, config, deps)
}
