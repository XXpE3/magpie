import { describe, it, expect } from 'vitest'
import { buildBranchReviewPrompt, canCliProviderFetchPr, canReviewersFetchPr } from '../../src/commands/review.js'
import type { MagpieConfig, ReviewerConfig } from '../../src/config/types.js'

const baseConfig: MagpieConfig = {
  providers: {
    'claude-code': {
      enabled: true,
      allowDangerousBypass: false,
      allowWrite: false,
      allowNetwork: false,
      extraAllowedTools: [],
    },
    'codex-cli': {
      enabled: true,
      allowDangerousBypass: false,
      allowWrite: false,
      allowNetwork: false,
      extraAllowedTools: [],
    },
    'gemini-cli': { enabled: true },
    openai: { api_key: 'test-key' },
  },
  defaults: { max_rounds: 3, output_format: 'markdown', check_convergence: true },
  reviewers: {},
  analyzer: { provider: 'claude-code', model: 'claude-code', prompt: 'analyze' },
  summarizer: { provider: 'claude-code', model: 'claude-code', prompt: 'summarize' },
}

function role(provider: string): ReviewerConfig {
  return { provider, model: provider, prompt: 'review' }
}

describe('PR review provider permissions', () => {
  it('does not treat read-only Claude Code as able to fetch PR diffs', () => {
    expect(canCliProviderFetchPr(baseConfig, 'claude-code')).toBe(false)
  })

  it('allows Claude Code PR fetching when network is enabled', () => {
    const config: MagpieConfig = {
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        'claude-code': {
          enabled: true,
          allowDangerousBypass: false,
          allowWrite: false,
          allowNetwork: true,
          extraAllowedTools: [],
        },
      },
    }

    expect(canCliProviderFetchPr(config, 'claude-code')).toBe(true)
  })

  it('requires Codex CLI write permission before treating network as PR fetch access', () => {
    const config: MagpieConfig = {
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        'codex-cli': {
          enabled: true,
          allowDangerousBypass: false,
          allowWrite: false,
          allowNetwork: true,
          extraAllowedTools: [],
        },
      },
    }

    expect(canCliProviderFetchPr(config, 'codex-cli')).toBe(false)
  })

  it('requires every selected CLI role to have PR fetch access before omitting the diff', () => {
    const roles = [role('claude-code'), role('codex-cli'), role('claude-code')]

    expect(canReviewersFetchPr(baseConfig, roles)).toBe(false)
  })

  it('keeps non-API CLI providers eligible for direct PR fetching', () => {
    expect(canReviewersFetchPr(baseConfig, [role('gemini-cli')])).toBe(true)
  })

  it('does not use direct PR fetching when any role is an API provider', () => {
    expect(canReviewersFetchPr(baseConfig, [role('gemini-cli'), role('openai')])).toBe(false)
  })
})

describe('branch review prompt', () => {
  it('embeds the branch diff for read-only CLI reviewers', () => {
    const prompt = buildBranchReviewPrompt('feature', 'main', 'diff --git a/a.ts b/a.ts\n+const x = 1')

    expect(prompt).toContain('branch "feature" compared to "main"')
    expect(prompt).toContain('```diff\ndiff --git a/a.ts b/a.ts\n+const x = 1\n```')
    expect(prompt).toContain('You already have the complete diff above')
  })
})
