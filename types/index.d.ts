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
  // 1 shows the whole tree; larger values magnify it.
  zoom: number
  // Graph coordinates the view centres on; absent, the whole tree is fitted.
  center?: { x: number; y: number }
}

declare module 'claude-code' {
  interface PluginState {
    'agent-tree': {
      nodes: Record<string, AgentNode>
      // Keyed by agent id, and 'main' for the main loop; newest last.
      activity: Record<string, ToolEvent[]>
      view: ViewState
      now: number
      mainToolCount: number
      // Claude Code's `theme` setting as /config names it (`dark`, `light-daltonized`, `auto`, ...).
      theme: string
      // The session's project folder name, the root node's label.
      project: string
    }
  }
}
