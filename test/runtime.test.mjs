import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { IdeaEndpointRegistry } from '../lib/discovery.js'
import { createRuntime } from '../lib/runtime.js'
import { startFakeMcp, DEFAULT_TOOLS } from './fake-mcp.mjs'
import { createFakeCtx, execAs } from './helpers.mjs'

const ALPHA = 'D:\\ideaProject\\alpha'
const BETA = 'D:\\ideaProject\\beta'

/**
 * @param {string[]} endpoints
 * @param {{ cwdBySession?: Record<string, string>, scan?: any, extra?: Record<string, unknown> }} [options]
 */
function build(options = {}) {
  const config = resolveConfig({
    endpoints: options.endpoints,
    refreshIntervalMs: 0,
    portProbe: { enabled: false },
    debug: false,
    ...(options.extra ?? {}),
  })
  const env = createFakeCtx({ cwdBySession: options.cwdBySession ?? {} })
  const runtime = createRuntime(env.ctx, config, { scan: options.scan })
  // 实际插件里元工具由 apply 注册；直接构造运行时测试时手动补上，保持同一套工具面。
  for (const definition of runtime.metaTools()) {
    env.ctx.effect(() => env.ctx.tools.register(definition))
  }
  return { env, runtime, config }
}

test('单端点：工具被注册，projectPath 参数被隐藏，调用带项目头', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const { env, runtime } = build({ endpoints: [fake.url], cwdBySession: { s1: ALPHA } })
  try {
    await runtime.start()
    const tool = env.tools.get('mcp__idea__get_project_modules')
    assert.ok(tool, '应注册代理工具')
    assert.equal(tool.parameters.properties.projectPath, undefined, 'projectPath 不应暴露给模型')

    const value = await execAs(tool, {}, 's1')
    assert.equal(value.text, 'get_project_modules ok for D:/ideaProject/alpha')
    assert.equal(fake.calls.length, 1, '单端点不探测，只发真实调用')
    assert.equal(fake.calls[0].headers['ij_mcp_server_project_path'], ALPHA)
    assert.equal(fake.calls[0].args.projectPath, ALPHA, '严格模式必须带 projectPath 参数')
  } finally {
    runtime.dispose()
    await fake.close()
  }
})

test('多端点：按会话 cwd 探测并路由到各自项目', async () => {
  const alpha = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const beta = await startFakeMcp({ projects: ['D:/ideaProject/beta'] })
  const { env, runtime } = build({
    endpoints: [alpha.url, beta.url],
    cwdBySession: { sAlpha: ALPHA, sBeta: BETA },
  })
  try {
    await runtime.start()
    const tool = env.tools.get('mcp__idea__get_project_modules')
    const valueAlpha = await execAs(tool, {}, 'sAlpha')
    const valueBeta = await execAs(tool, {}, 'sBeta')
    assert.match(valueAlpha.text, /ok for D:\/ideaProject\/alpha/)
    assert.match(valueBeta.text, /ok for D:\/ideaProject\/beta/)

    const lastAlpha = alpha.calls.filter((call) => call.headers['ij_mcp_server_project_path'] === ALPHA).at(-1)
    const lastBeta = beta.calls.filter((call) => call.headers['ij_mcp_server_project_path'] === BETA).at(-1)
    assert.ok(lastAlpha, 'alpha 端点应收到 alpha 项目调用')
    assert.ok(lastBeta, 'beta 端点应收到 beta 项目调用')
    assert.ok(alpha.calls.some((call) => call.args.projectPath === BETA), '探测必须走严格参数（请求头只是软提示）')
  } finally {
    runtime.dispose()
    await alpha.close()
    await beta.close()
  }
})

