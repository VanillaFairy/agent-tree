import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo } from 'claude-code'

import { layout, viewport, zoomAt } from './graph'
import { merge } from './register'

const PANE = {
  component: 'Pane',
  requestId: 'agent-tree',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 80,
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

test('the agent whose transcript is on screen is marked in the tree', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('agent.list', async () => ({ value: [PARENT] }))
  on('classic.SubagentStart', async () => ({}))
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })

  const plain = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
  expect(String((await plain.find({ type: 'Svg' }))?.props.source)).not.toContain('class="focus"')
  await plain.unmount()

  const viewing = await $.ui.mount({
    plugin: 'agent-tree',
    surface: 'desktop',
    ...PANE,
    props: { ...PANE.props, view: { agentId: 'a1' } },
  })
  expect(String((await viewing.find({ type: 'Svg' }))?.props.source)).toContain('class="focus"')
  await viewing.unmount()
})

test('a running tool call shows on its card, and is gone once it returns', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('agent.list', async () => ({ value: [] }))
  let during = ''
  on('tool.call', async () => {
    const desk = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
    during = String((await desk.find({ type: 'Svg' }))?.props.source)
    await desk.unmount()
    return { result: { type: 'text', file: { filePath: 'src/app.ts', content: '', numLines: 0, startLine: 1, totalLines: 0 } } }
  })
  await $.tool.call({ tool: 'Read', file_path: 'src/app.ts' })
  expect(during).toContain('Read src/app.ts')

  const after = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
  expect(String((await after.find({ type: 'Svg' }))?.props.source)).not.toContain('Read src/app.ts')
  await after.unmount()
})

test('zooming keeps the point under the pointer still, and zooming out fits the tree again', () => {
  const lay = layout(merge({}, [PARENT, CHILD, { ...CHILD, id: 'a3', parentId: undefined }], 0))
  const frame = { width: 1000, height: 600 }
  const fit = { zoom: 1 }
  const at = (v: { zoom: number; center?: { x: number; y: number } }, fx: number, fy: number) => {
    const vp = viewport(lay, v, frame)
    return { x: vp.x + fx * vp.w, y: vp.y + fy * vp.h }
  }

  const inward = zoomAt(lay, fit, frame, 0.3, 0.4, 2)
  expect(inward.zoom).toBe(2)
  const before = at(fit, 0.3, 0.4)
  const after = at(inward, 0.3, 0.4)
  expect(Math.abs(after.x - before.x) < 1e-6).toBe(true)
  expect(Math.abs(after.y - before.y) < 1e-6).toBe(true)

  expect(zoomAt(lay, inward, frame, 0.9, 0.9, 0.25)).toEqual(fit)
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
