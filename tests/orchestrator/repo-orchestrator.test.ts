// tests/orchestrator/repo-orchestrator.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RepoOrchestrator } from '../../src/orchestrator/repo-orchestrator.js'
import type { AIProvider } from '../../src/providers/types.js'
import type { Reviewer } from '../../src/orchestrator/types.js'
import type { ReviewPlan, ReviewStep } from '../../src/planner/types.js'
import type { FeaturePlan, FeatureStep } from '../../src/planner/feature-planner.js'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const testCapabilities = {
  canReadRepo: false,
  canUseTools: false,
  canDisableTools: false,
  supportsStreaming: true,
  supportsAbort: false,
  supportsSession: false,
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const createMockProvider = (responses: string[], capabilities: AIProvider['capabilities'] = testCapabilities): AIProvider => {
  let callCount = 0
  return {
    name: 'mock',
    capabilities,
    chat: vi.fn().mockImplementation(async () => responses[callCount++] || 'default'),
    chatStream: vi.fn().mockImplementation(async function* () {
      yield responses[callCount++] || 'default'
    })
  }
}

describe('RepoOrchestrator', () => {
  it('should execute review steps sequentially', async () => {
    const reviewerA: Reviewer = {
      id: 'security',
      provider: createMockProvider(['Found issue 1', 'Summary A']),
      systemPrompt: 'Security expert'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Final report']),
      systemPrompt: 'Summarizer'
    }

    const plan: ReviewPlan = {
      steps: [
        { name: 'src/core', description: 'Review core', files: [], estimatedTokens: 1000 }
      ],
      totalEstimatedTokens: 1000,
      totalEstimatedCost: 0.01
    }

    const orchestrator = new RepoOrchestrator([reviewerA], summarizer, {
      onStepStart: vi.fn(),
      onStepComplete: vi.fn()
    })

    const result = await orchestrator.executePlan(plan, 'test-repo')

    expect(result.issues).toBeDefined()
    expect(result.architectureAnalysis).toBeDefined()
  })

  it('should parse issues from reviewer responses', async () => {
    const reviewerA: Reviewer = {
      id: 'security',
      provider: createMockProvider([
        'ISSUE: [src/api.ts:10] - [SQL injection vulnerability] - [severity: high]'
      ]),
      systemPrompt: 'Security expert'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Architecture looks good']),
      systemPrompt: 'Summarizer'
    }

    const plan: ReviewPlan = {
      steps: [
        { name: 'src/api', description: 'Review API', files: [], estimatedTokens: 500 }
      ],
      totalEstimatedTokens: 500,
      totalEstimatedCost: 0.005
    }

    const orchestrator = new RepoOrchestrator([reviewerA], summarizer)
    const result = await orchestrator.executePlan(plan, 'test-repo')

    expect(result.issues.length).toBe(1)
    expect(result.issues[0].location).toBe('src/api.ts:10')
    expect(result.issues[0].description).toBe('SQL injection vulnerability')
    expect(result.issues[0].severity).toBe('high')
  })

  it('should parse issues from unified JSON schema responses', async () => {
    const reviewerA: Reviewer = {
      id: 'security',
      provider: createMockProvider([
        `\`\`\`json
{
  "issues": [
    {
      "severity": "medium",
      "category": "error-handling",
      "file": "src/api.ts",
      "line": 42,
      "title": "Missing error branch",
      "description": "The request failure path is ignored.",
      "suggestedFix": "Return an error response when the request fails.",
      "evidence": "src/api.ts:42 drops the rejected promise"
    }
  ],
  "verdict": "request_changes",
  "summary": "One issue"
}
\`\`\``
      ]),
      systemPrompt: 'Security expert'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Architecture looks good']),
      systemPrompt: 'Summarizer'
    }

    const plan: ReviewPlan = {
      steps: [
        { name: 'src/api', description: 'Review API', files: [], estimatedTokens: 500 }
      ],
      totalEstimatedTokens: 500,
      totalEstimatedCost: 0.005
    }

    const orchestrator = new RepoOrchestrator([reviewerA], summarizer)
    const result = await orchestrator.executePlan(plan, 'test-repo')

    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({
      location: 'src/api.ts:42',
      file: 'src/api.ts',
      line: 42,
      severity: 'medium',
      category: 'error-handling',
      title: 'Missing error branch',
      description: 'The request failure path is ignored.',
      suggestedFix: 'Return an error response when the request fails.',
      evidence: 'src/api.ts:42 drops the rejected promise'
    })
  })

  it('should embed real file contents for API providers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'magpie-repo-review-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'api.ts')
    await writeFile(filePath, 'export const token = "real-content"\n', 'utf8')

    const reviewerProvider = createMockProvider(['{"issues":[]}'])
    const reviewer: Reviewer = {
      id: 'api',
      provider: reviewerProvider,
      systemPrompt: 'API reviewer'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Summary']),
      systemPrompt: 'Summarizer'
    }

    const plan: ReviewPlan = {
      steps: [{
        name: 'api',
        description: 'Review API',
        files: [{ path: filePath, relativePath: 'api.ts', language: 'typescript', lines: 1, size: 36 }],
        estimatedTokens: 100
      }],
      totalEstimatedTokens: 100,
      totalEstimatedCost: 0.001
    }

    const orchestrator = new RepoOrchestrator([reviewer], summarizer)
    await orchestrator.executePlan(plan, 'test-repo')

    const prompt = vi.mocked(reviewerProvider.chat).mock.calls[0][0][0].content
    expect(prompt).toContain('## api.ts')
    expect(prompt).toContain('export const token = "real-content"')
    expect(prompt).toContain('"evidence"')
  })

  it('should keep CLI providers in readable repository mode', async () => {
    const cliCapabilities = { ...testCapabilities, canReadRepo: true, canUseTools: true }
    const reviewerProvider = createMockProvider(['{"issues":[]}'], cliCapabilities)
    const reviewer: Reviewer = {
      id: 'cli',
      provider: reviewerProvider,
      systemPrompt: 'CLI reviewer'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Summary']),
      systemPrompt: 'Summarizer'
    }
    const plan: ReviewPlan = {
      steps: [{
        name: 'api',
        description: 'Review API',
        files: [{ path: '/repo/api.ts', relativePath: 'api.ts', language: 'typescript', lines: 1, size: 36 }],
        estimatedTokens: 100
      }],
      totalEstimatedTokens: 100,
      totalEstimatedCost: 0.001
    }

    const orchestrator = new RepoOrchestrator([reviewer], summarizer)
    await orchestrator.executePlan(plan, 'test-repo')

    const prompt = vi.mocked(reviewerProvider.chat).mock.calls[0][0][0].content
    expect(prompt).toContain('Use your repository tools')
    expect(prompt).toContain('api.ts')
    expect(prompt).not.toContain('```typescript')
  })

  it('should chunk API prompts by prompt limits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'magpie-repo-review-'))
    tempDirs.push(dir)
    const files = []
    for (let i = 0; i < 3; i++) {
      const filePath = join(dir, `file${i}.ts`)
      await writeFile(filePath, `export const value${i} = ${i}\n`, 'utf8')
      files.push({ path: filePath, relativePath: `file${i}.ts`, language: 'typescript', lines: 1, size: 24 })
    }

    const reviewerProvider = createMockProvider(['{"issues":[]}', '{"issues":[]}', '{"issues":[]}'])
    const reviewer: Reviewer = {
      id: 'api',
      provider: reviewerProvider,
      systemPrompt: 'API reviewer'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Summary']),
      systemPrompt: 'Summarizer'
    }
    const plan: ReviewPlan = {
      steps: [{ name: 'chunked', description: 'Review chunks', files, estimatedTokens: 100 }],
      totalEstimatedTokens: 100,
      totalEstimatedCost: 0.001
    }

    const orchestrator = new RepoOrchestrator([reviewer], summarizer, {
      promptLimits: { maxFilesPerPrompt: 1, maxFileBytes: 100, maxPromptChars: 4_000 }
    })
    await orchestrator.executePlan(plan, 'test-repo')

    expect(reviewerProvider.chat).toHaveBeenCalledTimes(3)
    const prompts = vi.mocked(reviewerProvider.chat).mock.calls.map(call => call[0][0].content)
    expect(prompts[0]).toContain('file0.ts')
    expect(prompts[0]).not.toContain('file1.ts')
    expect(prompts[1]).toContain('file1.ts')
    expect(prompts[2]).toContain('file2.ts')
  })

  it('should call onStepStart and onStepComplete callbacks', async () => {
    const reviewerA: Reviewer = {
      id: 'reviewer',
      provider: createMockProvider(['No issues found']),
      systemPrompt: 'Reviewer'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Summary']),
      systemPrompt: 'Summarizer'
    }

    const onStepStart = vi.fn()
    const onStepComplete = vi.fn()

    const plan: ReviewPlan = {
      steps: [
        { name: 'step1', description: 'Step 1', files: [], estimatedTokens: 100 },
        { name: 'step2', description: 'Step 2', files: [], estimatedTokens: 100 }
      ],
      totalEstimatedTokens: 200,
      totalEstimatedCost: 0.002
    }

    const orchestrator = new RepoOrchestrator([reviewerA], summarizer, {
      onStepStart,
      onStepComplete
    })

    await orchestrator.executePlan(plan, 'test-repo')

    expect(onStepStart).toHaveBeenCalledTimes(2)
    expect(onStepComplete).toHaveBeenCalledTimes(2)
    expect(onStepStart).toHaveBeenCalledWith(plan.steps[0], 0, 2)
    expect(onStepStart).toHaveBeenCalledWith(plan.steps[1], 1, 2)
  })

  it('should debate high-severity issues', async () => {
    const reviewerA: Reviewer = {
      id: 'security',
      provider: createMockProvider([
        'ISSUE: [src/auth.ts:5] - [Hardcoded credentials] - [severity: high]',
        'This is definitely a critical issue'
      ]),
      systemPrompt: 'Security expert'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Architecture analysis']),
      systemPrompt: 'Summarizer'
    }

    const onDebate = vi.fn()

    const plan: ReviewPlan = {
      steps: [
        { name: 'src/auth', description: 'Review auth', files: [], estimatedTokens: 300 }
      ],
      totalEstimatedTokens: 300,
      totalEstimatedCost: 0.003
    }

    const orchestrator = new RepoOrchestrator([reviewerA], summarizer, { onDebate })
    const result = await orchestrator.executePlan(plan, 'test-repo')

    expect(onDebate).toHaveBeenCalled()
    expect(result.issues[0].debateSummary).toBeDefined()
  })

  it('should return correct token usage from plan', async () => {
    const reviewer: Reviewer = {
      id: 'reviewer',
      provider: createMockProvider(['No issues']),
      systemPrompt: 'Reviewer'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Summary']),
      systemPrompt: 'Summarizer'
    }

    const plan: ReviewPlan = {
      steps: [{ name: 'step1', description: 'Step 1', files: [], estimatedTokens: 1500 }],
      totalEstimatedTokens: 1500,
      totalEstimatedCost: 0.015
    }

    const orchestrator = new RepoOrchestrator([reviewer], summarizer)
    const result = await orchestrator.executePlan(plan, 'test-repo')

    expect(result.tokenUsage.total).toBe(1500)
    expect(result.tokenUsage.cost).toBe(0.015)
  })
})

