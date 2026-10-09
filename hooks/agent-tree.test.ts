import { expect, mock, test } from 'claude-code/testing'
import type { Plugin, TestBody } from 'claude-code/testing'
import type { AgentInfo } from 'claude-code'

import type { ViewState } from '../types'
import { SLIDE_MS, canPan, elapsed, layout, panBy, twoLines, viewport } from './graph'
import { CELL_H, TOOLBAR_ROWS, merge } from './register'

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

test('the tree runs left to right: children one column right of their parent, siblings stacked', () => {
  const lay = layout(merge({}, [PARENT, CHILD, { ...CHILD, id: 'a3' }], 0))
  const at = (id: string) => lay.placed.find(p => p.id === id)
  const [parent, first, second] = [at('a1'), at('a2'), at('a3')]
  if (!parent || !first || !second) throw new Error('layout dropped a node')
  expect(first.x > parent.x).toBe(true)
  expect(second.x).toBe(first.x)
  expect(second.y > first.y).toBe(true)
  expect(parent.y).toBe((first.y + second.y) / 2)
})

const MANY: AgentInfo[] = Array.from({ length: 30 }, (_, i) => ({ ...CHILD, id: `k${i}`, parentId: 'a1' }))

type Drawn = { x: number; y: number; w: number; h: number; height: number }
type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

function drawnOf(source: string): Drawn {
  const [x = NaN, y = NaN, w = NaN, h = NaN] = (source.match(/viewBox="([^"]+)"/)?.[1] ?? '').split(' ').map(Number)
  return { x, y, w, h, height: Number(source.match(/ height="([\d.]+)"/)?.[1]) }
}

async function drawnAfter($: Engine, ...keys: string[]): Promise<Drawn> {
  const ui = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
  for (const key of keys) await ui.press({ key })
  await ui.unmount()
  const again = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
  const source = String((await again.find({ type: 'Svg' }))?.props.source)
  await again.unmount()
  return drawnOf(source)
}

async function startMany($: Engine, on: On) {
  mock.clock(on, { now: 1000 })
  on('agent.list', async () => ({ value: [PARENT, ...MANY] }))
  on('classic.SubagentStart', async () => ({}))
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
}

const MANY_LAYOUT = layout(merge({}, [PARENT, ...MANY], 0))

test('the drawing fits under the toolbar, so the pane never scrolls, and + and − change its scale', async ($, on) => {
  await startMany($, on)
  const room = (PANE.props.scroll.bodyRows - TOOLBAR_ROWS) * CELL_H
  const start = await drawnAfter($)
  expect(start.height <= room).toBe(true)

  const zoomedIn = await drawnAfter($, 'zoom-in')
  expect(zoomedIn.height).toBe(start.height)
  expect(zoomedIn.w < start.w && zoomedIn.h < start.h).toBe(true)

  const zoomedOut = await drawnAfter($, 'zoom-out', 'zoom-out')
  expect(zoomedOut.w > start.w && zoomedOut.h > start.h).toBe(true)
})

test('Fit shows the whole tree', async ($, on) => {
  await startMany($, on)
  const fitted = await drawnAfter($, 'fit')
  expect(fitted.w >= MANY_LAYOUT.width - 0.2 && fitted.h >= MANY_LAYOUT.height - 0.2).toBe(true)
})

test('the arrows show only along an axis the tree overflows, and pan it within its edges', async ($, on) => {
  await startMany($, on)
  const ui = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
  expect(await ui.find({ key: 'pan-right' })).toBeUndefined()
  expect(await ui.find({ key: 'pan-down' })).toBeDefined()
  await ui.unmount()

  const down = await drawnAfter($, 'pan-down')
  expect(down.y > 0).toBe(true)
  const bottom = await drawnAfter($, ...Array.from({ length: 20 }, () => 'pan-down'))
  expect(Math.abs(bottom.y + bottom.h - MANY_LAYOUT.height) < 0.2).toBe(true)
  const top = await drawnAfter($, ...Array.from({ length: 20 }, () => 'pan-up'))
  expect(top.y).toBe(0)

  const zoomed = await drawnAfter($, 'zoom-in', 'zoom-in', 'zoom-in')
  const right = await drawnAfter($, 'pan-right')
  expect(right.x > zoomed.x).toBe(true)
  const farRight = await drawnAfter($, ...Array.from({ length: 12 }, () => 'pan-right'))
  expect(Math.abs(farRight.x + farRight.w - MANY_LAYOUT.width) < 0.2).toBe(true)
  const back = await drawnAfter($, ...Array.from({ length: 12 }, () => 'pan-left'))
  expect(back.x).toBe(0)
})

