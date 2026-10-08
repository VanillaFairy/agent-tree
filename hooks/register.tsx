import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { AgentNode, AgentStatus, ToolEvent, ViewState } from '../types'
import { argSummary, finished, started } from './activity'
import { ROOT, SLIDE_MS, STATUS_WORD, canPan, elapsed, fitZoom, graphSvg, layout, panBy, viewport, withoutDone, zoomBy } from './graph'
import type { Axis, Layout, Window } from './graph'

const PANE = 'agent-tree'
const OPEN = { id: PANE, title: 'Agents' }
// The desktop draws a pane in cells of about this many CSS pixels. The drawing
// fills the body below the toolbar and never more, so the pane never scrolls:
// a pane has no part that stays put while the rest scrolls, so the tree pans
// inside the drawing instead and the toolbar stays where it is.
const CELL_W = 8
export const CELL_H = 18
// Rows the toolbar takes, and a spare row so a cell estimate a little short
// doesn't tip the body into scrolling.
export const TOOLBAR_ROWS = 2
const SPARE_ROWS = 1
const ZOOM_STEP = 1.25
// Of the window's width or height, about how far one ◀ ▶ ▲ ▼ press moves it.
const PAN_STEP = 0.5
// How often a running agent's clock is checked. A run time turns over once a
// second; checking four times as often shows each new second within 250 ms.
const TICK_MS = 250

const WIDTH: ViewState = { zoom: 1 }

// The window's corner when the current drag began, and the window as last
// drawn, for turning cells dragged into graph units.
let dragStart: { press: number; left: number; top: number } | undefined
let drawnWindow: Window = { x: 0, y: 0, w: 1, h: 1, scale: 1 }

function dragOf(data: unknown): { press: number; dx: number; dy: number } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { press, dx, dy } = data as Record<string, unknown>
  return typeof press === 'number' && typeof dx === 'number' && typeof dy === 'number' ? { press, dx, dy } : undefined
}

const nodes = atom({ plugin: 'agent-tree', key: 'nodes' } as const, {})
const activity = atom({ plugin: 'agent-tree', key: 'activity' } as const, {})
const view = atom({ plugin: 'agent-tree', key: 'view' } as const, WIDTH)
const hideDone = atom({ plugin: 'agent-tree', key: 'hideDone' } as const, false)
const now = atom({ plugin: 'agent-tree', key: 'now' } as const, 0)
const mainToolCount = atom({ plugin: 'agent-tree', key: 'mainToolCount' } as const, 0)
const theme = atom({ plugin: 'agent-tree', key: 'theme' } as const, 'auto')
const project = atom({ plugin: 'agent-tree', key: 'project' } as const, '')

async function moveView($: EngineInterface, move: (lay: Layout, v: ViewState) => ViewState): Promise<void> {
  const [all, hide] = await Promise.all([read($, nodes), read($, hideDone)])
  const lay = layout(hide ? withoutDone(all) : all)
  await update($, view, v => move(lay, v))
}

function statusOf(raw: string): AgentStatus {
  if (raw === 'running' || raw === 'pending') return 'running'
  if (raw === 'failed' || raw === 'killed') return raw
  return 'completed'
}

// The engine's agent list is the source of truth for who exists, who spawned
// whom and how they ended; we add only what it lacks (timing, tool activity).
// An agent the list has dropped while we still had it running is taken as ended.
export function merge(
  prev: Record<string, AgentNode>,
  list: readonly AgentInfo[],
  at: number,
): Record<string, AgentNode> {
  const next: Record<string, AgentNode> = {}
  for (const node of Object.values(prev)) {
    next[node.id] = node.status === 'running' ? { ...node, status: 'completed', endedAt: at } : node
  }
  for (const info of list) {
    const old = prev[info.id]
    const status = statusOf(info.status)
    next[info.id] = {
      id: info.id,
      parentId: info.parentId,
      type: info.type,
      description: info.description || info.name || info.type,
      status,
      startedAt: old?.startedAt ?? at,
      endedAt: status === 'running' ? undefined : (old?.endedAt ?? at),
      toolCount: old?.toolCount ?? 0,
    }
  }
  return next
}

// Writes only what changed, since every write redraws the pane: `now` only
// when a running agent's run time would read differently.
async function refresh($: EngineInterface): Promise<void> {
  const [list, at, prev, was] = await Promise.all([$.agent.list(), $.clock.now(), read($, nodes), read($, now)])
  const next = merge(prev, list, at)
  if (JSON.stringify(next) !== JSON.stringify(prev)) await update($, nodes, () => next)
  const turned = (n: AgentNode) => n.status === 'running' && elapsed(at - n.startedAt) !== elapsed(was - n.startedAt)
  if (Object.values(next).some(turned)) await update($, now, () => at)
}

