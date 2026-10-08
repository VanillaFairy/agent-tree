import type { AgentNode, AgentStatus, ToolEvent, ViewState } from '../types'
import { current } from './activity'

export const ROOT = 'main'

const NODE_W = 212
const NODE_H = 74
const GAP_X = 48
const GAP_Y = 12
const PAD = 28
// Average glyph widths in CSS pixels, for clipping text to a card.
const GLYPH = { title: 6.3, meta: 5.6, mono: 6.7, time: 6.6 } as const
const MIN_ZOOM = 0.2
// How long a ◀ ▶ ▲ ▼ press slides the drawing.
export const SLIDE_MS = 240
const MAX_ZOOM = 8
// Zoom 1 never magnifies past this, so a small tree stays card-sized.
const MAX_FIT_SCALE = 1.25

// `x`, `y` are the card's top-left corner.
export type Placed = {
  id: string
  node?: AgentNode
  parent?: string
  x: number
  y: number
  depth: number
}

export type Layout = { placed: Placed[]; width: number; height: number }

function childrenOf(nodes: Record<string, AgentNode>): Map<string, AgentNode[]> {
  const kids = new Map<string, AgentNode[]>()
  for (const node of Object.values(nodes).sort((a, b) => a.startedAt - b.startedAt)) {
    const parent = node.parentId !== undefined && nodes[node.parentId] ? node.parentId : ROOT
    kids.set(parent, [...(kids.get(parent) ?? []), node])
  }
  return kids
}

// The tree with every done agent left out, unless something under it is not done.
export function withoutDone(nodes: Record<string, AgentNode>): Record<string, AgentNode> {
  const kids = childrenOf(nodes)
  const kept: Record<string, AgentNode> = {}
  const keep = (node: AgentNode): boolean => {
    const anyKid = (kids.get(node.id) ?? []).map(keep).some(Boolean)
    if (!anyKid && node.status === 'completed') return false
    kept[node.id] = node
    return true
  }
  for (const top of kids.get(ROOT) ?? []) keep(top)
  return kept
}

// A sideways tree: one column per depth, siblings stacked in start order, and
// a parent level with the middle of its children.
export function layout(nodes: Record<string, AgentNode>): Layout {
  const kids = childrenOf(nodes)
  const span = new Map<string, number>()
  const measure = (id: string): number => {
    const parts = (kids.get(id) ?? []).map(c => measure(c.id))
    const height = Math.max(NODE_H, parts.reduce((a, b) => a + b, 0) + GAP_Y * Math.max(0, parts.length - 1))
    span.set(id, height)
    return height
  }
  const total = measure(ROOT)

  const placed: Placed[] = []
  let deepest = 0
  const place = (id: string, node: AgentNode | undefined, parent: string | undefined, top: number, depth: number): number => {
    const here: Placed = { id, node, parent, x: PAD + depth * (NODE_W + GAP_X), y: top, depth }
    placed.push(here)
    deepest = Math.max(deepest, depth)
    const ys: number[] = []
    let at = top
    for (const child of kids.get(id) ?? []) {
      ys.push(place(child.id, child, id, at, depth + 1))
      at += (span.get(child.id) ?? NODE_H) + GAP_Y
    }
    if (ys.length > 0) here.y = ((ys[0] ?? top) + (ys[ys.length - 1] ?? top)) / 2
    return here.y
  }
  place(ROOT, undefined, undefined, PAD, 0)

  return { placed, width: PAD * 2 + (deepest + 1) * NODE_W + deepest * GAP_X, height: total + PAD * 2 }
}

// The drawing's size in CSS pixels: the room below the toolbar.
export type Frame = { width: number; height: number }

export type Axis = 'x' | 'y'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Pixels per graph unit at zoom 1: the tree's width fills the drawing.
function baseScale(lay: Layout, width: number): number {
  return Math.min(width / lay.width, MAX_FIT_SCALE)
}

// The part of the tree the drawing shows, in graph units, and its scale.
export type Window = { x: number; y: number; w: number; h: number; scale: number }

// Along one axis: a tree that fits starts at its edge, a longer one keeps the
// window inside it.
const edge = (length: number, room: number, at: number | undefined) => (room >= length ? 0 : clamp(at ?? 0, 0, length - room))

export function viewport(lay: Layout, view: ViewState, frame: Frame): Window {
  const scale = baseScale(lay, frame.width) * clamp(view.zoom, MIN_ZOOM, MAX_ZOOM)
  const w = frame.width / scale
  const h = frame.height / scale
  return { x: edge(lay.width, w, view.left), y: edge(lay.height, h, view.top), w, h, scale }
}

