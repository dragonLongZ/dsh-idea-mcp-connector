import assert from 'node:assert/strict'
import test from 'node:test'
import {
  baseName,
  isPathInside,
  matchesWildcard,
  normalizePath,
  normalizeUrl,
  publicToolName,
  stableStringify,
  truncateText,
} from '../lib/util.js'

test('publicToolName：干净名字原样使用', () => {
  assert.equal(publicToolName('idea', 'get_project_modules'), 'mcp__idea__get_project_modules')
})

test('publicToolName：需要替换/截断时追加哈希且不超长', () => {
  const long = 'a'.repeat(100)
  const name = publicToolName('idea', long)
  assert.ok(name.length <= 64, name)
  assert.match(name, /^[A-Za-z0-9_-]+$/)
  assert.notEqual(name, publicToolName('idea', `${long}b`))
})

test('normalizePath：统一分隔符、Windows 全小写、保留 UNC', () => {
  assert.equal(normalizePath('D:\\ideaProject\\demo\\'), 'd:/ideaproject/demo')
  assert.equal(normalizePath('d:/ideaProject/demo/'), 'd:/ideaproject/demo')
  assert.equal(normalizePath('/home/user/demo/'), '/home/user/demo')
  assert.equal(normalizePath('\\\\srv\\share\\p'), '//srv/share/p')
  assert.equal(normalizePath('//srv/share/p/'), '//srv/share/p')
})

test('isPathInside：Windows 大小写不敏感、UNC 前缀', () => {
  assert.equal(isPathInside('D:/P/A', 'd:/p/a/src'), true)
  assert.equal(isPathInside('D:/P/A', 'd:/p/a'), true)
  assert.equal(isPathInside('//srv/share/p', '\\\\SRV\\Share\\p\\src'), true)
  assert.equal(isPathInside('//srv/share/p', '//srv/share/other'), false)
})

test('isPathInside：前缀匹配不误伤同名前缀', () => {
  assert.equal(isPathInside('D:/ideaProject/demo', 'D:\\ideaProject\\demo\\src'), true)
  assert.equal(isPathInside('D:/ideaProject/demo', 'D:/ideaProject/demo'), true)
  assert.equal(isPathInside('D:/ideaProject/demo', 'D:/ideaProject/demo-two'), false)
  assert.equal(isPathInside('', 'D:/x'), false)
})

test('normalizeUrl 与 baseName', () => {
  assert.equal(normalizeUrl('http://127.0.0.1:64342/'), 'http://127.0.0.1:64342')
  assert.equal(normalizeUrl('http://127.0.0.1:64342/stream/'), 'http://127.0.0.1:64342/stream')
  assert.equal(baseName('D:\\ideaProject\\demo'), 'demo')
  assert.equal(baseName('D:/ideaProject/demo/'), 'demo')
})

test('matchesWildcard：* 与 ? 通配、大小写不敏感', () => {
  assert.equal(matchesWildcard('get_project_*', 'get_project_modules'), true)
  assert.equal(matchesWildcard('GET_PROJECT_*', 'get_project_modules'), true)
  assert.equal(matchesWildcard('get_project_modules', 'get_project_modules'), true)
  assert.equal(matchesWildcard('get_project?modules', 'get_project_modules'), true)
  assert.equal(matchesWildcard('get_project', 'get_project_modules'), false)
  assert.equal(matchesWildcard('*terminal*', 'execute_terminal_command'), true)
})

test('truncateText 与 stableStringify', () => {
  assert.equal(truncateText('abc', 10), 'abc')
  assert.match(truncateText('abcdef', 3), /省略 3 个字符/)
  assert.equal(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] }), stableStringify({ a: [2, { c: 3, d: 4 }], b: 1 }))
})
