import { describe, it, expect, vi, afterEach } from 'vitest'
import { DebateOrchestrator } from '../../src/orchestrator/orchestrator.js'
import type { AIProvider } from '../../src/providers/types.js'
import type { Reviewer, ReviewerStatus } from '../../src/orchestrator/types.js'
import { StatusTracker } from '../../src/status/tracker.js'
import type { TaskStatus } from '../../src/status/types.js'

const testCapabilities = {
  canReadRepo: false,
  canUseTools: false,
  canDisableTools: false,
  supportsStreaming: true,
  supportsAbort: true,
  supportsSession: false,
}

function makeReviewer(id: string, provider: AIProvider): Reviewer {
  return { id, provider, systemPrompt: `${id} prompt` }
}

function makeStreamProvider(name: string, chunks: string[], delayMs = 0): AIProvider {
  return {
    name,
    capabilities: testCapabilities,
    async chat() { return '```json\n{"issues":[]}\n```' },
    async *chatStream() {
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
      for (const chunk of chunks) {
        yield chunk
      }
    }
  }
}

function makeAbortAwarePendingProvider(name: string, onAbort: () => void): AIProvider {
  return {
    name,
    capabilities: testCapabilities,
    async chat() { return '```json\n{"issues":[]}\n```' },
    async *chatStream(_messages, _systemPrompt, options) {
      await new Promise<void>(resolve => {
        if (options?.signal?.aborted) {
          onAbort()
          resolve()
          return
        }
        options?.signal?.addEventListener('abort', () => {
          onAbort()
          resolve()
        }, { once: true })
      })
    }
  }
}

function makeFirstCallPendingThenStreamProvider(name: string, onAbort: () => void): AIProvider {
  let call = 0
  return {
    name,
    capabilities: testCapabilities,
    async chat() { return '```json\n{"issues":[]}\n```' },
    async *chatStream(_messages, _systemPrompt, options) {
      call++
      if (call === 1) {
        await new Promise<void>(resolve => {
          if (options?.signal?.aborted) {
            onAbort()
            resolve()
            return
          }
          options?.signal?.addEventListener('abort', () => {
            onAbort()
            resolve()
          }, { once: true })
        })
        return
      }
      yield `${name} round ${call}`
    }
  }
}

function makeRoundCountingProvider(name: string): AIProvider {
  let call = 0
  return {
    name,
    capabilities: testCapabilities,
    async chat() { return '```json\n{"issues":[]}\n```' },
    async *chatStream() {
      call++
      yield `${name} round ${call}`
    }
  }
}


function makeControllableProvider(name: string, chunks: string[], onAbort: () => void): { provider: AIProvider; complete(): void } {
  let complete!: () => void
  const ready = new Promise<void>(resolve => {
    complete = resolve
  })
  return {
    provider: {
      name,
      capabilities: testCapabilities,
      async chat() { return '```json\n{"issues":[]}\n```' },
      async *chatStream(_messages, _systemPrompt, options) {
        if (options?.signal?.aborted) {
          onAbort()
          return
        }
        options?.signal?.addEventListener('abort', onAbort, { once: true })
        await ready
        for (const chunk of chunks) {
          yield chunk
        }
      }
    },
    complete,
  }
}

function makeActivityThenChunkProvider(name: string, activityDelays: number[], finalDelayMs: number, chunk: string): AIProvider {
  return {
    name,
    capabilities: testCapabilities,
    async chat() { return '```json\n{"issues":[]}\n```' },
    async *chatStream(_messages, _systemPrompt, options) {
      for (const delay of activityDelays) {
        await new Promise(resolve => setTimeout(resolve, delay))
        options?.onActivity?.({ kind: 'stdout' })
      }
      if (finalDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, finalDelayMs))
      }
      yield chunk
    }
  }
}

function snapshotStatus(snapshots: TaskStatus[][]): (snapshot: TaskStatus[]) => void {
  return snapshot => snapshots.push(snapshot.map(task => ({ ...task })))
}

