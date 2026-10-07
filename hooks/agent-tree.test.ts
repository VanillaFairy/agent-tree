import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo } from 'claude-code'

import { merge } from './register'

const PANE = {
  component: 'Pane',
  requestId: 'agent-tree',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const PARENT: AgentInfo = { id: 'a1', description: 'Survey the repo', type: 'Explore', status: 'running' }
const CHILD: AgentInfo = { id: 'a2', parentId: 'a1', description: 'Read <the> logs & "notes"', type: 'scout', status: 'running' }

test('a spawned subagent shows nested under its parent, on every surface', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('agent.list', async () => ({ value: [PARENT, CHILD] }))
  on('classic.SubagentStart', async () => ({}))
  await $.classic.SubagentStart({ agent_id: 'a2', agent_type: 'scout' })

  const desk = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
  const svg = await desk.find({ type: 'Svg' })
  const alt = String(svg?.props.alt)
  expect(alt).toContain(`\n  ${PARENT.description} (Explore, running)`)
  expect(alt).toContain(`\n    ${CHILD.description} (scout, running)`)
  const source = String(svg?.props.source)
  expect(source).not.toContain('<the>')
  expect(source).toContain('Read &#60;the&#62; logs')
  await desk.unmount()

  const term = await $.ui.mount({ plugin: 'agent-tree', surface: 'terminal', ...PANE })
  expect(await term.find({ type: 'Text', text: /Survey the repo/ })).toBeDefined()
  await term.unmount()
})

test('collapsing an agent folds its children into a count', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('agent.list', async () => ({ value: [PARENT, CHILD] }))
  on('classic.SubagentStart', async () => ({}))
  await $.classic.SubagentStart({ agent_id: 'a2', agent_type: 'scout' })

  const desk = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
  await desk.select({ key: 'agent', value: 'a1' })
  await desk.press({ key: 'fold' })
  const alt = String((await desk.find({ type: 'Svg' }))?.props.alt)
  expect(alt).toContain(`${PARENT.description} (Explore, running) +1 folded`)
  expect(alt).not.toContain(CHILD.description)
  await desk.unmount()
})

test('a running tool call shows as live activity, and is gone once it returns', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('agent.list', async () => ({ value: [] }))
  let during: unknown
  on('tool.call', async () => {
    const desk = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
    during = await desk.find({ type: 'Text', text: /▸ Read src\/app\.ts/ })
    await desk.unmount()
    return { result: { type: 'text', file: { filePath: 'src/app.ts', content: '', numLines: 0, startLine: 1, totalLines: 0 } } }
  })
  await $.tool.call({ tool: 'Read', file_path: 'src/app.ts' })
  expect(during).toBeDefined()

  const after = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
  expect(await after.find({ type: 'Text', text: /▸ Read/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /Main session · 1 tools/ })).toBeDefined()
  await after.unmount()
})

test('an agent the engine stops listing while running is taken as ended, keeping its counts', () => {
  const seen = merge({}, [PARENT], 1000).a1
  if (!seen) throw new Error('merge dropped a listed agent')
  const after = merge({ a1: { ...seen, toolCount: 7 } }, [], 5000).a1
  expect(after?.status).toBe('completed')
  expect(after?.endedAt).toBe(5000)
  expect(after?.toolCount).toBe(7)

  const relisted = merge(after ? { a1: after } : {}, [{ ...PARENT, status: 'failed' }], 9000).a1
  expect(relisted?.status).toBe('failed')
  expect(relisted?.startedAt).toBe(1000)
})
