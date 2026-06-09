// src/reporter/types.ts
import type { RepoStats } from '../repo-scanner/types.js'

export type VerificationStatus = 'verified' | 'false_positive' | 'pre_existing' | 'needs_manual_review'

export interface IssueVerification {
  status: VerificationStatus
  severity: ReviewIssue['severity']
  reason: string
  evidence: string
}

export interface ReviewIssue {
  id: number
  location: string
  description: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'nitpick'
  consensus: string
  category?: string
  file?: string
  line?: number
  endLine?: number
  title?: string
  evidence?: string
  details?: string
  debateSummary?: string
  suggestedFix?: string
  verification?: IssueVerification
  publishable?: boolean
}

export interface RepoReviewResult {
  repoName: string
  timestamp: Date
  stats: RepoStats
  architectureAnalysis: string
  architectureStrengths?: string[]
  architectureImprovements?: string[]
  issues: ReviewIssue[]
  tokenUsage: {
    total: number
    cost: number
    breakdown?: Record<string, number>
  }
}
