import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { AgentNode, AgentStatus, ToolEvent, ViewState } from '../types'
import { argSummary, current, finished, started } from './activity'
import { ROOT, STATUS_LABEL, centerOf, elapsed, graphSvg, layout, panned, timelineSvg } from './graph'

const PANE = 'agent-tree'
const OPEN = { id: PANE, title: 'Agents' }
const MAX_ZOOM = 6

// Theme keys, not raw colours, so the terminal draws them in the person's theme.
const STATUS_COLOR: Record<AgentStatus, string> = {
  running: 'permission',
  completed: 'success',
  failed: 'error',
  killed: 'inactive',
}

const INITIAL_VIEW: ViewState = { zoom: 1, hideFinished: false, collapsed: [], selected: ROOT }

const nodes = atom({ plugin: 'agent-tree', key: 'nodes' } as const, {})
const activity = atom({ plugin: 'agent-tree', key: 'activity' } as const, {})
const view = atom({ plugin: 'agent-tree', key: 'view' } as const, INITIAL_VIEW)
const now = atom({ plugin: 'agent-tree', key: 'now' } as const, 0)
const mainToolCount = atom({ plugin: 'agent-tree', key: 'mainToolCount' } as const, 0)
const theme = atom({ plugin: 'agent-tree', key: 'theme' } as const, 'auto')

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
      ...old,
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

async function setTheme($: EngineInterface, value: unknown): Promise<void> {
  if (typeof value !== 'string' || value === (await read($, theme))) return
  await update($, theme, () => value)
}

async function syncTheme($: EngineInterface): Promise<void> {
  const row = (await $.config.list()).find(one => one.key === 'theme')
  await setTheme($, row?.value)
}

async function tick($: EngineInterface): Promise<void> {
  const [all, acts] = await Promise.all([read($, nodes), read($, activity)])
  if (Object.values(all).some(n => n.status === 'running')) return refresh($)
  if (current(acts[ROOT])) {
    const at = await $.clock.now()
    await update($, now, () => at)
  }
}

const zoomBy = ($: EngineInterface, factor: number) =>
  update($, view, v => ({ ...v, zoom: Math.min(MAX_ZOOM, Math.max(1, v.zoom * factor)) }))

async function pan($: EngineInterface, dx: number, dy: number): Promise<void> {
  const all = await read($, nodes)
  await update($, view, v => ({ ...v, center: panned(layout(all, v), v, dx, dy) }))
}

async function focusOn($: EngineInterface, id: string): Promise<void> {
  const all = await read($, nodes)
  await update($, view, v => ({ ...v, selected: id, zoom: Math.max(v.zoom, 2), center: centerOf(layout(all, v), id) }))
}

