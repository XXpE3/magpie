import { describe, expect, it, vi } from 'vitest'
import { buildReviewTargetPayload, DebateOrchestrator, selectReviewPrompt } from '../../src/orchestrator/orchestrator.js'
import type { ReviewTarget, Reviewer } from '../../src/orchestrator/types.js'
import type { AIProvider, ProviderCapabilities } from '../../src/providers/types.js'
import type { GatheredContext } from '../../src/context-gatherer/types.js'
import type { ContextGatherer } from '../../src/context-gatherer/gatherer.js'

const apiCapabilities: ProviderCapabilities = {
  canReadRepo: false,
  canUseTools: false,
  canDisableTools: false,
  supportsStreaming: true,
  supportsAbort: false,
  supportsSession: false,
}

function makeProvider(name: string, capabilities: ProviderCapabilities = apiCapabilities): AIProvider {
  return {
    name,
    capabilities,
    chat: vi.fn().mockResolvedValue('```json\n{"issues":[]}\n```'),
    chatStream: vi.fn().mockImplementation(async function* () {
      yield 'No issues found.'
    }),
  }
}

function makeReviewer(id: string, provider = makeProvider(id)): Reviewer {
  return { id, provider, systemPrompt: `${id} prompt` }
}

describe('ReviewTargetPayload', () => {
  it('embeds branch diff for API providers', () => {
    const target: ReviewTarget = {
      kind: 'branch',
      label: 'Branch: feature',
      repoRoot: '/repo',
      baseBranch: 'develop',
      diff: 'diff --git a/a.ts b/a.ts\n+const value = 1',
    }

    const payload = buildReviewTargetPayload(target)
    const prompt = selectReviewPrompt(payload, apiCapabilities)

    expect(prompt).toContain('branch "feature" compared to "develop"')
    expect(prompt).toContain('```diff\ndiff --git a/a.ts b/a.ts\n+const value = 1\n```')
  })

  it('embeds file contents and explicit file errors for API providers', () => {
    const target: ReviewTarget = {
      kind: 'files',
      label: 'Files: src/a.ts, src/missing.ts',
      repoRoot: '/repo',
      files: [
        { path: 'src/a.ts', content: 'export const value = 1' },
        { path: 'src/missing.ts', error: 'ENOENT: no such file' },
      ],
    }

    const prompt = selectReviewPrompt(buildReviewTargetPayload(target), apiCapabilities)

    expect(prompt).toContain('## src/a.ts')
    expect(prompt).toContain('export const value = 1')
    expect(prompt).toContain('## src/missing.ts')
    expect(prompt).toContain('Error reading file: ENOENT: no such file')
  })

  it('passes PR target diff and base branch to context gatherer', async () => {
    const diff = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-export const a = 0\n+export const a = 1'
    const gathered: GatheredContext = {
      affectedModules: [],
      callChain: [],
      relatedPRs: [],
      designPatterns: [],
      summary: 'context',
      gatheredAt: new Date(),
      prNumber: '42',
      baseBranch: 'release',
      rawReferences: [],
    }
    const gather = vi.fn().mockResolvedValue(gathered)
    const contextGatherer = { gather } as unknown as ContextGatherer
    const target: ReviewTarget = {
      kind: 'pr',
      label: 'PR #42',
      repoRoot: '/repo',
      prNumber: '42',
      prUrl: 'https://github.com/acme/repo/pull/42',
      repo: 'acme/repo',
      baseBranch: 'release',
      diff,
    }

    const orchestrator = new DebateOrchestrator(
      [makeReviewer('reviewer')],
      makeReviewer('summarizer'),
      makeReviewer('analyzer'),
      { maxRounds: 1, interactive: false, skipConclusion: true },
      contextGatherer
    )

    await orchestrator.runStreaming(target.label, 'fallback prompt', target)

    expect(gather).toHaveBeenCalledWith(diff, '42', 'release', '/repo')
  })
})
