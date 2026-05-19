export type TaskState =
  | 'pending'
  | 'running'
  | 'working'
  | 'streaming'
  | 'quiet'
  | 'stalled'
  | 'done'
  | 'error'
  | 'timeout'

export type TaskPhase =
  | 'context'
  | 'analyzer'
  | 'reviewer'
  | 'convergence'
  | 'summarizer'
  | 'structurizer'
  | 'verifier'

export interface TaskStatus {
  id: string
  phase: TaskPhase
  label: string
  state: TaskState
  startedAt?: number
  endedAt?: number
  lastActivityAt?: number
  lastOutputAt?: number
  outputChars: number
  chunkCount: number
  activityLabel?: string
  error?: string
}
