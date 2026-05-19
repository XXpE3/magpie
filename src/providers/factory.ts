// src/providers/factory.ts
import type { AIProvider } from './types.js'
import type { MagpieConfig, ProviderConfig, OllamaProviderConfig } from '../config/types.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenAIProvider } from './openai.js'
import { ClaudeCodeProvider } from './claude-code.js'
import { CodexCliProvider } from './codex-cli.js'
import { GeminiCliProvider } from './gemini-cli.js'
import { GeminiProvider } from './gemini.js'
import { QwenCodeProvider } from './qwen-code.js'
import { MiniMaxProvider } from './minimax.js'
import { MockProvider } from './mock.js'
import { checkCliBinary } from './cli-check.js'

const CLI_PROVIDERS = ['claude-code', 'codex-cli', 'gemini-cli', 'qwen-code'] as const
type ProviderName = 'anthropic' | 'openai' | 'google' | 'claude-code' | 'codex-cli' | 'gemini-cli' | 'qwen-code' | 'minimax' | 'ollama' | 'mock'

const PROVIDER_NAMES: readonly ProviderName[] = ['anthropic', 'openai', 'google', 'claude-code', 'codex-cli', 'gemini-cli', 'qwen-code', 'minimax', 'ollama', 'mock']
const OLLAMA_OPENAI_BASE_URL = 'http://localhost:11434/v1'

function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value)
}

/** Check if a configured provider maps to a CLI-based provider (has tool access / can read files) */
export function isCliModel(config: MagpieConfig, provider: string): boolean {
  return (CLI_PROVIDERS as readonly string[]).includes(resolveProviderName(config, provider))
}

export function normalizeOllamaBaseURL(baseURL: string): string {
  const trimmed = baseURL.trim()
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error()
    }
    const path = url.pathname.replace(/\/+$/, '')
    if (path === '') {
      url.pathname = '/v1'
    } else {
      url.pathname = path
    }
    return url.toString()
  } catch {
    throw new Error(`Invalid Ollama base URL: ${baseURL}. Include http:// or https://.`)
  }
}

function resolveProviderName(config: MagpieConfig, provider: string): ProviderName {
  if (!provider || typeof provider !== 'string') {
    throw new Error('Provider is required. Set a provider field in the reviewer, summarizer, analyzer, or contextGatherer config.')
  }

  const providerConfig = config.providers?.[provider]
  const providerName = providerConfig?.type || provider
  if (isProviderName(providerName)) {
    return providerName
  }

  // Custom configured providers without an explicit type are treated as
  // OpenAI-compatible aliases so `provider: moonshot` can use
  // `providers.moonshot.{api_key,base_url}` directly.
  if (providerConfig && !providerConfig.type) {
    return 'openai'
  }

  throw new Error(`Unknown provider: ${provider}. Check the provider name or set providers.${provider}.type to a supported provider type.`)
}

function getProviderConfig(config: MagpieConfig, providerName: ProviderName, provider: string): ProviderConfig | OllamaProviderConfig | undefined {
  return config.providers?.[provider] || config.providers?.[providerName]
}

function getCliModel(model: string, providerName: ProviderName): string | undefined {
  if ((CLI_PROVIDERS as readonly string[]).includes(providerName) && model !== providerName) {
    return model
  }
  return undefined
}

export function createProvider(model: string, config: MagpieConfig, provider: string): AIProvider {
  // Global mock mode: override all models to MockProvider
  if (config.mock) {
    return new MockProvider()
  }

  const providerName = resolveProviderName(config, provider)

  const cliModel = getCliModel(model, providerName)

  // Claude Code doesn't need API key config
  if (providerName === 'claude-code') {
    checkCliBinary('claude', 'Claude Code')
    return new ClaudeCodeProvider({ cliModel })
  }

  // Codex CLI doesn't need API key config
  if (providerName === 'codex-cli') {
    checkCliBinary('codex', 'Codex')
    return new CodexCliProvider({ cliModel })
  }

  // Gemini CLI doesn't need API key config (uses Google account)
  if (providerName === 'gemini-cli') {
    checkCliBinary('gemini', 'Gemini')
    return new GeminiCliProvider({ cliModel })
  }

  // Qwen Code CLI doesn't need API key config (uses OAuth)
  if (providerName === 'qwen-code') {
    checkCliBinary('qwen', 'Qwen Code')
    return new QwenCodeProvider({ cliModel })
  }

  // Mock provider for debug mode — no API key needed
  if (providerName === 'mock') {
    return new MockProvider()
  }

  // MiniMax uses API key from config or env
  if (providerName === 'minimax') {
    const providerConfig = getProviderConfig(config, providerName, provider)
    return new MiniMaxProvider({
      apiKey: providerConfig?.api_key || process.env.MINIMAX_API_KEY || '',
      model: model.toLowerCase() === 'minimax' ? 'MiniMax-M2.5' : model,
      baseURL: providerConfig?.base_url,
    })
  }

  if (providerName === 'ollama') {
    const providerConfig = getProviderConfig(config, providerName, provider)
    const baseURL = normalizeOllamaBaseURL(
      providerConfig?.base_url || process.env.OLLAMA_BASE_URL || OLLAMA_OPENAI_BASE_URL
    )
    return new OpenAIProvider({
      apiKey: providerConfig?.api_key || process.env.OLLAMA_API_KEY || 'ollama',
      model,
      baseURL,
      name: 'ollama',
    })
  }

  const providerConfig = getProviderConfig(config, providerName, provider)

  if (!providerConfig) {
    throw new Error(`Provider ${providerName} not configured for model ${model}`)
  }

  switch (providerName) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: providerConfig.api_key || '', model, baseURL: providerConfig.base_url })
    case 'openai':
      return new OpenAIProvider({
        apiKey: providerConfig.api_key || '',
        model,
        baseURL: providerConfig.base_url,
        name: provider && provider !== providerName ? provider : undefined,
      })
    case 'google':
      return new GeminiProvider({ apiKey: providerConfig.api_key || '', model, baseURL: providerConfig.base_url })
    default:
      throw new Error(`Unknown provider: ${providerName}`)
  }
}
