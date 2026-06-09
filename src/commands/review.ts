import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { loadConfig } from '../config/loader.js'
import type { CliProviderConfig, MagpieConfig, ReviewerConfig } from '../config/types.js'
import { createProvider, isCliModel } from '../providers/factory.js'
import { DebateOrchestrator, buildReviewTargetPayload } from '../orchestrator/orchestrator.js'
import type { DebateResult, Reviewer, ReviewerStatus } from '../orchestrator/types.js'
import { createInterface, emitKeypressEvents } from 'readline'
import { marked } from 'marked'
import TerminalRenderer from 'marked-terminal'
import { ContextGatherer } from '../context-gatherer/index.js'
import type { ReviewTarget, ReviewTargetFile, ReviewerSessionState } from './review/types.js'
import { fixMarkdown, getRandomJoke, formatMarkdown, formatVerificationLabel } from './review/utils.js'
import { selectReviewers, interactiveFollowUpQA, interactiveCommentReview, interactivePostReviewDiscussion, interactiveGeneralDiscussion } from './review/interactive.js'
import { handleRepoReview } from './review/repo-review.js'
import { canForceProceed, formatParallelStatus, isPlainForceProceedKey } from './review/parallel-status.js'
import { handleListSessions, handleResumeSession, handleExportSession } from './review/session-cmds.js'
import { filterDiff } from '../utils/diff-filter.js'
import { fetchLargePRDiff } from '../utils/large-diff.js'
import { requireSystemPrompt } from '../utils/prompt.js'
import { StatusRenderer, StatusTracker } from '../status/index.js'
import { parseGitHubPRUrl, runGh, runGit, validateGitHubRepo, validateGitRemoteName, validatePRNumber } from '../utils/command.js'

// Configure marked to render for terminal
marked.setOptions({
  renderer: new TerminalRenderer({
    reflowText: true,   // Reflow text to fit terminal width
    width: 120,         // Wider output for modern terminals
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TerminalRenderer type mismatch with marked
  }) as any
})

export function canCliProviderFetchPr(config: MagpieConfig, provider: string): boolean {
  const configuredProvider = config.providers?.[provider] as (CliProviderConfig & { type?: string }) | undefined
  const providerName = configuredProvider?.type || provider

  if (providerName === 'claude-code' || providerName === 'codex-cli') {
    const cliConfig = configuredProvider || config.providers?.[providerName] as CliProviderConfig | undefined
    if (cliConfig?.allowDangerousBypass === true) return true
    if (providerName === 'codex-cli') {
      return cliConfig?.allowNetwork === true && cliConfig?.allowWrite === true
    }
    return cliConfig?.allowNetwork === true
  }

  return true
}

export function canReviewersFetchPr(config: MagpieConfig, reviewerConfigs: ReviewerConfig[]): boolean {
  return reviewerConfigs.every(rc => isCliModel(config, rc.provider))
    && reviewerConfigs.every(rc => canCliProviderFetchPr(config, rc.provider))
}

export function buildBranchReviewPrompt(currentBranch: string, baseBranch: string, diff: string): string {
  return buildReviewTargetPayload({
    kind: 'branch',
    label: `Branch: ${currentBranch}`,
    repoRoot: process.cwd(),
    baseBranch,
    diff
  }).promptForApi
}