test('多端点：没有 IDE 打开该项目时给出可执行错误', async () => {
  const alpha = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const beta = await startFakeMcp({ projects: ['D:/ideaProject/beta'] })
  const { env, runtime } = build({
    endpoints: [alpha.url, beta.url],
    cwdBySession: { gamma: 'D:\\ideaProject\\gamma' },
  })
  try {
    await runtime.start()
    const tool = env.tools.get('mcp__idea__get_project_modules')
    await assert.rejects(() => execAs(tool, {}, 'gamma'), (error) => {
      assert.match(error.message, /没有 IDE 打开当前会话的项目/)
      assert.match(error.message, /gamma/)
      return true
    })
  } finally {
    runtime.dispose()
    await alpha.close()
    await beta.close()
  }
})

test('config.projects：手工映射优先生效且不再探测', async () => {
  const alpha = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const beta = await startFakeMcp({ projects: ['D:/ideaProject/beta'] })
  const { env, runtime } = build({
    endpoints: [alpha.url, beta.url],
    cwdBySession: { s1: ALPHA },
    extra: { projects: [{ path: 'D:/ideaProject/alpha', url: alpha.url }] },
  })
  try {
    await runtime.start()
    const tool = env.tools.get('mcp__idea__get_project_modules')
    await execAs(tool, {}, 's1')
    assert.equal(beta.calls.length, 0, '映射命中时不应探测另一个端点')
    assert.equal(alpha.calls.at(-1).headers['ij_mcp_server_project_path'], ALPHA)
  } finally {
    runtime.dispose()
    await alpha.close()
    await beta.close()
  }
})

test('includeTools 过滤与 idea_call 兜底', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const { env, runtime } = build({
    endpoints: [fake.url],
    cwdBySession: { s1: ALPHA },
    extra: { includeTools: ['get_project_*'] },
  })
  try {
    await runtime.start()
    assert.deepEqual([...env.tools.keys()].sort(), [
      'idea_call',
      'idea_refresh',
      'idea_status',
      'mcp__idea__get_project_modules',
    ])
    const call = env.tools.get('idea_call')
    const value = await execAs(call, { tool: 'get_file_problems', arguments: { path: 'pom.xml' } }, 's1')
    assert.match(value.text, /get_file_problems ok for D:\/ideaProject\/alpha/)
  } finally {
    runtime.dispose()
    await fake.close()
  }
})

test('日志发现：scan 给出的候选会被补上 /stream 并握手', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const origin = fake.url.replace('/stream', '')
  const { env, runtime } = build({
    endpoints: [],
    cwdBySession: { s1: ALPHA },
    scan: () => [{ url: origin, port: fake.port, product: 'IntelliJ IDEA 2026.2', logFile: 'idea.log', at: 1, source: 'log' }],
  })
  try {
    await runtime.start()
    const status = await runtime.status({ exec: { agent: { id: 's1' } } })
    assert.equal(status.endpoints.length, 1)
    assert.equal(status.endpoints[0].url, fake.url)
    assert.equal(status.endpoints[0].product, 'IntelliJ IDEA 2026.2')
    const tool = env.tools.get('mcp__idea__get_project_modules')
    assert.ok(tool)
  } finally {
    runtime.dispose()
    await fake.close()
  }
})

test('没有 IDE 时：元工具可用，状态里有排查指引', async () => {
  const { env, runtime } = build({ endpoints: [], scan: () => [] })
  try {
    await runtime.start()
    assert.deepEqual([...env.tools.keys()].sort(), ['idea_call', 'idea_refresh', 'idea_status'])
    const statusTool = env.tools.get('idea_status')
    const value = await execAs(statusTool, {}, 's1')
    assert.match(value.text, /未发现可用的 IDE MCP 端点/)
    assert.match(value.text, /idea_refresh/)
  } finally {
    runtime.dispose()
  }
})

test('超时不会被重试：非幂等工具只执行一次', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/alpha'], callDelayMs: 2500 })
  const { env, runtime } = build({
    endpoints: [fake.url],
    cwdBySession: { s1: ALPHA },
    extra: { toolCallTimeoutMs: 1000 },
  })
  try {
    await runtime.start()
    const tool = env.tools.get('mcp__idea__get_project_modules')
    await assert.rejects(() => execAs(tool, {}, 's1'), (error) => {
      assert.equal(error.code, 'idea-call-timeout')
      assert.match(error.message, /不会自动重试/)
      return true
    })
    assert.equal(fake.calls.length, 1, '超时后不得重发 tools/call')
    assert.equal(fake.initializeCount, 1, '超时后不得重新握手')
  } finally {
    runtime.dispose()
    await fake.close()
  }
})

