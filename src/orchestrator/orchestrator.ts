// src/orchestrator/orchestrator.ts
import type { AIProvider, Message, ProviderActivity, ProviderCapabilities } from '../providers/types.js'
import type { TaskPhase } from '../status/types.js'
import type {
  Reviewer,
  DebateMessage,
  DebateResult,
  OrchestratorOptions,
  TokenUsage,
  ReviewerStatus,
  MergedIssue,
  IssueCandidate,
  ReviewTarget,
  ReviewTargetPayload
} from './types.js'
import type { ContextGatherer } from '../context-gatherer/gatherer.js'
import type { GatheredContext } from '../context-gatherer/types.js'
import { parseReviewerOutput, parseFocusAreas, deduplicateIssues } from './issue-parser.js'
import { formatCallChainForReviewer } from '../context-gatherer/collectors/reference-collector.js'
import { logger } from '../utils/logger.js'

const LEGACY_REVIEWER_STALL_THRESHOLD_MS = 60_000
const LEGACY_REVIEWER_STALL_CHECK_INTERVAL_MS = 1_000
const LEGACY_STATUS_RENDER_THROTTLE_MS = 100

export class InterruptedError extends Error {
  constructor() { super('Interrupted by user') }
}

class ForceProceedError extends Error {
  constructor() { super('Force proceed requested') }
}

function isForceProceedError(error: unknown): boolean {
  return error instanceof ForceProceedError
}

function rawReviewerOutputIssueCount(response: string): number | undefined {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/)
  let jsonStr = jsonMatch?.[1]

  if (!jsonStr) {
    const rawMatch = response.match(/\{[\s\S]*"issues"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
    if (rawMatch) jsonStr = rawMatch[0]
  }

  if (!jsonStr) return undefined

  try {
    const parsed = JSON.parse(jsonStr)
    return Array.isArray(parsed.issues) ? parsed.issues.length : undefined
  } catch {
    return undefined
  }
}

function formatPriorIssueContext(candidates: IssueCandidate[]): string {
  if (candidates.length === 0) return ''

  const issues = deduplicateIssues(candidates)
  const issueText = issues.map((issue, index) => {
    const loc = issue.line ? `${issue.file}:${issue.line}` : issue.file
    const sources = issue.sources
      .map(source => `${source.reviewerId}${source.round == null ? '' : ` round ${source.round}`}`)
      .join(', ')
    const description = issue.description.length > 500
      ? `${issue.description.slice(0, 500)}…`
      : issue.description
    return `${index + 1}. [${issue.severity}] ${loc} — ${issue.title}\nDescription: ${description}\nSources: ${sources}`
  }).join('\n\n')

  return `\n\nPreviously extracted issues for reference only:\n\n${issueText}\n\nUse the previous issues only to resolve references in the current message. If the current message agrees with or confirms a previous issue, emit that issue using the previous file/title details and the current reviewer as the source. Do not emit previous issues that the current message does not mention, confirm, or discuss.`
}

interface VisibleConversationMessage {
  message: DebateMessage
  index: number
}

interface BuiltReviewMessages {
  messages: Message[]
  visibleMessages: VisibleConversationMessage[]
}

interface ReviewerRuntimeState {
  hasResponded: boolean
  lastSeenMessageIndex: number
}

function stopStream<T>(stream: AsyncGenerator<T, void, unknown>): void {
  const stopped = stream.return?.()
  if (stopped) void stopped.catch(() => {})
}

async function nextStreamChunk<T>(
  stream: AsyncGenerator<T, void, unknown>,
  signal?: AbortSignal
): Promise<IteratorResult<T, void>> {
  if (!signal) return stream.next()
  if (signal.aborted) {
    stopStream(stream)
    throw new ForceProceedError()
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      stopStream(stream)
      reject(new ForceProceedError())
    }

    signal.addEventListener('abort', onAbort, { once: true })
    stream.next().then(
      result => {
        cleanup()
        resolve(result)
      },
      error => {
        cleanup()
        reject(error)
      }
    )
  })
}

/**
 * Extract changed file paths from a diff/prompt containing `diff --git` headers.
 */
export function extractChangedFiles(taskPrompt: string): string[] {
  const files: string[] = []
  const regex = /diff --git a\/.+ b\/(.+)/g
  let match
  while ((match = regex.exec(taskPrompt)) !== null) {
    files.push(match[1])
  }
  return [...new Set(files)]
}

/**
 * Extract per-file hunk line ranges from a unified diff.
 * Returns a formatted string like:
 *   src/foo.ts: 35-46, 80-95
 *   src/bar.ts: 10-25
 */