// The zoom at which the whole tree fits the drawing.
export function fitZoom(lay: Layout, frame: Frame): number {
  return clamp(frame.height / lay.height / baseScale(lay, frame.width), MIN_ZOOM, 1)
}

// Zooms by `factor`, keeping the middle of the window where it is.
export function zoomBy(lay: Layout, view: ViewState, frame: Frame, factor: number): ViewState {
  const from = viewport(lay, view, frame)
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  const to = viewport(lay, { zoom }, frame)
  return { zoom, left: from.x + from.w / 2 - to.w / 2, top: from.y + from.h / 2 - to.h / 2 }
}

function span(lay: Layout, win: Window, axis: Axis): { at: number; room: number; length: number } {
  return axis === 'x' ? { at: win.x, room: win.w, length: lay.width } : { at: win.y, room: win.h, length: lay.height }
}

// Moves the window one step along `axis`, `direction` -1 or 1. The distance
// it can travel is cut into equal steps of about `fraction` of the window,
// so every press moves as far as the last and the last lands on the edge.
// The move slides from where the window was.
export function panBy(lay: Layout, view: ViewState, frame: Frame, axis: Axis, direction: number, fraction: number): ViewState {
  const from = viewport(lay, view, frame)
  const { at, room, length } = span(lay, from, axis)
  const range = length - room
  if (range <= 0) return view
  const step = range / Math.ceil(range / (fraction * room))
  const next = (direction > 0 ? Math.floor(at / step + 1e-6) + 1 : Math.ceil(at / step - 1e-6) - 1) * step
  const to = viewport(lay, axis === 'x' ? { ...view, left: next } : { ...view, top: next }, frame)
  return { zoom: view.zoom, left: to.x, top: to.y, from: { x: from.x, y: from.y } }
}

// Whether the window can still move along `axis` toward `direction`, -1 or 1.
export function canPan(lay: Layout, view: ViewState, frame: Frame, axis: Axis, direction: number): boolean {
  const { at, room, length } = span(lay, viewport(lay, view, frame), axis)
  return direction < 0 ? at > 0.5 : at + room < length - 0.5
}

// A stopwatch reading: whole seconds gone, seconds shown at every length.
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${pad(s % 60)}s`
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m ${pad(s % 60)}s`
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
.time{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;text-anchor:end}
.root{fill:var(--ink);font-size:13.5px;font-weight:650;text-anchor:end}
.root-meta{fill:var(--muted);font-size:11px;text-anchor:end}
.root-doing{fill:var(--live);font:11px ui-monospace,"Cascadia Code",Consolas,monospace;text-anchor:end}
.wire{fill:none;stroke:var(--line);stroke-width:1.2}
.pulse{fill:none;stroke:var(--live);stroke-width:2;stroke-linecap:round;stroke-dasharray:6 90;animation:flow 1.6s linear infinite}
.hint{fill:var(--muted);font-size:12px}
@keyframes flow{from{stroke-dashoffset:96}to{stroke-dashoffset:0}}
@media (prefers-reduced-motion: reduce){.pulse{animation:none;stroke-dasharray:none;opacity:.6}}`

// Right out of the parent, down or up, and right into the child, with soft corners.
function wire(from: Placed, to: Placed): string {
  const x0 = from.x + NODE_W
  const y0 = from.y + NODE_H / 2
  const x1 = to.x
  const y1 = to.y + NODE_H / 2
  const mid = x0 + (x1 - x0) / 2
  if (Math.abs(y1 - y0) < 1) return `M${x0} ${y0} H${x1}`
  const r = Math.min(8, Math.abs(y1 - y0) / 2, (x1 - x0) / 4)
  const dir = y1 > y0 ? 1 : -1
  return `M${x0} ${y0} H${mid - r} Q${mid} ${y0} ${mid} ${y0 + dir * r} V${y1 - dir * r} Q${mid} ${y1} ${mid + r} ${y1} H${x1}`
}

// Splits `text` over two lines of `px`, breaking after a space, `:`, `-` or
// `_` where it can; only the second line is ever clipped.
function twoLines(text: string, px: number, glyph: number = GLYPH.meta): [string, string] {
  const room = Math.max(4, Math.floor(px / glyph))
  if (text.length <= room) return [text, '']
  const head = text.slice(0, room + 1)
  const cut = Math.max(head.lastIndexOf(' '), head.lastIndexOf(':') + 1, head.lastIndexOf('-') + 1, head.lastIndexOf('_') + 1)
  const at = cut > room / 3 ? cut : room
  return [text.slice(0, at).trimEnd(), clip(text.slice(at).trimStart(), px, glyph)]
}

function agentCard(p: Placed, n: AgentNode, events: readonly ToolEvent[] | undefined, now: number, focus: boolean): string {
  const x = p.x
  const y = p.y
  const tx = x + 26
  const room = NODE_W - 36
  const doing = n.status === 'running' ? current(events) : undefined
  const [meta, more] = twoLines(`${n.type}   ${n.toolCount} tools`, room)
  // The run time sits on the dot's row at the card's right edge, and the
  // title gives way to it, never the other way round.
  const time = elapsed((n.endedAt ?? now) - n.startedAt)
  const timeRoom = time.length * GLYPH.time + 8
  const third =
    n.status === 'running'
      ? `<text class="doing" x="${tx}" y="${y + 64}">${esc(clip(doing ? `${doing.tool} ${doing.arg}` : 'thinking…', room, GLYPH.mono))}</text>`
      : `<text class="word ${n.status}" x="${tx}" y="${y + 64}">${STATUS_WORD[n.status]}</text>`
  return `<g class="${focus ? 'focus' : ''}">