async function tick($: EngineInterface): Promise<void> {
  if (Object.values(await read($, nodes)).some(n => n.status === 'running')) await refresh($)
}

async function setTheme($: EngineInterface, value: unknown): Promise<void> {
  if (typeof value !== 'string' || value === (await read($, theme))) return
  await update($, theme, () => value)
}

async function syncTheme($: EngineInterface): Promise<void> {
  const row = (await $.config.list()).find(one => one.key === 'theme')
  await setTheme($, row?.value)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-tree', description: 'Show this session’s subagent tree' })
    // Redraws only while an agent runs, so its run time counts up.
    $.clock.every(TICK_MS, () => {
      tick($).catch(() => undefined)
    })
    // `/theme` and the app's own appearance setting may change it without a
    // config.set reaching us, so the setting is also re-read now and then.
    $.clock.every(5000, () => {
      syncTheme($).catch(() => undefined)
    })
    const cwd = await $.session.cwd()
    await update($, project, () => cwd.split(/[\\/]/).filter(Boolean).pop() ?? '')
    await Promise.all([refresh($), syncTheme($).catch(() => undefined)])
    // Every session opens its own pane, so switching sessions shows that
    // session's tree. Best effort: a surface with no room waits or refuses.
    $.ui.open(OPEN).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'agent-tree' }, async $ => {
    await refresh($)
    await $.ui.open(OPEN)

    return { text: 'Agent tree opened.' }
  })

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    await setTheme($, result.value)

    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, nodes, () => ({}))
      await update($, activity, () => ({}))
      await update($, view, () => WIDTH)
      await update($, mainToolCount, () => 0)
    }

    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    await refresh($)
    $.ui.open(OPEN).catch(() => undefined)

    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const key = e.agentId ?? ROOT
    const known = key === ROOT || (await read($, nodes))[key] !== undefined
    const event: ToolEvent = {
      id: e.tool_use_id ?? `${key}:${Math.random()}`,
      tool,
      arg: argSummary(e as unknown as Record<string, unknown>),
      startedAt: await $.clock.now(),
    }
    if (known) {
      await update($, activity, acts => ({ ...acts, [key]: started(acts[key], event) }))
      if (key === ROOT) await update($, mainToolCount, n => n + 1)
      else await update($, nodes, all => (all[key] ? { ...all, [key]: { ...all[key], toolCount: all[key].toolCount + 1 } } : all))
    }

    let isError = true
    try {
      const ran = await next(e)
      isError = ran.deny !== undefined || ran.isError === true
      return ran
    } finally {
      if (known) {
        const at = await $.clock.now()
        await update($, activity, acts => ({ ...acts, [key]: finished(acts[key], event.id, at, isError) }))
      }
      if (tool === 'Agent') await refresh($)
    }
  })

  // Dragging the drawing pans the window, the tree following the pointer.
  on('ui.message', { requestId: PANE, element: 'drag' }, async ($, e) => {
    const drag = dragOf(e.data)
    if (!drag) return {}
    if (dragStart?.press !== drag.press) dragStart = { press: drag.press, left: drawnWindow.x, top: drawnWindow.y }
    const left = dragStart.left - (drag.dx * CELL_W) / drawnWindow.scale
    const top = dragStart.top - (drag.dy * CELL_H) / drawnWindow.scale
    if (Math.abs(left - drawnWindow.x) + Math.abs(top - drawnWindow.y) > 0.5) {
      await update($, view, v => ({ zoom: v.zoom, left, top }))
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [all, hide, acts, v, at, mainTools, look, name] = await Promise.all([
      read($, nodes),
      read($, hideDone),
      read($, activity),
      read($, view),
      read($, now),
      read($, mainToolCount),
      read($, theme),
      read($, project),
    ])
    const drawingRows = Math.max(4, e.props.scroll.bodyRows - TOOLBAR_ROWS - SPARE_ROWS)
    const frame = {
      width: Math.max(20, e.props.bodyColumns) * CELL_W,
      height: drawingRows * CELL_H,
    }
    const shown = hide ? withoutDone(all) : all
    const doneCount = Object.keys(all).length - Object.keys(shown).length
    // The desktop ignores a click on a Button while that Button's last press
    // is still being answered, so a press only starts its work and returns.
    const press = (work: () => Promise<unknown>) => (_: UiPressArgument) => {
      work().catch(err => {
        $.ui.toast(`agent-tree: ${String(err)}`)
      })
    }
    const zoom = (factor: number) => press(() => moveView($, (lay, view) => zoomBy(lay, view, frame, factor)))
    // Once the slide is over the drawing is redrawn still, so a later redraw
    // (a tick, a new agent) doesn't replay it; a newer press keeps its own.
    const pan = (axis: Axis, direction: number) =>
      press(async () => {
        await moveView($, (lay, view) => panBy(lay, view, frame, axis, direction, PAN_STEP))
        const slid = await read($, view)
        $.clock
          .sleep(SLIDE_MS)
          .then(() =>
            update($, view, v =>
              v.from !== undefined && v.left === slid.left && v.top === slid.top ? { zoom: v.zoom, left: v.left, top: v.top } : v,
            ),
          )
          .catch(() => undefined)
      })
    const fit = press(() => moveView($, lay => ({ zoom: fitZoom(lay, frame) })))
    const toggleDone = press(async () => {
      await update($, hideDone, h => !h)
      await update($, view, () => WIDTH)
    })
    const doneLabel = hide ? `Show done (${doneCount})` : 'Hide done'

    if (e.surface === 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e)
      const color: Record<AgentStatus, string> = { running: 'permission', completed: 'success', failed: 'error', killed: 'inactive' }
      return (
        <Box flexDirection="column">
          <Box>
            <Button key="done" hotkey="h" onPress={toggleDone}>{doneLabel}</Button>
          </Box>
          {layout(shown).placed.map(p =>
            p.node ? (
              <Text wrap="truncate-end">
                {'  '.repeat(p.depth)}
                {/* The run time comes before anything long, so a narrow pane
                    truncates the description instead. */}
                <Text color={color[p.node.status]}>●</Text> {elapsed((p.node.endedAt ?? at) - p.node.startedAt)}{' '}
                {p.node.description} <Text dimColor>{p.node.type} {STATUS_WORD[p.node.status]}</Text>
              </Text>
            ) : (
              <Text bold>{name || 'Session'}</Text>
            ),
          )}
          {Object.keys(all).length === 0 && <Text dimColor>Subagents show up here as they start</Text>}
        </Box>
      )
    }

    const elements = $.ui.resolve(e)
    const { Box, Button, Svg } = elements
    // Only the desktop draws a Client, so only there does the drawing drag.
    const Client = 'Client' in elements ? elements.Client : undefined
    const graph = graphSvg({
      nodes: shown,
      activity: acts,
      view: v,
      now: at,
      mainToolCount: mainTools,
      theme: look,
      project: name,
      focus: e.props.view.agentId,
      frame,
    })
    const lay = layout(shown)
    const win = viewport(lay, v, frame)
    drawnWindow = win
    const arrow = (axis: Axis, direction: number, key: string, glyph: string) => (
      <Button key={key} dimColor={!canPan(lay, v, frame, axis, direction)} onPress={pan(axis, direction)}>
        {glyph}
      </Button>
    )

    return (
      <Box flexDirection="column">
        <Box key="toolbar" height={TOOLBAR_ROWS} flexDirection="row" alignItems="center" gap={1}>
          <Button key="zoom-out" onPress={zoom(1 / ZOOM_STEP)}>−</Button>
          <Button key="zoom-in" onPress={zoom(ZOOM_STEP)}>+</Button>
          <Button key="fit" hotkey="f" onPress={fit}>Fit</Button>
          {win.w < lay.width && arrow('x', -1, 'pan-left', '◀')}
          {win.w < lay.width && arrow('x', 1, 'pan-right', '▶')}
          {win.h < lay.height && arrow('y', -1, 'pan-up', '▲')}
          {win.h < lay.height && arrow('y', 1, 'pan-down', '▼')}
          <Button key="done" hotkey="h" onPress={toggleDone}>{doneLabel}</Button>
        </Box>
        {/* Rows are what the pane measures in; the drawing's pixels are only
            an estimate of them, so the box clips what a short estimate lets
            spill over instead of the pane scrolling it. */}
        <Box position="relative" height={drawingRows} overflow="hidden">
          <Svg source={graph.source} alt={graph.alt} />
          {Client && (
            // The desktop sizes a Client's region by what its module draws,
            // so the module is told the drawing's size in cells.
            <Box position="absolute" top={0} left={0}>
              <Client key="drag" module="./drag.ts" props={{ columns: Math.floor(frame.width / CELL_W), rows: drawingRows }} />
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
