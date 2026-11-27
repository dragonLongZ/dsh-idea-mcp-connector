/**
 * 测试辅助：最小可用的 fake cordis ctx。
 * 只实现插件实际用到的服务形状，避免依赖真实运行时。
 */

/**
 * @param {{ cwdBySession?: Record<string, string> }} [options]
 */
export function createFakeCtx(options = {}) {
  const cwdBySession = options.cwdBySession ?? {}
  /** @type {Map<string, any>} */
  const tools = new Map()
  const sections = []
  const disposers = []

  const ctx = {
    tools: {
      register(definition) {
        if (!definition || typeof definition.name !== 'string') throw new Error('tool definition needs a name')
        if (tools.has(definition.name)) throw new Error(`duplicate tool name: ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    sessions: {
      get(id) {
        const cwd = cwdBySession[id]
        return cwd ? { id, header: { cwd } } : undefined
      },
    },
    workingDirectory: {
      get(session) {
        return cwdBySession[session.id]
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }

  return {
    ctx,
    tools,
    sections,
    /** 执行卸载。 */
    async dispose() {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose()
        } catch {
          // 忽略
        }
      }
    },
  }
}

/**
 * 等待条件成立（轮询 + 超时），用于异步初始同步。
 * @param {() => boolean} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 */
export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3000
  const intervalMs = options.intervalMs ?? 20
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitFor 超时')
}

/**
 * 从一个注册好的工具定义里执行一次调用。
 * @param {any} tool
 * @param {Record<string, unknown>} args
 * @param {string} sessionId
 */
export function execAs(tool, args, sessionId) {
  return tool.execute(args, { agent: { id: sessionId }, signal: new AbortController().signal })
}