function readReviewFiles(files: string[], repoRoot: string): ReviewTargetFile[] {
  return files.map(file => {
    try {
      return {
        path: file,
        content: readFileSync(resolve(repoRoot, file), 'utf-8')
      }
    } catch (error) {
      return {
        path: file,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
}

export const reviewCommand = new Command('review')
  .description('Review code changes with multiple AI reviewers')
  .argument('[pr]', 'PR number or URL (optional if using --local, --branch, or --files)')
  .option('-c, --config <path>', 'Path to config file')
  .option('-r, --rounds <number>', 'Maximum debate rounds', '5')
  .option('-i, --interactive', 'Interactive mode (pause between turns)')
  .option('-o, --output <file>', 'Output to file instead of stdout')
  .option('-f, --format <format>', 'Output format (markdown|json)', 'markdown')
  .option('--no-converge', 'Disable early stop when reviewers reach consensus')
  .option('-l, --local', 'Review local uncommitted changes (staged + unstaged)')
  .option('-b, --branch [base]', 'Review current branch vs base (default: main)')
  .option('--files <files...>', 'Review specific files')
  .option('--git-remote <name>', 'Git remote to use for PR URL detection (default: origin)')
  .option('--reviewers <ids>', 'Comma-separated reviewer IDs to use (e.g., claude,gemini)')
  .option('-a, --all', 'Use all reviewers (skip selection)')
  // Repo review options
  .option('--repo', 'Review entire repository')
  .option('--path <path>', 'Subdirectory to review (with --repo)')
  .option('--ignore <patterns...>', 'Patterns to ignore (with --repo)')
  .option('--quick', 'Quick mode: only architecture overview')
  .option('--deep', 'Deep mode: full analysis without prompts')
  .option('--plan-only', 'Only generate review plan, do not execute')
  .option('--reanalyze', 'Force re-analyze features (ignore cache)')
  .option('--list-sessions', 'List all review sessions')
  .option('--session <id>', 'Resume specific session by ID')
  .option('--export <file>', 'Export completed review to markdown')
  .option('--skip-context', 'Skip context gathering phase')
  .option('--no-post', 'Skip post-processing (GitHub comment flow)')
  .option('--no-conclusion', 'Skip final conclusion generation (bot mode)')
  .action(async (pr: string | undefined, options) => {
    const spinner = ora('Loading configuration...').start()

    // Graceful Ctrl+C handling: first press marks interrupted, second press force-exits
    const interruptState = { interrupted: false }
    let lastSigint = 0
    const sigintHandler = () => {
      const now = Date.now()
      if (interruptState.interrupted && now - lastSigint < 3000) {
        // Second Ctrl+C within 3s → force exit
        console.error('\nForce exit.')
        process.exit(130)
      }
      interruptState.interrupted = true
      lastSigint = now
      console.error(chalk.yellow('\n⚠ Ctrl+C received. Finishing current step... (press again to force exit)'))
    }
    process.on('SIGINT', sigintHandler)
    let disableForceProceedShortcut: () => void = () => {}

    try {
      // Load config first (needed for --repo handling)
      const config = loadConfig(options.config)
      spinner.succeed('Configuration loaded')

      // Handle --list-sessions
      if (options.listSessions) {
        await handleListSessions(spinner)
        return
      }

      // Handle --session <id>
      if (options.session) {
        await handleResumeSession(options.session, config, spinner)
        return
      }

      // Handle --export <file>
      if (options.export) {
        await handleExportSession(options.export, spinner)
        return
      }

      // Handle --repo flag
      if (options.repo) {
        await handleRepoReview(options, config, spinner)
        return
      }

      // Validate arguments (for non-repo review)
      if (!options.local && !options.branch && !options.files && !pr) {
        spinner.fail('Error')
        console.error(chalk.red('Error: Please specify a PR number or use --local, --branch, --files, or --repo'))
        process.exit(1)
      }

      spinner.start('Preparing review...')

      // Get local diff if --local flag is used
      let localDiff: string | null = null
      let reviewingLastCommit = false
      if (options.local) {
        spinner.text = 'Getting local changes...'
        try {
          // Get both staged and unstaged changes
          const diff = filterDiff(runGit(['diff', 'HEAD'], { maxBuffer: 10 * 1024 * 1024 }), config.defaults.diff_exclude)
          if (!diff.trim()) {
            // No uncommitted changes, fall back to last commit
            spinner.text = 'No uncommitted changes, getting last commit...'
            const lastCommitDiff = filterDiff(runGit(['diff', 'HEAD~1', 'HEAD'], { maxBuffer: 10 * 1024 * 1024 }), config.defaults.diff_exclude)
            if (!lastCommitDiff.trim()) {
              spinner.fail('No changes found')
              console.error(chalk.yellow('Tip: Make some changes or commits first, then run again.'))
              process.exit(0)
            }
            localDiff = lastCommitDiff
            reviewingLastCommit = true
            const commitMsg = runGit(['log', '-1', '--pretty=%s']).trim()
            spinner.succeed(`Reviewing last commit: "${commitMsg}" (${lastCommitDiff.split('\n').length} lines)`)
          } else {
            localDiff = diff
            spinner.succeed(`Found local changes (${diff.split('\n').length} lines)`)
          }
        } catch (error) {
          spinner.fail('Failed to get git diff')
          console.error(chalk.red('Error: Not a git repository or git is not available'))
          process.exit(1)
        }
      }

      // Determine review target
      const repoRoot = process.cwd()
      let target: ReviewTarget

      if (options.local) {
        target = {
          kind: 'local',
          label: reviewingLastCommit ? 'Last Commit' : 'Local Changes',
          repoRoot,
          diff: localDiff ?? ''
        }
      } else if (options.branch !== undefined) {
        const baseBranch = typeof options.branch === 'string' ? options.branch : config.defaults.base_branch || 'main'
        const currentBranch = runGit(['branch', '--show-current']).trim()
        let branchDiff = ''
        try {
          branchDiff = filterDiff(
            runGit(['diff', `${baseBranch}...${currentBranch}`], {
              maxBuffer: 10 * 1024 * 1024,
            }),
            config.defaults.diff_exclude
          )
        } catch {
          spinner.fail('Failed to get branch diff')
          console.error(chalk.red(`Error: Could not compare branch "${currentBranch}" to "${baseBranch}"`))
          process.exit(1)
        }
        if (!branchDiff.trim()) {
          spinner.fail('No branch changes found')
          console.error(chalk.yellow(`Tip: Make changes on "${currentBranch}" or choose a different base branch.`))
          process.exit(0)
        }
        spinner.succeed(`Found branch changes (${branchDiff.split('\n').length} lines)`)
        target = {
          kind: 'branch',
          label: `Branch: ${currentBranch}`,
          repoRoot,
          baseBranch,
          diff: branchDiff
        }
      } else if (options.files) {
        const files = readReviewFiles(options.files, repoRoot)
        target = {
          kind: 'files',
          label: `Files: ${options.files.join(', ')}`,
          repoRoot,
          files
        }
      } else if (pr) {
        // Support both PR number and full URL
        let prUrl = ''
        let prNumber: string

        let prRepo: string | undefined

        if (pr.startsWith('http')) {
          // Full URL provided
          const parsed = parseGitHubPRUrl(pr)
          prUrl = parsed.url
          prNumber = parsed.prNumber
          prRepo = parsed.repo
        } else {
          // Just PR number, try to detect repo from git
          prNumber = validatePRNumber(pr)
          const gitRemote = validateGitRemoteName(options.gitRemote || 'origin')

          // Use gh to resolve the actual PR URL (handles forks: finds PR on upstream repo)
          try {
            const resolvedUrl = runGh(['pr', 'view', prNumber, '--json', 'url', '--jq', '.url'], { timeout: 30000 }).trim()
            const parsed = parseGitHubPRUrl(resolvedUrl)
            prRepo = parsed.repo
            prUrl = parsed.url
          } catch {
            // gh pr view failed — fall back to git remote detection
          }

          if (!prRepo) {
            try {
              const remoteUrl = runGit(['remote', 'get-url', gitRemote]).trim()
              // Convert git@github.com:org/repo.git or https://github.com/org/repo.git to https://github.com/org/repo
              const repoMatch = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/)
              if (repoMatch) {
                const repo = validateGitHubRepo(repoMatch[1])
                prUrl = `https://github.com/${repo}/pull/${prNumber}`
              } else {
                prUrl = `PR #${prNumber}`  // Fallback
              }
            } catch {
              prUrl = `PR #${prNumber}`  // Fallback if not in git repo
            }
          }
        }

        // Fetch PR metadata. Base branch comes from GitHub instead of a hard-coded default.
        let prTitle = ''
        let prBody = ''
        let baseBranch: string | undefined
        let headSha: string | undefined
        try {
          const prInfo = JSON.parse(runGh(['pr', 'view', prUrl, '--json', 'title,body,baseRefName,headRefOid'], { timeout: 30000 }))
          prTitle = prInfo.title || ''
          prBody = prInfo.body || ''
          baseBranch = prInfo.baseRefName || undefined
          headSha = prInfo.headRefOid || undefined
        } catch {
          // Non-fatal: reviewers can still work without metadata
        }

        let prDiff = ''
        let diffNotice: string | undefined
        try {
          prDiff = runGh(['pr', 'diff', prUrl], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 })
          const originalLines = prDiff.split('\n').length
          prDiff = filterDiff(prDiff, config.defaults.diff_exclude)
          const filteredLines = prDiff.split('\n').length
          if (filteredLines < originalLines) {
            console.log(chalk.dim(`  Diff filtered: ${originalLines} -> ${filteredLines} lines (excluded generated files)`))
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          if (errMsg.includes('406') || errMsg.includes('too_large') || errMsg.includes('exceeded')) {
            console.log(chalk.yellow(`  PR diff too large for GitHub API, fetching via files API...`))
            try {
              const repo = prRepo || (() => {
                const remoteUrl = runGit(['remote', 'get-url', 'origin']).trim()
                const m = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/)
                return m ? validateGitHubRepo(m[1]) : ''
              })()
              if (repo) {
                const result = fetchLargePRDiff(repo, prNumber, {
                  maxLines: 15000,
                  excludePatterns: config.defaults.diff_exclude
                })
                prDiff = filterDiff(result.diff, config.defaults.diff_exclude)
                console.log(chalk.dim(`  Reconstructed diff: ${result.includedFiles}/${result.totalFiles} files (~${prDiff.split('\n').length} lines)`))
                if (result.truncated) {
                  console.log(chalk.yellow(`  Diff truncated to fit context window. Some files excluded.`))
                  diffNotice = `NOTE: This is a large PR. ${result.summary}`
                }
              }
            } catch (fallbackErr) {
              console.error(chalk.yellow(`Warning: Fallback diff fetch also failed: ${fallbackErr instanceof Error ? fallbackErr.message.slice(0, 100) : fallbackErr}`))
            }
          } else {
            console.error(chalk.yellow(`Warning: Could not pre-fetch PR diff: ${errMsg.slice(0, 100)}`))
          }
        }

        const allReviewerConfigs = [
          ...Object.values(config.reviewers),
          config.analyzer,
          config.summarizer,
        ]

        target = {
          kind: 'pr',
          label: `PR #${prNumber}`,
          repoRoot,
          repo: prRepo,
          prNumber,
          prUrl,
          prTitle,
          prBody,
          baseBranch,
          headSha,
          diff: prDiff,
          diffNotice,
          cliCanFetchPr: canReviewersFetchPr(config, allReviewerConfigs)
        }
      } else {
        spinner.fail('Error')
        console.error(chalk.red('Error: Please specify a PR number or use --local, --branch, --files, or --repo'))
        process.exit(1)
      }

      // Setup interactive mode readline early (before reviewer selection)
      // This ensures we use a single readline instance throughout
      let rl: ReturnType<typeof createInterface> | null = null
      if (options.interactive) {
        rl = createInterface({
          input: process.stdin,
          output: process.stdout
        })
      }

      // Determine which reviewers to use
      const allReviewerIds = Object.keys(config.reviewers)
      let selectedIds: string[]

      // Stop spinner before interactive selection
      spinner.stop()

      if (options.reviewers) {
        // Use --reviewers flag
        selectedIds = options.reviewers.split(',').map((s: string) => s.trim())
        const invalid = selectedIds.filter(id => !allReviewerIds.includes(id))
        if (invalid.length > 0) {
          spinner.fail('Error')
          console.error(chalk.red(`Unknown reviewer(s): ${invalid.join(', ')}`))
          console.error(chalk.dim(`Available: ${allReviewerIds.join(', ')}`))
          rl?.close()
          process.exit(1)
        }
      } else if (options.all || !process.stdin.isTTY) {
        // Use all reviewers (also auto-select in non-TTY mode to prevent hanging)
        if (!process.stdin.isTTY) {
          console.log(chalk.yellow('Non-interactive mode detected, using all reviewers.'))
        }
        selectedIds = allReviewerIds
      } else {
        // Default: interactive selection (pass rl to reuse it)
        selectedIds = await selectReviewers(allReviewerIds, rl || undefined)
      }

      if (selectedIds.length < 1) {
        spinner.fail('Error')
        console.error(chalk.red('Need at least 1 reviewer'))
        rl?.close()
        process.exit(1)
      }

      // Create reviewers
      const reviewers: Reviewer[] = selectedIds.map(id => ({
        id,
        provider: createProvider(config.reviewers[id].model, config, config.reviewers[id].provider),
        systemPrompt: requireSystemPrompt(`reviewers.${id}`, config.reviewers[id].prompt)
      }))

      // Create summarizer
      const summarizer: Reviewer = {
        id: 'summarizer',
        provider: createProvider(config.summarizer.model, config, config.summarizer.provider),
        systemPrompt: requireSystemPrompt('summarizer', config.summarizer.prompt)
      }

      // Create analyzer
      const analyzer: Reviewer = {
        id: 'analyzer',
        provider: createProvider(config.analyzer.model, config, config.analyzer.provider),
        systemPrompt: requireSystemPrompt('analyzer', config.analyzer.prompt)
      }

      // Create context gatherer (if enabled)
      let contextGatherer: ContextGatherer | undefined
      const contextEnabled = !options.skipContext && (config.contextGatherer?.enabled !== false)

      if (contextEnabled) {
        const contextModel = config.contextGatherer?.model || config.analyzer.model
        const contextProvider = config.contextGatherer?.provider || config.analyzer.provider
        contextGatherer = new ContextGatherer({
          provider: createProvider(contextModel, config, contextProvider),
          language: config.defaults.language,
          options: {
            callChain: config.contextGatherer?.callChain,
            history: config.contextGatherer?.history,
            docs: config.contextGatherer?.docs
          }
        })
      }

      const isSoloReview = reviewers.length === 1
      const maxRounds = isSoloReview ? 1 : parseInt(options.rounds, 10)
      // Convergence: disable for solo review; otherwise default from config, CLI can override with --no-converge
      const checkConvergence = !isSoloReview && options.converge !== false && (config.defaults.check_convergence !== false)

      console.log()
      console.log(chalk.bgBlue.white.bold(` ${target.label} Review `))
      console.log(chalk.dim(`├─ Reviewers: ${selectedIds.map(id => `${chalk.cyan(id)} ${chalk.gray('(' + config.reviewers[id].model + ')')}`).join(', ')}`))
      console.log(chalk.dim(`├─ Max rounds: ${maxRounds}`))
      console.log(chalk.dim(`├─ Convergence: ${checkConvergence ? 'enabled' : 'disabled'}`))
      console.log(chalk.dim(`└─ Context gathering: ${contextEnabled ? 'enabled' : 'disabled'}`))

      let currentReviewer = ''
      let currentRound = 1
      let messageBuffer = ''  // Buffer for current reviewer's message
      let currentHeaderPrinted = false
      let activeStream: { reviewerId: string; startTime: number; outputChars: number; chunkCount: number } | null = null

      // Use object ref to avoid TypeScript control flow issues with closures
      const spinnerRef: {
        spinner: ReturnType<typeof ora> | null
        interval: ReturnType<typeof setInterval> | null
        parallelStatuses: ReviewerStatus[] | null
      } = {
        spinner: null,
        interval: null,
        parallelStatuses: null
      }

      let parallelControl: { forceProceed(): void } | null = null
      let forceProceedListenerAttached = false
      let previousRawMode: boolean | undefined
      const onForceProceedKey = (input: string, key?: { name?: string; ctrl?: boolean; meta?: boolean }) => {
        if (key?.ctrl && key.name === 'c') {
          sigintHandler()
          return
        }
        if (!parallelControl || !isPlainForceProceedKey(input, key) || !canForceProceed(spinnerRef.parallelStatuses)) return
        const control = parallelControl
        disableForceProceedShortcut()
        if (spinnerRef.spinner) {
          spinnerRef.spinner.text = chalk.yellow('Force proceeding with completed reviewer results...')
        }
        control.forceProceed()
      }
      disableForceProceedShortcut = () => {
        parallelControl = null
        if (!forceProceedListenerAttached) return
        forceProceedListenerAttached = false
        process.stdin.off('keypress', onForceProceedKey)
        if (process.stdin.isTTY && process.stdin.setRawMode && previousRawMode !== undefined) {
          process.stdin.setRawMode(previousRawMode)
        }
        previousRawMode = undefined
      }
      const enableForceProceedShortcut = (control: { forceProceed(): void }) => {
        parallelControl = control
        if (!process.stdin.isTTY || forceProceedListenerAttached) return
        emitKeypressEvents(process.stdin, rl ?? undefined)
        process.stdin.on('keypress', onForceProceedKey)
        forceProceedListenerAttached = true
        previousRawMode = process.stdin.isRaw
        if (process.stdin.setRawMode) {
          process.stdin.setRawMode(true)
        }
        if (process.stdin.isPaused?.()) process.stdin.resume()
      }

      const statusRenderer = new StatusRenderer()
      const status = new StatusTracker(snapshot => statusRenderer.render(snapshot), {
        quietMs: 30_000,
        stalledMs: 60_000,
      })
      status.start()

      const formatChars = (chars = 0): string => chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : `${chars}`

      const printMessageHeader = (reviewerId: string) => {
        if (reviewerId === 'analyzer') {
          console.log(chalk.magenta.bold(`\n${'─'.repeat(50)}`))
          console.log(chalk.magenta.bold(`  📋 Analysis`))
          console.log(chalk.magenta.bold(`${'─'.repeat(50)}\n`))
        } else {
          console.log(chalk.cyan.bold(`\n┌─ ${reviewerId} `) + chalk.dim(`[Round ${currentRound}/${maxRounds}]`))
          console.log(chalk.cyan(`│`))
        }
        currentHeaderPrinted = true
      }

      // Render buffered message when reviewer changes
      const flushBuffer = () => {
        if (spinnerRef.interval) {
          clearInterval(spinnerRef.interval)
          spinnerRef.interval = null
        }
        if (spinnerRef.spinner) {
          spinnerRef.spinner.stop()
          spinnerRef.spinner = null
        }
        statusRenderer.clear()
        if (messageBuffer) {
          if (!currentHeaderPrinted && currentReviewer) {
            printMessageHeader(currentReviewer)
          }
          console.log(marked(fixMarkdown(messageBuffer)))
          messageBuffer = ''
          currentHeaderPrinted = false
        }
        activeStream = null
      }

      const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
        maxRounds,
        interactive: options.interactive,
        checkConvergence,
        language: config.defaults.language,
        interruptState,
        skipConclusion: options.conclusion === false,
        status,
        onWaiting: (reviewerId) => {
          // Flush previous reviewer's buffer before showing spinner
          flushBuffer()
          // Show separator for convergence check to make it stand out
          if (reviewerId === 'convergence-check') {
            console.log(chalk.yellow.bold(`\n┌─ 🔍 Convergence Judge ─────────────────────────`))
          }
          const isParallelRound = reviewerId.startsWith('round-')
          const baseLabel = reviewerId === 'context-gatherer' ? 'Phase: context gathering' :
                       reviewerId === 'analyzer' ? 'Phase: analyzing changes' :
                       reviewerId === 'summarizer' ? 'Phase: final summary' :
                       reviewerId === 'verifier' ? 'Phase: verifying conclusion' :
                       reviewerId === 'convergence-check' ? 'Phase: convergence check' :
                       isParallelRound ? `Round ${reviewerId.split('-')[1]}/${maxRounds}: parallel review` :
                       `Phase: ${reviewerId} thinking`

          // Show spinner with a joke (and parallel/stream status if available)
          const updateSpinner = () => {
            const joke = getRandomJoke()
            if (spinnerRef.spinner) {
              if (spinnerRef.parallelStatuses && isParallelRound) {
                const round = parseInt(reviewerId.split('-')[1])
                spinnerRef.spinner.text = formatParallelStatus(round, maxRounds, spinnerRef.parallelStatuses, Boolean(parallelControl))
              } else if (activeStream) {
                const elapsed = (Date.now() - activeStream.startTime) / 1000
                const statusLine = activeStream.chunkCount > 0
                  ? `${baseLabel} [${chalk.cyan(`▸ ${reviewerId}`)}${chalk.dim(` ${formatChars(activeStream.outputChars)} chars`)}]`
                  : `${baseLabel} [${chalk.yellow(`… ${reviewerId}`)}${chalk.dim(` ${Math.floor(elapsed)}s`)}]`
                spinnerRef.spinner.text = `${statusLine} ${chalk.dim(`| ${joke}`)}`
              } else {
                spinnerRef.spinner.text = `${baseLabel}... ${chalk.dim(`| ${joke}`)}`
              }
            }
          }

          spinnerRef.parallelStatuses = null  // Reset for new waiting phase
          activeStream = reviewerId === 'analyzer'
            ? { reviewerId, startTime: Date.now(), outputChars: 0, chunkCount: 0 }
            : null
          spinnerRef.spinner = ora({ text: `${baseLabel}...`, discardStdin: false }).start()
          updateSpinner()
          // Update joke every 15 seconds
          spinnerRef.interval = setInterval(updateSpinner, 15000)
        },
        onParallelStatus: (round, statuses) => {
          spinnerRef.parallelStatuses = statuses
          // Immediately update spinner to show every reviewer; skip jokes here to keep all statuses visible.
          if (spinnerRef.spinner) {
            spinnerRef.spinner.text = formatParallelStatus(round, maxRounds, statuses, Boolean(parallelControl))
          }
        },
        onParallelRoundControl: (control) => {
          if (control) {
            enableForceProceedShortcut(control)
            if (spinnerRef.spinner && spinnerRef.parallelStatuses) {
              spinnerRef.spinner.text = formatParallelStatus(control.round, maxRounds, spinnerRef.parallelStatuses, Boolean(parallelControl))
            }
          } else {
            disableForceProceedShortcut()
          }
        },
        onMessage: (reviewerId, chunk) => {
          if (reviewerId === 'analyzer') {
            if (reviewerId !== currentReviewer) {
              if (currentReviewer || messageBuffer) {
                flushBuffer()
              }
              currentReviewer = reviewerId
              currentHeaderPrinted = false
            }
            messageBuffer += chunk
            if (activeStream) {
              activeStream.outputChars += chunk.length
              activeStream.chunkCount += 1
              if (spinnerRef.spinner) {
                const joke = getRandomJoke()
                spinnerRef.spinner.text = `Phase: analyzing changes [${chalk.cyan(`▸ ${reviewerId}`)}${chalk.dim(` ${formatChars(activeStream.outputChars)} chars`)}] ${chalk.dim(`| ${joke}`)}`
              }
            }
            return
          }

          if (reviewerId !== currentReviewer) {
            // Flush previous reviewer's buffer
            flushBuffer()
            currentReviewer = reviewerId
            printMessageHeader(reviewerId)
          }
          // Buffer the chunk instead of writing directly
          messageBuffer += chunk
        },
        onConvergenceJudgment: (verdict, reasoning) => {
          statusRenderer.clear()
          // Display the judge's reasoning
          if (reasoning) {
            console.log(chalk.dim(`│`))
            console.log(chalk.dim(`│ ${reasoning.split('\n').join('\n│ ')}`))
          }
        },
        onRoundComplete: (round, converged) => {
          statusRenderer.clear()
          // Stop any running spinner (e.g., from convergence-check)
          if (spinnerRef.spinner) {
            spinnerRef.spinner.stop()
            spinnerRef.spinner = null
          }
          if (spinnerRef.interval) {
            clearInterval(spinnerRef.interval)
            spinnerRef.interval = null
          }
          console.log()
          if (converged) {
            console.log(chalk.yellow(`└─ Verdict: `) + chalk.green.bold(`CONVERGED`))
            console.log(chalk.green.bold(`\n✅ Round ${round}/${maxRounds} - CONSENSUS REACHED`))
            console.log(chalk.green(`   Stopping early to save tokens.\n`))
          } else {
            console.log(chalk.yellow(`└─ Verdict: `) + chalk.red.bold(`NOT CONVERGED`))
            console.log(chalk.dim(`\n── Round ${round}/${maxRounds} complete ──\n`))
          }
          currentRound = round + 1
        },
        onInteractive: options.interactive ? async () => {
          // Ensure stdin is flowing (ora spinner may have paused it)
          if (process.stdin.isPaused?.()) process.stdin.resume()
          return new Promise((resolve) => {
            rl!.question(chalk.yellow('\n💬 Press Enter to continue, type to interject, or q to end: '), (answer) => {
              resolve(answer || null)
            })
          })
        } : undefined,
        // Post-analysis Q&A: allow user to ask specific reviewers before debate
        onPostAnalysisQA: options.interactive ? async () => {
          // Flush analysis buffer before showing interactive prompt
          flushBuffer()
          // Ensure stdin is flowing (ora spinner may have paused it)
          if (process.stdin.isPaused?.()) process.stdin.resume()
          return new Promise((resolve) => {
            console.log(chalk.cyan(`\n💡 You can ask specific reviewers questions before the debate begins.`))
            console.log(chalk.dim(`   Format: @reviewer_id question (e.g., @claude What about security?)${reviewers.map(r => `\n   Available: @${r.id}`).join('')}`))
            rl!.question(chalk.yellow('❓ Ask a question or press Enter to start debate: '), (answer) => {
              if (!answer || answer.trim() === '') {
                resolve(null)  // Proceed to debate
                return
              }

              // Parse @target format
              const match = answer.match(/^@(\S+)\s+(.+)$/s)
              if (match) {
                resolve({ target: match[1], question: match[2] })
              } else {
                console.log(chalk.red('   Invalid format. Use: @reviewer_id question'))
                resolve(null)
              }
            })
          })
        } : undefined,
        onContextGathered: (context) => {
          // Flush analysis buffer before displaying context
          flushBuffer()
          // Display context gathering result
          console.log(chalk.magenta.bold(`\n${'─'.repeat(50)}`))
          console.log(chalk.magenta.bold(`  🔍 System Context`))
          console.log(chalk.magenta.bold(`${'─'.repeat(50)}\n`))

          if (context.affectedModules.length > 0) {
            console.log(chalk.dim(`Affected Modules:`))
            for (const mod of context.affectedModules) {
              const impact = mod.impactLevel === 'core' ? chalk.red('●') :
                             mod.impactLevel === 'moderate' ? chalk.yellow('●') :
                             chalk.green('●')
              console.log(chalk.dim(`  ${impact} ${mod.name} (${mod.affectedFiles.length} files)`))
            }
            console.log()
          }

          if (context.relatedPRs.length > 0) {
            console.log(chalk.dim(`Related PRs:`))
            for (const pr of context.relatedPRs.slice(0, 5)) {
              console.log(chalk.dim(`  • #${pr.number}: ${pr.title}`))
            }
            console.log()
          }

          if (context.summary) {
            console.log(marked(fixMarkdown(context.summary)))
          }
        }
      }, contextGatherer)

      let result: DebateResult
      try {
        result = await orchestrator.runStreaming(
          target.label,
          buildReviewTargetPayload(target).promptForCli,
          target
        )
      } finally {
        status.stop()
        statusRenderer.clear()
      }

      // Flush any remaining buffered content
      flushBuffer()

      // Stop any lingering spinner/interval (summarizer doesn't stream)
      if (spinnerRef.interval) {
        clearInterval(spinnerRef.interval)
        spinnerRef.interval = null
      }
      if (spinnerRef.spinner) {
        spinnerRef.spinner.stop()
        spinnerRef.spinner = null
      }

      // Final conclusion with nice formatting
      console.log(chalk.green.bold(`\n${'═'.repeat(50)}`))
      console.log(chalk.green.bold(`  🎯 Final Conclusion`))
      console.log(chalk.green.bold(`${'═'.repeat(50)}\n`))
      // Render markdown for terminal
      console.log(marked(fixMarkdown(result.finalConclusion)))

      // Verified conclusion
      if (result.verifiedConclusion) {
        console.log(chalk.blue.bold(`\n${'═'.repeat(50)}`))
        console.log(chalk.blue.bold(`  ✅ Verified Conclusion`))
        console.log(chalk.blue.bold(`${'═'.repeat(50)}\n`))
        console.log(marked(fixMarkdown(result.verifiedConclusion)))
      }

      // Display structured issues table (if available)
      if (result.parsedIssues && result.parsedIssues.length > 0) {
        const issues = result.parsedIssues
        const severityColors: Record<string, (s: string) => string> = {
          critical: chalk.red.bold,
          high: chalk.red,
          medium: chalk.yellow,
          low: chalk.blue,
          nitpick: chalk.dim
        }
        const totalRaw = issues.reduce((sum, i) => sum + i.raisedBy.length, 0)

        console.log(chalk.magenta.bold(`\n${'─'.repeat(50)}`))
        console.log(chalk.magenta.bold(`  📋 Issues Found (${issues.length} unique, ${totalRaw} total across reviewers)`))
        console.log(chalk.magenta.bold(`${'─'.repeat(50)}\n`))

        for (let i = 0; i < issues.length; i++) {
          const issue = issues[i]
          const color = severityColors[issue.severity] || chalk.white
          const location = issue.line ? `${issue.file}:${issue.line}` : issue.file
          const reviewers = issue.raisedBy.map(r => chalk.cyan(r)).join(', ')

          console.log(color(`  ${String(i + 1).padStart(2)}. [${issue.severity.toUpperCase().padEnd(8)}] ${issue.title}`))
          console.log(chalk.dim(`      ${location}  [${reviewers}]`))
          if (issue.verification) {
            console.log(chalk.dim(`      verification: ${formatVerificationLabel(issue)} — ${issue.verification.reason}`))
            if (issue.verification.evidence) {
              console.log(chalk.dim(`      evidence: ${issue.verification.evidence.slice(0, 140)}`))
            }
          }
          if (issue.suggestedFix) {
            console.log(chalk.green(`      Fix: ${issue.suggestedFix.slice(0, 100)}`))
          }
          console.log()
        }
      }

      // Save and compare with previous review (if structured issues available)
      if (result.parsedIssues && result.parsedIssues.length > 0) {
        try {
          const { HistoryTracker } = await import('../history/tracker.js')
          const repoName = process.cwd().split('/').pop() || 'repo'
          const tracker = new HistoryTracker(process.cwd())
          await tracker.saveReview(repoName, target.label, result.parsedIssues)

          const diff = await tracker.diffLatest(repoName, target.label)
          if (diff) {
            console.log(chalk.cyan.bold(`\n  vs. previous review (${diff.previousTimestamp}):`))
            if (diff.fixed.length > 0) console.log(chalk.green(`    ✅ ${diff.fixed.length} fixed`))
            if (diff.stillOpen.length > 0) console.log(chalk.yellow(`    ⚠️  ${diff.stillOpen.length} still open`))
            if (diff.new.length > 0) console.log(chalk.red(`    🆕 ${diff.new.length} new`))
          }
        } catch {
          // History tracking is optional, don't fail the review
        }
      }

      // Build all available roles (reviewers + analyzer + summarizer)
      const allRoles = [
        ...orchestrator.getReviewers(),
        orchestrator.getAnalyzer(),
        orchestrator.getSummarizer()
      ]
      const reviewerSessions = new Map<string, ReviewerSessionState>()

      // PR reviews: General Discussion → Issue-by-issue loop
      if (options.post !== false && target.kind === 'pr' && result.parsedIssues && result.parsedIssues.length > 0) {
        if (!rl) {
          rl = createInterface({ input: process.stdin, output: process.stdout })
        }

        // Optional general discussion phase (chat + resolve issues inline)
        const discussionResult = await interactiveGeneralDiscussion(
          rl, allRoles, result, target, result.parsedIssues, spinnerRef, reviewerSessions, config.defaults.language
        )

        // Filter out issues already resolved in general discussion
        const remainingIssues = result.parsedIssues.filter((_, i) => !discussionResult.resolvedIndices.has(i))

        if (remainingIssues.length > 0) {
          // Ensure stdin is flowing (ora spinner may have paused it)
          if (process.stdin.isPaused?.()) process.stdin.resume()
          const preApprovedCount = discussionResult.approvedComments.length
          const prompt = preApprovedCount > 0
            ? `\n  Review ${remainingIssues.length} remaining issues and post to GitHub? (${preApprovedCount} already queued) (y/n): `
            : `\n  Review and post individual comments to GitHub? (y/n): `
          const enterPostProcess = await new Promise<string>(resolve => {
            rl!.question(chalk.yellow(prompt), resolve)
          })
          if (enterPostProcess.trim().toLowerCase() === 'y') {
            const prNum = target.label.match(/\d+/)?.[0] || target.label
            await interactiveCommentReview(rl!, remainingIssues, allRoles, prNum, spinnerRef, result, target, interruptState, reviewerSessions, config.defaults.language, discussionResult.approvedComments)
          } else if (preApprovedCount > 0) {
            // User declined issue-by-issue but has pre-approved comments — post them directly
            const prNum = target.label.match(/\d+/)?.[0] || target.label
            await interactiveCommentReview(rl!, [], allRoles, prNum, spinnerRef, result, target, interruptState, reviewerSessions, config.defaults.language, discussionResult.approvedComments)
          }
        } else if (discussionResult.approvedComments.length > 0) {
          // All issues resolved in discussion — post approved ones
          const prNum = target.label.match(/\d+/)?.[0] || target.label
          await interactiveCommentReview(rl!, [], allRoles, prNum, spinnerRef, result, target, interruptState, reviewerSessions, config.defaults.language, discussionResult.approvedComments)
        } else if (discussionResult.resolvedIndices.size > 0) {
          console.log(chalk.dim('\n  All issues resolved in discussion. Nothing to post.'))
        }
      }

      // Post-review discussion for non-PR reviews (keep existing behavior)
      else if (result.parsedIssues && result.parsedIssues.length > 0 && options.interactive && rl) {
        await interactivePostReviewDiscussion(rl, allRoles, result, target, result.parsedIssues, spinnerRef, reviewerSessions, config.defaults.language)
      }

      // Display token usage
      console.log(chalk.dim(`\n${'─'.repeat(50)}`))
      console.log(chalk.dim(`  📊 Token Usage (Estimated)`))
      console.log(chalk.dim(`${'─'.repeat(50)}`))
      let totalInput = 0
      let totalOutput = 0
      let totalCost = 0
      for (const usage of result.tokenUsage) {
        totalInput += usage.inputTokens
        totalOutput += usage.outputTokens
        totalCost += usage.estimatedCost || 0
        const pad = 12 - usage.reviewerId.length
        console.log(chalk.dim(`  ${usage.reviewerId}${' '.repeat(Math.max(0, pad))} ${usage.inputTokens.toLocaleString().padStart(8)} in  ${usage.outputTokens.toLocaleString().padStart(8)} out`))
      }
      console.log(chalk.dim(`${'─'.repeat(50)}`))
      console.log(chalk.yellow(`  Total${' '.repeat(6)} ${totalInput.toLocaleString().padStart(8)} in  ${totalOutput.toLocaleString().padStart(8)} out  ~$${totalCost.toFixed(4)}`))

      if (result.convergedAtRound) {
        console.log(chalk.green(`\n  ✓ Converged at round ${result.convergedAtRound}`))
      }

      if (options.output) {
        const { writeFileSync } = await import('fs')
        if (options.format === 'json') {
          writeFileSync(options.output, JSON.stringify(result, null, 2))
        } else {
          writeFileSync(options.output, formatMarkdown(result))
        }
        console.log(chalk.green(`\n  ✓ Output saved to: ${options.output}`))
      }

      // Interactive follow-up Q&A after conclusion
      if (options.interactive && rl) {
        await interactiveFollowUpQA(rl, reviewers, result, spinnerRef)
      }

      console.log()

      rl?.close()
    } catch (error) {
      if ((error as Error)?.constructor?.name === 'InterruptedError') {
        spinner.stop()
        console.log(chalk.yellow('\n⚠ Review interrupted.'))
        process.exit(130)
      }
      spinner.fail('Error')
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`))
      }
      process.exit(1)
    } finally {
      process.removeListener('SIGINT', sigintHandler)
      disableForceProceedShortcut()
    }
  })