export function extractDiffLineRanges(diff: string): string {
  const ranges = new Map<string, Array<string>>()
  let currentFile = ''

  for (const line of diff.split('\n')) {
    const fileMatch = line.match(/^diff --git a\/.+ b\/(.+)/)
    if (fileMatch) {
      currentFile = fileMatch[1]
      continue
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (hunkMatch && currentFile) {
      const start = parseInt(hunkMatch[1])
      const count = hunkMatch[2] ? parseInt(hunkMatch[2]) : 1
      const end = start + count - 1
      if (!ranges.has(currentFile)) {
        ranges.set(currentFile, [])
      }
      ranges.get(currentFile)!.push(end > start ? `${start}-${end}` : `${start}`)
    }
  }

  return [...ranges.entries()]
    .map(([file, r]) => `  ${file}: ${r.join(', ')}`)
    .join('\n')
}

function targetHeader(target: ReviewTarget): string {
  if (target.kind === 'pr') {
    return `Please review ${target.prUrl || target.label}.`
  }
  if (target.kind === 'branch') {
    const branchName = target.label.replace(/^Branch:\s*/, '')
    return `Please review the changes in branch "${branchName}"${target.baseBranch ? ` compared to "${target.baseBranch}"` : ''}.`
  }
  if (target.kind === 'files') {
    const files = target.files?.map(file => file.path).join(', ') || 'the requested files'
    return `Please review the following files: ${files}.`
  }
  return 'Please review the local code changes.'
}

function formatPrMetadata(target: ReviewTarget): string {
  const sections: string[] = []
  if (target.prTitle?.trim()) {
    sections.push(`Title: ${target.prTitle}`)
  }
  if (target.prBody?.trim()) {
    sections.push(`Description:\n${target.prBody}`)
  }
  return sections.join('\n\n')
}

function formatDiffSection(diff: string | undefined, notice?: string): string {
  if (!diff?.trim()) {
    return 'Diff was not available. Report this clearly instead of guessing from missing changes.'
  }
  const noticeSection = notice ? `${notice}\n\n` : ''
  return `${noticeSection}Here is the diff:\n\n\`\`\`diff\n${diff}\n\`\`\``
}

function formatFilesSection(files: ReviewTarget['files'] | undefined): string {
  if (!files || files.length === 0) {
    return 'No file contents were available. Report this clearly instead of guessing from missing files.'
  }

  return files.map(file => {
    if (file.error) {
      return `## ${file.path}\n\nError reading file: ${file.error}`
    }
    return `## ${file.path}\n\n\`\`\`\n${file.content ?? ''}\n\`\`\``
  }).join('\n\n')
}

export function buildReviewTargetPayload(target: ReviewTarget, fallbackPrompt = ''): ReviewTargetPayload {
  const header = targetHeader(target)
  let promptForCli = ''
  let promptForApi = ''

  if (target.kind === 'pr') {
    const metadata = formatPrMetadata(target)
    const metadataSection = metadata ? `\n\n${metadata}` : ''
    const hasDiff = Boolean(target.diff?.trim())
    promptForCli = target.cliCanFetchPr === false && hasDiff
      ? `${header}${metadataSection}\n\n${formatDiffSection(target.diff, target.diffNotice)}\n\nAnalyze these changes and provide your feedback. You already have the complete diff above; do not attempt to fetch it again.`
      : `${header}\n\nUse your repository tools to inspect the changed files and relevant context. Review every changed file and function systematically.`
    if (target.cliCanFetchPr !== false || !hasDiff) {
      promptForCli = `${header}${metadataSection}\n\nUse your repository tools to inspect the changed files and relevant context. Review every changed file and function systematically.`
    }
    promptForApi = `${header}${metadataSection}\n\n${formatDiffSection(target.diff, target.diffNotice)}\n\nAnalyze these changes and provide your feedback.`
  } else if (target.kind === 'branch') {
    promptForCli = `${header}\n\nUse git and file-reading tools from ${target.repoRoot} to inspect the branch diff and source context.`
    promptForApi = `${header}\n\n${formatDiffSection(target.diff, target.diffNotice)}\n\nAnalyze these changes and provide your feedback. You already have the complete diff above; do not attempt to fetch it again.`
  } else if (target.kind === 'files') {
    promptForCli = `${header}\n\nUse file-reading tools from ${target.repoRoot} to inspect the requested files.`
    promptForApi = `${header}\n\nHere are the file contents:\n\n${formatFilesSection(target.files)}\n\nAnalyze these files and provide your feedback.`
  } else {
    promptForCli = target.diff?.trim()
      ? `${header}\n\n${formatDiffSection(target.diff, target.diffNotice)}\n\nAnalyze these changes and provide your feedback. You already have the complete diff above; do not rely on the working-tree diff being present.`
      : `${header}\n\nUse git and file-reading tools from ${target.repoRoot} to inspect the local diff and source context.`
    promptForApi = `${header}\n\n${formatDiffSection(target.diff, target.diffNotice)}\n\nAnalyze these changes and provide your feedback.`
  }

  return {
    promptForCli: promptForCli || fallbackPrompt,
    promptForApi: promptForApi || fallbackPrompt,
    diff: target.diff,
    diffNotice: target.diffNotice,
    files: target.files
  }
}

export function selectReviewPrompt(payload: ReviewTargetPayload, capabilities?: ProviderCapabilities): string {
  return capabilities?.canReadRepo === true && capabilities.canUseTools === true
    ? payload.promptForCli
    : payload.promptForApi
}

export class DebateOrchestrator {
  private reviewers: Reviewer[]
  private summarizer: Reviewer
  private analyzer: Reviewer
  private contextGatherer: ContextGatherer | null
  private options: OrchestratorOptions
  private conversationHistory: DebateMessage[] = []
  private tokenUsage: Map<string, { input: number; output: number }> = new Map()
  private analysis: string = ''  // Store analysis to avoid repeating diff
  private gatheredContext: GatheredContext | null = null  // Store gathered context
  private taskPrompt: string = ''  // Original task prompt (contains PR number, etc.)
  private reviewTarget: ReviewTarget | null = null
  private reviewTargetPayload: ReviewTargetPayload | null = null
  private reviewerStates: Map<string, ReviewerRuntimeState> = new Map()

  constructor(
    reviewers: Reviewer[],
    summarizer: Reviewer,
    analyzer: Reviewer,
    options: OrchestratorOptions,
    contextGatherer?: ContextGatherer
  ) {
    this.reviewers = reviewers
    this.summarizer = summarizer
    this.analyzer = analyzer
    this.contextGatherer = contextGatherer || null
    this.options = options
  }

  /** Throw if externally interrupted (e.g., Ctrl+C) */
  private checkInterrupt(): void {
    if (this.options.interruptState?.interrupted) {
      throw new InterruptedError()
    }
  }

  /** Build a language instruction suffix (empty string if no language configured) */
  private get langSuffix(): string {
    if (!this.options.language) return ''
    return `\n\nIMPORTANT: You MUST respond in ${this.options.language}. All your analysis, comments, and explanations must be written in ${this.options.language}.`
  }

  /** Build a language instruction prefix for system prompts (stronger than suffix) */
  private get langPrefix(): string {
    if (!this.options.language) return ''
    return `[LANGUAGE REQUIREMENT] You MUST write ALL responses in ${this.options.language}. This applies to all analysis, comments, summaries, and explanations. Only code snippets, variable names, and JSON keys should remain in English.\n\n`
  }

  /** Prepend language prefix to a system prompt */
  private withLang(systemPrompt?: string): string | undefined {
    if (!systemPrompt) return systemPrompt
    return this.langPrefix + systemPrompt
  }

  private setReviewTarget(prompt: string, target?: ReviewTarget): void {
    this.reviewTarget = target || null
    this.reviewTargetPayload = target
      ? buildReviewTargetPayload(target, prompt)
      : { promptForCli: prompt, promptForApi: prompt }
    this.taskPrompt = this.reviewTargetPayload.promptForApi
  }

  private promptFor(provider: AIProvider): string {
    if (!this.reviewTargetPayload) return this.taskPrompt
    return selectReviewPrompt(this.reviewTargetPayload, provider.capabilities)
  }

  private resetReviewerStates(): void {
    this.reviewerStates.clear()
    for (const reviewer of this.reviewers) {
      this.reviewerStates.set(reviewer.id, {
        hasResponded: false,
        lastSeenMessageIndex: -1,
      })
    }
  }

  private getReviewerState(reviewerId: string): ReviewerRuntimeState {
    let state = this.reviewerStates.get(reviewerId)
    if (!state) {
      state = { hasResponded: false, lastSeenMessageIndex: -1 }
      this.reviewerStates.set(reviewerId, state)
    }
    return state
  }

  private recordVisibleMessages(reviewerId: string, messages: Array<{ index: number }>): void {
    if (messages.length === 0) return
    const state = this.getReviewerState(reviewerId)
    for (const message of messages) {
      if (message.index > state.lastSeenMessageIndex) {
        state.lastSeenMessageIndex = message.index
      }
    }
  }

  private addConversationMessage(
    reviewerId: string,
    content: string,
    round: number,
    phase: DebateMessage['phase'],
    status: DebateMessage['status'] = 'success'
  ): void {
    this.conversationHistory.push({
      reviewerId,
      content,
      timestamp: new Date(),
      round,
      phase,
      status,
    })
  }

  private isSuccessfulReviewMessage(message: DebateMessage): boolean {
    return message.reviewerId !== 'user'
      && (message.phase ?? 'review') === 'review'
      && (message.status ?? 'success') === 'success'
  }

  private getVisibleMessages(currentReviewerId: string, currentRound: number): VisibleConversationMessage[] {
    return this.conversationHistory
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => {
        const status = message.status ?? 'success'
        if (status !== 'success') return false

        const round = message.round ?? currentRound
        if (message.reviewerId === 'user') {
          const phase = message.phase ?? 'interactive'
          return (phase === 'interactive' || phase === 'review') && round <= currentRound
        }

        if (round >= currentRound) return false
        if (message.reviewerId === currentReviewerId) return false
        return this.isSuccessfulReviewMessage(message)
      })
  }

  private formatInteractiveMessages(messages: VisibleConversationMessage[]): string {
    if (messages.length === 0) return ''
    const content = messages
      .map(({ message }) => `[Human]: ${message.content}`)
      .join('\n\n---\n\n')
    return `\n\nAdditional user guidance for this round:\n\n${content}`
  }

  private markReviewerResponded(reviewerId: string): void {
    this.getReviewerState(reviewerId).hasResponded = true
  }

  // Estimate tokens from text (CJK ~0.7 tokens/char, English ~0.25 tokens/char)
  private estimateTokens(text: string): number {
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
    return Math.ceil(cjkCount * 0.7 + (text.length - cjkCount) / 4)
  }

  private trackTokens(reviewerId: string, input: string, output: string) {
    const existing = this.tokenUsage.get(reviewerId) || { input: 0, output: 0 }
    existing.input += this.estimateTokens(input)
    existing.output += this.estimateTokens(output)
    this.tokenUsage.set(reviewerId, existing)
  }

  private getTokenUsage(): TokenUsage[] {
    const usage: TokenUsage[] = []
    for (const [reviewerId, tokens] of this.tokenUsage) {
      usage.push({
        reviewerId,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        // Rough cost estimate: $0.01 per 1K tokens (varies by model)
        estimatedCost: (tokens.input + tokens.output) * 0.00001
      })
    }
    return usage
  }

  private async collectStream(
    taskId: string,
    phase: TaskPhase,
    reviewer: Reviewer,
    messages: Message[],
    onChunk?: (chunk: string) => void,
    onActivity?: (activity: ProviderActivity) => void,
    signal?: AbortSignal
  ): Promise<string> {
    this.options.status?.begin(taskId, phase, reviewer.id)
    let fullResponse = ''

    try {
      const stream = reviewer.provider.chatStream(
        messages,
        this.withLang(reviewer.systemPrompt),
        {
          onActivity: activity => {
            this.options.status?.activity(taskId, activity.label ?? activity.kind)
            onActivity?.(activity)
          },
          signal,
        }
      )

      while (true) {
        const next = await nextStreamChunk(stream, signal)
        if (next.done) break

        const chunk = next.value
        fullResponse += chunk
        this.options.status?.output(taskId, chunk)
        onChunk?.(chunk)
      }

      this.options.status?.done(taskId)
      return fullResponse
    } catch (error) {
      if (isForceProceedError(error)) {
        this.options.status?.cancelled(taskId, error)
        throw error
      }

      const message = error instanceof Error ? error.message : String(error)
      if (message.toLowerCase().includes('timed out')) {
        this.options.status?.timeout(taskId, error)
      } else {
        this.options.status?.error(taskId, error)
      }
      throw error
    }
  }

  private async trackedPromise<T>(
    taskId: string,
    phase: TaskPhase,
    label: string,
    run: () => Promise<T>
  ): Promise<T> {
    this.options.status?.begin(taskId, phase, label)
    try {
      const result = await run()
      this.options.status?.done(taskId)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.toLowerCase().includes('timed out')) {
        this.options.status?.timeout(taskId, error)
      } else {
        this.options.status?.error(taskId, error)
      }
      throw error
    }
  }

  // Check if reviewers have converged (reached consensus)
  private async checkConvergence(round: number): Promise<boolean> {
    const roundMessages = this.conversationHistory.filter(message =>
      message.round === round && this.isSuccessfulReviewMessage(message)
    )
    if (roundMessages.length < this.reviewers.length) {
      return false
    }

    const messagesText = roundMessages
      .map(m => `[${m.reviewerId}]: ${m.content}`)
      .join('\n\n---\n\n')

    const isFirstRound = round <= 1
    const roundContext = isFirstRound
      ? `IMPORTANT: This is Round 1. Reviewers have NOT seen each other's opinions - they reviewed independently. If they independently arrived at the same conclusions, that IS valid convergence.`
      : `IMPORTANT: This is Round ${round}. Reviewers have now seen each other's opinions.`

    const prompt = `You are a strict consensus judge. Analyze whether these ${this.reviewers.length} reviewers have reached TRUE CONSENSUS.

${roundContext}

TRUE CONSENSUS requires ALL of the following:
1. All reviewers agree on the SAME final verdict (all approve OR all request changes)
2. Critical/blocking issues identified by ANY reviewer are acknowledged by ALL others
3. No reviewer has raised a concern that others have ignored or dismissed without addressing
4. They explicitly agree on what actions to take (not just "no disagreement")

NOT CONSENSUS if ANY of these:
- One reviewer identified a Critical/Important issue that others didn't address
- Reviewers found DIFFERENT sets of issues without cross-validating each other's findings
- One reviewer says "I disagree" or challenges another's reasoning
- Reviewers give different verdicts or severity assessments
- Silence on another's point (not responding to it) - silence is NOT agreement
- They list problems but haven't confirmed they agree on the complete list

Reviews from Round ${round}:
${messagesText}

First, provide a brief reasoning (2-3 sentences) explaining your judgment.
Then on the LAST line, respond with EXACTLY one word: CONVERGED or NOT_CONVERGED`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await this.trackedPromise(
      'convergence',
      'convergence',
      'convergence check',
      () => this.summarizer.provider.chat(
        messages,
        'You are a strict consensus judge. Be VERY conservative - if there is ANY doubt, respond NOT_CONVERGED. Provide brief reasoning, then on the last line respond with exactly one word: CONVERGED or NOT_CONVERGED.'
      )
    )

    // Parse response - extract verdict from last line, rest is reasoning
    const lines = response.trim().split('\n')
    const lastLine = lines[lines.length - 1].trim().toUpperCase()
    const verdict = lastLine.split(/\s+/)[0]
    const isConverged = verdict === 'CONVERGED'

    // Extract reasoning (everything except the last line)
    const reasoning = lines.slice(0, -1).join('\n').trim()

    // Notify callback with judgment details
    this.options.onConvergenceJudgment?.(
      isConverged ? 'CONVERGED' : 'NOT_CONVERGED',
      reasoning || response.trim()
    )

    return isConverged
  }

  /**
   * Extract diff content from prompt (for local/branch reviews)
   */
  private extractDiffFromPrompt(prompt: string): string {
    // If prompt contains diff directly (local/branch review), extract it
    const diffMatch = prompt.match(/```diff\n([\s\S]*?)```/)
    if (diffMatch) {
      return diffMatch[1]
    }
    // For PR reviews, return the full prompt (diff will be fetched by reviewer)
    return prompt
  }

  private async preAnalyze(prompt: string): Promise<string> {
    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await this.analyzer.provider.chat(messages, this.withLang(this.analyzer.systemPrompt))
    this.trackTokens('analyzer', prompt + (this.analyzer.systemPrompt || ''), response)
    return response
  }

  async run(label: string, prompt: string, target?: ReviewTarget): Promise<DebateResult> {
    this.conversationHistory = []
    this.tokenUsage.clear()
    this.resetReviewerStates()
    this.setReviewTarget(prompt, target)
    let convergedAtRound: number | undefined

    try {
      // Run pre-analysis first and store it
      const analysisPrompt = this.promptFor(this.analyzer.provider)
      this.analysis = await this.preAnalyze(analysisPrompt)
      this.checkInterrupt()

      // Run debate rounds
      for (let round = 1; round <= this.options.maxRounds; round++) {
        this.checkInterrupt()
        for (const reviewer of this.reviewers) {
          // Check for user interruption in interactive mode
          if (this.options.interactive && this.options.onInteractive) {
            const userInput = await this.options.onInteractive()
            if (userInput === 'q') {
              break
            }
            if (userInput) {
              this.addConversationMessage('user', userInput, round, 'interactive')
            }
          }

          const builtMessages = this.buildMessages(reviewer.id, round)
          const response = await reviewer.provider.chat(builtMessages.messages, this.withLang(reviewer.systemPrompt))

          const inputText = builtMessages.messages.map(m => m.content).join('\n') + (reviewer.systemPrompt || '')
          this.trackTokens(reviewer.id, inputText, response)
          this.recordVisibleMessages(reviewer.id, builtMessages.visibleMessages)

          this.addConversationMessage(reviewer.id, response, round, 'review')
          this.markReviewerResponded(reviewer.id)

          this.options.onMessage?.(reviewer.id, response)
        }

        // Check convergence if enabled
        let converged = false
        if (this.options.checkConvergence && round < this.options.maxRounds) {
          converged = await this.checkConvergence(round)
          if (converged) {
            convergedAtRound = round
          }
        }

        this.options.onRoundComplete?.(round, converged)

        if (converged) {
          break
        }
      }

      this.checkInterrupt()

      let finalConclusion = ''
      let verifiedConclusion: string | undefined

      if (!this.options.skipConclusion) {
        finalConclusion = await this.getFinalConclusion()
      }

      // End summarizer session for clean JSON extraction call
      this.summarizer.provider.endSession?.()
      const parsedIssues = await this.extractIssues()

      if (parsedIssues.length > 0) {
        await this.verifyIssues(parsedIssues)
      }

      if (finalConclusion && !this.options.skipConclusion) {
        verifiedConclusion = await this.verifyConclusion(finalConclusion)
      }

      return {
        prNumber: label,
        analysis: this.analysis,
        messages: this.conversationHistory,
        finalConclusion,
        verifiedConclusion,
        tokenUsage: this.getTokenUsage(),
        convergedAtRound,
        ...(parsedIssues.length > 0 ? { parsedIssues } : {})
      }
    } finally {
      for (const reviewer of this.reviewers) {
        reviewer.provider.endSession?.()
      }
      this.analyzer.provider.endSession?.()
      this.summarizer.provider.endSession?.()
    }
  }

  async runStreaming(label: string, prompt: string, target?: ReviewTarget): Promise<DebateResult> {
    this.conversationHistory = []
    this.tokenUsage.clear()
    this.resetReviewerStates()
    this.analysis = ''
    this.setReviewTarget(prompt, target)
    let convergedAtRound: number | undefined

    // Start sessions for reviewers that support it (with descriptive names for session listings)
    for (const reviewer of this.reviewers) {
      reviewer.provider.startSession?.(`Magpie | ${label} | reviewer:${reviewer.id}`)
    }
    this.analyzer.provider.startSession?.(`Magpie | ${label} | analyzer`)
    this.summarizer.provider.startSession?.(`Magpie | ${label} | summarizer`)

    try {
      // Run context gathering and analysis in parallel (they're independent)
      // Display is sequential: analysis streams first, then context appears after
      const contextPromise = this.contextGatherer
        ? (async () => {
            this.options.onWaiting?.('context-gatherer')
            this.options.status?.begin('context', 'context', 'context gathering')
            try {
              const diff = this.reviewTargetPayload?.diff ?? this.extractDiffFromPrompt(this.taskPrompt)
              const prNumber = this.reviewTarget?.prNumber ?? label
              const baseBranch = this.reviewTarget?.baseBranch ?? 'main'
              const cwd = this.reviewTarget?.repoRoot ?? process.cwd()
              this.gatheredContext = await this.contextGatherer!.gather(diff, prNumber, baseBranch, cwd)
              this.options.status?.done('context')
            } catch (error) {
              this.options.status?.error('context', error)
              logger.warn('Context gathering failed:', error)
            }
          })()
        : Promise.resolve()

      const analysisPromise = (async () => {
        const analysisPrompt = this.promptFor(this.analyzer.provider)
        const analyzeMessages: Message[] = [{ role: 'user', content: analysisPrompt }]
        this.options.onWaiting?.('analyzer')
        this.analysis = await this.collectStream(
          'analyzer',
          'analyzer',
          this.analyzer,
          analyzeMessages,
          chunk => this.options.onMessage?.('analyzer', chunk)
        )
        this.trackTokens('analyzer', analysisPrompt + (this.analyzer.systemPrompt || ''), this.analysis)
      })()

      await Promise.all([contextPromise, analysisPromise])
      this.checkInterrupt()

      // Display context after analysis completes (parallel work, sequential display)
      if (this.gatheredContext) {
        this.options.onContextGathered?.(this.gatheredContext)
      }

      // Post-analysis Q&A: let user ask specific reviewers questions before debate
      if (this.options.onPostAnalysisQA) {
        while (true) {
          const qa = await this.options.onPostAnalysisQA()
          if (!qa) break  // User wants to proceed to debate

          // Find target reviewer (strip @ prefix if present)
          const targetId = qa.target.replace(/^@/, '')
          const targetReviewer = this.reviewers.find(r => r.id.toLowerCase() === targetId.toLowerCase())

          if (!targetReviewer) {
            // Invalid target, skip
            continue
          }

          // Build Q&A message
          const qaMessages: Message[] = [{
            role: 'user',
            content: `Based on the analysis above, please answer this question:\n\n${qa.question}`
          }]

          this.options.onWaiting?.(targetReviewer.id)
          const qaResponse = await this.collectStream(
            `reviewer:${targetReviewer.id}:qa`,
            'reviewer',
            targetReviewer,
            qaMessages,
            chunk => this.options.onMessage?.(targetReviewer.id, chunk)
          )

          // Track tokens and add to history
          this.trackTokens(targetReviewer.id, qa.question, qaResponse)
          this.addConversationMessage('user', `[Question to ${targetReviewer.id}]: ${qa.question}`, 0, 'qa')
          this.addConversationMessage(targetReviewer.id, qaResponse, 0, 'qa')
        }
      }

      for (let round = 1; round <= this.options.maxRounds; round++) {
        this.checkInterrupt()
        // Handle interactive mode before round starts
        if (this.options.interactive && this.options.onInteractive) {
          const userInput = await this.options.onInteractive()
          if (userInput === 'q') break
          if (userInput) {
            this.addConversationMessage('user', userInput, round, 'interactive')
          }
        }

        const reviewerTasks = this.reviewers.map(reviewer => {
          const builtMessages = this.buildMessages(reviewer.id, round)
          return {
            reviewer,
            messages: builtMessages.messages,
            visibleMessages: builtMessages.visibleMessages,
          }
        })

        // Execute all reviewers in parallel with unified status tracking.
        // Also keep the legacy onParallelStatus callback alive for external callers.
        this.options.onWaiting?.(`round-${round}`)
        this.options.status?.pendingMany(reviewerTasks.map(({ reviewer }) => ({
          id: `reviewer:${reviewer.id}`,
          phase: 'reviewer',
          label: reviewer.id,
        })))

        const legacyStatuses: ReviewerStatus[] = reviewerTasks.map(({ reviewer }) => {
          const state = this.getReviewerState(reviewer.id)
          return {
            reviewerId: reviewer.id,
            status: 'pending' as const,
            outputChars: 0,
            chunkCount: 0,
            hasResponded: state.hasResponded,
            lastSeenMessageIndex: state.lastSeenMessageIndex,
          }
        })
        let legacyStatusTimer: ReturnType<typeof setTimeout> | null = null
        let lastLegacyStatusEmitAt = 0
        const clearLegacyStatusTimer = () => {
          if (!legacyStatusTimer) return
          clearTimeout(legacyStatusTimer)
          legacyStatusTimer = null
        }
        const emitLegacyStatusNow = () => {
          if (!this.options.onParallelStatus) return
          clearLegacyStatusTimer()
          lastLegacyStatusEmitAt = Date.now()
          try {
            this.options.onParallelStatus(round, legacyStatuses)
          } catch {
            // Legacy status callbacks are observational; they must not break review execution.
          }
        }
        const emitLegacyStatusSoon = () => {
          if (!this.options.onParallelStatus || legacyStatusTimer) return
          const elapsed = Date.now() - lastLegacyStatusEmitAt
          const delay = Math.max(0, LEGACY_STATUS_RENDER_THROTTLE_MS - elapsed)
          legacyStatusTimer = setTimeout(() => {
            legacyStatusTimer = null
            emitLegacyStatusNow()
          }, delay)
        }
        const updateLegacyStatus = (index: number, next: Partial<ReviewerStatus>, immediate = false) => {
          legacyStatuses[index] = { ...legacyStatuses[index], ...next }
          if (immediate) {
            emitLegacyStatusNow()
          } else {
            emitLegacyStatusSoon()
          }
        }
        const markLegacyStalledReviewers = () => {
          if (!this.options.onParallelStatus) return
          const now = Date.now()
          let changed = false

          for (let index = 0; index < legacyStatuses.length; index++) {
            const status = legacyStatuses[index]
            if (!['thinking', 'streaming', 'stalled'].includes(status.status)) continue
            const lastActivityAt = status.lastActivityAt ?? status.startTime
            if (!lastActivityAt) continue

            const idleMs = now - lastActivityAt
            if (idleMs <= LEGACY_REVIEWER_STALL_THRESHOLD_MS) continue

            const stalledFor = Math.floor(idleMs / 1000)
            if (status.status !== 'stalled' || status.stalledFor !== stalledFor) {
              legacyStatuses[index] = { ...status, status: 'stalled', stalledFor }
              changed = true
            }
          }

          if (changed) emitLegacyStatusNow()
        }
        emitLegacyStatusNow()
        let forceProceedRequested = false
        const hasCompletedReviewer = () => legacyStatuses.some(status => status.status === 'done')
        const forceProceedController = new AbortController()
        try {
          this.options.onParallelRoundControl?.({
            round,
            forceProceed: () => {
              if (forceProceedRequested || !hasCompletedReviewer()) return
              forceProceedRequested = true
              forceProceedController.abort()
            }
          })
        } catch {
          // Parallel round controls are observational; they must not break review execution.
        }


        const reviewerPromises = reviewerTasks.map(async ({ reviewer, messages, visibleMessages }, index) => {
          const startTime = Date.now()
          updateLegacyStatus(index, {
            status: 'thinking',
            startTime,
            lastActivityAt: startTime,
            outputChars: 0,
            chunkCount: 0,
            stalledFor: undefined,
          }, true)

          try {
            const fullResponse = await this.collectStream(
              `reviewer:${reviewer.id}`,
              'reviewer',
              reviewer,
              messages,
              chunk => {
                const current = legacyStatuses[index]
                updateLegacyStatus(index, {
                  status: 'streaming',
                  lastActivityAt: Date.now(),
                  outputChars: (current.outputChars ?? 0) + chunk.length,
                  chunkCount: (current.chunkCount ?? 0) + 1,
                  stalledFor: undefined,
                })
              },
              () => {
                const current = legacyStatuses[index]
                updateLegacyStatus(index, {
                  status: (current.chunkCount ?? 0) > 0 ? 'streaming' : 'thinking',
                  lastActivityAt: Date.now(),
                  stalledFor: undefined,
                })
              },
              forceProceedController.signal
            )
            const endTime = Date.now()
            updateLegacyStatus(index, {
              status: 'done',
              endTime,
              duration: (endTime - (legacyStatuses[index].startTime ?? endTime)) / 1000,
              stalledFor: undefined,
            }, true)
            const inputText = messages.map(m => m.content).join('\n') + (reviewer.systemPrompt || '')
            return { reviewer, fullResponse, inputText, visibleMessages, failed: false as const, cancelled: false as const }
          } catch (err) {
            const endTime = Date.now()
            const forceProceed = isForceProceedError(err)
            updateLegacyStatus(index, {
              status: forceProceed ? 'cancelled' : 'error',
              endTime,
              duration: (endTime - (legacyStatuses[index].startTime ?? endTime)) / 1000,
              stalledFor: undefined,
            }, true)
            if (forceProceed) {
              return { reviewer, fullResponse: '', inputText: '', failed: false as const, cancelled: true as const }
            }
            logger.warn(`Reviewer ${reviewer.id} failed in round ${round}:`, err)
            return { reviewer, fullResponse: '', inputText: '', failed: true as const, cancelled: false as const, error: err }
          }
        })

        const legacyStallInterval = setInterval(markLegacyStalledReviewers, LEGACY_REVIEWER_STALL_CHECK_INTERVAL_MS)
        let results: Awaited<(typeof reviewerPromises)[number]>[]
        try {
          results = await Promise.all(reviewerPromises)
        } finally {
          clearInterval(legacyStallInterval)
          clearLegacyStatusTimer()
          try {
            this.options.onParallelRoundControl?.(null)
          } catch {
            // Parallel round controls are observational; they must not break review execution.
          }
        }

        // Fail only if ALL reviewers failed
        const successResults = results.filter(r => !r.failed && !r.cancelled)
        if (successResults.length === 0) {
          const failures = results.filter(r => r.failed)
          if (failures.length === 0) {
            throw new Error(`No completed reviewer results in round ${round}; cannot force proceed`)
          }
          const errors = failures.map(r => `${r.reviewer.id}: ${r.error instanceof Error ? r.error.message : r.error}`).filter(Boolean)
          throw new Error(`All reviewers failed in round ${round}:\n${errors.join('\n')}`)
        }

        // Process results - only add successful ones to history
        for (const result of results) {
          if (result.cancelled) {
            continue
          }
          if (result.failed) {
            this.options.onMessage?.(result.reviewer.id, `[Review failed: ${result.error instanceof Error ? result.error.message : 'unknown error'}]`)
            continue
          }
          this.trackTokens(result.reviewer.id, result.inputText, result.fullResponse)
          this.recordVisibleMessages(result.reviewer.id, result.visibleMessages)
          this.addConversationMessage(result.reviewer.id, result.fullResponse, round, 'review')
          this.markReviewerResponded(result.reviewer.id)
          const resultIndex = reviewerTasks.findIndex(({ reviewer }) => reviewer.id === result.reviewer.id)
          if (resultIndex >= 0) {
            updateLegacyStatus(resultIndex, {
              hasResponded: true,
              lastSeenMessageIndex: this.getReviewerState(result.reviewer.id).lastSeenMessageIndex,
            }, true)
          }
          this.options.onMessage?.(result.reviewer.id, result.fullResponse)
        }

        // Check convergence if enabled
        let converged = false
        if (this.options.checkConvergence && round < this.options.maxRounds) {
          this.options.onWaiting?.('convergence-check')
          converged = await this.checkConvergence(round)
          if (converged) {
            convergedAtRound = round
          }
        }

        this.options.onRoundComplete?.(round, converged)

        if (converged) {
          break
        }
      }

      this.checkInterrupt()

      let finalConclusion = ''
      let verifiedConclusion: string | undefined

      if (!this.options.skipConclusion) {
        this.options.onWaiting?.('summarizer')
        finalConclusion = await this.getFinalConclusion()
      }

      // End summarizer session before structurization so it gets a clean,
      // non-session call. The session context (convergence + conclusion) would
      // pollute the JSON extraction and --resume ignores custom system prompts.
      this.summarizer.provider.endSession?.()
      const parsedIssues = await this.extractIssues()

      // Verify+Audit: check each issue against actual code using tools.
      // This replaces both the old text-only verifyConclusion and the
      // downstream audit step in li-bot.
      if (parsedIssues.length > 0) {
        this.options.onWaiting?.('verifier')
        await this.verifyIssues(parsedIssues)
      }

      // Legacy: if conclusion was generated and skipConclusion is false,
      // also verify conclusion text (for CLI interactive mode)
      if (finalConclusion && !this.options.skipConclusion) {
        verifiedConclusion = await this.verifyConclusion(finalConclusion)
      }

      return {
        prNumber: label,
        analysis: this.analysis,
        context: this.gatheredContext || undefined,
        messages: this.conversationHistory,
        finalConclusion,
        verifiedConclusion,
        tokenUsage: this.getTokenUsage(),
        convergedAtRound,
        ...(parsedIssues.length > 0 ? { parsedIssues } : {})
      }
    } finally {
      // End sessions
      for (const reviewer of this.reviewers) {
        reviewer.provider.endSession?.()
      }
      this.analyzer.provider.endSession?.()
      this.summarizer.provider.endSession?.()  // Safe to call again (idempotent)
    }
  }

  private buildMessages(currentReviewerId: string, currentRound: number): BuiltReviewMessages {
    const reviewer = this.reviewers.find(r => r.id === currentReviewerId)
    const hasSession = reviewer?.provider.sessionId !== undefined
    const reviewerState = this.getReviewerState(currentReviewerId)
    const otherReviewerIds = this.reviewers.filter(r => r.id !== currentReviewerId).map(r => r.id)
    const visibleMessages = this.getVisibleMessages(currentReviewerId, currentRound)

    // Round 1: Each reviewer gives independent opinion (no other reviewers' responses).
    if (currentRound === 1) {
      // Build context section if available
      let contextSection = ''
      if (this.gatheredContext?.summary) {
        contextSection = `
## System Context
${this.gatheredContext.summary}

`
      }

      // Extract and inject focus hints from analysis
      let focusSection = ''
      const focusAreas = parseFocusAreas(this.analysis)
      if (focusAreas.length > 0) {
        focusSection = `\nThe analyzer suggests focusing on: ${focusAreas.join('; ')}.\nThese are suggestions — also flag anything else you notice beyond these areas.\n`
      }

      // Add structured call chain context if available
      let callChainSection = ''
      if (this.gatheredContext?.rawReferences && this.gatheredContext.rawReferences.length > 0) {
        callChainSection = '\n' + formatCallChainForReviewer(this.gatheredContext.rawReferences) + '\n'
      }

      const interactiveMessages = visibleMessages.filter(({ message }) => message.reviewerId === 'user')
      const interactiveSection = this.formatInteractiveMessages(interactiveMessages)

      // First round - independent, exhaustive review
      const taskPrompt = reviewer ? this.promptFor(reviewer.provider) : this.taskPrompt
      const prompt = `Task: ${taskPrompt}
${contextSection}${focusSection}${callChainSection}Here is the analysis:

${this.analysis}${interactiveSection}

You are [${currentReviewerId}]. Review EVERY changed file and EVERY changed function/block — do not skip any.
For each change, check: correctness, security, performance, error handling, edge cases, maintainability.
If you reviewed a file and found no issues, say so briefly. Do not stop early.${this.langSuffix}`

      return { messages: [{ role: 'user', content: prompt }], visibleMessages }
    }

    // Round 2+: Each reviewer sees previous review rounds plus successful user interjections
    // for this round; never current-round reviewer responses.
    if (hasSession) {
      // Session mode: send only messages not already included in this reviewer's previous prompts.
      const lastSeenMessageIndex = reviewerState.lastSeenMessageIndex
      const newMessages = visibleMessages.filter(({ index }) => index > lastSeenMessageIndex)

      if (newMessages.length === 0) {
        return {
          messages: [{ role: 'user', content: 'Please continue with your review.' }],
          visibleMessages: [],
        }
      }

      const newContent = newMessages
        .map(({ message }) => `[${message.reviewerId}]: ${message.content}`)
        .join('\n\n---\n\n')

      return {
        messages: [{
          role: 'user',
          content: `You are [${currentReviewerId}]. Here's what others said in the previous round:\n\n${newContent}\n\nDo three things:\n1. Continue your own exhaustive review — are there changed files or functions you haven't covered yet? Cover them now.\n2. Point out what the other reviewers MISSED — which files or changes did they skip or gloss over?\n3. Respond to their points — agree where valid, challenge where you disagree.${this.langSuffix}`
        }],
        visibleMessages: newMessages,
      }
    }

    // Non-session mode: full context with all previous rounds
    const debateContext = `You are [${currentReviewerId}] in a code review debate with [${otherReviewerIds.join('], [')}].
Your shared goal: find ALL real issues in the code — leave nothing uncovered.

IMPORTANT:
- You are [${currentReviewerId}], the other reviewer${otherReviewerIds.length > 1 ? 's are' : ' is'} [${otherReviewerIds.join('], [')}]
- Continue your own exhaustive review — cover any changed files or functions you haven't addressed yet
- Point out what others MISSED — which files or changes did they skip or gloss over?
- Challenge weak arguments - don't agree just to be polite
- Acknowledge good points and build on them
- If you disagree, explain why with evidence`

    let prompt = `Task: ${this.taskPrompt}

Here is the analysis:

${this.analysis}

${debateContext}

Previous rounds discussion:`

    const messages: Message[] = [
      { role: 'user', content: prompt }
    ]

    for (const { message } of visibleMessages) {
      const prefix = message.reviewerId === 'user' ? '[Human]: ' : `[${message.reviewerId}]: `
      messages.push({
        role: 'user',
        content: prefix + message.content
      })
    }

    const myMessages = this.conversationHistory.filter(message =>
      message.reviewerId === currentReviewerId
        && (message.round ?? currentRound) < currentRound
        && this.isSuccessfulReviewMessage(message)
    )
    for (const message of myMessages) {
      messages.push({
        role: 'assistant',
        content: message.content
      })
    }

    return { messages, visibleMessages }
  }


  /** Expose reviewers for post-review discussion */
  getReviewers(): Reviewer[] {
    return this.reviewers
  }

  /** Expose analyzer for post-review discussion */
  getAnalyzer(): Reviewer {
    return this.analyzer
  }

  /** Expose summarizer for post-review discussion */
  getSummarizer(): Reviewer {
    return this.summarizer
  }

  /** Extract structured issues from review discussion using AI.
   *  Always uses the summarizer to produce consistent, controlled output. */
  private async extractIssues(): Promise<MergedIssue[]> {
    return this.structurizeIssues()
  }

  /** Use AI to extract structured issues from unstructured review text.
   *  Retries with feedback if the first attempt produces invalid JSON. */
  private async structurizeIssues(): Promise<MergedIssue[]> {
    const reviewMessages = this.conversationHistory
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => this.isSuccessfulReviewMessage(message))

    if (reviewMessages.length === 0) return []

    // Extract changed files and valid line ranges from the diff to constrain structurizer output
    const changedFiles = extractChangedFiles(this.taskPrompt)
    const diffLineRanges = extractDiffLineRanges(this.taskPrompt)
    let changedFilesConstraint = ''
    if (changedFiles.length > 0) {
      changedFilesConstraint = `\n- IMPORTANT: Only reference files that are in the PR diff. Changed files: ${changedFiles.join(', ')}`
      if (diffLineRanges) {
        changedFilesConstraint += `\n- CRITICAL: The "line" field MUST be a number within these valid diff ranges (GitHub rejects comments on other lines). If an issue is about code outside these ranges, omit the "line" field entirely.\nValid line ranges per file:\n${diffLineRanges}`
      }
    }

    const systemPrompt = 'You extract structured issues from one code review message. Output only valid JSON.'
    const chatOpts = { disableTools: true }
    const maxAttempts = 3
    const candidates: IssueCandidate[] = []

    for (const { message, index } of reviewMessages) {
      const roundLabel = message.round == null ? 'unknown' : String(message.round)
      const priorIssueContext = formatPriorIssueContext(candidates)
      const basePrompt = `Extract concrete issues from this single code review message into structured JSON.

Reviewer ID: ${message.reviewerId}
Round: ${roundLabel}

Review message:

${message.content}${priorIssueContext}

Output ONLY a JSON block (no other text):
\`\`\`json
{
  "issues": [
    {
      "severity": "critical|high|medium|low|nitpick",
      "category": "correctness|security|performance|concurrency|resource-leak|error-handling|build|testing|documentation|architecture|compatibility|style",
      "file": "path/to/file",
      "line": 42,
      "title": "One-line summary",
      "description": "Concise explanation for GitHub PR comment (see rules below)",
      "suggestedFix": "Brief one-line fix summary"
    }
  ]
}
\`\`\`

Rules:
- Include every concrete issue mentioned in this message.
- The "description" field will be posted directly as a GitHub PR inline comment. Keep it concise: (1) What the problem is, (2) Concrete impact or risk, (3) Fix suggestion if non-obvious. Reference line numbers instead of quoting large code blocks.
- "category" MUST be one of the 12 values listed above. Choose the closest match, do not invent new categories.
- If the message has no concrete issues, return {"issues":[]}.
- If a file path or line number is mentioned, include it; otherwise omit the field.
- Severity (STRICT — when in doubt, choose LOWER):
  critical = compilation failure, data corruption, exploitable security hole, guaranteed crash
  high = logic error that WILL trigger, resource leak, real concurrency bug
  medium = edge case, missing error handling, compatibility risk
  low = code quality, minor concern
  nitpick = style only${changedFilesConstraint}${this.options.language ? `\n- Write the "title", "description", and "suggestedFix" fields in ${this.options.language}. Keep JSON keys and severity/category values in English.` : ''}`

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          this.options.onWaiting?.('structurizer')

          const prompt = attempt === 1
            ? basePrompt
            : `Your previous response was not valid JSON, had an invalid issues array, or omitted required fields from extracted issues. Output ONLY a fenced JSON block with an issues array. No other text.

Review message from ${message.reviewerId}, round ${roundLabel}:

${message.content}${priorIssueContext}

Required JSON format:
\`\`\`json
{"issues": [{"severity": "critical|high|medium|low|nitpick", "category": "string", "file": "path", "title": "summary", "description": "details"}]}
\`\`\``

          const messages: Message[] = [{ role: 'user', content: prompt }]
          this.summarizer.provider.endSession?.()
          const response = await this.trackedPromise(
            'structurizer',
            'structurizer',
            'extracting issues',
            () => this.summarizer.provider.chat(messages, systemPrompt, chatOpts)
          )
          this.trackTokens('summarizer', prompt, response)

          const parsed = parseReviewerOutput(response)
          if (parsed) {
            const rawIssueCount = rawReviewerOutputIssueCount(response)
            if (parsed.issues.length > 0 || rawIssueCount === 0) {
              for (const issue of parsed.issues) {
                candidates.push({
                  reviewerId: message.reviewerId,
                  round: message.round,
                  messageIndex: index,
                  issue
                })
              }
              break
            }
          }
          // Parse failed or all emitted issues were filtered — will retry if attempts remain.
        } catch {
          this.summarizer.provider.endSession?.()
          // Call failed — will retry if attempts remain, then continue with the next message.
        }
      }
    }

    this.summarizer.provider.endSession?.()
    return deduplicateIssues(candidates)
  }

  private async getFinalConclusion(): Promise<string> {
    // Build conversation text from all debate rounds
    const conversationText = this.conversationHistory
      .map(msg => `[${msg.reviewerId}]:\n${msg.content}`)
      .join('\n\n---\n\n')

    const prompt = `There are ${this.reviewers.length} reviewers in this debate. Based on their full discussion below, provide a final conclusion including:
- Points of consensus
- Points of disagreement with analysis
- Recommended action items

${conversationText}${this.langSuffix}`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = this.options.status
      ? await this.collectStream(
          'summarizer',
          'summarizer',
          this.summarizer,
          messages
        )
      : await this.summarizer.provider.chat(messages, this.withLang(this.summarizer.systemPrompt))
    this.trackTokens('summarizer', prompt + (this.summarizer.systemPrompt || ''), response)
    return response
  }

  /**
   * Verify the final conclusion by cross-checking it against the actual PR diff/code.
   * The summarizer re-examines the conclusion's correctness and reasonableness,
   * then produces a verified final conclusion.
   */
  private async verifyConclusion(finalConclusion: string): Promise<string> {
    const prompt = `You are given a final review conclusion and the original PR/code changes. Your job is to VERIFY the conclusion by cross-checking it against the actual code.

## Final Conclusion to Verify

${finalConclusion}

## Original PR/Code Changes

${this.taskPrompt}

## Analysis

${this.analysis}

## Verification Task

Carefully re-read the actual code changes above and verify the conclusion:

1. **Correctness Check**: Are the issues mentioned in the conclusion actually present in the code? Are there any false positives (issues claimed but not real)?
2. **Completeness Check**: Did the conclusion miss any important issues that are visible in the code?
3. **Reasonableness Check**: Are the severity ratings appropriate? Are the recommended actions practical?
4. **Evidence Check**: For each key claim in the conclusion, can you find supporting evidence in the actual diff?

Then provide your **Verified Final Conclusion** that:
- Confirms findings that are supported by the code
- Corrects any inaccurate claims
- Adds any missed issues you found
- Adjusts severity or recommendations if needed
- Gives a final, authoritative assessment${this.langSuffix}`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const systemPrompt = this.withLang('You are a meticulous code review verifier. Your job is to fact-check review conclusions against the actual code changes. Be precise and evidence-based — cite specific code when confirming or correcting claims.')
    const response = await this.trackedPromise(
      'verifier:conclusion',
      'verifier',
      'verifying conclusion',
      () => this.summarizer.provider.chat(messages, systemPrompt)
    )
    this.trackTokens('summarizer', prompt + (systemPrompt || ''), response)
    return response
  }

  /**
   * Verify+Audit: check each structured issue against actual code using tools.
   * Mutates the parsedIssues array in-place: adjusts severity based on verification.
   * This replaces the downstream audit step that was previously in li-bot.
   */
  private async verifyIssues(issues: MergedIssue[]): Promise<void> {
    const issuesText = issues.map((iss, i) => {
      const loc = iss.line ? `${iss.file}:${iss.line}` : iss.file
      const agreement = iss.raisedBy.length >= 2
        ? `[raised by BOTH: ${iss.raisedBy.join(', ')}]`
        : `[raised by: ${iss.raisedBy.join(', ')} only]`
      return `### Issue ${i} [${iss.severity}] ${agreement}\nLocation: ${loc}\nTitle: ${iss.title}\nDescription: ${iss.description}`
    }).join('\n\n')

    const prompt = `You are a strict code review auditor. You have access to the full repository via Read/Grep/Glob tools.

For EACH issue below:
1. Use Read/Grep/Glob to check the actual code and verify the claim is accurate
2. Check if the issue is truly introduced by this PR, or pre-existing
3. Check if the pattern is intentional/by-design (grep for similar patterns in the codebase)
4. Re-score the severity using these strict definitions:
   - critical: Compilation failure, data corruption, exploitable security hole, guaranteed crash
   - high: Logic error that WILL trigger under realistic conditions, resource leak, real concurrency bug
   - medium: Edge case that COULD trigger, missing error handling, compatibility risk
   - low: Code quality, minor concern, pre-existing issue
   - nitpick: Style only, or false positive (issue does not actually exist)

Agreement signal: Issues raised by BOTH reviewers have higher prior probability of being real.
Issues raised by only ONE reviewer should be scrutinized more carefully.

Output ONLY a JSON block:
\`\`\`json
{
  "verified": [
    {"index": 0, "severity": "high", "reason": "Verified: null deref confirmed at line 42"},
    {"index": 1, "severity": "nitpick", "reason": "False positive: caller already validates input at line 30"}
  ]
}
\`\`\`

All issues must appear in the "verified" array. Index corresponds to the issue number above.

Issues to verify:

${issuesText}${this.langSuffix}`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const systemPrompt = this.withLang(
      'You are a strict code review auditor. Use Read/Grep/Glob tools to verify each issue against the actual code. Be precise — check the real code, do not guess.'
    )

    try {
      const response = await this.trackedPromise(
        'verifier:issues',
        'verifier',
        'verifying issues',
        () => this.summarizer.provider.chat(messages, systemPrompt)
      )
      this.trackTokens('verifier', prompt + (systemPrompt || ''), response)

      // Parse the verification result
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/)
      const jsonStr = jsonMatch?.[1] || response
      const match = jsonStr.match(/\{[\s\S]*"verified"\s*:\s*\[[\s\S]*?\]\s*\}/)
      if (match) {
        const parsed = JSON.parse(match[0])
        if (Array.isArray(parsed.verified)) {
          // Apply verified severities back to issues
          for (const v of parsed.verified) {
            const idx = v.index
            if (idx >= 0 && idx < issues.length && typeof v.severity === 'string') {
              issues[idx].severity = v.severity as MergedIssue['severity']
            }
          }
          logger.info(`Verified ${parsed.verified.length} issues`)
        }
      }
    } catch (err) {
      // Verification failure is non-fatal — keep original severities
      logger.warn('Issue verification failed, keeping original severities:', err)
    }
  }
}