describe('RepoOrchestrator - Feature Based', () => {
  const mockProvider = {
    name: 'mock',
    capabilities: testCapabilities,
    chat: vi.fn().mockResolvedValue('ISSUE: [test.ts:10] - [test issue] - [severity: medium]')
  }

  const mockReviewer = {
    id: 'reviewer1',
    provider: mockProvider,
    systemPrompt: 'Review code'
  }

  const mockSummarizer = {
    id: 'summarizer',
    provider: mockProvider,
    systemPrompt: 'Summarize'
  }

  it('should execute feature plan and track results', async () => {
    const featurePlan: FeaturePlan = {
      steps: [
        {
          featureId: 'write',
          name: 'Write Operations',
          description: 'Insert and update',
          files: [{ path: '/a.ts', relativePath: 'a.ts', language: 'ts', lines: 100, size: 1000 }],
          estimatedTokens: 250
        }
      ],
      totalEstimatedTokens: 250,
      totalEstimatedCost: 0.0025
    }

    const orchestrator = new RepoOrchestrator([mockReviewer], mockSummarizer, {})
    const result = await orchestrator.executeFeaturePlan(featurePlan, 'test-repo')

    expect(result.featureResults).toBeDefined()
    expect(result.featureResults['write']).toBeDefined()
    expect(result.featureResults['write'].issues.length).toBeGreaterThanOrEqual(0)
  })

  it('should call onFeatureComplete callback', async () => {
    const onFeatureComplete = vi.fn()

    const featurePlan: FeaturePlan = {
      steps: [
        { featureId: 'write', name: 'Write', description: '', files: [], estimatedTokens: 100 }
      ],
      totalEstimatedTokens: 100,
      totalEstimatedCost: 0.001
    }

    const orchestrator = new RepoOrchestrator([mockReviewer], mockSummarizer, {
      onFeatureComplete
    })

    await orchestrator.executeFeaturePlan(featurePlan, 'test-repo')

    expect(onFeatureComplete).toHaveBeenCalledWith('write', expect.any(Object))
  })

  it('should wait for async onFeatureComplete callback', async () => {
    let saved = false

    const featurePlan: FeaturePlan = {
      steps: [
        { featureId: 'write', name: 'Write', description: '', files: [], estimatedTokens: 100 }
      ],
      totalEstimatedTokens: 100,
      totalEstimatedCost: 0.001
    }

    const orchestrator = new RepoOrchestrator([mockReviewer], mockSummarizer, {
      onFeatureComplete: async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
        saved = true
      }
    })

    await orchestrator.executeFeaturePlan(featurePlan, 'test-repo')

    expect(saved).toBe(true)
  })
})
