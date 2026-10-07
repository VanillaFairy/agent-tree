import type { AgentNode, AgentStatus, ToolEvent, ViewState } from '../types'
import { current } from './activity'

export const ROOT = 'main'

const NODE_W = 212
const NODE_H = 60
const GAP_X = 26
const GAP_Y = 52
const PAD = 28
// Average glyph widths in CSS pixels, for clipping text to a card.
const GLYPH = { title: 6.3, meta: 5.6, mono: 6.7 } as const
const MAX_ZOOM = 8
// The fitted view never magnifies past this, so a small tree stays card-sized.
const MAX_FIT_SCALE = 1.25

export type Placed = {
  id: string
  node?: AgentNode
  parent?: string
  x: number
  y: number
  depth: number
}

export type Layout = { placed: Placed[]; width: number; height: number }

export type Box = { x: number; y: number; w: number; h: number }

function childrenOf(nodes: Record<string, AgentNode>): Map<string, AgentNode[]> {
  const kids = new Map<string, AgentNode[]>()
  for (const node of Object.values(nodes).sort((a, b) => a.startedAt - b.startedAt)) {
    const parent = node.parentId !== undefined && nodes[node.parentId] ? node.parentId : ROOT
    kids.set(parent, [...(kids.get(parent) ?? []), node])
  }
  return kids
}

// A tidy top-down tree: each subtree takes the width of its widest row and a
// parent sits centred over its children. `x` is a node's centre, `y` its top.
export function layout(nodes: Record<string, AgentNode>): Layout {
  const kids = childrenOf(nodes)
  const span = new Map<string, number>()
  const measure = (id: string): number => {
    const parts = (kids.get(id) ?? []).map(c => measure(c.id))
    const width = Math.max(NODE_W, parts.reduce((a, b) => a + b, 0) + GAP_X * Math.max(0, parts.length - 1))
    span.set(id, width)
    return width
  }
  const total = measure(ROOT)

  const placed: Placed[] = []
  let deepest = 0
  const place = (id: string, node: AgentNode | undefined, parent: string | undefined, left: number, depth: number) => {
    placed.push({ id, node, parent, x: left + (span.get(id) ?? NODE_W) / 2, y: PAD + depth * (NODE_H + GAP_Y), depth })
    deepest = Math.max(deepest, depth)
    let at = left
    for (const child of kids.get(id) ?? []) {
      place(child.id, child, id, at, depth + 1)
      at += (span.get(child.id) ?? NODE_W) + GAP_X
    }
  }
  place(ROOT, undefined, undefined, PAD, 0)

  return { placed, width: total + PAD * 2, height: PAD * 2 + (deepest + 1) * NODE_H + deepest * GAP_Y }
}

// The drawing's size in CSS pixels.
export type Frame = { width: number; height: number }

// The whole tree, widened or heightened to the frame's aspect so it never
// stretches; zoom 1 shows exactly this.
function fitted(lay: Layout, frame: Frame): Box {
  const aspect = frame.height / frame.width
  const w = Math.max(lay.width, lay.height / aspect, frame.width / MAX_FIT_SCALE)
  const h = w * aspect
  return { x: (lay.width - w) / 2, y: (lay.height - h) / 2, w, h }
}

export function viewport(lay: Layout, view: ViewState, frame: Frame): Box {
  const fit = fitted(lay, frame)
  const w = fit.w / view.zoom
  const h = fit.h / view.zoom
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  const cx = clamp(view.center?.x ?? fit.x + fit.w / 2, fit.x + w / 2, fit.x + fit.w - w / 2)
  const cy = clamp(view.center?.y ?? fit.y + fit.h / 2, fit.y + h / 2, fit.y + fit.h - h / 2)
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

// Zooms by `factor` keeping the graph point under the pointer where it is.
// `fx`, `fy` are the pointer's place across the drawing, 0 to 1.
export function zoomAt(lay: Layout, view: ViewState, frame: Frame, fx: number, fy: number, factor: number): ViewState {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom * factor))
  if (zoom === 1) return { zoom }
  const vp = viewport(lay, view, frame)
  const px = vp.x + fx * vp.w
  const py = vp.y + fy * vp.h
  const w = vp.w * (view.zoom / zoom)
  const h = vp.h * (view.zoom / zoom)
  return { zoom, center: { x: px - fx * w + w / 2, y: py - fy * h + h / 2 } }
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