test('tools/list 瞬时失败时沿用上一份工具列表', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const { env, runtime } = build({ endpoints: [fake.url], cwdBySession: { s1: ALPHA } })
  try {
    await runtime.start()
    assert.ok(env.tools.has('mcp__idea__get_project_modules'))
    fake.failToolsListNext(1)
    await runtime.sync({ force: true })
    assert.ok(env.tools.has('mcp__idea__get_project_modules'), '一次 tools/list 失败不应卸载工具')
    const status = await runtime.status({ exec: { agent: { id: 's1' } } })
    assert.ok(status.warnings.some((warning) => warning.includes('沿用上次的工具列表')))
  } finally {
    runtime.dispose()
    await fake.close()
  }
})

test('非 force 同步也会发现 IDE 新增的工具（工具 TTL 生效）', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const { env, runtime } = build({
    endpoints: [fake.url],
    cwdBySession: { s1: ALPHA },
    extra: { toolListTtlMs: 0 },
  })
  try {
    await runtime.start()
    assert.equal(env.tools.has('mcp__idea__new_tool'), false)
    fake.addTool({
      name: 'new_tool',
      description: 'added later',
      inputSchema: { type: 'object', properties: { projectPath: { type: 'string' } } },
    })
    await runtime.sync({ force: false })
    assert.ok(env.tools.has('mcp__idea__new_tool'), '周期同步应发现新增工具')
  } finally {
    runtime.dispose()
    await fake.close()
  }
})

test('工具名冲突不会导致每轮全量重注册', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const { env, runtime } = build({ endpoints: [fake.url], cwdBySession: { s1: ALPHA } })
  try {
    // 模拟另一个插件占用了 get_project_modules 的公开名
    env.ctx.tools.register({
      name: 'mcp__idea__get_project_modules',
      description: 'foreign',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: () => [] },
      execute: async () => ({ text: '' }),
    })
    const first = await runtime.start()
    assert.equal(first.registered, 2, '除了冲突工具以外的工具应正常注册')
    const status1 = await runtime.status({ exec: { agent: { id: 's1' } } })
    assert.equal(status1.conflicts.length, 1)
    const second = await runtime.sync({ force: false })
    assert.equal(second.changed, false, '冲突稳定时不应反复重注册')
    assert.ok(env.tools.has('mcp__idea__get_project_modules'))
    assert.equal(env.tools.get('mcp__idea__get_project_modules').description, 'foreign')
  } finally {
    runtime.dispose()
    await fake.close()
  }
})

test('includeFilters：excludeTools 与 injectProjectPath:false', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const { env, runtime } = build({
    endpoints: [fake.url],
    cwdBySession: { s1: ALPHA },
    extra: { excludeTools: ['get_project_modules'], injectProjectPath: false },
  })
  try {
    await runtime.start()
    assert.equal(env.tools.has('mcp__idea__get_project_modules'), false)
    assert.ok(env.tools.has('mcp__idea__list_directory_tree'))
    const tool = env.tools.get('mcp__idea__list_directory_tree')
    const value = await execAs(tool, { directoryPath: '.' }, 's1')
    assert.match(value.text, /ok for D:\/ideaProject\/alpha/)
    assert.equal(fake.calls[0].args.projectPath, undefined, '关闭注入后不应带 projectPath 参数')
    assert.equal(fake.calls[0].headers['ij_mcp_server_project_path'], ALPHA)
  } finally {
    runtime.dispose()
    await fake.close()
  }
})

