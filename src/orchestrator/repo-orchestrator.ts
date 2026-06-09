// src/orchestrator/repo-orchestrator.ts
import { open } from 'fs/promises'
import type { Message } from '../providers/types.js'
import type { Reviewer } from './types.js'
import type { ReviewPlan, ReviewStep } from '../planner/types.js'
import type { RepoReviewResult, ReviewIssue } from '../reporter/types.js'
import type { RepoStats, FileInfo } from '../repo-scanner/types.js'
import type { FeatureReviewResult } from '../state/types.js'
import { parseReviewerOutput } from './issue-parser.js'

export type ReviewFocus = 'security' | 'performance' | 'architecture' | 'code-quality' | 'testing' | 'documentation'

export interface RepoReviewPromptLimits {
  maxFilesPerPrompt?: number
  maxFileBytes?: number
  maxPromptChars?: number
}

const DEFAULT_PROMPT_LIMITS: Required<RepoReviewPromptLimits> = {
  maxFilesPerPrompt: 20,
  maxFileBytes: 20_000,
  maxPromptChars: 60_000
}

const ISSUE_SCHEMA_INSTRUCTIONS = `Output ONLY a JSON block:
\`\`\`json
{
  "issues": [
    {
      "severity": "critical|high|medium|low|nitpick",
      "category": "correctness|security|performance|concurrency|resource-leak|error-handling|build|testing|documentation|architecture|compatibility|style",
      "file": "path/to/file",
      "line": 42,
      "title": "One-line summary",
      "description": "Concise explanation",
      "suggestedFix": "Brief one-line fix summary",
      "evidence": "Specific code or behavior that supports the finding"
    }
  ],
  "verdict": "approve|request_changes|comment",
  "summary": "Brief summary"
}
\`\`\`

Rules:
- Include every concrete issue found.
- If there are no concrete issues, return {"issues":[],"verdict":"approve","summary":"No issues found"}.
- Use the exact repository-relative file path.
- Include "line" when the location is clear.
- Severity: critical = compilation failure, data corruption, exploitable security hole, guaranteed crash; high = logic error that will trigger, resource leak, real concurrency bug; medium = edge case, missing error handling, compatibility risk; low = code quality; nitpick = style only.`

const TRUNCATED_CONTENT_NOTICE = '\n\n[File content truncated by repo review prompt limits.]'

function normalizePromptLimits(limits?: RepoReviewPromptLimits): Required<RepoReviewPromptLimits> {
  return {
    maxFilesPerPrompt: Math.max(1, Math.floor(limits?.maxFilesPerPrompt ?? DEFAULT_PROMPT_LIMITS.maxFilesPerPrompt)),
    maxFileBytes: Math.max(1, Math.floor(limits?.maxFileBytes ?? DEFAULT_PROMPT_LIMITS.maxFileBytes)),
    maxPromptChars: Math.max(1_000, Math.floor(limits?.maxPromptChars ?? DEFAULT_PROMPT_LIMITS.maxPromptChars))
  }
}

function issueLocation(file: string, line?: number): string {
  return line == null ? file : `${file}:${line}`
}

function clipSection(section: string, maxLength: number): string {
  if (section.length <= maxLength) return section
  if (maxLength <= TRUNCATED_CONTENT_NOTICE.length) return section.slice(0, maxLength)
  return section.slice(0, maxLength - TRUNCATED_CONTENT_NOTICE.length) + TRUNCATED_CONTENT_NOTICE
}

async function readFilePreview(file: FileInfo, maxBytes: number): Promise<{ content: string; truncated: boolean; error?: string }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(file.path, 'r')
    const bytesToRead = Math.min(file.size, maxBytes)
    const buffer = Buffer.allocUnsafe(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
    return {
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: file.size > maxBytes
    }
  } catch (error) {
    return {
      content: '',
      truncated: false,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    await handle?.close()
  }
}

function formatFileSection(file: FileInfo, preview: { content: string; truncated: boolean; error?: string }): string {
  if (preview.error) {
    return `## ${file.relativePath}\n\nError reading file: ${preview.error}`
  }
  const truncation = preview.truncated ? TRUNCATED_CONTENT_NOTICE : ''
  return `## ${file.relativePath}\n\n\`\`\`${file.language}\n${preview.content}${truncation}\n\`\`\``
}

export interface RepoOrchestratorOptions {
  onStepStart?: (step: ReviewStep, index: number, total: number) => void
  onStepComplete?: (step: ReviewStep, index: number) => void
  onMessage?: (reviewerId: string, chunk: string) => void
  onDebate?: (issue: string, messages: string[]) => void
  focusAreas?: ReviewFocus[]
  promptLimits?: RepoReviewPromptLimits
  onFeatureComplete?: (featureId: string, result: FeatureReviewResult) => void | Promise<void>
}