describe('DebateOrchestrator streaming task status', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits pending, running, streaming, and done status with chunk activity', async () => {
    const snapshots: TaskStatus[][] = []
    const status = new StatusTracker(snapshotStatus(snapshots))
    const reviewer = makeReviewer('reviewer-1', makeStreamProvider('reviewer', ['hello', ' world']))
    const summarizer = makeReviewer('summarizer', makeStreamProvider('summarizer', ['summary']))
    const analyzer = makeReviewer('analyzer', makeStreamProvider('analyzer', ['analysis']))

    const orchestrator = new DebateOrchestrator([reviewer], summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
      skipConclusion: true,
      status
    })

    await orchestrator.runStreaming('test', 'Review this code')

    const reviewerStatuses = snapshots
      .map(snapshot => snapshot.find(task => task.id === 'reviewer:reviewer-1'))
      .filter((task): task is TaskStatus => Boolean(task))

    expect(reviewerStatuses.map(task => task.state)).toEqual(expect.arrayContaining([
      'pending',
      'running',
      'streaming',
      'done'
    ]))

    const streaming = reviewerStatuses.find(task => task.state === 'streaming')
    expect(streaming?.lastActivityAt).toEqual(expect.any(Number))
    expect(streaming?.chunkCount).toBeGreaterThan(0)
    expect(streaming?.outputChars).toBeGreaterThan(0)

    const done = reviewerStatuses.at(-1)
    expect(done?.state).toBe('done')
    expect(done?.chunkCount).toBe(2)
    expect(done?.outputChars).toBe('hello world'.length)
  })

  it('emits full status snapshots for every parallel reviewer', async () => {
    const snapshots: TaskStatus[][] = []
    const status = new StatusTracker(snapshotStatus(snapshots))
    const reviewers = [
      makeReviewer('codex', makeStreamProvider('codex', ['a'])),
      makeReviewer('claude', makeStreamProvider('claude', ['b'])),
      makeReviewer('gemini', makeStreamProvider('gemini', ['c']))
    ]
    const summarizer = makeReviewer('summarizer', makeStreamProvider('summarizer', ['summary']))
    const analyzer = makeReviewer('analyzer', makeStreamProvider('analyzer', ['analysis']))

    const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
      skipConclusion: true,
      status
    })

    await orchestrator.runStreaming('test', 'Review this code')

    const reviewerSnapshots = snapshots
      .map(snapshot => snapshot.filter(task => task.phase === 'reviewer'))
      .filter(snapshot => snapshot.length > 0)

    expect(reviewerSnapshots.length).toBeGreaterThan(0)
    for (const snapshot of reviewerSnapshots) {
      expect(snapshot.map(task => task.id)).toEqual(['reviewer:codex', 'reviewer:claude', 'reviewer:gemini'])
    }
    expect(reviewerSnapshots.some(snapshot => snapshot.every(task => ['running', 'streaming', 'done'].includes(task.state)))).toBe(true)
  })

  it('keeps legacy onParallelStatus snapshots for every parallel reviewer', async () => {
    const snapshots: ReviewerStatus[][] = []
    const reviewers = [
      makeReviewer('codex', makeStreamProvider('codex', ['a'])),
      makeReviewer('claude', makeStreamProvider('claude', ['b']))
    ]
    const summarizer = makeReviewer('summarizer', makeStreamProvider('summarizer', ['summary']))
    const analyzer = makeReviewer('analyzer', makeStreamProvider('analyzer', ['analysis']))

    const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
      skipConclusion: true,
      onParallelStatus: (_round, statuses) => snapshots.push(statuses.map(status => ({ ...status })))
    })

    await orchestrator.runStreaming('test', 'Review this code')

    expect(snapshots.length).toBeGreaterThan(0)
    for (const snapshot of snapshots) {
      expect(snapshot.map(status => status.reviewerId)).toEqual(['codex', 'claude'])
    }
    expect(snapshots.at(-1)?.map(status => status.status)).toEqual(['done', 'done'])
  })

  it('isolates legacy onParallelStatus callback failures', async () => {
    const reviewer = makeReviewer('reviewer', makeStreamProvider('reviewer', ['review']))
    const summarizer = makeReviewer('summarizer', makeStreamProvider('summarizer', ['summary']))
    const analyzer = makeReviewer('analyzer', makeStreamProvider('analyzer', ['analysis']))

    const orchestrator = new DebateOrchestrator([reviewer], summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
      skipConclusion: true,
      onParallelStatus: () => { throw new Error('observer failed') }
    })

    await expect(orchestrator.runStreaming('test', 'Review this code')).resolves.toBeDefined()
  })

  it('throttles legacy onParallelStatus updates during high-volume streaming', async () => {
    let statusCalls = 0
    const chunks = Array.from({ length: 100 }, () => 'x')
    const reviewer = makeReviewer('reviewer', makeStreamProvider('reviewer', chunks))
    const summarizer = makeReviewer('summarizer', makeStreamProvider('summarizer', ['summary']))
    const analyzer = makeReviewer('analyzer', makeStreamProvider('analyzer', ['analysis']))

    const orchestrator = new DebateOrchestrator([reviewer], summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
      skipConclusion: true,
      onParallelStatus: () => { statusCalls++ }
    })

    await orchestrator.runStreaming('test', 'Review this code')

    expect(statusCalls).toBeGreaterThan(0)
    expect(statusCalls).toBeLessThan(20)
  })

  it('keeps legacy reviewers active when providers report activity before text chunks', async () => {
    vi.useFakeTimers()

    const snapshots: ReviewerStatus[][] = []
    const reviewer = makeReviewer('cli-reviewer', makeActivityThenChunkProvider('cli', [20_000, 20_000, 20_000], 5_000, 'done'))
    const summarizer = makeReviewer('summarizer', makeStreamProvider('summarizer', ['summary']))
    const analyzer = makeReviewer('analyzer', makeStreamProvider('analyzer', ['analysis']))

    const orchestrator = new DebateOrchestrator([reviewer], summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
      skipConclusion: true,
      onParallelStatus: (_round, statuses) => snapshots.push(statuses.map(status => ({ ...status })))
    })

    const runPromise = orchestrator.runStreaming('test', 'Review this code')

    await vi.advanceTimersByTimeAsync(61_000)
    const reviewerSnapshots = snapshots
      .map(snapshot => snapshot.find(status => status.reviewerId === 'cli-reviewer'))
      .filter((status): status is ReviewerStatus => Boolean(status))

    expect(reviewerSnapshots.length).toBeGreaterThan(0)
    expect(reviewerSnapshots.some(status => status.status === 'stalled')).toBe(false)
    expect(reviewerSnapshots.at(-1)?.lastActivityAt).toBeGreaterThanOrEqual(Date.now() - 1_000)

    await vi.advanceTimersByTimeAsync(5_000)
    await runPromise
  })

  it('ignores force proceed before any reviewer has completed', async () => {
    let control: { forceProceed(): void } | null = null
    let firstAborted = false
    let secondAborted = false
    const firstProvider = makeControllableProvider('first', ['first result'], () => { firstAborted = true })
    const secondProvider = makeControllableProvider('second', ['second result'], () => { secondAborted = true })
    const reviewers = [
      makeReviewer('first', firstProvider.provider),
      makeReviewer('second', secondProvider.provider)
    ]
    const summarizer = makeReviewer('summarizer', makeStreamProvider('summarizer', ['summary']))
    const analyzer = makeReviewer('analyzer', makeStreamProvider('analyzer', ['analysis']))

    const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
      skipConclusion: true,
      onParallelRoundControl: nextControl => {
        control = nextControl
        control?.forceProceed()
      },
    })

    const runPromise = orchestrator.runStreaming('test', 'Review this code')
    await Promise.resolve()
    expect(firstAborted).toBe(false)
    expect(secondAborted).toBe(false)

    firstProvider.complete()
    secondProvider.complete()
    const result = await runPromise

    expect(firstAborted).toBe(false)
    expect(secondAborted).toBe(false)
    expect(result.messages.map(message => message.reviewerId).sort()).toEqual(['first', 'second'])
  })

  it('force-proceeds only the current round and continues later rounds', async () => {
    let control: { forceProceed(): void } | null = null
    let forced = false
    let slowAborted = false
    const completedRounds: number[] = []
    const taskSnapshots: TaskStatus[][] = []
    const legacySnapshots: Array<{ round: number; statuses: ReviewerStatus[] }> = []
    const failedMessages: string[] = []
    const status = new StatusTracker(snapshotStatus(taskSnapshots))

    const fast = makeReviewer('fast', makeRoundCountingProvider('fast'))
    const slow = makeReviewer('slow', makeFirstCallPendingThenStreamProvider('slow', () => { slowAborted = true }))
    const summarizer = makeReviewer('summarizer', makeStreamProvider('summarizer', ['summary']))
    const analyzer = makeReviewer('analyzer', makeStreamProvider('analyzer', ['analysis']))

    const orchestrator = new DebateOrchestrator([fast, slow], summarizer, analyzer, {
      maxRounds: 3,
      status,
      interactive: false,
      checkConvergence: false,
      skipConclusion: true,
      onParallelRoundControl: nextControl => {
        control = nextControl
      },
      onParallelStatus: (round, statuses) => {
        const fastDone = statuses.some(status => status.reviewerId === 'fast' && status.status === 'done')
        const slowPending = statuses.some(status => status.reviewerId === 'slow' && status.status !== 'done')
        legacySnapshots.push({ round, statuses: statuses.map(status => ({ ...status })) })
        if (!forced && control && fastDone && slowPending) {
          forced = true
          control.forceProceed()
        }
      },
      onRoundComplete: round => {
        completedRounds.push(round)
      },
      onMessage: (_reviewerId, chunk) => {
        if (chunk.includes('[Review failed')) failedMessages.push(chunk)
      },
    })

    const result = await orchestrator.runStreaming('test', 'Review this code')

    expect(slowAborted).toBe(true)
    expect(completedRounds).toEqual([1, 2, 3])
    expect(result.messages.map(message => message.reviewerId)).toEqual(['fast', 'fast', 'slow', 'fast', 'slow'])
    expect(result.messages.map(message => message.content)).toEqual([
      'fast round 1',
      'fast round 2',
      'slow round 2',
      'fast round 3',
      'slow round 3',
    ])
    const roundOneCancelled = legacySnapshots
      .filter(snapshot => snapshot.round === 1)
      .some(snapshot => snapshot.statuses.find(status => status.reviewerId === 'slow')?.status === 'cancelled')
    expect(roundOneCancelled).toBe(true)
    expect(taskSnapshots.flat().find(task => task.id === 'reviewer:slow' && task.state === 'cancelled')?.error).toBe('Force proceed requested')
    expect(taskSnapshots.flat().some(task => task.id === 'reviewer:slow' && task.state === 'error' && task.error?.includes('Force proceed requested'))).toBe(false)
    expect(failedMessages).toEqual([])
  })

  it('preserves final conclusion result and summarizer token usage with status tracking', async () => {
    const snapshots: TaskStatus[][] = []
    const status = new StatusTracker(snapshotStatus(snapshots))
    const reviewer = makeReviewer('reviewer-1', makeStreamProvider('reviewer', ['LGTM']))
    const summarizer = makeReviewer('summarizer', makeStreamProvider('summarizer', ['Final', ' conclusion']))
    const analyzer = makeReviewer('analyzer', makeStreamProvider('analyzer', ['analysis']))

    const orchestrator = new DebateOrchestrator([reviewer], summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
      status
    })

    const result = await orchestrator.runStreaming('test', 'Review this code')

    expect(result.finalConclusion).toBe('Final conclusion')
    expect(result.tokenUsage.find(usage => usage.reviewerId === 'summarizer')?.outputTokens).toBeGreaterThan(0)
    expect(snapshots.flat().some(task => task.id === 'summarizer' && task.state === 'done')).toBe(true)
  })

  it('marks running reviewers as stalled after inactivity threshold', async () => {
    vi.useFakeTimers()

    const snapshots: TaskStatus[][] = []
    const status = new StatusTracker(snapshotStatus(snapshots))
    status.start()
    const reviewer = makeReviewer('slow-reviewer', makeStreamProvider('reviewer', ['late'], 62_000))
    const summarizer = makeReviewer('summarizer', makeStreamProvider('summarizer', ['summary']))
    const analyzer = makeReviewer('analyzer', makeStreamProvider('analyzer', ['analysis']))

    const orchestrator = new DebateOrchestrator([reviewer], summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
      skipConclusion: true,
      status
    })

    const runPromise = orchestrator.runStreaming('test', 'Review this code')

    await vi.advanceTimersByTimeAsync(61_000)
    expect(snapshots.flat().some(task => task.id === 'reviewer:slow-reviewer' && task.state === 'stalled')).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)
    await runPromise
    status.stop()
  })

  it('refreshes active task snapshots on timer ticks even when state does not change', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    const snapshots: TaskStatus[][] = []
    const status = new StatusTracker(snapshotStatus(snapshots))
    status.start()
    status.begin('task', 'reviewer', 'reviewer')

    const afterBegin = snapshots.length
    await vi.advanceTimersByTimeAsync(2_000)

    expect(snapshots.length).toBeGreaterThan(afterBegin)
    status.stop()
  })

  it('throttles repeated output snapshots without dropping terminal updates', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    const snapshots: TaskStatus[][] = []
    const status = new StatusTracker(snapshotStatus(snapshots), { renderThrottleMs: 100 })
    status.begin('task', 'reviewer', 'reviewer')
    status.output('task', 'a')

    const afterFirstOutput = snapshots.length
    status.output('task', 'b')
    status.output('task', 'c')
    expect(snapshots.length).toBe(afterFirstOutput)

    await vi.advanceTimersByTimeAsync(100)
    expect(snapshots.length).toBeGreaterThan(afterFirstOutput)

    const beforeDone = snapshots.length
    status.done('task')
    expect(snapshots.length).toBe(beforeDone + 1)
    expect(snapshots.at(-1)?.find(task => task.id === 'task')?.state).toBe('done')
    status.stop()
  })
})
