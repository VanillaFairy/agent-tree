import type { AgentNode, AgentStatus, ToolEvent, ViewState } from '../types'
import { current } from './activity'

export const ROOT = 'main'

const BOX_W = 176
const BOX_H = 64
const GAP_X = 18
const GAP_Y = 46
const MARGIN = 20
const OUT_W = 460
const CHAR_PX = 6.3
const PAN = 0.3

export type Placed = {
  id: string
  node?: AgentNode
  parent?: string
  x: number
  y: number
  depth: number
  hidden: number
}

export type Layout = { placed: Placed[]; width: number; height: number }

export type Viewport = { x: number; y: number; w: number; h: number; outH: number }

const isOpen = (s: AgentStatus) => s === 'running' || s === 'failed'

function childrenOf(nodes: Record<string, AgentNode>): Map<string, AgentNode[]> {
  const kids = new Map<string, AgentNode[]>()
  for (const node of Object.values(nodes).sort((a, b) => a.startedAt - b.startedAt)) {
    const parent = node.parentId !== undefined && nodes[node.parentId] ? node.parentId : ROOT
    kids.set(parent, [...(kids.get(parent) ?? []), node])
  }
  return kids
}

// The tree as drawn: finished branches dropped when asked (a finished agent
// stays while something under it is still open), collapsed ones folded.
export function layout(nodes: Record<string, AgentNode>, view: ViewState): Layout {
  const kids = childrenOf(nodes)
  const keep = (node: AgentNode): boolean =>
    !view.hideFinished || isOpen(node.status) || (kids.get(node.id) ?? []).some(keep)
  const visible = (id: string) => (kids.get(id) ?? []).filter(keep)
  const count = (id: string): number => visible(id).reduce((n, c) => n + 1 + count(c.id), 0)
  const shown = (id: string) => (view.collapsed.includes(id) ? [] : visible(id))

  const span = new Map<string, number>()
  const measure = (id: string): number => {
    const parts = shown(id).map(c => measure(c.id))
    const width = Math.max(BOX_W, parts.reduce((a, b) => a + b, 0) + GAP_X * Math.max(0, parts.length - 1))
    span.set(id, width)
    return width
  }
  const total = measure(ROOT)

  const placed: Placed[] = []
  let depthMax = 0
  const place = (id: string, node: AgentNode | undefined, parent: string | undefined, left: number, depth: number) => {
    const width = span.get(id) ?? BOX_W
    const folded = view.collapsed.includes(id) ? count(id) : 0
    placed.push({ id, node, parent, x: left + width / 2, y: MARGIN + depth * (BOX_H + GAP_Y), depth, hidden: folded })
    depthMax = Math.max(depthMax, depth)
    let at = left
    for (const child of shown(id)) {
      place(child.id, child, id, at, depth + 1)
      at += (span.get(child.id) ?? BOX_W) + GAP_X
    }
  }
  place(ROOT, undefined, undefined, MARGIN, 0)

  return { placed, width: total + MARGIN * 2, height: MARGIN * 2 + (depthMax + 1) * BOX_H + depthMax * GAP_Y + 14 }
}

export function viewport(lay: Layout, view: ViewState): Viewport {
  const outH = Math.round(Math.min(520, Math.max(240, (OUT_W * lay.height) / lay.width)))
  const aspect = outH / OUT_W
  const fitW = Math.max(lay.width, lay.height / aspect)
  const w = fitW / Math.max(1, view.zoom)
  const h = w * aspect
  const cx = Math.min(lay.width, Math.max(0, view.center?.x ?? lay.width / 2))
  const cy = Math.min(lay.height, Math.max(0, view.center?.y ?? lay.height / 2))
  return { x: cx - w / 2, y: cy - h / 2, w, h, outH }
}

export function panned(lay: Layout, view: ViewState, dx: number, dy: number): ViewState['center'] {
  const vp = viewport(lay, view)
  return { x: vp.x + vp.w / 2 + dx * vp.w * PAN, y: vp.y + vp.h / 2 + dy * vp.h * PAN }
}