test('pinnedProjectPath：端点固定项目优先于会话 cwd', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const config = resolveConfig({
    endpoints: [{ url: fake.url, projectPath: 'D:\\ideaProject\\alpha' }],
    refreshIntervalMs: 0,
    portProbe: { enabled: false },
  })
  const env = createFakeCtx({ cwdBySession: { s1: BETA } })
  const runtime = createRuntime(env.ctx, config)
  for (const definition of runtime.metaTools()) env.ctx.effect(() => env.ctx.tools.register(definition))
  try {
    await runtime.start()
    const tool = env.tools.get('mcp__idea__get_project_modules')
    const value = await execAs(tool, {}, 's1')
    assert.match(value.text, /ok for D:\/ideaProject\/alpha/)
    assert.equal(fake.calls[0].args.projectPath, 'D:\\ideaProject\\alpha')
  } finally {
    runtime.dispose()
    await fake.close()
  }
})

test('没有会话工作目录时给出明确错误', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const { env, runtime } = build({ endpoints: [fake.url], cwdBySession: {} })
  try {
    await runtime.start()
    const tool = env.tools.get('mcp__idea__get_project_modules')
    await assert.rejects(() => execAs(tool, {}, 'unknown-session'), (error) => {
      assert.equal(error.code, 'idea-no-session-cwd')
      return true
    })
  } finally {
    runtime.dispose()
    await fake.close()
  }
})

test('用户取消时传播原始 abort，而不是包装成普通失败', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/alpha'], callDelayMs: 2000 })
  const { env, runtime } = build({
    endpoints: [fake.url],
    cwdBySession: { s1: ALPHA },
    extra: { toolCallTimeoutMs: 10000 },
  })
  try {
    await runtime.start()
    const controller = new AbortController()
    const reason = new Error('user-abort')
    const pending = env.tools.get('mcp__idea__get_project_modules').execute({}, {
      agent: { id: 's1' },
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(reason), 100)
    await assert.rejects(() => pending, (error) => error === reason || /user-abort|abort/i.test(String(error?.message)))
    assert.equal(fake.calls.length, 1, '取消后不得重发')
  } finally {
    runtime.dispose()
    await fake.close()
  }
})

test('工具只存在于一个端点时，不会把调用发到不支持的端点', async () => {
  const onlyTool = {
    name: 'only_on_alpha',
    description: 'alpha only',
    inputSchema: { type: 'object', properties: { projectPath: { type: 'string' } } },
  }
  const alpha = await startFakeMcp({ projects: ['D:/ideaProject/alpha'], tools: [onlyTool] })
  const beta = await startFakeMcp({ projects: ['D:/ideaProject/beta'], tools: DEFAULT_TOOLS })
  const { env, runtime } = build({
    endpoints: [alpha.url, beta.url],
    cwdBySession: { alphaS: ALPHA, betaS: BETA },
  })
  try {
    await runtime.start()
    const tool = env.tools.get('mcp__idea__only_on_alpha')
    assert.ok(tool)
    const value = await execAs(tool, {}, 'alphaS')
    assert.match(value.text, /ok for D:\/ideaProject\/alpha/)

    const callsBefore = beta.calls.length
    await assert.rejects(() => execAs(tool, {}, 'betaS'), (error) => {
      assert.match(error.message, /IDE 没有打开会话项目/)
      return true
    })
    assert.equal(beta.calls.length, callsBefore, 'beta 端点不应收到该工具调用')
  } finally {
    runtime.dispose()
    await alpha.close()
    await beta.close()
  }
})

test('端点在 DISCOVERY 后被 markDisconnected，可重新发现', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const config = resolveConfig({ endpoints: [fake.url], refreshIntervalMs: 0, portProbe: { enabled: false } })
  const registry = new IdeaEndpointRegistry({ config })
  try {
    await registry.refresh()
    assert.equal(registry.endpoints().length, 1)
    registry.markDisconnected(fake.url)
    assert.equal(registry.endpoints().length, 0)
    await registry.refresh()
    assert.equal(registry.endpoints().length, 1)
  } finally {
    await registry.close()
    await fake.close()
  }
})
