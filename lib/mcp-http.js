/**
 * 极简 MCP Streamable HTTP 客户端（零依赖，只用全局 fetch）。
 *
 * 为什么不用官方 SDK：本连接器的核心是「每次请求按会话工作目录带上
 * `IJ_MCP_SERVER_PROJECT_PATH` 头 / `projectPath` 参数」，需要精确控制单次请求头；
 * 同时插件运行在 profile 里，不能依赖 DSH 安装目录中的包。
 *
 * 协议要点（2025-06-18 及兼容版本）：
 * - POST JSON-RPC 到端点，`Accept` 同时声明 application/json 与 text/event-stream；
 * - 初始化响应里的 `Mcp-Session-Id` 要回填到后续每个请求；
 * - 服务端可能用 application/json 或 text/event-stream 返回同一条响应。
 */
import { combineSignal } from './util.js'

/** 客户端标识，会出现在 IDE 的 MCP 日志里。 */
export const CLIENT_INFO = Object.freeze({ name: 'dsh-idea-mcp-connector', version: '0.1.0' })

/** 优先尝试的协议版本；协商失败会依次回退。 */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

/**
 * 连接 / 协议层错误。`kind` 决定上层是重试、换端点还是直接报错。
 */
export class McpError extends Error {
  /**
 * @param {string} message
 * @param {{ kind?: 'transport' | 'timeout' | 'http' | 'auth' | 'rpc' | 'tool' | 'protocol', code?: number, status?: number, body?: string, retryable?: boolean }} [options]
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'McpError'
    this.kind = options.kind ?? 'protocol'
    this.code = options.code
    this.status = options.status
    this.body = options.body
    this.retryable = options.retryable === true
  }
}

/** IDE 在 projectPath 无法对应到已打开项目时返回的错误文案。 */
const PROJECT_NOT_FOUND_PATTERNS = [
  /doesn't correspond to any open project/i,
  /does not correspond to any open project/i,
  /Unable to determine the target project/i,
  /Project not found/i,
  /Invalid project path/i,
  /Failed to parse project path/i,
  /no suitable project/i,
  /suitable project not found/i,
]

/** 协议版本不匹配时值得换一个版本重试。 */
const VERSION_MISMATCH_PATTERNS = [/protocol version/i, /unsupported.*version/i, /invalid.*version/i]

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isProjectNotFoundError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const body = error && typeof error === 'object' && 'body' in error ? String(error.body ?? '') : ''
  return PROJECT_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(message) || pattern.test(body))
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isVersionMismatchError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return VERSION_MISMATCH_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isSessionExpiredError(error) {
  if (!(error instanceof McpError) || error.kind !== 'http') return false
  if (error.status === 404) return true
  return error.status === 400 && /session/i.test(error.body ?? '')
}

/**
 * 把 SSE 响应文本拆成 JSON-RPC 消息数组。
 * @param {string} text
 * @returns {any[]}
 */
export function parseSseMessages(text) {
  const messages = []
  for (const block of String(text ?? '').split(/\r?\n\r?\n/)) {
    const data = []
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length === 0) continue
    const payload = data.join('\n')
    if (!payload.trim() || payload.trim() === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload)
      if (Array.isArray(parsed)) messages.push(...parsed)
      else messages.push(parsed)
    } catch {
      // 非 JSON 的 data 事件（如 keep-alive）直接忽略
    }
  }
  return messages
}

/**
 * 从响应头/响应体里挑选与请求 id 对应的消息。
 * @param {Headers} headers
 * @param {string} text
 * @param {number | string | undefined} id
 * @returns {any}
 */
function pickMessage(headers, text, id) {
  const contentType = headers.get('content-type') ?? ''
  if (!text.trim()) return undefined
  let messages
  if (contentType.includes('text/event-stream')) {
    messages = parseSseMessages(text)
  } else {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new McpError(`MCP 响应不是合法 JSON：${text.slice(0, 200)}`, { kind: 'protocol' })
    }
    messages = Array.isArray(parsed) ? parsed : [parsed]
  }
  if (id === undefined) {
    // 通知（无 id）只关心「是否有结果/错误」，取第一条有效消息即可
    return messages.find((message) => message && (message.result !== undefined || message.error !== undefined)) ?? messages[0]
  }
  const match = messages.find((message) => message && message.id === id)
  if (!match) {
    throw new McpError(`MCP 响应缺少 id=${id} 的 JSON-RPC 消息（收到 ${messages.length} 条）`, { kind: 'protocol' })
  }
  return match
}

/**
 * 把 MCP 工具结果里的文本块拼起来，用于错误信息。
 * @param {{ content?: any[] }} result
 * @returns {string}
 */
