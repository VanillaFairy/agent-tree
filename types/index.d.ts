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
  lastMessage?: string
  transcriptPath?: string
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
  zoom: number
  // Graph coordinates the view centres on; absent, the whole graph is fitted.
  center?: { x: number; y: number }
  hideFinished: boolean
  collapsed: string[]
  selected: string
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
    }
  }
}
