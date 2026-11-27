/**
 * 工具定义：三个常驻元工具（idea_status / idea_refresh / idea_call）+
 * 从 IDE 复刻的 `mcp__<serverName>__<tool>` 代理工具。
 *
 * 代理工具对外隐藏 IDEA 的 `projectPath` 参数（该值由连接器按会话注入），
 * 其余 schema 原样透传，保证模型看到的就是 IDE 的真实能力。
 */
import { publicToolName, truncateText } from './util.js'

/** 统一的工具错误类型，携带 IDE 原始错误文案。 */
export class IdeaToolError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'IdeaToolError'
    this.code = options.code ?? 'idea-tool-error'
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/**
 * 代理工具的 output schema。所有内容统一渲染成一段文本，
 * 避免 DSH 输出校验与 MCP 复杂 content 之间的耦合。
 * @returns {{ schema: Record<string, unknown>, render: (args: unknown, value: any) => any[] }}
 */
function textOutput() {
  return {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    render(_args, value) {
      const text = typeof value?.text === 'string' ? value.text : ''
      return [{ type: 'text', text }]
    },
  }
}

/**
 * 把 MCP `content` / `structuredContent` 归一成模型可读文本。
 * @param {{ content?: any[], structuredContent?: any, isError?: boolean }} result
 * @param {{ maxChars: number }} config
 * @returns {string}
 */
export function renderMcpResult(result, config) {
  const parts = []
  for (const block of result?.content ?? []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'image') {
      const bytes = typeof block.data === 'string' ? Math.floor((block.data.length * 3) / 4) : 0
      parts.push(`[图片已省略：${block.mimeType ?? 'unknown'}，约 ${bytes} 字节]`)
    } else if (block.type === 'audio') {
      parts.push(`[音频已省略：${block.mimeType ?? 'unknown'}]`)
    } else if (block.type === 'resource') {
      const resource = block.resource ?? {}
      parts.push(`[资源 ${resource.uri ?? ''}${resource.text ? `]\n${resource.text}` : ']'}`)
    } else if (block.type === 'resource_link') {
      parts.push(`[资源链接 ${block.name ?? ''} <${block.uri ?? ''}>]`)
    } else {
      parts.push(`[${block.type ?? '未知内容'}]\n${safeJson(block)}`)
    }
  }
  if (parts.length === 0 && result?.structuredContent !== undefined) {
    parts.push(safeJson(result.structuredContent))
  }
  if (parts.length === 0) return '（IDE 工具没有返回内容）'
  return truncateText(parts.join('\n\n'), config.maxResultChars)
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeJson(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * 从 MCP 工具 schema 里去掉 `projectPath`，防止模型自行指定项目。
 * @param {any} tool
 * @param {{ projectPathArg: string }} config
 * @returns {Record<string, unknown>}
 */
export function modelFacingParameters(tool, config) {
  const schema = tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {}
  const parameters = { ...schema }
  delete parameters.$schema
  if (parameters.properties && typeof parameters.properties === 'object') {
    const properties = { ...parameters.properties }
    delete properties[config.projectPathArg]
    parameters.properties = properties
    if (Array.isArray(parameters.required)) {
      const required = parameters.required.filter((name) => name !== config.projectPathArg)
      if (required.length > 0) parameters.required = required
      else delete parameters.required
    }
  }
  // DSH 要求对象型 JSON Schema；个别 MCP 工具可能省略 type/properties。
  if (parameters.type === undefined) parameters.type = 'object'
  if (parameters.properties === undefined) parameters.properties = {}
  return parameters
}

/**
 * 构造一个代理工具定义。
 * @param {import('./runtime.js').IdeaConnectorRuntime} runtime
 * @param {any} rawTool 服务端原始工具
 * @returns {Record<string, unknown>}
 */
export function createProxyTool(runtime, rawTool) {
  const config = runtime.config
  const rawName = String(rawTool.name)
  return {
    name: publicToolName(config.serverName, rawName),
    description: typeof rawTool.description === 'string' && rawTool.description.trim()
      ? rawTool.description
      : `JetBrains IDE MCP 工具：${rawName}`,
    parameters: modelFacingParameters(rawTool, config),
    output: textOutput(),
    // 比客户端内部超时多留 5s，让内部超时先触发、给出可诊断的错误且不触发重试
    timeoutMs: config.toolCallTimeoutMs + 5000,
    async execute(args, exec) {
      const { result } = await runtime.callRouted(rawName, args ?? {}, exec, { tool: rawTool })
      const text = renderMcpResult(result, config)
      if (result.isError) throw new IdeaToolError(text, { code: 'idea-tool-error' })
      return { text }
    },
  }
}

/**
 * 构造常驻元工具。
 * @param {import('./runtime.js').IdeaConnectorRuntime} runtime
 * @returns {Array<Record<string, unknown>>}
 */
export function createMetaTools(runtime) {
  const config = runtime.config
  return [
    {
      name: 'idea_status',
      description: `查看 JetBrains IDE MCP 连接器的状态：发现了哪些 IDE 端点、注册了哪些 mcp__${config.serverName}__* 工具、当前会话的项目如何路由。IDE 刚启动或工具缺失时先调用它。`,
      parameters: { type: 'object', properties: {}, required: [] },
      output: textOutput(),
      timeoutMs: 30000,
      async execute(_args, exec) {
        const status = await runtime.status({ exec })
        return { text: runtime.renderStatus(status) }
      },
    },
    {
      name: 'idea_refresh',
      description: `重新扫描并连接本机的 JetBrains IDE MCP 端点，刷新 mcp__${config.serverName}__* 工具列表。打开/重启 IDE 后调用一次即可。`,
      parameters: { type: 'object', properties: {}, required: [] },
      output: textOutput(),
      timeoutMs: 60000,
      async execute(_args, exec) {
        const status = await runtime.status({ exec, refresh: true })
        return { text: `已重新扫描 IDE 端点。\n\n${runtime.renderStatus(status)}` }
      },
    },
    {
      name: 'idea_call',
      description: `直接调用一个 JetBrains IDE MCP 工具（原始工具名 + JSON 参数），用于 mcp__${config.serverName}__* 工具尚未注册、或想访问被 includeTools 过滤掉的工具时。参数会自动带上当前会话的项目路径。`,
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'IDE 的原始工具名，例如 get_project_modules。可用 idea_status 查看已发现的工具。' },
          arguments: { type: 'object', description: '传给 IDE 工具的 JSON 参数对象，可省略。' },
          projectPath: { type: 'string', description: '可选：覆盖本次调用的项目路径；默认用当前会话工作目录。' },
        },
        required: ['tool'],
      },
      output: textOutput(),
      timeoutMs: config.toolCallTimeoutMs,
      async execute(args, exec) {
        const rawName = typeof args?.tool === 'string' ? args.tool.trim() : ''
        if (!rawName) throw new IdeaToolError('idea_call 需要 tool 参数。', { code: 'invalid-arguments' })
        const projectPath = typeof args?.projectPath === 'string' && args.projectPath.trim() ? args.projectPath.trim() : undefined
        const { result, routing } = await runtime.callRouted(rawName, args?.arguments ?? {}, exec, {
          rawTool: runtime.findTool(rawName),
          projectPath,
        })
        const text = renderMcpResult(result, config)
        if (result.isError) throw new IdeaToolError(text, { code: 'idea-tool-error' })
        const suffix = routing.warning ? `\n\n⚠️ ${routing.warning}` : ''
        return { text: `${text}${suffix}` }
      },
    },
  ]
}