export function resultText(result) {
  return (result?.content ?? [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 一个 MCP Streamable HTTP 连接。一个实例对应一个端点，可被多个会话共享；
 * 项目区分靠每次请求的 `IJ_MCP_SERVER_PROJECT_PATH` 头，不靠连接本身。
 */
export class McpHttpClient {
  #url
  #headers
  #timeoutMs
  #fetchImpl
  #protocolVersions
  #nextId = 1
  #sessionId
  #protocolVersion
  #serverInfo
  #serverInstructions
  #capabilities
  #connected = false
  #connecting
  #closed = false

  /**
   * @param {{ url: string, headers?: Record<string, string>, timeoutMs?: number, protocolVersions?: string[], fetchImpl?: typeof fetch }} options
   */
  constructor(options) {
    if (!options?.url) throw new Error('McpHttpClient 需要 url')
    this.#url = options.url
    this.#headers = { ...(options.headers ?? {}) }
    this.#timeoutMs = options.timeoutMs ?? 60000
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.#protocolVersions = options.protocolVersions ?? PROTOCOL_VERSIONS
  }

  get url() {
    return this.#url
  }

  get connected() {
    return this.#connected
  }

  /** 连接信息快照，供状态工具展示。 */
  get info() {
    return {
      url: this.#url,
      connected: this.#connected,
      protocolVersion: this.#protocolVersion,
      sessionId: this.#sessionId,
      serverInfo: this.#serverInfo,
      capabilities: this.#capabilities,
    }
  }

  /** 服务端在 initialize 里给出的使用说明（如有）。 */
  get serverInstructions() {
    return this.#serverInstructions ?? ''
  }

  /**
   * 建立连接（幂等；并发调用共享同一次握手）。
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<ReturnType<McpHttpClient['info']>>}
   */
  async connect(options = {}) {
    if (this.#closed) throw new McpError('连接已关闭', { kind: 'transport' })
    if (this.#connected) return this.info
    if (!this.#connecting) {
      this.#connecting = this.#doConnect(options).finally(() => {
        this.#connecting = undefined
      })
    }
    return this.#connecting
  }

  /**
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} options
   * @returns {Promise<ReturnType<McpHttpClient['info']>>}
   */
  async #doConnect(options) {
    let lastError
    for (const version of this.#protocolVersions) {
      try {
        return await this.#initializeWith(version, options)
      } catch (error) {
        lastError = error
        if (error instanceof McpError) {
          if (error.kind === 'transport' || error.kind === 'auth' || error.kind === 'http' || error.kind === 'timeout') throw error
          if (error.kind === 'rpc' && !isVersionMismatchError(error)) throw error
        }
      }
    }
    throw lastError ?? new McpError('MCP 握手失败', { kind: 'protocol' })
  }

  /**
   * 用指定协议版本握手。
   * @param {string} version
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} options
   */
  async #initializeWith(version, options) {
    this.#sessionId = undefined
    const response = await this.#post(
      {
        jsonrpc: '2.0',
        id: this.#nextId++,
        method: 'initialize',
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      },
      { signal: options.signal, timeoutMs: options.timeoutMs ?? this.#timeoutMs },
    )
    const message = pickMessage(response.headers, response.text, undefined)
    if (!message || typeof message !== 'object') {
      throw new McpError('MCP initialize 没有返回 JSON-RPC 响应', { kind: 'protocol' })
    }
    if (message.error) throw rpcError(message.error)
    const result = message.result
    if (!result || typeof result !== 'object' || !result.serverInfo) {
      throw new McpError('MCP initialize 响应缺少 serverInfo', { kind: 'protocol' })
    }
    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId) this.#sessionId = sessionId
    this.#protocolVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion : version
    this.#serverInfo = result.serverInfo
    this.#capabilities = result.capabilities ?? {}
    this.#serverInstructions = typeof result.instructions === 'string' ? result.instructions : ''
    this.#connected = true
    try {
      await this.notify('notifications/initialized', undefined, { signal: options.signal })
    } catch {
      // 部分实现不回 202，也不影响后续请求；初始化通知失败不致命
    }
    return this.info
  }

  /**
   * 发送通知（无 id，无响应体）。
   * @param {string} method
   * @param {Record<string, unknown> | undefined} params
   * @param {{ signal?: AbortSignal, timeoutMs?: number, headers?: Record<string, string> }} [options]
   */
  async notify(method, params, options = {}) {
    const payload = { jsonrpc: '2.0', method }
    if (params !== undefined) payload.params = params
    await this.#post(payload, options, { expectBody: false })
  }

  /**
   * 列出服务端全部工具（自动翻页）。
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<any[]>}
   */
  async listTools(options = {}) {
    const tools = []
    const seen = new Set()
    let cursor
    for (let page = 0; page < 50; page += 1) {
      const result = await this.#rpc('tools/list', cursor === undefined ? {} : { cursor }, options)
      const list = Array.isArray(result?.tools) ? result.tools : []
      for (const tool of list) {
        const name = typeof tool?.name === 'string' ? tool.name : ''
        if (!name || seen.has(name)) continue
        seen.add(name)
        tools.push(tool)
      }
      const next = result?.nextCursor
      if (typeof next !== 'string' || !next || next === cursor) break
      cursor = next
    }
    return tools
  }

  /**
   * 调用一个工具。
   * @param {string} name 服务端原始工具名
   * @param {Record<string, unknown>} args
   * @param {{ signal?: AbortSignal, headers?: Record<string, string>, timeoutMs?: number }} [options]
   * @returns {Promise<{ content: any[], structuredContent?: any, isError?: boolean }>}
   */
  async callTool(name, args, options = {}) {
    const result = await this.#rpc('tools/call', { name, arguments: args ?? {} }, {
      signal: options.signal,
      headers: options.headers,
      timeoutMs: options.timeoutMs ?? this.#timeoutMs,
    })
    if (!result || typeof result !== 'object') {
      return { content: [] }
    }
    const normalized = {
      content: Array.isArray(result.content) ? result.content : [],
      structuredContent: result.structuredContent,
      isError: result.isError === true,
    }
    // 真实 IDE 的「项目不存在」等预期错误是 HTTP 200 + result.isError=true，
    // 必须当成失败抛出，否则会被当成成功结果缓存并继续路由。
    if (normalized.isError) {
      throw new McpError(resultText(normalized) || `IDE 工具 ${name} 返回错误`, { kind: 'tool' })
    }
    return normalized
  }

  /**
   * 发 JSON-RPC 请求；会话过期时重连一次。
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {{ signal?: AbortSignal, headers?: Record<string, string>, timeoutMs?: number }} options
   * @returns {Promise<any>}
   */
  async #rpc(method, params, options) {
    await this.connect({ signal: options.signal, timeoutMs: options.timeoutMs })
    try {
      return await this.#send(method, params, options)
    } catch (error) {
      if (this.#sessionId && isSessionExpiredError(error)) {
        this.#connected = false
        this.#sessionId = undefined
        await this.connect({ signal: options.signal, timeoutMs: options.timeoutMs })
        return this.#send(method, params, options)
      }
      throw error
    }
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {{ signal?: AbortSignal, headers?: Record<string, string>, timeoutMs?: number }} options
   * @returns {Promise<any>}
   */
  async #send(method, params, options) {
    const id = this.#nextId++
    const response = await this.#post({ jsonrpc: '2.0', id, method, params }, options)
    const message = pickMessage(response.headers, response.text, id)
    if (!message || typeof message !== 'object') {
      throw new McpError(`MCP ${method} 没有返回 JSON-RPC 响应`, { kind: 'protocol' })
    }
    if (message.error) throw rpcError(message.error)
    return message.result
  }

  /**
   * 统一 POST 与错误归一化。
   * @param {unknown} payload
   * @param {{ signal?: AbortSignal, timeoutMs?: number, headers?: Record<string, string> }} options
   * @param {{ expectBody?: boolean }} [behavior]
   * @returns {Promise<{ text: string, headers: Headers, status: number }>}
   */
  async #post(payload, options = {}, behavior = {}) {
    if (this.#closed) throw new McpError('连接已关闭', { kind: 'transport' })
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs
    const { signal, dispose } = combineSignal(options.signal, timeoutMs)
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.#headers,
      ...(options.headers ?? {}),
    }
    if (this.#sessionId) headers['mcp-session-id'] = this.#sessionId
    if (this.#protocolVersion) headers['mcp-protocol-version'] = this.#protocolVersion
    try {
      let response
      let text
      try {
        response = await this.#fetchImpl(this.#url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal,
        })
        text = await response.text()
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (signal.aborted) {
          throw new McpError(`IDE 调用超时（${timeoutMs}ms）或已取消：${this.#url}`, { kind: 'timeout' })
        }
        const reason = error instanceof Error ? error.message : String(error)
        throw new McpError(`无法连接 IDE MCP 端点 ${this.#url}：${reason}`, { kind: 'transport', retryable: true })
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new McpError(`IDE MCP 端点拒绝访问（HTTP ${response.status}）`, {
            kind: 'auth',
            status: response.status,
            body: text,
          })
        }
        throw new McpError(`IDE MCP 端点返回 HTTP ${response.status}`, {
          kind: 'http',
          status: response.status,
          body: text,
        })
      }
      if (behavior.expectBody === false) return { text: '', headers: response.headers, status: response.status }
      return { text, headers: response.headers, status: response.status }
    } finally {
      dispose()
    }
  }

  /** 关闭连接（尽力通知服务端，不等待服务端响应语义）。 */
  async close() {
    this.#closed = true
    this.#connected = false
    if (!this.#sessionId) return
    try {
      await this.#fetchImpl(this.#url, {
        method: 'DELETE',
        headers: {
          ...this.#headers,
          'mcp-session-id': this.#sessionId,
          'mcp-protocol-version': this.#protocolVersion ?? PROTOCOL_VERSIONS[0],
        },
      })
    } catch {
      // 关闭失败不影响本地清理
    } finally {
      this.#sessionId = undefined
    }
  }
}

/**
 * 把 JSON-RPC error 转成统一错误。
 * @param {{ code?: number, message?: string, data?: unknown }} error
 * @returns {McpError}
 */
function rpcError(error) {
  const code = typeof error?.code === 'number' ? error.code : undefined
  const detail = typeof error?.message === 'string' && error.message ? error.message : '未知 JSON-RPC 错误'
  const suffix = error?.data === undefined ? '' : `：${safeJson(error.data)}`
  return new McpError(detail + suffix, { kind: 'rpc', code })
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeJson(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}