export function clip(text: string, px: number, glyph: number = GLYPH.meta): string {
  const room = Math.max(4, Math.floor(px / glyph))
  const flat = text.replace(/[\r\n\t]+/g, ' ').trim()
  return flat.length <= room ? flat : flat.slice(0, room - 1) + '…'
}

export const STATUS_WORD: Record<AgentStatus, string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

type Tokens = Record<string, string>

// Transparent ground: the pane's own background shows through, so only ink,
// hairlines and a faint card tint are drawn.
const DARK: Tokens = {
  ink: '#ececec', muted: '#9b9b9b', faint: 'rgba(255,255,255,.055)', line: 'rgba(255,255,255,.16)',
  live: '#8aa4ff', ok: '#74c393', bad: '#f27b6b', off: '#7c7c7c',
}
const LIGHT: Tokens = {
  ink: '#1f1f1f', muted: '#6c6c6c', faint: 'rgba(0,0,0,.045)', line: 'rgba(0,0,0,.18)',
  live: '#3b5bdb', ok: '#2b8a57', bad: '#c9483b', off: '#9a9a9a',
}
// The colour-blind themes keep done and failed apart without red against green
// (Okabe-Ito blue and vermillion), and move live off blue to stay distinct.
const DALTONIZED_DARK: Tokens = { live: '#2fd1a0', ok: '#56b4e9', bad: '#e69f00' }
const DALTONIZED_LIGHT: Tokens = { live: '#009e73', ok: '#0072b2', bad: '#d55e00' }

const vars = (t: Tokens) => Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(';')

// Claude Code's theme setting by name: a light or dark one is drawn as such
// whatever the OS says; `auto` (or a name we do not know) follows the system.
export function themeCss(theme: string): string {
  const dalton = theme.includes('daltonized')
  const light = { ...LIGHT, ...(dalton ? DALTONIZED_LIGHT : {}) }
  const dark = { ...DARK, ...(dalton ? DALTONIZED_DARK : {}) }
  if (theme.includes('light')) return `svg{${vars(light)}}`
  if (theme.includes('dark')) return `svg{${vars(dark)}}`
  return `svg{${vars(light)}}\n@media (prefers-color-scheme: dark){svg{${vars(dark)}}}`
}

const CSS = `
text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;white-space:pre}
.card{fill:var(--faint)}
.focus .card{stroke:var(--ink);stroke-width:1.4}
.title{fill:var(--ink);font-size:12.5px;font-weight:600}
.meta{fill:var(--muted);font-size:11px}
.doing{fill:var(--live);font:11px ui-monospace,"Cascadia Code",Consolas,monospace}
.dot.running{fill:var(--live)}.dot.completed{fill:var(--ok)}.dot.failed{fill:var(--bad)}.dot.killed{fill:var(--off)}
.word.completed{fill:var(--ok)}.word.failed{fill:var(--bad)}.word.killed{fill:var(--off)}
.word{font-size:11px}
.root{fill:var(--ink);font-size:13.5px;font-weight:650;text-anchor:middle}
.root-meta{fill:var(--muted);font-size:11px;text-anchor:middle}
.root-doing{fill:var(--live);font:11px ui-monospace,"Cascadia Code",Consolas,monospace;text-anchor:middle}
.wire{fill:none;stroke:var(--line);stroke-width:1.2}
.pulse{fill:none;stroke:var(--live);stroke-width:2;stroke-linecap:round;stroke-dasharray:6 90;animation:flow 1.6s linear infinite}
.hint{fill:var(--muted);font-size:12px;text-anchor:middle}
@keyframes flow{from{stroke-dashoffset:96}to{stroke-dashoffset:0}}
@media (prefers-reduced-motion: reduce){.pulse{animation:none;stroke-dasharray:none;opacity:.6}}`

// Down from the parent, across, and down into the child, with soft corners.
function wire(from: Placed, to: Placed): string {
  const x0 = from.x
  const y0 = from.y + NODE_H
  const x1 = to.x
  const y1 = to.y
  const mid = y0 + (y1 - y0) / 2
  if (Math.abs(x1 - x0) < 1) return `M${x0} ${y0} V${y1}`
  const r = Math.min(8, Math.abs(x1 - x0) / 2, (y1 - y0) / 4)
  const dir = x1 > x0 ? 1 : -1
  return `M${x0} ${y0} V${mid - r} Q${x0} ${mid} ${x0 + dir * r} ${mid} H${x1 - dir * r} Q${x1} ${mid} ${x1} ${mid + r} V${y1}`
}

