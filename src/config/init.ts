// src/config/init.ts
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface ReviewerOption {
  id: string
  name: string
  model: string
  description: string
  needsApiKey: boolean
  provider?: 'anthropic' | 'openai' | 'google' | 'claude-code' | 'codex-cli' | 'gemini-cli' | 'ollama'
}

export const AVAILABLE_REVIEWERS: ReviewerOption[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    model: 'claude-code',
    description: 'Uses your Claude Code subscription (no API key needed)',
    needsApiKey: false,
    provider: 'claude-code'
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    model: 'codex-cli',
    description: 'Uses your OpenAI Codex CLI subscription (no API key needed)',
    needsApiKey: false,
    provider: 'codex-cli'
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    model: 'gemini-cli',
    description: 'Uses your Gemini CLI (Google account, no API key needed)',
    needsApiKey: false,
    provider: 'gemini-cli'
  },
  {
    id: 'claude-api',
    name: 'Claude Sonnet 4.5',
    model: 'claude-sonnet-4-5-20250514',
    description: 'Uses Anthropic API (requires ANTHROPIC_API_KEY)',
    needsApiKey: true,
    provider: 'anthropic'
  },
  {
    id: 'gpt',
    name: 'GPT-5.2',
    model: 'gpt-5.2',
    description: 'Uses OpenAI API (requires OPENAI_API_KEY)',
    needsApiKey: true,
    provider: 'openai'
  },
  {
    id: 'gemini',
    name: 'Gemini 3.1 Pro',
    model: 'gemini-3.1-pro-preview',
    description: 'Uses Google AI API (requires GOOGLE_API_KEY)',
    needsApiKey: true,
    provider: 'google'
  },
  {
    id: 'ollama-glm',
    name: 'GLM 5.1 Cloud',
    model: 'glm-5.1:cloud',
    description: 'Uses local Ollama OpenAI-compatible API',
    needsApiKey: false,
    provider: 'ollama'
  },
  {
    id: 'ollama-kimi',
    name: 'Kimi K2.6 Cloud',
    model: 'kimi-k2.6:cloud',
    description: 'Uses local Ollama OpenAI-compatible API',
    needsApiKey: false,
    provider: 'ollama'
  },
  {
    id: 'ollama-qwen',
    name: 'Qwen 3.5 397B Cloud',
    model: 'qwen3.5:397b-cloud',
    description: 'Uses local Ollama OpenAI-compatible API',
    needsApiKey: false,
    provider: 'ollama'
  }
]

const REVIEW_PROMPT = `You are a thorough code reviewer. Your job is to find ALL issues — not just the obvious ones.

      REVIEW METHOD:
      1. Use 'gh pr view' and 'gh pr diff' to get the PR details
      2. Go through EVERY changed file and EVERY changed function/block systematically
      3. For each change, evaluate: correctness, security, performance, error handling, edge cases, maintainability
      4. Do NOT stop after finding a few issues — exhaust every file and every change before concluding

      IMPORTANT: Do not skip any changed file. Do not gloss over any changed function.
      If a file has no issues, briefly note that you reviewed it and found nothing.

      After your analysis, output your findings as a structured JSON block:
      \`\`\`json
      {
        "issues": [
          {
            "severity": "critical|high|medium|low|nitpick",
            "category": "security|performance|error-handling|style|correctness|...",
            "file": "path/to/file.ts",
            "line": 42,
            "title": "One-line summary",
            "description": "Detailed explanation",
            "suggestedFix": "What to do about it"
          }
        ],
        "verdict": "approve|request_changes|comment",
        "summary": "Brief overall assessment"
      }
      \`\`\`
      You may include free-form discussion before the JSON block.`

