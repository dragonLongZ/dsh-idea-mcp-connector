/**
 * DSH Host 插件入口：JetBrains IDE MCP 连接器。
 *
 * 解决的问题（源自真实场景）：
 * - IDEA 的 MCP Server 插件每次启动随机分配端口，且不写任何可发现的锁文件；
 * - 多个 IDEA 项目/窗口共用（或各自拥有）MCP 端点，模型无法知道该连哪个；
 * - 原生 `dsh-mcp-client` 只能静态配置一个 URL，没有「按会话项目路由」。
 *
 * 这个插件的做法：
 * 1. 从各产品 `idea.log` 的 `Responding at http://127.0.0.1:<port>` 发现端点；
 * 2. MCP 握手验证后，把 IDE 工具注册成 `mcp__idea__*`；
 * 3. 每次调用按「当前会话工作目录」选择端点，并在请求头/参数里带上
 *    `IJ_MCP_SERVER_PROJECT_PATH`，让 IDE 把调用路由到对应项目窗口；
 * 4. 常驻 idea_status / idea_refresh / idea_call 三个元工具用于排障和兜底。
 */
import { resolveConfig } from './lib/config.js'
import { createRuntime } from './lib/runtime.js'

/** 插件名（Loader 行里显示）。 */
export const name = 'dsh-idea-mcp-connector'

/** 依赖的 Host 服务；缺一个插件就不激活，避免半残状态。 */
export const inject = ['tools', 'sessions', 'workingDirectory', 'systemPrompt']

/**
 * @param {any} ctx cordis Host 上下文
 * @param {Record<string, unknown> | undefined} rawConfig bundle 行 config
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  for (const warning of config.warnings) console.warn(`[dsh-idea-mcp-connector] ${warning}`)
  const runtime = createRuntime(ctx, config)

  // 元工具常驻：IDE 没开时也能用它们排障、等 IDE 打开后重新扫描。
  for (const definition of runtime.metaTools()) {
    ctx.effect(() => ctx.tools.register(definition))
  }

  // 周期性重扫：IDE 重启/换端口后自动恢复，不需要重启 DSH。
  ctx.effect(() => {
    const timer = config.refreshIntervalMs > 0
      ? setInterval(() => {
        runtime.sync({ force: false }).catch((error) => {
          if (config.debug) console.warn('[dsh-idea-mcp-connector] 周期同步失败:', error)
        })
      }, config.refreshIntervalMs)
      : undefined
    timer?.unref?.()
    return () => {
      if (timer) clearInterval(timer)
      runtime.dispose()
    }
  })

  // 系统提示：只在确实注册到工具时出现，避免模型去找不存在的工具。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'idea-mcp-connector',
    order: 59,
    text: () => {
      const summary = runtime.promptSummary()
      if (summary.toolCount === 0) return ''
      const products = summary.products.length > 0 ? summary.products.join('、') : 'JetBrains IDE'
      return [
        `[JetBrains IDE MCP] 已连接 ${summary.endpointCount} 个 IDE 端点（${products}），IDE 工具以 mcp__${config.serverName}__* 提供。`,
        '调用时连接器会按当前会话的工作目录自动选择项目窗口，不需要也不应该手动传 projectPath。',
        '如果工具调用报项目找不到，让用户在对应 IDE 窗口打开当前项目后重试；可用 idea_status 查看端点状态，idea_refresh 重新扫描。',
      ].join('')
    },
  }))

  // 首次发现异步进行：IDE 没开时插件照常加载，元工具仍可调用。
  runtime.start().catch((error) => {
    if (config.debug) console.warn('[dsh-idea-mcp-connector] 启动同步失败:', error)
  })
}

/** 供测试与二次开发使用的内部构造器。 */
export const internals = { createRuntime, resolveConfig }
