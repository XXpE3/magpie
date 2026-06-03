import chalk from 'chalk'
import type { ReviewerStatus } from '../../orchestrator/types.js'

export interface KeypressKey {
  name?: string
  ctrl?: boolean
  meta?: boolean
}

export function canForceProceed(statuses: ReviewerStatus[] | null | undefined): boolean {
  return statuses?.some(status => status.status === 'done') ?? false
}

export function isPlainForceProceedKey(input: string, key?: KeypressKey): boolean {
  if (key?.ctrl || key?.meta) return false
  return input === 'q' || input === 'Q'
}

export function formatParallelStatus(
  round: number,
  maxRounds: number,
  statuses: ReviewerStatus[],
  hasControl: boolean
): string {
  const statusParts = statuses.map(status => {
    if (status.status === 'done') {
      return chalk.green(`${status.reviewerId}:✓${elapsedSeconds(status).toFixed(1)}s`)
    }
    if (status.status === 'error') {
      return chalk.red(`${status.reviewerId}:✗${elapsedSeconds(status).toFixed(1)}s`)
    }
    if (status.status === 'cancelled') {
      return chalk.yellow(`${status.reviewerId}:⊘${elapsedSeconds(status).toFixed(1)}s`)
    }
    if (status.status === 'stalled') {
      return chalk.yellow(`${status.reviewerId}:⚠${status.stalledFor ?? Math.floor(elapsedSeconds(status))}s`)
    }
    if (status.status === 'streaming') {
      return chalk.cyan(`${status.reviewerId}:▸${formatChars(status.outputChars)}c`)
    }
    if (status.status === 'thinking') {
      return chalk.yellow(`${status.reviewerId}:…${Math.floor(elapsedSeconds(status))}s`)
    }
    return chalk.dim(`${status.reviewerId}:○`)
  })

  const hint = hasControl && canForceProceed(statuses) ? chalk.dim(' (press Q to finish current round)') : ''
  return `Round ${round}/${maxRounds}: parallel review [${statusParts.join(' ')}]${hint}`
}

function formatChars(chars = 0): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : `${chars}`
}

function elapsedSeconds(reviewerStatus: ReviewerStatus): number {
  if (reviewerStatus.duration !== undefined) return reviewerStatus.duration
  if (!reviewerStatus.startTime) return 0
  return (Date.now() - reviewerStatus.startTime) / 1000
}
