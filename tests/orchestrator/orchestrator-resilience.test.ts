import { describe, it, expect } from 'vitest'
import { DebateOrchestrator } from '../../src/orchestrator/orchestrator.js'
import type { AIProvider } from '../../src/providers/types.js'
import type { Reviewer } from '../../src/orchestrator/types.js'

const testCapabilities = {
  canReadRepo: false,
  canUseTools: false,
  canDisableTools: false,
  supportsStreaming: true,
  supportsAbort: false,
  supportsSession: false,
}

function makeProvider(name: string, response: string): AIProvider {
  return {
    name,
    capabilities: testCapabilities,
    async chat() { return response },
    async *chatStream() { yield response },
  }
}

function makeFailingProvider(name: string): AIProvider {
  return {
    name,
    capabilities: testCapabilities,
    async chat() { throw new Error(`${name} crashed`) },
    async *chatStream() { throw new Error(`${name} crashed`) },
  }
}

function makeFailOnCallsProvider(name: string, failedCalls: Set<number>): AIProvider {
  let call = 0
  return {
    name,
    capabilities: testCapabilities,
    async chat() { return `${name} response` },
    async *chatStream() {
      call++
      if (failedCalls.has(call)) {
        throw new Error(`${name} crashed`)
      }
      yield `${name} round ${call}`
    },
  }
}

function makeReviewer(id: string, provider: AIProvider): Reviewer {
  return { id, provider, systemPrompt: 'Review the code.' }
}

describe('DebateOrchestrator resilience', () => {
  it('should complete review when one reviewer fails in streaming mode', async () => {
    const goodProvider = makeProvider('good', 'LGTM, no issues found.')
    const badProvider = makeFailingProvider('bad')

    const reviewers = [
      makeReviewer('good-reviewer', goodProvider),
      makeReviewer('bad-reviewer', badProvider),
    ]
    const summarizer = makeReviewer('summarizer', makeProvider('sum', 'Final conclusion.'))
    const analyzer = makeReviewer('analyzer', makeProvider('analyzer', 'Analysis done.'))

    const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
    })

    const result = await orchestrator.runStreaming('test', 'Review this code')
    expect(result.finalConclusion).toBeTruthy()
    expect(result.messages.some(m => m.reviewerId === 'good-reviewer')).toBe(true)
  })

  it('should fail if ALL reviewers fail', async () => {
    const reviewers = [
      makeReviewer('bad-1', makeFailingProvider('bad1')),
      makeReviewer('bad-2', makeFailingProvider('bad2')),
    ]
    const summarizer = makeReviewer('summarizer', makeProvider('sum', 'Final conclusion.'))
    const analyzer = makeReviewer('analyzer', makeProvider('analyzer', 'Analysis done.'))

    const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
    })

    await expect(orchestrator.runStreaming('test', 'Review this code'))
      .rejects.toThrow('All reviewers failed')
  })

  it('should not check convergence for a partially successful current round', async () => {
    const convergencePrompts: string[] = []
    const reviewers = [
      makeReviewer('stable', makeFailOnCallsProvider('stable', new Set())),
      makeReviewer('flaky', makeFailOnCallsProvider('flaky', new Set([2]))),
    ]
    const summarizerProvider: AIProvider = {
      name: 'summarizer',
      capabilities: testCapabilities,
      async chat(messages) {
        const prompt = messages.map(message => message.content).join('\n')
        if (prompt.includes('TRUE CONSENSUS')) {
          convergencePrompts.push(prompt)
          return convergencePrompts.length === 1 ? 'Still different.\nNOT_CONVERGED' : 'Wrong partial convergence.\nCONVERGED'
        }
        return '```json\n{"issues":[]}\n```'
      },
      async *chatStream() { yield 'summary' },
    }
    const summarizer = makeReviewer('summarizer', summarizerProvider)
    const analyzer = makeReviewer('analyzer', makeProvider('analyzer', 'Analysis done.'))

    const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
      maxRounds: 3,
      interactive: false,
      checkConvergence: true,
      skipConclusion: true,
    })

    const result = await orchestrator.runStreaming('test', 'Review this code')

    expect(convergencePrompts).toHaveLength(1)
    expect(convergencePrompts[0]).toContain('stable round 1')
    expect(convergencePrompts[0]).toContain('flaky round 1')
    expect(result.messages.map(message => `${message.reviewerId}:${message.round}:${message.status}`)).toEqual([
      'stable:1:success',
      'flaky:1:success',
      'stable:2:success',
      'stable:3:success',
      'flaky:3:success',
    ])
  })
})
