import assert from 'node:assert/strict'
import test from 'node:test'
import { McpHttpClient, isProjectNotFoundError, parseSseMessages } from '../lib/mcp-http.js'
import { startFakeMcp } from './fake-mcp.mjs'

test('parseSseMessages：解析 data 事件并忽略 keep-alive', () => {
  const messages = parseSseMessages([
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    '',
    ': keep-alive',
    '',
    'data: [DONE]',
    '',
  ].join('\n'))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, 1)
})

test('SSE 传输：握手、列工具、调工具并携带项目头', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/demo'], transport: 'sse' })
  try {
    const client = new McpHttpClient({ url: fake.url, timeoutMs: 5000 })
    const info = await client.connect()
    assert.equal(info.serverInfo.name, 'IntelliJ IDEA MCP Server')
    assert.equal(info.protocolVersion, '2025-06-18')

    const tools = await client.listTools()
    assert.deepEqual(tools.map((tool) => tool.name), ['get_project_modules', 'list_directory_tree', 'get_file_problems'])

    const result = await client.callTool('get_project_modules', {}, {
      headers: { IJ_MCP_SERVER_PROJECT_PATH: 'D:/ideaProject/demo' },
    })
    assert.equal(result.content[0].text, 'get_project_modules ok for D:/ideaProject/demo')
    assert.equal(fake.calls[0].headers['ij_mcp_server_project_path'], 'D:/ideaProject/demo')
    await client.close()
  } finally {
    await fake.close()
  }
})

test('JSON 传输：同一客户端实现可用', async () => {
  const fake = await startFakeMcp({ transport: 'json' })
  try {
    const client = new McpHttpClient({ url: fake.url, timeoutMs: 5000 })
    await client.connect()
    const tools = await client.listTools()
    assert.equal(tools.length, 3)
    await client.close()
  } finally {
    await fake.close()
  }
})

test('tools/list 分页', async () => {
  const fake = await startFakeMcp({ pageSize: 1 })
  try {
    const client = new McpHttpClient({ url: fake.url, timeoutMs: 5000 })
    const tools = await client.listTools()
    assert.equal(tools.length, 3)
    await client.close()
  } finally {
    await fake.close()
  }
})

test('协议版本回退：服务端拒绝首个版本时自动降级', async () => {
  const fake = await startFakeMcp({ protocolVersion: '2025-03-26', rejectFirstVersion: true })
  try {
    const client = new McpHttpClient({ url: fake.url, timeoutMs: 5000 })
    const info = await client.connect()
    assert.equal(info.protocolVersion, '2025-03-26')
    await client.close()
  } finally {
    await fake.close()
  }
})

test('项目不存在时（严格参数）返回结构化错误并可分类', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/demo'] })
  try {
    const client = new McpHttpClient({ url: fake.url, timeoutMs: 5000 })
    await expectReject(
      () => client.callTool('get_project_modules', { projectPath: 'D:/other' }, {
        headers: { IJ_MCP_SERVER_PROJECT_PATH: 'D:/other' },
      }),
      (error) => {
        assert.match(error.message, /doesn't correspond to any open project/)
        assert.equal(isProjectNotFoundError(error), true)
      },
    )
    await client.close()
  } finally {
    await fake.close()
  }
})

test('会话过期（404）后自动重连一次', async () => {
  const fake = await startFakeMcp()
  try {
    const client = new McpHttpClient({ url: fake.url, timeoutMs: 5000 })
    await client.connect()
    fake.invalidateSessions()
    const result = await client.callTool('get_project_modules', {}, {
      headers: { IJ_MCP_SERVER_PROJECT_PATH: 'D:/ideaProject/demo' },
    })
    assert.match(result.content[0].text, /ok for/)
    await client.close()
  } finally {
    await fake.close()
  }
})

test('超时归类为 timeout（不是 transport，避免被重试）', async () => {
  const fake = await startFakeMcp({ callDelayMs: 300 })
  try {
    const client = new McpHttpClient({ url: fake.url, timeoutMs: 5000 })
    await client.connect()
    await expectReject(
      () => client.callTool('get_project_modules', {}, {
        timeoutMs: 80,
        headers: { IJ_MCP_SERVER_PROJECT_PATH: 'D:/ideaProject/demo' },
      }),
      (error) => {
        assert.equal(error.kind, 'timeout')
      },
    )
    await client.close()
  } finally {
    await fake.close()
  }
})

test('isError 结果被当作失败抛出（对齐真实 IDE）', async () => {
  const fake = await startFakeMcp({ projects: ['D:/ideaProject/demo'] })
  try {
    const client = new McpHttpClient({ url: fake.url, timeoutMs: 5000 })
    await client.connect()
    await expectReject(
      () => client.callTool('get_project_modules', { projectPath: 'D:/other' }, {
        headers: { IJ_MCP_SERVER_PROJECT_PATH: 'D:/other' },
      }),
      (error) => {
        assert.equal(error.kind, 'tool')
        assert.equal(isProjectNotFoundError(error), true)
      },
    )
    await client.close()
  } finally {
    await fake.close()
  }
})

test('响应 id 不匹配时报协议错误（不把通知当结果）', async () => {
  const fake = await startFakeMcp({ respondWithWrongId: true })
  try {
    const client = new McpHttpClient({ url: fake.url, timeoutMs: 5000 })
    await client.connect()
    await expectReject(() => client.listTools(), (error) => {
      assert.equal(error.kind, 'protocol')
      assert.match(error.message, /id=/)
    })
    await client.close()
  } finally {
    await fake.close()
  }
})

test('连接已关闭的端口时报 transport 错误', async () => {
  const fake = await startFakeMcp()
  const url = fake.url
  await fake.close()
  const client = new McpHttpClient({ url, timeoutMs: 300 })
  await expectReject(() => client.connect(), (error) => {
    assert.equal(error.kind, 'transport')
    assert.equal(error.retryable, true)
  })
})

/**
 * @param {() => Promise<unknown>} fn
 * @param {(error: any) => void} check
 */
async function expectReject(fn, check) {
  try {
    await fn()
  } catch (error) {
    check(error)
    return
  }
  throw new Error('预期失败但成功了')
}
