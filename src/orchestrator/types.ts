// src/orchestrator/types.ts
import type { AIProvider } from '../providers/types.js'
import type { GatheredContext } from '../context-gatherer/types.js'
import type { StatusTracker } from '../status/tracker.js'

export type ReviewTargetKind = 'pr' | 'local' | 'branch' | 'files'

export interface ReviewTargetFile {
  path: string
  content?: string
  error?: string
}

export interface ReviewTarget {
  kind: ReviewTargetKind
  label: string
  repoRoot: string
  repo?: string
  prNumber?: string
  prUrl?: string
  prTitle?: string
  prBody?: string
  baseBranch?: string
  headSha?: string
  diff?: string
  diffNotice?: string
  cliCanFetchPr?: boolean
  files?: ReviewTargetFile[]
}

export interface ReviewTargetPayload {
  promptForCli: string
  promptForApi: string
  diff?: string
  diffNotice?: string
  files?: ReviewTargetFile[]
}

export interface Reviewer {
  id: string
  provider: AIProvider
  systemPrompt: string
}

export type DebateMessagePhase = 'review' | 'interactive' | 'qa'

export type DebateMessageStatus = 'success' | 'failed' | 'cancelled'

export interface DebateMessage {
  reviewerId: string
  content: string
  timestamp: Date
  round?: number
  phase?: DebateMessagePhase
  status?: DebateMessageStatus
}

export interface TokenUsage {
  reviewerId: string
  inputTokens: number
  outputTokens: number
  estimatedCost?: number  // USD
}

export interface DebateResult {
  prNumber: string
  analysis: string
  context?: GatheredContext
  messages: DebateMessage[]
  finalConclusion: string
  verifiedConclusion?: string  // Verified conclusion after cross-checking with PR/code
  tokenUsage: TokenUsage[]
  convergedAtRound?: number  // If converged early
  parsedIssues?: MergedIssue[]   // Deduplicated structured issues (if reviewers output JSON)
}

export interface ReviewerStatus {
  reviewerId: string
  status: 'pending' | 'thinking' | 'streaming' | 'stalled' | 'done' | 'error' | 'cancelled'
  startTime?: number      // timestamp ms
  endTime?: number        // timestamp ms
  duration?: number       // seconds
  lastActivityAt?: number // timestamp ms of last stream activity
  outputChars?: number    // cumulative streamed characters
  chunkCount?: number     // observed stream chunks
  stalledFor?: number     // seconds since last activity
  hasResponded?: boolean
  lastSeenMessageIndex?: number
}

export interface ParallelRoundControl {
  round: number
  forceProceed(): void
}

export interface OrchestratorOptions {
  maxRounds: number
  interactive: boolean
  language?: string  // Output language instruction to inject into prompts
  onMessage?: (reviewerId: string, chunk: string) => void
  onRoundComplete?: (round: number, converged: boolean) => void
  onInteractive?: () => Promise<string | null>
  onWaiting?: (reviewerId: string) => void
  onParallelStatus?: (round: number, statuses: ReviewerStatus[]) => void  // Track parallel execution
  checkConvergence?: boolean  // Enable convergence detection
  onConvergenceJudgment?: (verdict: 'CONVERGED' | 'NOT_CONVERGED', reasoning: string) => void  // Convergence judgment details
  // Post-analysis Q&A: return { target: '@reviewer_id', question: 'text' } or null to continue
  onPostAnalysisQA?: () => Promise<{ target: string; question: string } | null>
  onContextGathered?: (context: GatheredContext) => void  // Context gathering complete callback
  status?: StatusTracker  // Unified task status tracking
  interruptState?: { interrupted: boolean }  // External interrupt signal (e.g., Ctrl+C)
  /** Called with a control object while a parallel reviewer round is active; called with null when it ends. */
  onParallelRoundControl?: (control: ParallelRoundControl | null) => void
  skipConclusion?: boolean  // Skip getFinalConclusion + old verifyConclusion (bot mode)
}

/** Structured issue from a reviewer */
export interface ReviewIssue {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'nitpick'
  category: string
  file: string
  line?: number
  endLine?: number
  title: string
  description: string
  suggestedFix?: string
  codeSnippet?: string
  raisedBy?: string[]  // preserved from structurizer output
}

export interface IssueSource {
  reviewerId: string
  round?: number
  messageIndex: number
}

export interface IssueCandidate extends IssueSource {
  issue: ReviewIssue
}

/** Structured output from a reviewer (parsed from JSON block in response) */
export interface ReviewerOutput {
  issues: ReviewIssue[]
  verdict: 'approve' | 'request_changes' | 'comment'
  summary: string
}

/** Deduplicated issue with attribution */
export interface MergedIssue extends ReviewIssue {
  raisedBy: string[]       // reviewer IDs who found this issue
  descriptions: string[]   // each reviewer's description
  sources: IssueSource[]   // exact review messages that raised this issue
}
