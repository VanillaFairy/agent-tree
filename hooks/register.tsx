import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { AgentNode, AgentStatus, ToolEvent, ViewState } from '../types'
import { argSummary, current, finished, started } from './activity'
import { ROOT, STATUS_WORD, elapsed, graphSvg, layout, zoomAt } from './graph'

const PANE = 'agent-tree'
const OPEN = { id: PANE, title: 'Agents' }
// The desktop draws a pane in cells of about this many CSS pixels; the drawing
// is sized from the cells the pane reports so it fills the body without scrolling.
const CELL_W = 8
const CELL_H = 18
const WHEEL_STEP = 1.2

const FIT: ViewState = { zoom: 1 }

const nodes = atom({ plugin: 'agent-tree', key: 'nodes' } as const, {})
const activity = atom({ plugin: 'agent-tree', key: 'activity' } as const, {})
const view = atom({ plugin: 'agent-tree', key: 'view' } as const, FIT)
const now = atom({ plugin: 'agent-tree', key: 'now' } as const, 0)
const mainToolCount = atom({ plugin: 'agent-tree', key: 'mainToolCount' } as const, 0)
const theme = atom({ plugin: 'agent-tree', key: 'theme' } as const, 'auto')
const project = atom({ plugin: 'agent-tree', key: 'project' } as const, '')

// Where the pane was last drawn, for mapping a wheel tick's cell onto the
// drawing. A scroll only ever follows a draw, so these are set when read.
const drawn = { surface: '', columns: 1, rows: 1 }

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

async function refresh($: EngineInterface): Promise<void> {
  const [list, at] = await Promise.all([$.agent.list(), $.clock.now()])
  await update($, nodes, prev => merge(prev, list, at))
  await update($, now, () => at)
}

async function tick($: EngineInterface): Promise<void> {
  const [all, acts] = await Promise.all([read($, nodes), read($, activity)])
  if (Object.values(all).some(n => n.status === 'running')) return refresh($)
  if (current(acts[ROOT])) {
    const at = await $.clock.now()
    await update($, now, () => at)
  }
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
    // Ticks only while something runs, so elapsed times count up; a missed
    // tick is redrawn by the next one.
    $.clock.every(1000, () => {
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
      await update($, view, () => FIT)
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

  // The wheel zooms the drawing around the pointer instead of scrolling the
  // pane; zooming all the way out fits the whole tree again.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (drawn.surface === 'terminal' || !e.pointer || e.by === 0) return next(e)
    const fx = Math.min(1, Math.max(0, e.pointer.column / drawn.columns))
    const fy = Math.min(1, Math.max(0, e.pointer.row / drawn.rows))
    const factor = WHEEL_STEP ** -e.by
    const all = await read($, nodes)
    const frame = { width: drawn.columns * CELL_W, height: drawn.rows * CELL_H }
    await update($, view, v => zoomAt(layout(all), v, frame, fx, fy, factor))

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [all, acts, v, at, mainTools, look, name] = await Promise.all([
      read($, nodes),
      read($, activity),
      read($, view),
      read($, now),
      read($, mainToolCount),
      read($, theme),
      read($, project),
    ])
    const columns = Math.max(20, e.props.bodyColumns)
    const rows = Math.max(8, e.props.scroll.bodyRows - 1)
    Object.assign(drawn, { surface: e.surface, columns, rows })

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      const color: Record<AgentStatus, string> = { running: 'permission', completed: 'success', failed: 'error', killed: 'inactive' }
      return (
        <Box flexDirection="column">
          {layout(all).placed.map(p =>
            p.node ? (
              <Text wrap="truncate-end">
                {'  '.repeat(p.depth)}
                <Text color={color[p.node.status]}>●</Text> {p.node.description}{' '}
                <Text dimColor>
                  {p.node.type} {elapsed((p.node.endedAt ?? at) - p.node.startedAt)} {STATUS_WORD[p.node.status]}
                </Text>
              </Text>
            ) : (
              <Text bold>{name || 'Session'}</Text>
            ),
          )}
          {Object.keys(all).length === 0 && <Text dimColor>Subagents show up here as they start</Text>}
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e)
    const graph = graphSvg({
      nodes: all,
      activity: acts,
      view: v,
      now: at,
      mainToolCount: mainTools,
      theme: look,
      project: name,
      focus: e.props.view.agentId,
      width: columns * CELL_W,
      height: rows * CELL_H,
    })

    return <Svg source={graph.source} alt={graph.alt} />
  })
}
