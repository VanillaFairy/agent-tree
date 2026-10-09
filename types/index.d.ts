export type AgentStatus = 'running' | 'completed' | 'failed' | 'killed'

export type AgentNode = {
  id: string
  parentId?: string
  type: string
  description: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  toolCount: number
}

export type ToolEvent = {
  id: string
  tool: string
  arg: string
  startedAt: number
  endedAt?: number
  isError?: boolean
}

export type ViewState = {
  // 1 fits the tree's width to the pane (magnifying a narrow tree only so far);
  // larger magnifies, smaller shrinks.
  zoom: number
  // Graph coordinates of the window's top-left corner while the tree overflows
  // it; absent, 0.
  left?: number
  top?: number
  // Where the window was before the last ◀ ▶ ▲ ▼ press: the drawing slides
  // from there, and the pane clears it once the slide is over.
  from?: { x: number; y: number }
}

declare module 'claude-code' {
  interface PluginState {
    'agent-tree': {
      nodes: Record<string, AgentNode>
      // Keyed by agent id, and 'main' for the main loop; newest last.
      activity: Record<string, ToolEvent[]>
      view: ViewState
      // Done agents are left out, save those with something under them not done.
      hideDone: boolean
      now: number
      mainToolCount: number
      // Claude Code's `theme` setting as /config names it (`dark`, `light-daltonized`, `auto`, ...).
      theme: string
      // The session's project folder name, the root node's label.
      project: string
      // The person closed the pane; only /agent-tree brings it back.
      hidden: boolean
    }
  }
}