async function stop($: EngineInterface, id: string): Promise<void> {
  const result = await $.tool.call({ tool: 'TaskStop', task_id: id })
  const failed = 'deny' in result && result.deny !== undefined ? result.deny : result.isError ? result.text : undefined
  await $.ui.toast(failed ? `Could not stop the agent: ${failed}` : 'Agent stopped.')
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-tree', description: 'Show the live subagent graph in a pane' })
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
    await Promise.all([refresh($), syncTheme($).catch(() => undefined)])

    return next(e)
  })

  on('command.run', { command: 'agent-tree' }, async $ => {
    await refresh($)
    await $.ui.open(OPEN)

    return { text: 'Agent graph opened.' }
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
      await update($, view, () => INITIAL_VIEW)
      await update($, mainToolCount, () => 0)
    }

    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    await refresh($)
    // Opening unasked is best effort: a surface with no room or no pane refuses it.
    $.ui.open(OPEN).catch(() => undefined)

    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    await update($, nodes, all => {
      const node = all[e.agent_id]
      if (!node) return all
      return {
        ...all,
        [e.agent_id]: { ...node, lastMessage: e.last_assistant_message, transcriptPath: e.agent_transcript_path },
      }
    })

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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [all, acts, v, at, mainTools, look] = await Promise.all([
      read($, nodes),
      read($, activity),
      read($, view),
      read($, now),
      read($, mainToolCount),
      read($, theme),
    ])
    if (e.surface === 'mobile') {
      const { Svg } = $.ui.resolve(e)
      const graph = graphSvg(all, acts, v, at, mainTools, look)
      return <Svg source={graph.source} alt={graph.alt} isInteractive />
    }

    const { Box, Text, Button, Select, Link } = $.ui.resolve(e)
    const selected = v.selected === ROOT || all[v.selected] ? v.selected : ROOT
    const node = all[selected]
    const events = acts[selected] ?? []
    const doing = current(events)
    const hasChildren = Object.values(all).some(n => n.parentId === selected) || (selected === ROOT && Object.keys(all).length > 0)
    const isFolded = v.collapsed.includes(selected)
    const order = layout(all, { ...v, collapsed: [], hideFinished: false }).placed
    const glyph: Record<AgentStatus, string> = { running: '●', completed: '✓', failed: '✗', killed: '■' }

    const toolbar = (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key="zoom-out" onPress={() => zoomBy($, 1 / 1.5)}>−</Button>
        <Button key="zoom-in" onPress={() => zoomBy($, 1.5)}>+</Button>
        <Button key="fit" onPress={() => update($, view, w => ({ ...w, zoom: 1, center: undefined }))}>Fit</Button>
        <Button key="left" onPress={() => pan($, -1, 0)}>←</Button>
        <Button key="up" onPress={() => pan($, 0, -1)}>↑</Button>
        <Button key="down" onPress={() => pan($, 0, 1)}>↓</Button>
        <Button key="right" onPress={() => pan($, 1, 0)}>→</Button>
        <Button key="finished" onPress={() => update($, view, w => ({ ...w, hideFinished: !w.hideFinished }))}>
          {v.hideFinished ? 'Show finished' : 'Hide finished'}
        </Button>
      </Box>
    )

    const picker = (
      <Select
        key="agent"
        label="Agent"
        value={selected}
        options={order.map(p => ({
          value: p.id,
          label: p.node ? `${'  '.repeat(p.depth)}${glyph[p.node.status]} ${p.node.description}` : 'Main session',
        }))}
        onSelect={value => update($, view, w => ({ ...w, selected: value }))}
      />
    )

    const actions = (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key="center" onPress={() => focusOn($, selected)}>Center</Button>
        {hasChildren && (
          <Button
            key="fold"
            onPress={() =>
              update($, view, w => ({
                ...w,
                collapsed: w.collapsed.includes(selected) ? w.collapsed.filter(id => id !== selected) : [...w.collapsed, selected],
              }))
            }
          >
            {isFolded ? 'Expand' : 'Collapse'}
          </Button>
        )}
        {node?.status === 'running' && (
          <Button key="stop" onPress={() => stop($, selected)}>Stop</Button>
        )}
        {node?.transcriptPath && <Link href={`file:///${node.transcriptPath.replace(/\\/g, '/')}`} label="Open transcript" />}
      </Box>
    )

    const heading = node
      ? `${node.description} · ${node.type} · ${STATUS_LABEL[node.status]} · ${node.toolCount} tools · ${elapsed((node.endedAt ?? at) - node.startedAt)}`
      : `Main session · ${mainTools} tools · ${Object.keys(all).length} agents`
    const nowLine = doing ? `▸ ${doing.tool} ${doing.arg}` : node?.status === 'running' ? 'thinking…' : undefined

    if (e.surface === 'terminal') {
      return (
        <Box flexDirection="column" gap={1}>
          {toolbar}
          <Box flexDirection="column">
            {layout(all, v).placed.map(p => (
              <Text wrap="truncate-end" bold={p.id === selected}>
                {'  '.repeat(p.depth)}
                {p.node ? (
                  <Text>
                    <Text color={STATUS_COLOR[p.node.status]}>{glyph[p.node.status]}</Text> {p.node.description}
                  </Text>
                ) : (
                  'Main session'
                )}
                {p.hidden > 0 ? ` (+${p.hidden})` : ''}
              </Text>
            ))}
          </Box>
          {picker}
          <Text bold wrap="truncate-end">{heading}</Text>
          {nowLine && <Text color="permission" wrap="truncate-end">{nowLine}</Text>}
          {[...events].reverse().slice(0, 8).map(ev => (
            <Text dimColor wrap="truncate-end">
              {ev.endedAt === undefined ? '▸' : ev.isError ? '✗' : '·'} {ev.tool} {ev.arg}
            </Text>
          ))}
          {actions}
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e)
    const graph = graphSvg(all, acts, { ...v, selected }, at, mainTools, look)
    const timeline = timelineSvg(events, at, look)

    return (
      <Box flexDirection="column" gap={1}>
        {toolbar}
        <Svg source={graph.source} alt={graph.alt} isInteractive />
        {picker}
        <Text bold wrap="truncate-end">{heading}</Text>
        {nowLine && <Text color="permission" wrap="truncate-end">{nowLine}</Text>}
        <Svg source={timeline.source} alt={timeline.alt} isInteractive />
        {node?.lastMessage && <Text dimColor wrap="wrap">{node.lastMessage.slice(0, 600)}</Text>}
        {actions}
      </Box>
    )
  })
}
