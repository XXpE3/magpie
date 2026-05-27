import { describe, expect, it } from 'vitest'
import type { ReviewerStatus } from '../../src/orchestrator/types.js'
import { canForceProceed, formatParallelStatus, isPlainForceProceedKey } from '../../src/commands/review/parallel-status.js'

function status(reviewerId: string, state: ReviewerStatus['status']): ReviewerStatus {
  return { reviewerId, status: state }
}

describe('review parallel status helpers', () => {
  it('does not show force proceed hint before any reviewer is done', () => {
    const text = formatParallelStatus(1, 3, [status('a', 'pending'), status('b', 'streaming')], true)

    expect(canForceProceed([status('a', 'pending'), status('b', 'streaming')])).toBe(false)
    expect(text).not.toContain('(press Q to continue)')
  })

  it('shows force proceed hint once a reviewer is done and control exists', () => {
    const text = formatParallelStatus(1, 3, [status('a', 'done'), status('b', 'streaming')], true)

    expect(canForceProceed([status('a', 'done'), status('b', 'streaming')])).toBe(true)
    expect(text).toContain('(press Q to continue)')
  })

  it('only accepts unmodified q or Q as force proceed keys', () => {
    expect(isPlainForceProceedKey('q')).toBe(true)
    expect(isPlainForceProceedKey('Q')).toBe(true)
    expect(isPlainForceProceedKey('q', { name: 'q', ctrl: true })).toBe(false)
    expect(isPlainForceProceedKey('q', { name: 'q', meta: true })).toBe(false)
    expect(isPlainForceProceedKey('\u0003', { name: 'c', ctrl: true })).toBe(false)
    expect(isPlainForceProceedKey('x', { name: 'x' })).toBe(false)
  })
})
