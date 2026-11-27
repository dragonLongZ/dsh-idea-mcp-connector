import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  listProductLogs,
  parseRespondingEndpoints,
  prettifyProduct,
  scanJetBrainsLogs,
} from '../lib/log-scan.js'

/** 与真实 idea.log 一致的 ktor 启动行。 */
function respondingLine(port, date = '2026-11-18 09:15:05') {
  return `${date},230 [ 190592]   INFO - io.ktor.server.Application - Responding at http://127.0.0.1:${port}`
}

const LOG_TEXT = [
  '2026-11-17 09:17:38,141 [ 162619]   INFO - io.ktor.server.Application - Responding at http://127.0.0.1:64342',
  '2026-11-18 09:15:05,230 [ 190592]   INFO - io.ktor.server.Application - Responding at http://127.0.0.1:64352',
  '2026-11-18 09:15:06,000 [ 190600]   INFO - io.ktor.server.Application - Responding at http://127.0.0.1:64362',
].join('\n')

test('parseRespondingEndpoints：解析所有 ktor 端口并忽略非回环地址', () => {
  const text = [
    LOG_TEXT,
    '2026-11-18 09:15:07,000 [ 1]   INFO - io.ktor.server.Application - Responding at http://10.0.0.5:9999',
    '2026-11-18 09:15:08,000 [ 1]   INFO - unrelated - Responding at http://127.0.0.1:1234',
  ].join('\n')
  const endpoints = parseRespondingEndpoints(text)
  assert.deepEqual(endpoints.map((endpoint) => endpoint.port), [64342, 64352, 64362])
  assert.equal(endpoints[1].url, 'http://127.0.0.1:64352')
})

test('scanJetBrainsLogs：每个产品取最近一次启动的端口', () => {
  const products = [
    { product: 'IntelliJ IDEA 2026.2', productDir: 'D:/logs/IntelliJIdea2026.2', logFile: 'idea.log' },
    { product: 'PyCharm 2026.2', productDir: 'D:/logs/PyCharm2026.2', logFile: 'pycharm.log' },
  ]
  const scan = scanJetBrainsLogs({
    roots: ['ignored'],
    list: () => products,
    readFile: (file) => (file === 'idea.log' ? LOG_TEXT : 'no mcp server here'),
  })
  assert.equal(scan.length, 1)
  assert.equal(scan[0].port, 64362, '应取日志里最后一条 Responding at')
  assert.equal(scan[0].product, 'IntelliJ IDEA 2026.2')
  assert.equal(scan[0].source, 'log')
})

test('prettifyProduct：产品目录名转展示名', () => {
  assert.equal(prettifyProduct('IntelliJIdea2026.2'), 'IntelliJ IDEA 2026.2')
  assert.equal(prettifyProduct('PyCharm2026.2'), 'PyCharm 2026.2')
  assert.equal(prettifyProduct('GoLand2024.3'), 'GoLand 2024.3')
  assert.equal(prettifyProduct('Custom2026.1'), 'Custom 2026.1')
  assert.equal(prettifyProduct('misc'), 'misc')
})

test('scanJetBrainsLogs：读不到日志时安静降级', () => {
  const scan = scanJetBrainsLogs({
    roots: ['ignored'],
    list: () => [
      { product: 'IntelliJ IDEA 2026.2', productDir: 'x', logFile: 'a.log' },
      { product: 'PyCharm 2026.2', productDir: 'y', logFile: 'b.log' },
    ],
    readFile: (file) => {
      if (file === 'a.log') throw new Error('EACCES')
      return ''
    },
  })
  assert.deepEqual(scan, [])
})

test('轮转日志：MCP 启动行滚出 idea.log 后仍能发现', () => {
  const root = mkdtempSync(join(tmpdir(), 'jb-logs-'))
  const logDir = join(root, 'IntelliJIdea2026.2', 'log')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(join(logDir, 'idea.log'), 'nothing here\n')
  writeFileSync(join(logDir, 'idea.1.log'), `${respondingLine(64352)}\n`)

  const found = scanJetBrainsLogs({ roots: [root] })
  assert.equal(found.length, 1)
  assert.equal(found[0].port, 64352)
  assert.match(found[0].logFile, /idea\.1\.log$/)

  // 当前日志更新后，以更新的启动时间（而不是文件名）为准
  writeFileSync(join(logDir, 'idea.log'), `${respondingLine(64372, '2026-11-19 10:00:00')}\n`)
  const updated = scanJetBrainsLogs({ roots: [root] })
  assert.equal(updated[0].port, 64372)
})

test('listProductLogs：包含轮转文件并按修改时间从新到旧', () => {
  const root = mkdtempSync(join(tmpdir(), 'jb-list-'))
  const logDir = join(root, 'PyCharm2026.2', 'log')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(join(logDir, 'idea.log'), 'current\n')
  writeFileSync(join(logDir, 'idea.1.log'), 'old\n')
  writeFileSync(join(logDir, 'unrelated.txt'), 'x\n')

  const listed = listProductLogs([root])
  assert.equal(listed.length, 2)
  assert.deepEqual(listed.map((item) => item.logFile.split(/[\\/]/).pop()).sort(), ['idea.1.log', 'idea.log'])
})
