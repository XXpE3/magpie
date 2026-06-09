// tests/orchestrator/orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { DebateOrchestrator } from '../../src/orchestrator/orchestrator'
import type { AIProvider } from '../../src/providers/types'
import type { Reviewer } from '../../src/orchestrator/types'

const testCapabilities = {
  canReadRepo: false,
  canUseTools: false,
  canDisableTools: false,
  supportsStreaming: true,
  supportsAbort: false,
  supportsSession: false,
}

const createMockProvider = (name: string, responses: string[]): AIProvider => {
  let callCount = 0
  return {
    name,
    capabilities: testCapabilities,
    chat: vi.fn().mockImplementation(async () => responses[callCount++] || 'default'),
    chatStream: vi.fn().mockImplementation(async function* () {
      yield responses[callCount++] || 'default'
    })
  }
}

describe('DebateOrchestrator', () => {
  it('should run debate for specified rounds', async () => {
    const reviewerA: Reviewer = {
      id: 'reviewer-1',
      provider: createMockProvider('a', ['Round 1 from A', 'Round 2 from A', 'Summary A']),
      systemPrompt: 'You are reviewer A'
    }
    const reviewerB: Reviewer = {
      id: 'reviewer-2',
      provider: createMockProvider('b', ['Round 1 from B', 'Round 2 from B', 'Summary B']),
      systemPrompt: 'You are reviewer B'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider('s', ['Final conclusion']),
      systemPrompt: 'You are a summarizer'
    }
    const analyzer: Reviewer = {
      id: 'analyzer',
      provider: createMockProvider('analyzer', ['PR analysis result']),
      systemPrompt: 'You are an analyzer'
    }

    const orchestrator = new DebateOrchestrator(
      [reviewerA, reviewerB],
      summarizer,
      analyzer,
      { maxRounds: 2, interactive: false }
    )

    const result = await orchestrator.run('123', 'Review this PR')

    expect(result.prNumber).toBe('123')
    expect(result.analysis).toBe('PR analysis result')
    expect(result.messages.length).toBe(4) // 2 reviewers * 2 rounds
    expect(result.finalConclusion).toBe('Final conclusion')
  })

  it('should pass conversation history to reviewers', async () => {
    const mockChat = vi.fn().mockResolvedValue('response')
    const reviewerA: Reviewer = {
      id: 'reviewer-1',
      provider: { name: 'a', capabilities: testCapabilities, chat: mockChat, chatStream: vi.fn() },
      systemPrompt: 'You are A'
    }
    const reviewerB: Reviewer = {
      id: 'reviewer-2',
      provider: { name: 'b', capabilities: testCapabilities, chat: vi.fn().mockResolvedValue('B response'), chatStream: vi.fn() },
      systemPrompt: 'You are B'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: { name: 's', capabilities: testCapabilities, chat: vi.fn().mockResolvedValue('summary'), chatStream: vi.fn() },
      systemPrompt: 'Summarize'
    }
    const analyzer: Reviewer = {
      id: 'analyzer',
      provider: { name: 'analyzer', capabilities: testCapabilities, chat: vi.fn().mockResolvedValue('analysis'), chatStream: vi.fn() },
      systemPrompt: 'Analyze'
    }

    const orchestrator = new DebateOrchestrator(
      [reviewerA, reviewerB],
      summarizer,
      analyzer,
      { maxRounds: 1, interactive: false }
    )

    await orchestrator.run('123', 'Review PR')

    // First call should have initial prompt
    expect(mockChat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('Review PR') })
      ]),
      'You are A'
    )
  })

  it('extracts issues from all review rounds and deduplicates with source rounds', async () => {
    const reviewerA: Reviewer = {
      id: 'reviewer-1',
      provider: createMockProvider('a', [
        'Round 1 issue from reviewer 1: src/auth.ts line 42 has SQL injection risk',
        'Round 2 from reviewer 1: no additional issues'
      ]),
      systemPrompt: 'You are reviewer A'
    }
    const reviewerB: Reviewer = {
      id: 'reviewer-2',
      provider: createMockProvider('b', [
        'Round 1 duplicate from reviewer 2: src/auth.ts line 42 has SQL injection vulnerability',
        'Round 2 from reviewer 2: no additional issues'
      ]),
      systemPrompt: 'You are reviewer B'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider('s', [
        '```json\n{"issues":[{"severity":"high","category":"security","file":"src/auth.ts","line":42,"title":"SQL injection risk","description":"Query concatenates user input"}]}\n```',
        '```json\n{"issues":[{"severity":"medium","category":"security","file":"src/auth.ts","line":42,"title":"SQL injection vulnerability","description":"Query concatenates user input"}]}\n```',
        '```json\n{"issues":[]}\n```',
        'plain text without json',
        'still not json',
        'not json either',
        '```json\n{"verified":[{"index":0,"severity":"high","reason":"verified"}]}\n```'
      ]),
      systemPrompt: 'You are a summarizer'
    }
    const analyzer: Reviewer = {
      id: 'analyzer',
      provider: createMockProvider('analyzer', ['PR analysis result']),
      systemPrompt: 'You are an analyzer'
    }

    const orchestrator = new DebateOrchestrator(
      [reviewerA, reviewerB],
      summarizer,
      analyzer,
      { maxRounds: 2, interactive: false, checkConvergence: false, skipConclusion: true }
    )

    const result = await orchestrator.run('123', 'Review this PR')

    expect(result.parsedIssues).toHaveLength(1)
    expect(result.parsedIssues![0].raisedBy).toEqual(['reviewer-1', 'reviewer-2'])
    expect(result.parsedIssues![0].sources).toEqual([
      { reviewerId: 'reviewer-1', round: 1, messageIndex: 0 },
      { reviewerId: 'reviewer-2', round: 1, messageIndex: 1 }
    ])

    const summarizerChat = vi.mocked(summarizer.provider.chat)
    const firstExtractionPrompt = summarizerChat.mock.calls[0][0][0].content
    const secondExtractionPrompt = summarizerChat.mock.calls[1][0][0].content
    expect(firstExtractionPrompt).toContain('Round 1 issue from reviewer 1')
    expect(firstExtractionPrompt).not.toContain('Round 1 duplicate from reviewer 2')
    expect(secondExtractionPrompt).toContain('Round 1 duplicate from reviewer 2')
    expect(secondExtractionPrompt).not.toContain('Round 1 issue from reviewer 1')
  })

  it('retries when valid JSON contains only filtered issue objects', async () => {
    const reviewer: Reviewer = {
      id: 'reviewer-1',
      provider: createMockProvider('a', ['Review found src/auth.ts line 42 SQL injection']),
      systemPrompt: 'You are reviewer A'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider('s', [
        '```json\n{"issues":[{"severity":"invalid","category":"security","file":"src/auth.ts","line":42,"title":"SQL injection risk","description":"Query concatenates user input"}]}\n```',
        '```json\n{"issues":[{"severity":"high","category":"security","file":"src/auth.ts","line":42,"title":"SQL injection risk","description":"Query concatenates user input"}]}\n```',
        '```json\n{"verified":[{"index":0,"severity":"high","reason":"verified"}]}\n```'
      ]),
      systemPrompt: 'You are a summarizer'
    }
    const analyzer: Reviewer = {
      id: 'analyzer',
      provider: createMockProvider('analyzer', ['PR analysis result']),
      systemPrompt: 'You are an analyzer'
    }

    const orchestrator = new DebateOrchestrator(
      [reviewer],
      summarizer,
      analyzer,
      { maxRounds: 1, interactive: false, checkConvergence: false, skipConclusion: true }
    )

    const result = await orchestrator.run('123', 'Review this PR')

    expect(result.parsedIssues).toHaveLength(1)
    expect(result.parsedIssues![0].title).toBe('SQL injection risk')
    expect(vi.mocked(summarizer.provider.chat)).toHaveBeenCalledTimes(3)
  })

  it('resets summarizer sessions after structurizer chat failures', async () => {
    const reviewer: Reviewer = {
      id: 'reviewer-1',
      provider: createMockProvider('a', ['Review found no issues']),
      systemPrompt: 'You are reviewer A'
    }
    const endSession = vi.fn()
    const summarizerProvider: AIProvider = {
      name: 's',
      capabilities: testCapabilities,
      chat: vi.fn()
        .mockRejectedValueOnce(new Error('cli failed'))
        .mockResolvedValueOnce('```json\n{"issues":[]}\n```'),
      chatStream: vi.fn(),
      endSession
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: summarizerProvider,
      systemPrompt: 'You are a summarizer'
    }
    const analyzer: Reviewer = {
      id: 'analyzer',
      provider: createMockProvider('analyzer', ['PR analysis result']),
      systemPrompt: 'You are an analyzer'
    }

    const orchestrator = new DebateOrchestrator(
      [reviewer],
      summarizer,
      analyzer,
      { maxRounds: 1, interactive: false, checkConvergence: false, skipConclusion: true }
    )

    await orchestrator.run('123', 'Review this PR')

    expect(summarizerProvider.chat).toHaveBeenCalledTimes(2)
    expect(endSession.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('uses prior extracted issues to preserve cross-message confirmations', async () => {
    const reviewerA: Reviewer = {
      id: 'reviewer-1',
      provider: createMockProvider('a', [
        'src/auth.ts line 42 has SQL injection risk',
        'No additional issues'
      ]),
      systemPrompt: 'You are reviewer A'
    }
    const reviewerB: Reviewer = {
      id: 'reviewer-2',
      provider: createMockProvider('b', [
        'No independent issues',
        "I agree with reviewer-1's SQL injection finding; no additional issues"
      ]),
      systemPrompt: 'You are reviewer B'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider('s', [
        '```json\n{"issues":[{"severity":"high","category":"security","file":"src/auth.ts","line":42,"title":"SQL injection risk","description":"Query concatenates user input"}]}\n```',
        '```json\n{"issues":[]}\n```',
        '```json\n{"issues":[]}\n```',
        '```json\n{"issues":[{"severity":"high","category":"security","file":"src/auth.ts","line":42,"title":"SQL injection risk","description":"Reviewer confirms the query concatenates user input"}]}\n```',
        '```json\n{"verified":[{"index":0,"severity":"high","reason":"verified"}]}\n```'
      ]),
      systemPrompt: 'You are a summarizer'
    }
    const analyzer: Reviewer = {
      id: 'analyzer',
      provider: createMockProvider('analyzer', ['PR analysis result']),
      systemPrompt: 'You are an analyzer'
    }

    const orchestrator = new DebateOrchestrator(
      [reviewerA, reviewerB],
      summarizer,
      analyzer,
      { maxRounds: 2, interactive: false, checkConvergence: false, skipConclusion: true }
    )

    const result = await orchestrator.run('123', 'Review this PR')

    expect(result.parsedIssues).toHaveLength(1)
    expect(result.parsedIssues![0].raisedBy).toEqual(['reviewer-1', 'reviewer-2'])
    expect(result.parsedIssues![0].sources).toEqual([
      { reviewerId: 'reviewer-1', round: 1, messageIndex: 0 },
      { reviewerId: 'reviewer-2', round: 2, messageIndex: 3 }
    ])

    const confirmationPrompt = vi.mocked(summarizer.provider.chat).mock.calls[3][0][0].content
    expect(confirmationPrompt).toContain('Previously extracted issues for reference only')
    expect(confirmationPrompt).toContain('SQL injection risk')
  })
})
