import type { ToolEvent } from '../types'

const KEEP = 24
const ARG_KEYS = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'skill', 'description', 'prompt']

// The one argument that says what a call is about: the file it touches, the
// command it runs, what it searches for.
export function argSummary(input: Record<string, unknown>): string {
  for (const key of ARG_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return value.replace(/\s+/g, ' ').trim().slice(0, 160)
  }
  return ''
}

export function started(list: readonly ToolEvent[] | undefined, event: ToolEvent): ToolEvent[] {
  return [...(list ?? []), event].slice(-KEEP)
}

export function finished(list: readonly ToolEvent[] | undefined, id: string, at: number, isError: boolean): ToolEvent[] {
  return (list ?? []).map(one => (one.id === id ? { ...one, endedAt: at, ...(isError ? { isError } : {}) } : one))
}

export function current(list: readonly ToolEvent[] | undefined): ToolEvent | undefined {
  return [...(list ?? [])].reverse().find(one => one.endedAt === undefined)
}