function agentCard(p: Placed, n: AgentNode, events: readonly ToolEvent[] | undefined, now: number, focus: boolean): string {
  const x = p.x - NODE_W / 2
  const y = p.y
  const tx = x + 26
  const room = NODE_W - 36
  const doing = n.status === 'running' ? current(events) : undefined
  const meta = `${n.type}   ${n.toolCount} tools   ${elapsed((n.endedAt ?? now) - n.startedAt)}`
  const third =
    n.status === 'running'
      ? `<text class="doing" x="${tx}" y="${y + 50}">${esc(clip(doing ? `${doing.tool} ${doing.arg}` : 'thinking…', room, GLYPH.mono))}</text>`
      : `<text class="word ${n.status}" x="${tx}" y="${y + 50}">${STATUS_WORD[n.status]}</text>`
  return `<g class="${focus ? 'focus' : ''}">
<rect class="card" x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="10"/>
<circle class="dot ${n.status}" cx="${x + 14}" cy="${y + 17}" r="3.5"/>
<text class="title" x="${tx}" y="${y + 21}">${esc(clip(n.description, room, GLYPH.title))}</text>
<text class="meta" x="${tx}" y="${y + 36}">${esc(clip(meta, room))}</text>${third}</g>`
}

function rootCard(p: Placed, project: string, events: readonly ToolEvent[] | undefined, mainTools: number, agents: number, running: number): string {
  const y = p.y
  const room = NODE_W + 40
  const doing = current(events)
  const meta = agents === 0 ? `this session   ${mainTools} tools` : `this session   ${agents} agents   ${running} running`
  const third = doing ? `<text class="root-doing" x="${p.x}" y="${y + 50}">${esc(clip(`${doing.tool} ${doing.arg}`, room, GLYPH.mono))}</text>` : ''
  return `<g>
<text class="root" x="${p.x}" y="${y + 20}">${esc(clip(project || 'Session', room, GLYPH.title))}</text>
<text class="root-meta" x="${p.x}" y="${y + 36}">${esc(meta)}</text>${third}</g>`
}

export type GraphInput = {
  nodes: Record<string, AgentNode>
  activity: Record<string, ToolEvent[]>
  view: ViewState
  now: number
  mainToolCount: number
  theme: string
  project: string
  // The agent whose transcript is on screen beside the pane, if any.
  focus?: string
  // The drawing's size in CSS pixels; the tree is fitted to its aspect.
  width: number
  height: number
}

export function graphSvg(g: GraphInput): { source: string; alt: string } {
  const lay = layout(g.nodes)
  const vp = viewport(lay, g.view, g)
  const where = new Map(lay.placed.map(p => [p.id, p]))
  const agents = Object.values(g.nodes)
  const running = agents.filter(n => n.status === 'running').length

  const wires = lay.placed.flatMap(p => {
    const from = p.parent === undefined ? undefined : where.get(p.parent)
    if (!from) return []
    const d = wire(from, p)
    return p.node?.status === 'running'
      ? [`<path class="wire" d="${d}"/>`, `<path class="pulse" pathLength="96" d="${d}"/>`]
      : [`<path class="wire" d="${d}"/>`]
  })
  const cards = lay.placed.map(p =>
    p.node
      ? agentCard(p, p.node, g.activity[p.id], g.now, p.id === g.focus)
      : rootCard(p, g.project, g.activity[ROOT], g.mainToolCount, agents.length, running),
  )
  const hint =
    agents.length === 0
      ? `<text class="hint" x="${lay.width / 2}" y="${PAD + NODE_H + 30}">Subagents show up here as they start</text>`
      : ''

  const box = [vp.x, vp.y, vp.w, vp.h].map(v => v.toFixed(1)).join(' ')
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${g.width}" height="${g.height}" viewBox="${box}"><style>${themeCss(g.theme)}${CSS}</style>${wires.join('')}${cards.join('')}${hint}</svg>`
  const alt = lay.placed
    .map(p => `${'  '.repeat(p.depth)}${p.node ? `${p.node.description} (${p.node.type}, ${STATUS_WORD[p.node.status]})` : g.project || 'Session'}`)
    .join('\n')
  return { source, alt }
}
