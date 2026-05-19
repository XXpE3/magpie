import { describe, it, expect, vi, afterEach } from 'vitest'
import { DebateOrchestrator } from '../../src/orchestrator/orchestrator.js'
import type { AIProvider } from '../../src/providers/types.js'
import type { Reviewer, ReviewerStatus } from '../../src/orchestrator/types.js'
import { StatusTracker } from '../../src/status/tracker.js'
import type { TaskStatus } from '../../src/status/types.js'

function makeReviewer(id: string, provider: AIProvider): Reviewer {
  return { id, provider, systemPrompt: `${id} prompt` }
}

function makeStreamProvider(name: string, chunks: string[], delayMs = 0): AIProvider {
  return {
    name,
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
})
