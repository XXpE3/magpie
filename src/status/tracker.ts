import type { TaskPhase, TaskState, TaskStatus } from './types.js'

export interface StatusTrackerOptions {
  quietMs?: number
  stalledMs?: number
}

export class StatusTracker {
  private tasks = new Map<string, TaskStatus>()
  private timer: ReturnType<typeof setInterval> | null = null
  private quietMs: number
  private stalledMs: number

  constructor(
    private readonly onChange: (snapshot: TaskStatus[]) => void,
    options: StatusTrackerOptions = {}
  ) {
    this.quietMs = options.quietMs ?? 30_000
    this.stalledMs = options.stalledMs ?? 60_000
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 1000)
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  begin(id: string, phase: TaskPhase, label = id): void {
    const now = Date.now()
    this.tasks.set(id, {
      id,
      phase,
      label,
      state: 'running',
      startedAt: now,
      lastActivityAt: now,
      outputChars: 0,
      chunkCount: 0,
    })
    this.emit()
  }

  pending(id: string, phase: TaskPhase, label = id): void {
    if (this.tasks.has(id)) return
    this.tasks.set(id, {
      id,
      phase,
      label,
      state: 'pending',
      outputChars: 0,
      chunkCount: 0,
    })
    this.emit()
  }

  pendingMany(tasks: Array<{ id: string; phase: TaskPhase; label?: string }>): void {
    let changed = false
    for (const task of tasks) {
      if (this.tasks.has(task.id)) continue
      this.tasks.set(task.id, {
        id: task.id,
        phase: task.phase,
        label: task.label ?? task.id,
        state: 'pending',
        outputChars: 0,
        chunkCount: 0,
      })
      changed = true
    }
    if (changed) this.emit()
  }

  activity(id: string, label?: string): void {
    const task = this.tasks.get(id)
    if (!task || isTerminal(task.state)) return

    this.tasks.set(id, {
      ...task,
      state: task.outputChars > 0 ? 'streaming' : 'working',
      lastActivityAt: Date.now(),
      activityLabel: label,
    })
    this.emit()
  }

  output(id: string, chunk: string): void {
    const task = this.tasks.get(id)
    if (!task || isTerminal(task.state)) return

    const now = Date.now()
    this.tasks.set(id, {
      ...task,
      state: 'streaming',
      lastActivityAt: now,
      lastOutputAt: now,
      outputChars: task.outputChars + chunk.length,
      chunkCount: task.chunkCount + 1,
      activityLabel: 'text output',
    })
    this.emit()
  }

  done(id: string): void {
    this.finish(id, 'done')
  }

  error(id: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.finish(id, 'error', message)
  }

  timeout(id: string, error?: unknown): void {
    const message = error instanceof Error ? error.message : error ? String(error) : undefined
    this.finish(id, 'timeout', message)
  }

  snapshot(): TaskStatus[] {
    return [...this.tasks.values()]
  }

  private finish(id: string, state: Extract<TaskState, 'done' | 'error' | 'timeout'>, error?: string): void {
    const task = this.tasks.get(id)
    if (!task) return

    this.tasks.set(id, {
      ...task,
      state,
      endedAt: Date.now(),
      error,
    })
    this.emit()
  }

  private tick(): void {
    const now = Date.now()
    let changed = false

    for (const [id, task] of this.tasks) {
      if (isTerminal(task.state)) continue

      const last = task.lastActivityAt ?? task.startedAt
      if (!last) continue

      const idleMs = now - last
      let nextState: TaskState | null = null

      if (idleMs >= this.stalledMs) {
        nextState = 'stalled'
      } else if (idleMs >= this.quietMs) {
        nextState = 'quiet'
      }

      if (nextState && task.state !== nextState) {
        this.tasks.set(id, { ...task, state: nextState })
        changed = true
      }
    }

    if (changed) this.emit()
  }

  private emit(): void {
    this.onChange(this.snapshot())
  }
}

function isTerminal(state: TaskState): boolean {
  return state === 'done' || state === 'error' || state === 'timeout'
}
