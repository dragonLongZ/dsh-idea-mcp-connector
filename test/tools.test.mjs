import assert from 'node:assert/strict'
import test from 'node:test'
import { injectProjectPathArgument } from '../lib/router.js'
import { modelFacingParameters, renderMcpResult } from '../lib/tools.js'

const config = { projectPathArg: 'projectPath', injectProjectPath: true }
const tool = {
  name: 'get_project_modules',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'hidden' },
      verbose: { type: 'boolean' },
    },
    required: ['projectPath'],
  },
}

test('modelFacingParameters：隐藏 projectPath 并清理 required', () => {
  const parameters = modelFacingParameters(tool, config)
  assert.deepEqual(Object.keys(parameters.properties), ['verbose'])
  assert.equal(parameters.required, undefined)
})

test('modelFacingParameters：缺省 schema 兜底成对象 schema', () => {
  assert.deepEqual(modelFacingParameters({ name: 'x' }, config), { type: 'object', properties: {} })
})

test('injectProjectPathArgument：schema 声明了才注入', () => {
  assert.deepEqual(injectProjectPathArgument({ verbose: true }, tool, 'D:/p', config), {
    verbose: true,
    projectPath: 'D:/p',
  })
  assert.deepEqual(injectProjectPathArgument({ a: 1 }, { inputSchema: { type: 'object', properties: {} } }, 'D:/p', config), { a: 1 })
  assert.deepEqual(injectProjectPathArgument({ a: 1 }, tool, 'D:/p', { ...config, injectProjectPath: false }), { a: 1 })
})

test('renderMcpResult：文本、图片、结构化内容与截断', () => {
  const text = renderMcpResult({ content: [{ type: 'text', text: 'hello' }] }, { maxChars: 1000 })
  assert.equal(text, 'hello')

  const image = renderMcpResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] }, { maxChars: 1000 })
  assert.match(image, /图片已省略：image\/png/)

  const structured = renderMcpResult({ content: [], structuredContent: { modules: [] } }, { maxChars: 1000 })
  assert.match(structured, /"modules": \[\]/)

  const empty = renderMcpResult({ content: [] }, { maxChars: 1000 })
  assert.match(empty, /没有返回内容/)
})