export function centerOf(lay: Layout, id: string): ViewState['center'] {
  const at = lay.placed.find(p => p.id === id)
  return at ? { x: at.x, y: at.y + BOX_H / 2 } : undefined
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

export function clip(text: string, px: number): string {
  const room = Math.max(4, Math.floor(px / CHAR_PX))
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= room ? flat : flat.slice(0, room - 1) + '…'
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

type Tokens = Record<string, string>

const LIGHT: Tokens = {
  bg: '#ffffff', card: '#f6f7f9', edge: '#c9ced8', fg: '#1d2330', muted: '#6b7385',
  run: '#2f7cf6', ok: '#1f9d55', bad: '#d64545', off: '#9aa1ae', root: '#7a5af8',
  read: '#0e9384', edit: '#d97706', shell: '#7a5af8', agent: '#2f7cf6',
}
const DARK: Tokens = {
  bg: '#1c1f26', card: '#262a33', edge: '#424957', fg: '#e8eaef', muted: '#9aa1ae',
  run: '#5b9bff', ok: '#3ecf7a', bad: '#ff6b6b', off: '#6b7385', root: '#a48bff',
  read: '#2ec4b6', edit: '#f5a524', shell: '#a48bff', agent: '#5b9bff',
}
// The colour-blind themes keep done and failed apart without red against green
// (Okabe-Ito blue and vermillion), move running off blue and edits off amber
// so neither is mistaken for another state.
const DALTONIZED_LIGHT: Tokens = { run: '#009e73', ok: '#0072b2', bad: '#d55e00', agent: '#009e73', edit: '#cc79a7' }
const DALTONIZED_DARK: Tokens = { run: '#2fd1a0', ok: '#56b4e9', bad: '#e69f00', agent: '#2fd1a0', edit: '#e8a3cc' }

const vars = (t: Tokens) => Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(';')

// Claude Code's theme setting by name: a light or dark one is drawn as such
// whatever the OS says; `auto` (or a name we do not know) follows the system.
export function themeCss(theme: string): string {
  const dalton = theme.includes('daltonized')
  const light = { ...LIGHT, ...(dalton ? DALTONIZED_LIGHT : {}) }
  const dark = { ...DARK, ...(dalton ? DALTONIZED_DARK : {}) }
  if (theme.includes('light')) return `svg{color-scheme:light;${vars(light)}}`
  if (theme.includes('dark')) return `svg{color-scheme:dark;${vars(dark)}}`
  return `svg{color-scheme:light dark;${vars(light)}}\n@media (prefers-color-scheme: dark){svg{${vars(dark)}}}`
}

const BASE_CSS = `.canvas{fill:var(--bg)}
.title{fill:var(--fg);font:600 12px system-ui,-apple-system,"Segoe UI",sans-serif}
.detail{fill:var(--muted);font:10.5px ui-monospace,"Cascadia Code",Consolas,monospace}`

const GRAPH_CSS = `
.bg{fill:var(--card);stroke:var(--edge);stroke-width:1}
.link{fill:none;stroke:var(--edge);stroke-width:1.5}
.link.running{stroke:var(--run);stroke-dasharray:6 5;animation:flow .9s linear infinite}
.doing{fill:var(--run);font:10.5px ui-monospace,"Cascadia Code",Consolas,monospace}
.running .bar,.running .dot{fill:var(--run)}
.completed .bar,.completed .dot{fill:var(--ok)}
.failed .bar,.failed .dot{fill:var(--bad)}
.killed .bar,.killed .dot{fill:var(--off)}
.root .bar,.root .dot{fill:var(--root)}
.running .bg{stroke:var(--run)}
.running .dot{animation:pulse 1.2s ease-in-out infinite}
.sel .bg{stroke:var(--fg);stroke-width:2.5}
.card:hover .bg{stroke:var(--fg)}
.badge{fill:var(--fg)}
.badge-text{fill:var(--bg);font:600 10px system-ui,sans-serif;text-anchor:middle}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes flow{to{stroke-dashoffset:-11}}`

function card(p: Placed, title: string, line2: string, line3: string, doing: boolean, cls: string, tip: string): string {
  const x = p.x - BOX_W / 2
  const y = p.y
  const tx = x + 20
  const badge =
    p.hidden > 0
      ? `<circle class="badge" cx="${p.x}" cy="${y + BOX_H + 9}" r="9"/><text class="badge-text" x="${p.x}" y="${y + BOX_H + 12.5}">+${p.hidden}</text>`
      : ''
  return `<g class="card ${cls}"><title>${esc(tip)}</title>
<rect class="bg" x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="9"/>
<rect class="bar" x="${x}" y="${y}" width="4" height="${BOX_H}" rx="2"/>
<circle class="dot" cx="${x + 12}" cy="${y + 15}" r="4"/>
<text class="title" x="${tx}" y="${y + 19}">${esc(clip(title, BOX_W - 28))}</text>
<text class="detail" x="${tx}" y="${y + 36}">${esc(clip(line2, BOX_W - 28))}</text>
<text class="${doing ? 'doing' : 'detail'}" x="${tx}" y="${y + 52}">${esc(clip(line3, BOX_W - 28))}</text>${badge}</g>`
}

function doingLine(events: readonly ToolEvent[] | undefined): string | undefined {
  const now = current(events)
  return now ? `▸ ${now.tool}${now.arg ? ' ' + now.arg : ''}` : undefined
}

export function graphSvg(
  nodes: Record<string, AgentNode>,
  activity: Record<string, ToolEvent[]>,
  view: ViewState,
  now: number,
  mainToolCount: number,
  theme: string,
): { source: string; alt: string; height: number; width: number } {
  const lay = layout(nodes, view)
  const vp = viewport(lay, view)
  const where = new Map(lay.placed.map(p => [p.id, p]))
  const all = Object.values(nodes)
  const running = all.filter(n => n.status === 'running').length

  const edges = lay.placed
    .filter(p => p.parent !== undefined)
    .map(p => {
      const from = where.get(p.parent ?? ROOT)
      if (!from) return ''
      const y0 = from.y + BOX_H
      const mid = (y0 + p.y) / 2
      const cls = p.node?.status === 'running' ? 'link running' : 'link'
      return `<path class="${cls}" d="M${from.x} ${y0} C${from.x} ${mid} ${p.x} ${mid} ${p.x} ${p.y}"/>`
    })

  const cards = lay.placed.map(p => {
    const sel = p.id === view.selected ? ' sel' : ''
    const doing = doingLine(activity[p.id])
    if (!p.node) {
      const line2 = `${mainToolCount} tools · ${all.length} agents · ${running} running`
      return card(p, 'Main session', line2, doing ?? 'idle', doing !== undefined, `root${sel}`, 'Main session')
    }
    const n = p.node
    const age = elapsed((n.endedAt ?? now) - n.startedAt)
    const line2 = `${n.type} · ${n.toolCount} tools · ${age}`
    const line3 = (n.status === 'running' && doing) || STATUS_LABEL[n.status]
    const tip = `${n.description}\n${n.type} · ${STATUS_LABEL[n.status]} · ${n.toolCount} tools · ${age}${doing ? '\n' + doing : ''}`
    return card(p, n.description, line2, line3, n.status === 'running' && doing !== undefined, `${n.status}${sel}`, tip)
  })

  const box = `${vp.x.toFixed(1)} ${vp.y.toFixed(1)} ${vp.w.toFixed(1)} ${vp.h.toFixed(1)}`
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_W}" height="${vp.outH}" viewBox="${box}"><style>${themeCss(theme)}${BASE_CSS}${GRAPH_CSS}</style><rect class="canvas" x="${vp.x}" y="${vp.y}" width="${vp.w}" height="${vp.h}"/>${edges.join('')}${cards.join('')}</svg>`
  const alt = lay.placed
    .map(p => {
      const label = p.node ? `${p.node.description} (${p.node.type}, ${STATUS_LABEL[p.node.status]})` : 'Main session'
      return `${'  '.repeat(p.depth)}${label}${p.hidden ? ` +${p.hidden} folded` : ''}`
    })
    .join('\n')
  return { source, alt, height: vp.outH, width: OUT_W }
}

const TOOL_KIND: Record<string, string> = {
  Read: 'read', Grep: 'read', Glob: 'read', WebFetch: 'read', WebSearch: 'read', LS: 'read',
  Edit: 'edit', Write: 'edit', NotebookEdit: 'edit', MultiEdit: 'edit',
  Bash: 'shell', PowerShell: 'shell',
  Agent: 'agent', Workflow: 'agent', SendMessage: 'agent', Skill: 'agent',
}

const TIMELINE_CSS = `
.lane{fill:var(--card)}
.fill{opacity:.22}
.chip{font:600 10.5px ui-monospace,"Cascadia Code",Consolas,monospace}
.read{fill:var(--read)}.edit{fill:var(--edit)}.shell{fill:var(--shell)}.agent{fill:var(--agent)}.other{fill:var(--muted)}.err{fill:var(--bad)}
.live{animation:pulse 1.2s ease-in-out infinite}
.dur{fill:var(--muted);font:10px ui-monospace,Consolas,monospace;text-anchor:end}
.row:hover .lane{fill:var(--edge)}
@keyframes pulse{0%,100%{opacity:.35}50%{opacity:.12}}`

// One row per recent tool call, newest on top: the tool, what it touched, and
// a bar as long as the call took against the slowest call shown.
export function timelineSvg(events: readonly ToolEvent[], now: number, theme: string): { source: string; alt: string } {
  const ROW = 20
  const rows = [...events].reverse().slice(0, 14)
  const took = (e: ToolEvent) => (e.endedAt ?? now) - e.startedAt
  const longest = Math.max(1000, ...rows.map(took))
  const height = Math.max(ROW, rows.length * ROW) + 4
  const body = rows
    .map((e, i) => {
      const y = 2 + i * ROW
      const kind = e.isError ? 'err' : (TOOL_KIND[e.tool] ?? 'other')
      const bar = Math.max(3, ((OUT_W - 4) * took(e)) / longest)
      const live = e.endedAt === undefined ? ' live' : ''
      const tip = `${e.tool}${e.arg ? ': ' + e.arg : ''}\n${elapsed(took(e))}${e.endedAt === undefined ? ', running' : ''}${e.isError ? ', error' : ''}`
      return `<g class="row"><title>${esc(tip)}</title>
<rect class="lane" x="2" y="${y}" width="${OUT_W - 4}" height="${ROW - 3}" rx="4"/>
<rect class="fill ${kind}${live}" x="2" y="${y}" width="${bar.toFixed(1)}" height="${ROW - 3}" rx="4"/>
<text class="chip ${kind}" x="8" y="${y + 12.5}">${esc(clip(e.tool, 80))}</text>
<text class="detail" x="96" y="${y + 12.5}">${esc(clip(e.arg, OUT_W - 160))}</text>
<text class="dur" x="${OUT_W - 8}" y="${y + 12.5}">${elapsed(took(e))}</text></g>`
    })
    .join('')
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_W}" height="${height}" viewBox="0 0 ${OUT_W} ${height}"><style>${themeCss(theme)}${BASE_CSS}${TIMELINE_CSS}</style>${body}</svg>`
  const alt = rows.map(e => `${e.tool} ${e.arg} (${elapsed(took(e))})`).join('\n') || 'No tool calls yet'
  return { source, alt }
}