test('every arrow step moves the same distance, the last landing on the edge', () => {
  const lay = MANY_LAYOUT
  const frame = { width: 736, height: 500 }
  for (const axis of ['x', 'y'] as const) {
    for (const zoom of [1.1, 1.5625, 2, 3.7]) {
      for (const direction of [1, -1]) {
        const far = direction > 0 ? 0 : 1e9
        let view: ViewState = { zoom, left: far, top: far }
        const at = () => {
          const win = viewport(lay, view, frame)
          return axis === 'x' ? { pos: win.x, room: win.w, length: lay.width } : { pos: win.y, room: win.h, length: lay.height }
        }
        const positions = [at().pos]
        for (let i = 0; i < 50 && canPan(lay, view, frame, axis, direction); i++) {
          view = panBy(lay, view, frame, axis, direction, 0.5)
          positions.push(at().pos)
        }
        const steps = positions.slice(1).map((p, i) => Math.abs(p - (positions[i] ?? p)))
        expect(steps.length > 0).toBe(true)
        for (const step of steps) expect(Math.abs(step - (steps[0] ?? 0)) < 1e-6).toBe(true)
        const end = at()
        expect(direction > 0 ? Math.abs(end.pos + end.room - end.length) < 1e-6 : end.pos === 0).toBe(true)
      }
    }
  }
})

test('an arrow slides the drawing from the old view to the new one, then settles still', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  on('agent.list', async () => ({ value: [PARENT, ...MANY] }))
  on('classic.SubagentStart', async () => ({}))
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
  const before = await drawnAfter($)

  const ui = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
  await ui.press({ key: 'pan-down' })
  const sliding = String((await ui.find({ type: 'Svg' }))?.props.source)
  const [, from = '', to = ''] = sliding.match(/<animate attributeName="viewBox" from="([^"]+)" to="([^"]+)"/) ?? []
  expect(Number(from.split(' ')[1])).toBe(before.y)
  expect(Number(to.split(' ')[1]) > before.y).toBe(true)
  expect(sliding).toContain(`viewBox="${to}"`)

  await clock.advance(SLIDE_MS)
  const settled = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(settled).not.toContain('<animate')
  expect(settled).toContain(`viewBox="${to}"`)
  await ui.unmount()
})

