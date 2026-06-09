import { describe, expect, it } from 'vitest'
import type { MergedIssue, VerificationStatus } from '../../src/orchestrator/types.js'
import { isIssuePublishable, requiresManualPublishReview } from '../../src/commands/review/utils.js'

function issue(status: VerificationStatus, publishable = true): MergedIssue {
  return {
    severity: 'medium',
    category: 'correctness',
    file: 'src/app.ts',
    title: 'Issue',
    description: 'Description',
    raisedBy: ['reviewer-1'],
    descriptions: ['Description'],
    sources: [{ reviewerId: 'reviewer-1', messageIndex: 0 }],
    verification: {
      status,
      severity: 'medium',
      reason: 'verified by test',
      evidence: 'src/app.ts:1',
    },
    publishable,
  }
}

describe('review issue publishability helpers', () => {
  it('allows verified issues and filters false positives', () => {
    expect(isIssuePublishable(issue('verified'))).toBe(true)
    expect(isIssuePublishable(issue('false_positive', false))).toBe(false)
  })

  it('routes needs_manual_review issues through manual review', () => {
    const manual = issue('needs_manual_review')

    expect(isIssuePublishable(manual)).toBe(true)
    expect(requiresManualPublishReview(manual)).toBe(true)
  })

  it('does not publish pre-existing issues by default', () => {
    expect(isIssuePublishable(issue('pre_existing', false))).toBe(false)
  })
})