export function generateConfig(selectedReviewerIds: string[]): string {
  const selectedReviewers = AVAILABLE_REVIEWERS.filter(r => selectedReviewerIds.includes(r.id))

  // Determine which providers need API keys
  const needsAnthropic = selectedReviewers.some(r => r.provider === 'anthropic')
  const needsOpenai = selectedReviewers.some(r => r.provider === 'openai')
  const needsGoogle = selectedReviewers.some(r => r.provider === 'google')
  const needsOllama = selectedReviewers.some(r => r.provider === 'ollama')

  // Build providers section
  let providersSection = '# AI Provider API Keys (use environment variables)\nproviders:'
  if (needsAnthropic) {
    providersSection += `
  anthropic:
    api_key: \${ANTHROPIC_API_KEY}`
  }
  if (needsOpenai) {
    providersSection += `
  openai:
    api_key: \${OPENAI_API_KEY}`
  }
  if (needsGoogle) {
    providersSection += `
  google:
    api_key: \${GOOGLE_API_KEY}`
  }
  if (needsOllama) {
    providersSection += `
  ollama:
    base_url: http://localhost:11434
    # api_key: \${OLLAMA_API_KEY}`
  }
  if (!needsAnthropic && !needsOpenai && !needsGoogle && !needsOllama) {
    providersSection += ' {}'  // Empty providers if only CLI tools are used
  }

  // Build reviewers section
  let reviewersSection = '# Reviewer configurations\nreviewers:'
  for (const reviewer of selectedReviewers) {
    const providerLine = reviewer.provider ? `\n    provider: ${reviewer.provider}` : ''
    reviewersSection += `
  ${reviewer.id}:
    model: ${reviewer.model}${providerLine}`
  }

  // Determine analyzer model (prefer first selected reviewer)
  const analyzerReviewer = selectedReviewers[0]
  const analyzerModel = analyzerReviewer?.model || 'claude-code'
  const analyzerProviderLine = analyzerReviewer?.provider ? `  provider: ${analyzerReviewer.provider}\n` : ''
  const contextProviderComment = analyzerReviewer?.provider
    ? `  # provider: ${analyzerReviewer.provider}  # Optional: defaults to analyzer provider\n`
    : ''

  const config = `# Magpie Configuration

${providersSection}

# Default settings
defaults:
  max_rounds: 5
  output_format: markdown
  check_convergence: true  # Stop early when reviewers reach consensus

# Shared prompt for all reviewers
prompt_file: prompt.txt

${reviewersSection}

# Analyzer configuration - runs before debate to provide context
analyzer:
  model: ${analyzerModel}
${analyzerProviderLine}  prompt: |
    You are a senior engineer providing PR context analysis.
    Before the review debate begins, analyze this PR and provide:

    1. **What this PR does** - A clear summary of the changes
    2. **Architecture/Design** - Key architectural decisions and patterns used
    3. **Purpose** - What problem this solves or what feature it adds
    4. **Trade-offs** - Any trade-offs made and why
    5. **Things to note** - Important details reviewers should pay attention to
    6. **Suggested Review Focus** - List 2-4 key areas reviewers should focus on for THIS specific PR

    Use 'gh pr view' and 'gh pr diff' to get the PR details.
    Be concise but thorough. Start your response directly with the analysis — do NOT include any preamble, thinking, or meta-commentary like "Here's my analysis" or "Let me look at this".

# Summarizer configuration
summarizer:
  model: ${analyzerModel}
${analyzerProviderLine}  prompt: |
    You are a neutral technical reviewer.
    Based on the full reviewer discussion, provide:
    - Points of consensus
    - Points of disagreement with analysis
    - Recommended action items

# Context gatherer configuration (collects system-level context before review)
contextGatherer:
  enabled: true
  # model: ${analyzerModel}  # Optional: defaults to analyzer model
${contextProviderComment}  callChain:
    maxDepth: 2
    maxFilesToAnalyze: 20
  history:
    maxDays: 30
    maxPRs: 10
  docs:
    patterns:
      - docs
      - README.md
      - ARCHITECTURE.md
      - DESIGN.md
    maxSize: 50000
`

  return config
}

// Legacy default config for backwards compatibility
export const DEFAULT_CONFIG = generateConfig(['claude-code', 'codex-cli'])

export function initConfig(baseDir?: string, selectedReviewers?: string[]): string {
  const base = baseDir || homedir()
  const magpieDir = join(base, '.magpie')
  const configPath = join(magpieDir, 'config.yaml')
  const promptPath = join(magpieDir, 'prompt.txt')

  if (existsSync(configPath)) {
    throw new Error(`Config already exists: ${configPath}`)
  }

  const config = selectedReviewers
    ? generateConfig(selectedReviewers)
    : DEFAULT_CONFIG

  mkdirSync(magpieDir, { recursive: true })
  writeFileSync(configPath, config, 'utf-8')
  if (!existsSync(promptPath)) {
    writeFileSync(promptPath, REVIEW_PROMPT + '\n', 'utf-8')
  }

  return configPath
}