test('dragging the drawing with any button moves the view by as much as the pointer moved, and back again', async ($, on) => {
  await startMany($, on)
  const before = await drawnAfter($, 'zoom-in', 'zoom-in', 'zoom-in')
  const perColumn = before.w / PANE.props.bodyColumns
  const perRow = (before.h * CELL_H) / before.height

  for (const button of ['left', 'middle', 'right'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
    const current = async () => drawnOf(String((await ui.find({ type: 'Svg' }))?.props.source))
    await ui.pointer({ type: 'down', button, x: 30, y: 10, in: 'drag' })
    await ui.pointer({ type: 'move', button, x: 20, y: 6, in: 'drag' })
    const dragged = await current()
    await ui.pointer({ type: 'move', button, x: 30, y: 10, in: 'drag' })
    const back = await current()
    await ui.pointer({ type: 'up', button, x: 30, y: 10, in: 'drag' })
    await ui.unmount()

    expect(Math.abs(dragged.x - before.x - 10 * perColumn) < 0.2).toBe(true)
    expect(Math.abs(dragged.y - before.y - 4 * perRow) < 0.2).toBe(true)
    expect(Math.abs(back.x - before.x) < 0.2 && Math.abs(back.y - before.y) < 0.2).toBe(true)
  }
})

test('hiding done agents keeps a done agent with work still running under it', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const doneParent = { ...PARENT, status: 'completed' }
  const doneLeaf: AgentInfo = { id: 'a3', description: 'Finished leaf', type: 'scout', status: 'completed' }
  on('agent.list', async () => ({ value: [doneParent, CHILD, doneLeaf] }))
  on('classic.SubagentStart', async () => ({}))
  await $.classic.SubagentStart({ agent_id: 'a2', agent_type: 'scout' })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-tree', surface, ...PANE })
    await ui.press({ key: 'done' })
    await ui.unmount()

    const hidden = await $.ui.mount({ plugin: 'agent-tree', surface, ...PANE })
    const shown = surface === 'desktop'
      ? String((await hidden.find({ type: 'Svg' }))?.props.alt)
      : (await hidden.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    expect(shown).toContain(PARENT.description)
    expect(shown).toContain('Read <the> logs')
    expect(shown).not.toContain('Finished leaf')
    await hidden.press({ key: 'done' })
    await hidden.unmount()
  }
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

test('a running agent’s run time shows whole however long its title, and turns over within a quarter second', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let listed: AgentInfo[] = []
  on('agent.list', async () => ({ value: listed }))
  on('classic.SubagentStart', async () => ({}))
  on('command.register', async () => ({ value: undefined }))
  on('session.cwd', async () => ({ value: '/work/app' }))
  on('config.list', async () => ({ value: [] }))
  on('ui.open', async () => ({ value: undefined }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  // Off the tick's beat, so a slower tick would show the new second late.
  await clock.advance(100)
  const start = clock.now()
  listed = [{ ...PARENT, description: 'A very long description of the work '.repeat(3) }]
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })

  const card = async () => {
    const ui = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
    const source = String((await ui.find({ type: 'Svg' }))?.props.source)
    await ui.unmount()
    return { time: source.match(/class="time"[^>]*>([^<]*)</)?.[1], title: source.match(/class="title"[^>]*>([^<]*)</)?.[1] ?? '' }
  }
  for (const at of [999, 1250, 75_250]) {
    await clock.set(start + at)
    const { time, title } = await card()
    // At most a quarter second behind the true run time.
    expect(time).toBe(elapsed(at - 250))
    expect(title.endsWith('…')).toBe(true)
  }
})

// Stands in for the person's close mark, which a test cannot press.
const CLOSER: Plugin = {
  name: 'closer',
  register(on) {
    on('command.run', { command: 'close-agent-tree' }, async $ => {
      await $.ui.close({ id: 'agent-tree' })
      return { text: '' }
    })
  },
}

test('a pane the person closed stays closed and stops working until /agent-tree', { plugins: [CLOSER] }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let opens = 0
  let lists = 0
  on('agent.list', async () => {
    lists++
    return { value: [PARENT] }
  })
  on('classic.SubagentStart', async () => ({}))
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('session.cwd', async () => ({ value: '/work/app' }))
  on('config.list', async () => ({ value: [] }))
  on('ui.open', async () => {
    opens++
    return { value: { isPlaced: true } }
  })
  on('ui.close', async () => ({ value: undefined }))
  on('command.run', async () => ({ text: '' }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
  const openedBefore = opens

  await $.command.run({ command: 'close-agent-tree', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 200 } })
  const listedAtClose = lists
  await $.classic.SubagentStart({ agent_id: 'a2', agent_type: 'scout' })
  await clock.advance(10_000)
  expect(opens).toBe(openedBefore)
  expect(lists).toBe(listedAtClose)

  await $.command.run({ command: 'agent-tree', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 200 } })
  expect(opens).toBe(openedBefore + 1)
  const listedAtOpen = lists
  await clock.advance(10_000)
  expect(lists).toBeGreaterThan(listedAtOpen)
})

test('the run time keeps counting seconds past an hour', () => {
  expect(elapsed(3_725_000)).toBe('1h 02m 05s')
})

test('an agent type too long for one line goes on to a second, the tool count with it', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const type = 'vf-superpowers:reviewer-xhigh'
  on('agent.list', async () => ({ value: [{ ...PARENT, type }] }))
  on('classic.SubagentStart', async () => ({}))
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: type })

  const ui = await $.ui.mount({ plugin: 'agent-tree', surface: 'desktop', ...PANE })
  const source = String((await ui.find({ type: 'Svg' }))?.props.source)
  await ui.unmount()
  const lines = [...source.matchAll(/class="meta"[^>]*>([^<]*)</g)].map(m => m[1])
  expect(lines.length).toBe(2)
  expect(lines.join(' ')).toContain(type)
  expect(lines.join(' ')).toContain('0 tools')
})

test('neither line of a two-line type runs past its room, wherever the break falls', () => {
  const room = 10
  for (const mark of [' ', ':', '-', '_']) {
    for (let at = room - 2; at <= room + 1; at++) {
      const text = `${'a'.repeat(at)}${mark}${'b'.repeat(room)}`
      const lines = twoLines(text, room, 1)
      expect(lines.every(line => line.length <= room)).toBe(true)
    }
  }
  const tabbed = twoLines('agentics:\tscout\n  3 tools', room, 1)
  expect(tabbed.join(' ')).not.toMatch(/[\t\n]/)
})