export interface FeatureRepoReviewResult extends RepoReviewResult {
  featureResults: Record<string, FeatureReviewResult>
}

export class RepoOrchestrator {
  private reviewers: Reviewer[]
  private summarizer: Reviewer
  private options: RepoOrchestratorOptions
  private allIssues: ReviewIssue[] = []
  private issueCounter = 0

  constructor(
    reviewers: Reviewer[],
    summarizer: Reviewer,
    options: RepoOrchestratorOptions = {}
  ) {
    this.reviewers = reviewers
    this.summarizer = summarizer
    this.options = options
  }

  async executePlan(plan: ReviewPlan, repoName: string, stats?: RepoStats): Promise<RepoReviewResult> {
    this.allIssues = []
    this.issueCounter = 0

    // Phase 1: Architecture analysis (first step overview)
    const architectureAnalysis = await this.analyzeArchitecture(plan)

    // Phase 2: Execute each step
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]
      this.options.onStepStart?.(step, i, plan.steps.length)

      await this.executeStep(step)

      this.options.onStepComplete?.(step, i)
    }

    // Phase 3: Debate on found issues
    await this.debateIssues()

    return {
      repoName,
      timestamp: new Date(),
      stats: stats || { totalFiles: 0, totalLines: 0, languages: {}, estimatedTokens: 0, estimatedCost: 0 },
      architectureAnalysis,
      issues: this.allIssues,
      tokenUsage: {
        total: plan.totalEstimatedTokens,
        cost: plan.totalEstimatedCost
      }
    }
  }

  async executeFeaturePlan(plan: { steps: Array<{ featureId: string; name: string; description: string; files: FileInfo[]; estimatedTokens: number }>; totalEstimatedTokens: number; totalEstimatedCost: number }, repoName: string, stats?: RepoStats): Promise<FeatureRepoReviewResult> {
    this.allIssues = []
    this.issueCounter = 0
    const featureResults: Record<string, FeatureReviewResult> = {}

    // Phase 1: Architecture analysis
    const architectureAnalysis = await this.analyzeArchitecture({ steps: plan.steps, totalEstimatedTokens: plan.totalEstimatedTokens, totalEstimatedCost: plan.totalEstimatedCost })

    // Phase 2: Execute each feature
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]
      this.options.onStepStart?.(step, i, plan.steps.length)

      const stepIssuesBefore = this.allIssues.length
      await this.executeStep(step)
      const stepIssuesAfter = this.allIssues.length

      const featureIssues = this.allIssues.slice(stepIssuesBefore, stepIssuesAfter)
      const result: FeatureReviewResult = {
        featureId: step.featureId,
        issues: featureIssues,
        summary: `Found ${featureIssues.length} issues in ${step.name}`,
        reviewedAt: new Date()
      }

      featureResults[step.featureId] = result
      await this.options.onFeatureComplete?.(step.featureId, result)
      this.options.onStepComplete?.(step, i)
    }

    // Phase 3: Debate on found issues
    await this.debateIssues()

    return {
      repoName,
      timestamp: new Date(),
      stats: stats || { totalFiles: 0, totalLines: 0, languages: {}, estimatedTokens: 0, estimatedCost: 0 },
      architectureAnalysis,
      issues: this.allIssues,
      tokenUsage: {
        total: plan.totalEstimatedTokens,
        cost: plan.totalEstimatedCost
      },
      featureResults
    }
  }

  private async analyzeArchitecture(plan: ReviewPlan): Promise<string> {
    const stepNames = plan.steps.map(s => s.name).join(', ')
    const prompt = `Analyze the overall architecture of this codebase. The main modules are: ${stepNames}. Provide a brief assessment.`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await this.summarizer.provider.chat(messages, this.summarizer.systemPrompt)
    return response
  }

  private async executeStep(step: ReviewStep): Promise<void> {
    const focusAreas = this.options.focusAreas || ['security', 'performance', 'code-quality']
    const focusText = this.getFocusInstructions(focusAreas)

    for (const reviewer of this.reviewers) {
      const prompts = reviewer.provider.capabilities.canReadRepo && reviewer.provider.capabilities.canUseTools
        ? [this.buildCliReviewPrompt(step, focusText)]
        : await this.buildApiReviewPrompts(step, focusText)

      for (const prompt of prompts) {
        const messages: Message[] = [{ role: 'user', content: prompt }]
        const response = await reviewer.provider.chat(messages, reviewer.systemPrompt)
        this.options.onMessage?.(reviewer.id, response)

        this.parseIssues(response)
      }
    }
  }

  private parseIssues(response: string): void {
    const parsed = parseReviewerOutput(response)

    if (parsed) {
      for (const issue of parsed.issues) {
        this.issueCounter++
        this.allIssues.push({
          id: this.issueCounter,
          location: issueLocation(issue.file, issue.line),
          description: issue.description,
          severity: issue.severity,
          consensus: '1/1',
          category: issue.category,
          file: issue.file,
          line: issue.line,
          endLine: issue.endLine,
          title: issue.title,
          suggestedFix: issue.suggestedFix,
          evidence: issue.evidence
        })
      }
      return
    }

    const issueRegex = /ISSUE:\s*\[([^\]]+)\]\s*-\s*\[([^\]]+)\]\s*-\s*\[severity:\s*(high|medium|low)\]/gi
    let match

    while ((match = issueRegex.exec(response)) !== null) {
      this.issueCounter++
      this.allIssues.push({
        id: this.issueCounter,
        location: match[1],
        description: match[2],
        severity: match[3] as 'high' | 'medium' | 'low',
        consensus: '1/1'
      })
    }
  }

  private buildCliReviewPrompt(step: ReviewStep, focusText: string): string {
    const fileList = step.files.map(f => f.relativePath).join('\n')
    return `Review the following files in ${step.name}:
${fileList}

Use your repository tools to inspect the files and relevant context.

${focusText}

${ISSUE_SCHEMA_INSTRUCTIONS}`
  }

  private async buildApiReviewPrompts(step: ReviewStep, focusText: string): Promise<string[]> {
    const limits = normalizePromptLimits(this.options.promptLimits)
    const prefix = `Review the following files in ${step.name}.

${focusText}

The file contents are embedded below. Review only these provided contents.

${ISSUE_SCHEMA_INSTRUCTIONS}

Files:
`
    const prompts: string[] = []
    const sections: string[] = []
    let currentLength = prefix.length
    const maxSectionLength = Math.max(1, limits.maxPromptChars - prefix.length - 1)

    const flush = () => {
      if (sections.length === 0) return
      prompts.push(prefix + sections.join('\n\n'))
      sections.length = 0
      currentLength = prefix.length
    }

    for (const file of step.files) {
      const preview = await readFilePreview(file, limits.maxFileBytes)
      let section = formatFileSection(file, preview)
      section = clipSection(section, maxSectionLength)
      const separatorLength = sections.length === 0 ? 0 : 2

      if (
        sections.length > 0 &&
        (sections.length >= limits.maxFilesPerPrompt || currentLength + separatorLength + section.length > limits.maxPromptChars)
      ) {
        flush()
      }

      sections.push(section)
      currentLength += (sections.length === 1 ? 0 : 2) + section.length
    }

    flush()
    return prompts.length > 0 ? prompts : [prefix]
  }

  private getFocusInstructions(focusAreas: ReviewFocus[]): string {
    const focusDescriptions: Record<ReviewFocus, string> = {
      'security': 'security vulnerabilities (injection, XSS, authentication, authorization, data exposure)',
      'performance': 'performance issues (N+1 queries, memory leaks, inefficient algorithms, unnecessary computation)',
      'architecture': 'architectural problems (coupling, cohesion, separation of concerns, design patterns)',
      'code-quality': 'code quality (readability, maintainability, naming, complexity, duplication)',
      'testing': 'testing gaps (missing tests, inadequate coverage, test quality)',
      'documentation': 'documentation issues (missing docs, outdated comments, unclear APIs)'
    }

    const instructions = focusAreas.map(f => focusDescriptions[f]).join(', ')
    return `Focus your review on: ${instructions}. Identify any issues in these areas.`
  }

  private async debateIssues(): Promise<void> {
    // For severe issues, run a debate round
    const highIssues = this.allIssues.filter(i => i.severity === 'critical' || i.severity === 'high')

    for (const issue of highIssues) {
      const debateMessages: string[] = []
      const prompt = `Evaluate this potential issue: ${issue.description} at ${issue.location}. Is this a real problem? What's the actual severity?`

      for (const reviewer of this.reviewers) {
        const messages: Message[] = [{ role: 'user', content: prompt }]
        const response = await reviewer.provider.chat(messages, reviewer.systemPrompt)
        debateMessages.push(response)
      }

      issue.debateSummary = debateMessages.join('\n---\n')
      issue.consensus = `${this.reviewers.length}/${this.reviewers.length}`
      this.options.onDebate?.(issue.description, debateMessages)
    }
  }
}
