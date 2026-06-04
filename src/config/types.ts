// src/config/types.ts
export type ProviderType = 'anthropic' | 'openai' | 'google' | 'claude-code' | 'codex-cli' | 'gemini-cli' | 'qwen-code' | 'minimax' | 'ollama' | 'mock'

export interface ProviderConfig {
  type?: ProviderType
  api_key?: string
  base_url?: string
  enabled?: boolean
}

export interface CliSecurityConfig {
  allowDangerousBypass?: boolean
  allowWrite?: boolean
  allowNetwork?: boolean
  extraAllowedTools?: string[]
}

export interface CliProviderConfig extends ProviderConfig, CliSecurityConfig {
  enabled?: boolean
}

export interface OllamaProviderConfig {
  type?: 'ollama' | 'openai'
  api_key?: string
  base_url?: string
}

export interface ReviewerConfig {
  provider: string
  model: string
  prompt?: string
}

export interface DefaultsConfig {
  max_rounds: number
  output_format: 'markdown' | 'json'
  check_convergence: boolean
  language?: string  // Output language (e.g., 'zh', 'en', 'ja')
  base_branch?: string  // Default base branch for branch reviews
  diff_exclude?: string[]  // Glob patterns for files to exclude from diff (e.g., '*.pb.go', '*generated*')
}

export interface ContextGathererConfigOptions {
  enabled: boolean
  callChain?: {
    maxDepth?: number
    maxFilesToAnalyze?: number
  }
  history?: {
    maxDays?: number
    maxPRs?: number
  }
  docs?: {
    patterns?: string[]
    maxSize?: number
  }
  provider?: string  // Provider key from providers; defaults to analyzer provider
  model?: string  // Model to use for context analysis
}

export interface MagpieConfig {
  prompt_file?: string
  providers: Record<string, ProviderConfig | OllamaProviderConfig | CliProviderConfig | undefined> & {
    anthropic?: ProviderConfig
    openai?: ProviderConfig
    google?: ProviderConfig
    'claude-code'?: CliProviderConfig
    'codex-cli'?: CliProviderConfig
    'gemini-cli'?: { enabled: boolean }
    'qwen-code'?: { enabled: boolean }
    minimax?: ProviderConfig
    ollama?: OllamaProviderConfig
  }
  mock?: boolean
  defaults: DefaultsConfig
  reviewers: Record<string, ReviewerConfig>
  summarizer: ReviewerConfig
  analyzer: ReviewerConfig
  contextGatherer?: ContextGathererConfigOptions
}
