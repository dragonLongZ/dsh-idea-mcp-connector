/**
 * 测试用的假 JetBrains MCP 服务：实现 Streamable HTTP + JSON-RPC 的最小集，
 * 用来验证发现、握手、工具同步、按项目路由与错误分类。
 *
 * 行为对齐真实 IDE：
 * - `initialize` 返回 `Mcp-Session-Id`；
 * - `tools/call` 先按 `arguments.projectPath`、再按 `IJ_MCP_SERVER_PROJECT_PATH`
 *   请求头解析项目；项目不在打开的列表里就返回 "doesn't correspond to any open project"；
 * - 支持 application/json 与 text/event-stream 两种响应形态。
 */
import { createServer } from 'node:http'

/** 默认工具集，模仿 IDEA 的常见工具。 */
export const DEFAULT_TOOLS = [
  {
    name: 'get_project_modules',
    description: 'Returns the modules of the current project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'The project path.' },
      },
      required: [],
    },
  },
  {
    name: 'list_directory_tree',
    description: 'Provides a tree representation of the specified directory.',
    inputSchema: {
      type: 'object',
      properties: {
        directoryPath: { type: 'string' },
        maxDepth: { type: 'integer' },
        projectPath: { type: 'string', description: 'The project path.' },
      },
      required: ['directoryPath'],
    },
  },
  {
    name: 'get_file_problems',
    description: 'Analyzes the specified file for errors and warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        projectPath: { type: 'string', description: 'The project path.' },
      },
      required: ['path'],
    },
  },
]

/**
 * 启动假 MCP 服务。
 * @param {{
 *   port?: number,
 *   projects?: string[],
 *   tools?: any[],
 *   transport?: 'sse' | 'json',
 *   protocolVersion?: string,
 *   rejectFirstVersion?: boolean,
 *   pageSize?: number,
 *   callDelayMs?: number,
 *   handler?: (call: { name: string, args: any, project: string, headers: Record<string, string> }) => any,
 * }} [options]
 */
export async function startFakeMcp(options = {}) {
  const projects = options.projects ?? ['D:/ideaProject/demo']
  const tools = [...(options.tools ?? DEFAULT_TOOLS)]
  const transport = options.transport ?? 'sse'
  const protocolVersion = options.protocolVersion ?? '2025-06-18'
  const pageSize = options.pageSize ?? 100
  const calls = []
  /** @type {Set<string>} */
  const sessions = new Set()
  let sessionSeq = 0
  let firstVersionRejected = false
  let initializeCount = 0
  let toolsListFailures = options.failToolsListTimes ?? 0

  const projectNotFound = (projectPath) => ({
    isError: true,
    content: [{
      type: 'text',
      text: `\`projectPath\`=\`${projectPath}\` doesn't correspond to any open project.\n Currently open projects: ${JSON.stringify({ projects: projects.map((path) => ({ path })) })}`,
    }],
  })

  /**
   * @param {any} payload
   * @param {import('node:http').ServerResponse} res
   * @param {string | undefined} sessionId
   */
  function send(payload, res, sessionId) {
    const body = JSON.stringify(payload)
    const headers = { 'content-type': transport === 'sse' ? 'text/event-stream' : 'application/json' }
    if (sessionId) headers['mcp-session-id'] = sessionId
    if (transport === 'sse') {
      res.writeHead(200, headers)
      res.end(`event: message\ndata: ${body}\n\n`)
    } else {
      res.writeHead(200, headers)
      res.end(body)
    }
  }

  /**
   * @param {any} message
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(message, req, res) {
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(',') : String(value ?? '')]),
    )
    const sessionId = headers['mcp-session-id']

    if (message.method === 'initialize') {
      initializeCount += 1
      if (options.rejectFirstVersion && !firstVersionRejected && message.params?.protocolVersion !== protocolVersion) {
        firstVersionRejected = true
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unsupported protocol version' } }, res, undefined)
        return
      }
      sessionSeq += 1
      const nextSession = `fake-session-${sessionSeq}`
      sessions.add(nextSession)
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'IntelliJ IDEA MCP Server', version: '1.0-test' },
          instructions: 'fake IDE',
        },
      }, res, nextSession)
      return
    }

    if (message.method === 'notifications/initialized') {
      res.writeHead(202).end()
      return
    }

    if (message.id === undefined) {
      res.writeHead(202).end()
      return
    }

    if (sessionId && !sessions.has(sessionId)) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"session not found"}')
      return
    }

    if (message.method === 'tools/list') {
      if (toolsListFailures > 0) {
        toolsListFailures -= 1
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"tools list boom"}')
        return
      }
      const cursor = Number(message.params?.cursor ?? 0)
      const slice = tools.slice(cursor, cursor + pageSize)
      const next = cursor + pageSize < tools.length ? String(cursor + pageSize) : undefined
      send({
        jsonrpc: '2.0',
        id: options.respondWithWrongId ? message.id + 100 : message.id,
        result: { tools: slice, ...(next ? { nextCursor: next } : {}) },
      }, res, undefined)
      return
    }

    if (message.method === 'tools/call') {
      const name = message.params?.name
      const args = message.params?.arguments ?? {}
      const normalize = (value) => String(value ?? '').replace(/\\/g, '/')
      const explicit = typeof args.projectPath === 'string' && args.projectPath ? args.projectPath : undefined
      const headerPath = headers['ij_mcp_server_project_path']
      let project = ''

      // 对齐真实 IDEA：参数是严格模式；请求头只是软提示，解析不到时退回默认（第一个）项目。
      // 项目不存在时返回 HTTP 200 + result.isError=true，而不是 JSON-RPC error。
      if (explicit !== undefined) {
        if (!projects.includes(normalize(explicit))) {
          calls.push({ name, args, project: '', headers })
          send({ jsonrpc: '2.0', id: message.id, result: projectNotFound(explicit) }, res, undefined)
          return
        }
        project = normalize(explicit)
      } else if (headerPath && projects.includes(normalize(headerPath))) {
        project = normalize(headerPath)
      } else if (projects.length > 0) {
        project = projects[0]
      } else {
        calls.push({ name, args, project: '', headers })
        send({ jsonrpc: '2.0', id: message.id, result: projectNotFound(headerPath ?? '') }, res, undefined)
        return
      }

      calls.push({ name, args, project, headers })
      // 先记录再延迟：超时测试要能确认「IDE 实际收到了几次调用」
      if (options.callDelayMs) await new Promise((resolve) => setTimeout(resolve, options.callDelayMs))
      const result = options.handler
        ? await options.handler({ name, args, project, headers })
        : { content: [{ type: 'text', text: `${name} ok for ${project}` }] }
      if (result?.__transportError) {
        res.writeHead(result.status ?? 500, { 'content-type': 'application/json' }).end('{"error":"boom"}')
        return
      }
      send({ jsonrpc: '2.0', id: message.id, result }, res, undefined)
      return
    }

    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } }, res, undefined)
  }

  const server = createServer((req, res) => {
    if (req.method === 'DELETE') {
      res.writeHead(405).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let message
      try {
        message = JSON.parse(body)
      } catch {
        res.writeHead(400).end('bad json')
        return
      }
      handle(message, req, res).catch((error) => {
        res.writeHead(500).end(String(error))
      })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    server,
    port,
    url: `http://127.0.0.1:${port}/stream`,
    calls,
    projects,
    tools,
    get initializeCount() {
      return initializeCount
    },
    addTool: (tool) => tools.push(tool),
    failToolsListNext: (times) => {
      toolsListFailures = times
    },
    invalidateSessions: () => sessions.clear(),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
