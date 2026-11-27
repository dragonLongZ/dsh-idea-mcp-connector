import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, name } from '../index.js'
import { DEFAULTS, resolveConfig, withStreamPath } from '../lib/config.js'
import { startFakeMcp } from './fake-mcp.mjs'
import { createFakeCtx, execAs, waitFor } from './helpers.mjs'

test('插件导出的名字与依赖服务', () => {
  assert.equal(name, 'dsh-idea-mcp-connector')
  assert.deepEqual(inject, ['tools', 'sessions', 'workingDirectory', 'systemPrompt'])
})

test('配置默认值与非法值降级', () => {
  const defaults = resolveConfig()
  assert.equal(defaults.serverName, DEFAULTS.serverName)
  assert.equal(defaults.streamPath, '/stream')
  assert.equal(defaults.injectProjectPath, true)

  const bad = resolveConfig({ serverName: '包含中文', refreshIntervalMs: -5, portProbe: { base: 0, step: 'x', count: 999 } })
  assert.equal(bad.serverName, 'idea')
  assert.equal(bad.refreshIntervalMs, 0)
  assert.equal(bad.portProbe.base, 64342)
  assert.equal(bad.portProbe.step, 10)
  assert.equal(bad.portProbe.count, 32)
  assert.ok(bad.warnings.length >= 1)
})

test('withStreamPath：裸端点补 /stream，已有路径保持', () => {
  assert.equal(withStreamPath('http://127.0.0.1:64342', '/stream'), 'http://127.0.0.1:64342/stream')
  assert.equal(withStreamPath('http://127.0.0.1:64342/', '/stream'), 'http://127.0.0.1:64342/stream')
  assert.equal(withStreamPath('http://127.0.0.1:64342/stream', '/stream'), 'http://127.0.0.1:64342/stream')
  assert.equal(withStreamPath('http://127.0.0.1:64342/mcp', '/stream'), 'http://127.0.0.1:64342/mcp')
})

test('apply：注册元工具、初始同步代理工具、系统提示只在有工具时出现', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/alpha'] })
  const env = createFakeCtx({ cwdBySession: { s1: 'D:\\ideaProject\\alpha' } })
  try {
    apply(env.ctx, { endpoints: [fake.url], refreshIntervalMs: 0, portProbe: { enabled: false } })
    // 元工具是同步注册的
    assert.ok(env.tools.has('idea_status'))
    assert.ok(env.tools.has('idea_refresh'))
    assert.ok(env.tools.has('idea_call'))
    assert.equal(env.sections.length, 1)

    await waitFor(() => env.tools.has('mcp__idea__get_project_modules'))
    const promptText = env.sections[0].text({})
    assert.match(promptText, /JetBrains IDE MCP/)
    assert.match(promptText, /mcp__idea__/)

    const value = await execAs(env.tools.get('mcp__idea__get_project_modules'), {}, 's1')
    assert.match(value.text, /ok for D:\/ideaProject\/alpha/)
  } finally {
    await env.dispose()
    await fake.close()
  }
})

test('apply：IDE 未启动时插件仍加载，不注册代理工具', async () => {
  const env = createFakeCtx({})
  try {
    apply(env.ctx, { endpoints: ['http://127.0.0.1:1/stream'], refreshIntervalMs: 0, connectTimeoutMs: 200 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual([...env.tools.keys()].sort(), ['idea_call', 'idea_refresh', 'idea_status'])
    assert.equal(env.sections[0].text({}), '', '没有工具时系统提示应为空')
  } finally {
    await env.dispose()
  }
})
