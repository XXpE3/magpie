import chalk from 'chalk'
import type { TaskStatus } from './types.js'

export class StatusRenderer {
  private lastLineCount = 0

  render(tasks: TaskStatus[]): void {
    if (!process.stderr.isTTY) return

    const lines = this.buildLines(tasks)
    this.clear()
    if (lines.length === 0) return

    process.stderr.write(lines.join('\n') + '\n')
    this.lastLineCount = lines.length
  }

  clear(): void {
    if (!process.stderr.isTTY || this.lastLineCount === 0) return
    process.stderr.write(`\x1b[${this.lastLineCount}A`)
    process.stderr.write('\x1b[J')
    this.lastLineCount = 0
  }

  private buildLines(tasks: TaskStatus[]): string[] {
    return tasks.map(task => {
      const elapsed = formatElapsed(task)
      const chars = task.outputChars > 0 ? `${formatChars(task.outputChars)} chars` : 'no text'
      const activity = task.activityLabel ? `, ${task.activityLabel}` : ''
      const idle = formatIdle(task)

      return [
        chalk.dim(task.phase.padEnd(12)),
        task.label.padEnd(18),
        formatState(task).padEnd(14),
        chalk.dim(elapsed.padStart(6)),
        chalk.dim(chars.padEnd(10)),
        chalk.dim(`${idle}${activity}`),
      ].join(' ')
    })
  }
}

function formatState(task: TaskStatus): string {
  switch (task.state) {
    case 'pending': return chalk.dim('pending')
    case 'running': return chalk.yellow('thinking')
    case 'working': return chalk.yellow('working')
    case 'streaming': return chalk.cyan('streaming')
    case 'quiet': return chalk.yellow('quiet')
    case 'stalled': return chalk.red('stalled')
    case 'done': return chalk.green('done')
    case 'error': return chalk.red('error')
    case 'timeout': return chalk.red('timeout')
    case 'cancelled': return chalk.yellow('cancelled')
  }
}

function formatElapsed(task: TaskStatus): string {
  if (!task.startedAt) return ''
  const end = task.endedAt ?? Date.now()
  return `${((end - task.startedAt) / 1000).toFixed(1)}s`
}

function formatIdle(task: TaskStatus): string {
  if (!task.lastActivityAt || task.state === 'done' || task.state === 'error' || task.state === 'timeout' || task.state === 'cancelled') return ''
  const idleSeconds = Math.floor((Date.now() - task.lastActivityAt) / 1000)
  if (task.state === 'stalled') return `no provider activity for ${idleSeconds}s`
  if (task.state === 'quiet') return `quiet for ${idleSeconds}s`
  return `last activity ${idleSeconds}s ago`
}

function formatChars(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars)
}
