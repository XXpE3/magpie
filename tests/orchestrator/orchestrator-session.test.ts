import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DebateOrchestrator } from '../../src/orchestrator/orchestrator.js'
import type { Reviewer, OrchestratorOptions, ReviewerStatus } from '../../src/orchestrator/types.js'
import type { AIProvider, Message } from '../../src/providers/types.js'
import { parseReviewerOutput, parseFocusAreas, deduplicateIssues } from '../../src/orchestrator/issue-parser.js'

// Mock issue-parser to return minimal valid output
vi.mock('../../src/orchestrator/issue-parser.js', () => ({
  parseReviewerOutput: vi.fn(),
  parseFocusAreas: vi.fn(),
  deduplicateIssues: vi.fn()
}))

vi.mock('../../src/context-gatherer/collectors/reference-collector.js', () => ({
  formatCallChainForReviewer: vi.fn().mockReturnValue('')
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

function createMockReviewer(id: string): Reviewer {
  return {
    id,
    systemPrompt: 'test prompt',
    provider: {
      name: 'mock',
      chat: vi.fn().mockResolvedValue('mock response'),
      chatStream: vi.fn().mockImplementation(async function* () { yield 'mock' }),
      startSession: vi.fn(),
      endSession: vi.fn(),
      setCwd: vi.fn()
    }
  }
}

const testCapabilities = {
  canReadRepo: false,
  canUseTools: false,
  canDisableTools: false,
  supportsStreaming: true,
  supportsAbort: true,
  supportsSession: false,
}

function createCapturingReviewer(
  id: string,
  responses: string[],
  calls: Message[][],
  sessionId?: string
): Reviewer {
  let call = 0
  const provider: AIProvider = {
    name: id,
    capabilities: { ...testCapabilities, supportsSession: Boolean(sessionId) },
    sessionId,
    chat: vi.fn().mockResolvedValue('```json\n{"issues":[]}\n```'),
    chatStream: vi.fn().mockImplementation(async function* (messages: Message[]) {
      calls.push(messages.map(message => ({ ...message })))
      yield responses[call++] ?? `${id} response`
    }),
    startSession: vi.fn(),
    endSession: vi.fn(),
  }
  return { id, systemPrompt: `${id} prompt`, provider }
}

function createSecondCallPendingReviewer(
  id: string,
  calls: Message[][]
): Reviewer {
  let call = 0
  const provider: AIProvider = {
    name: id,
    capabilities: { ...testCapabilities, supportsSession: true },
    sessionId: `${id}-session`,
    chat: vi.fn().mockResolvedValue('```json\n{"issues":[]}\n```'),
    chatStream: vi.fn().mockImplementation(async function* (messages: Message[], _systemPrompt: string | undefined, options?: { signal?: AbortSignal }) {
      call++
      calls.push(messages.map(message => ({ ...message })))
      if (call === 2) {
        await new Promise<void>(resolve => {
          if (options?.signal?.aborted) {
            resolve()
            return
          }
          options?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return
      }
      yield `${id} round ${call}`
    }),
    startSession: vi.fn(),
    endSession: vi.fn(),
  }
  return { id, systemPrompt: `${id} prompt`, provider }
}

function messagesText(messages: Message[] | undefined): string {
  return messages?.map(message => message.content).join('\n') ?? ''
}

describe('DebateOrchestrator - review context visibility', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(parseReviewerOutput).mockReturnValue({ issues: [], verdict: 'comment', summary: 'no issues' })
    vi.mocked(parseFocusAreas).mockReturnValue([])
    vi.mocked(deduplicateIssues).mockReturnValue([])
  })

  it('passes current-round interactive user guidance to reviewers', async () => {
    const reviewerACalls: Message[][] = []
    const reviewerBCalls: Message[][] = []
    const reviewerA = createCapturingReviewer('a', ['a round 1', 'a round 2'], reviewerACalls)
    const reviewerB = createCapturingReviewer('b', ['b round 1', 'b round 2'], reviewerBCalls)
    const summarizer = createMockReviewer('summarizer')
    const analyzer = createMockReviewer('analyzer')
    let interactiveCall = 0

    const orchestrator = new DebateOrchestrator([reviewerA, reviewerB], summarizer, analyzer, {
      maxRounds: 2,
      interactive: true,
      checkConvergence: false,
      skipConclusion: true,
      onInteractive: vi.fn().mockImplementation(() => {
        interactiveCall++
        return interactiveCall === 2 ? 'focus on the migration edge case' : ''
      }),
    })

    await orchestrator.runStreaming('test', 'Review this code')

    expect(messagesText(reviewerACalls[1])).toContain('focus on the migration edge case')
    expect(messagesText(reviewerBCalls[1])).toContain('focus on the migration edge case')
  })

  it('does not include post-analysis Q&A messages in review-round context', async () => {
    const reviewerACalls: Message[][] = []
    const reviewerBCalls: Message[][] = []
    const reviewerA = createCapturingReviewer('a', ['qa answer', 'a round 1', 'a round 2'], reviewerACalls)
    const reviewerB = createCapturingReviewer('b', ['b round 1', 'b round 2'], reviewerBCalls)
    const summarizer = createMockReviewer('summarizer')
    const analyzer = createMockReviewer('analyzer')
    let asked = false

    const orchestrator = new DebateOrchestrator([reviewerA, reviewerB], summarizer, analyzer, {
      maxRounds: 2,
      interactive: false,
      checkConvergence: false,
      skipConclusion: true,
      onPostAnalysisQA: vi.fn().mockImplementation(() => {
        if (asked) return undefined
        asked = true
        return { target: 'a', question: 'Should reviewers consider QA-only detail?' }
      }),
    })

    await orchestrator.runStreaming('test', 'Review this code')

    const roundTwoContext = messagesText(reviewerBCalls[1])
    expect(roundTwoContext).not.toContain('[Question to a]')
    expect(roundTwoContext).not.toContain('Should reviewers consider QA-only detail?')
    expect(roundTwoContext).not.toContain('qa answer')
  })

  it('advances session seen state only after the reviewer response is delivered', async () => {
    const fastCalls: Message[][] = []
    const slowCalls: Message[][] = []
    const fast = createCapturingReviewer('fast', ['fast round 1', 'fast round 2', 'fast round 3'], fastCalls)
    const slow = createSecondCallPendingReviewer('slow', slowCalls)
    const summarizer = createMockReviewer('summarizer')
    const analyzer = createMockReviewer('analyzer')
    let control: { round: number; forceProceed(): void } | null = null
    let forced = false

    const orchestrator = new DebateOrchestrator([fast, slow], summarizer, analyzer, {
      maxRounds: 3,
      interactive: false,
      checkConvergence: false,
      skipConclusion: true,
      onParallelRoundControl: nextControl => {
        control = nextControl
      },
      onParallelStatus: (round, statuses: ReviewerStatus[]) => {
        const fastDone = statuses.some(status => status.reviewerId === 'fast' && status.status === 'done')
        const slowPending = statuses.some(status => status.reviewerId === 'slow' && status.status !== 'done')
        if (!forced && round === 2 && control && fastDone && slowPending) {
          forced = true
          control.forceProceed()
        }
      },
    })

    await orchestrator.runStreaming('test', 'Review this code')

    const slowRoundThreeContext = messagesText(slowCalls[2])
    expect(slowRoundThreeContext).toContain('fast round 1')
    expect(slowRoundThreeContext).toContain('fast round 2')
  })
})

describe('DebateOrchestrator - session cleanup', () => {
  let reviewerA: Reviewer
  let reviewerB: Reviewer
  let summarizer: Reviewer
  let analyzer: Reviewer

  beforeEach(() => {
    vi.resetAllMocks()
    // Re-setup module mocks after reset
    vi.mocked(parseReviewerOutput).mockReturnValue({ issues: [], verdict: 'comment', summary: 'no issues' })
    vi.mocked(parseFocusAreas).mockReturnValue([])
    vi.mocked(deduplicateIssues).mockReturnValue([])
    reviewerA = createMockReviewer('a')
    reviewerB = createMockReviewer('b')
    summarizer = createMockReviewer('summarizer')
    analyzer = createMockReviewer('analyzer')
  })

  it('calls endSession on all providers after successful run', async () => {
    const options: OrchestratorOptions = {
      maxRounds: 1,
      checkConvergence: false
    }
    const orchestrator = new DebateOrchestrator(
      [reviewerA, reviewerB], summarizer, analyzer, options
    )

    await orchestrator.run('test', 'test prompt')

    expect(reviewerA.provider.endSession).toHaveBeenCalled()
    expect(reviewerB.provider.endSession).toHaveBeenCalled()
    expect(summarizer.provider.endSession).toHaveBeenCalled()
    expect(analyzer.provider.endSession).toHaveBeenCalled()
  })

  it('calls endSession on all providers even when error occurs', async () => {
    // Make analyzer throw
    analyzer.provider.chat = vi.fn().mockRejectedValue(new Error('analyzer crashed'))

    const options: OrchestratorOptions = {
      maxRounds: 1,
      checkConvergence: false
    }
    const orchestrator = new DebateOrchestrator(
      [reviewerA], summarizer, analyzer, options
    )

    await expect(orchestrator.run('test', 'test prompt')).rejects.toThrow('analyzer crashed')

    // Sessions should still be cleaned up
    expect(reviewerA.provider.endSession).toHaveBeenCalled()
    expect(analyzer.provider.endSession).toHaveBeenCalled()
    expect(summarizer.provider.endSession).toHaveBeenCalled()
  })
})