<rect class="card" x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="10"/>
<circle class="dot ${n.status}" cx="${x + 14}" cy="${y + 17}" r="3.5"/>
<text class="title" x="${tx}" y="${y + 21}">${esc(clip(n.description, room - timeRoom, GLYPH.title))}</text>
<text class="time" x="${x + NODE_W - 10}" y="${y + 21}">${time}</text>
${more === ''
    ? `<text class="meta" x="${tx}" y="${y + 43}">${esc(meta)}</text>`
    : `<text class="meta" x="${tx}" y="${y + 36}">${esc(meta)}</text>
<text class="meta" x="${tx}" y="${y + 50}">${esc(more)}</text>`}${third}</g>`
}

// Right-aligned against its column's edge, where the wires leave it.
function rootCard(p: Placed, project: string, events: readonly ToolEvent[] | undefined, mainTools: number, agents: number, running: number): string {
  const y = p.y
  const x = p.x + NODE_W - 10
  const room = NODE_W + PAD - 14
  const doing = current(events)
  const meta = agents === 0 ? `this session   ${mainTools} tools` : `this session   ${agents} agents   ${running} running`
  const third = doing ? `<text class="root-doing" x="${x}" y="${y + 50}">${esc(clip(`${doing.tool} ${doing.arg}`, room, GLYPH.mono))}</text>` : ''
  return `<g>
<text class="root" x="${x}" y="${y + 20}">${esc(clip(project || 'Session', room, GLYPH.title))}</text>
<text class="root-meta" x="${x}" y="${y + 36}">${esc(clip(meta, room))}</text>${third}</g>`
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
  frame: Frame
}

export function graphSvg(g: GraphInput): { source: string; alt: string } {
  const lay = layout(g.nodes)
  const vp = viewport(lay, g.view, g.frame)
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
      ? `<text class="hint" x="${PAD}" y="${PAD + NODE_H + 30}">Subagents show up here as they start</text>`
      : ''

  const box = (x: number, y: number) => [x, y, vp.w, vp.h].map(v => v.toFixed(1)).join(' ')
  const from = g.view.from
  // The drawing animates itself: each redraw replaces it whole, so a slide
  // between two views has to live inside the new one.
  const slide =
    from !== undefined && Math.abs(from.x - vp.x) + Math.abs(from.y - vp.y) > 0.5
      ? `<animate attributeName="viewBox" from="${box(from.x, from.y)}" to="${box(vp.x, vp.y)}" dur="${SLIDE_MS}ms" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".3 0 .2 1"/>`
      : ''
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${g.frame.width}" height="${g.frame.height}" viewBox="${box(vp.x, vp.y)}">${slide}<style>${themeCss(g.theme)}${CSS}</style>${wires.join('')}${cards.join('')}${hint}</svg>`
  const alt = lay.placed
    .map(p => `${'  '.repeat(p.depth)}${p.node ? `${p.node.description} (${p.node.type}, ${STATUS_WORD[p.node.status]})` : g.project || 'Session'}`)
    .join('\n')
  return { source, alt }
}
