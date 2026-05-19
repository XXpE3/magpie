// tests/providers/factory.test.ts
import { describe, it, expect } from 'vitest'
import { createProvider, isCliModel, normalizeOllamaBaseURL } from '../../src/providers/factory.js'
import type { MagpieConfig } from '../../src/config/types.js'

describe('Provider Factory', () => {
  const mockConfig: MagpieConfig = {
    providers: {
      anthropic: { api_key: 'ant-key' },
      openai: { api_key: 'oai-key' },
      google: { api_key: 'google-key' },
      minimax: { api_key: 'minimax-key' },
      ollama: { base_url: 'http://localhost:11434' },
      'claude-code': { enabled: true },
      'codex-cli': { enabled: true },
      'gemini-cli': { enabled: true },
      'qwen-code': { enabled: true },
    },
    defaults: { max_rounds: 3, output_format: 'markdown', check_convergence: true },
    reviewers: {},
    summarizer: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', prompt: '' },
    analyzer: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', prompt: '' }
  }

  describe('isCliModel', () => {
    it('should detect direct CLI providers from config provider names', () => {
      expect(isCliModel(mockConfig, 'codex-cli')).toBe(true)
      expect(isCliModel(mockConfig, 'openai')).toBe(false)
    })

    it('should detect CLI provider aliases by configured type', () => {
      const config: MagpieConfig = {
        ...mockConfig,
        providers: {
          ...mockConfig.providers,
          codexAlias: { type: 'codex-cli' },
          deepseek: { type: 'openai', api_key: 'deepseek-key' },
        }
      }

      expect(isCliModel(config, 'codexAlias')).toBe(true)
      expect(isCliModel(config, 'deepseek')).toBe(false)
    })
  })

  describe('createProvider', () => {
    it('should create anthropic provider from explicit provider', () => {
      const provider = createProvider('claude-sonnet-4-20250514', mockConfig, 'anthropic')
      expect(provider.name).toBe('anthropic')
    })

    it('should create openai provider from explicit provider', () => {
      const provider = createProvider('gpt-4o', mockConfig, 'openai')
      expect(provider.name).toBe('openai')
    })

    it('should create google provider from explicit provider', () => {
      const provider = createProvider('gemini-pro', mockConfig, 'google')
      expect(provider.name).toBe('gemini')
    })

    it('should create minimax provider from explicit provider', () => {
      const provider = createProvider('MiniMax-M2.7-highspeed', mockConfig, 'minimax')
      expect(provider.name).toBe('minimax')
    })

    it('should create ollama provider from explicit provider', () => {
      const provider = createProvider('custom-ollama-model', mockConfig, 'ollama')
      expect(provider.name).toBe('ollama')
    })

    it('should support custom provider aliases with explicit type', () => {
      const configWithDeepSeek: MagpieConfig = {
        ...mockConfig,
        providers: {
          ...mockConfig.providers,
          deepseek: { type: 'openai', api_key: 'deepseek-key', base_url: 'https://api.deepseek.com/v1' },
        }
      }
      const provider = createProvider('deepseek-v4-pro', configWithDeepSeek, 'deepseek')
      expect(provider.name).toBe('deepseek')
    })

    it('should default configured custom providers to OpenAI-compatible aliases', () => {
      const configWithMoonshot: MagpieConfig = {
        ...mockConfig,
        providers: {
          ...mockConfig.providers,
          moonshot: { api_key: 'moonshot-key', base_url: 'https://api.moonshot.cn/v1' },
        }
      }
      const provider = createProvider('kimi-k2', configWithMoonshot, 'moonshot')
      expect(provider.name).toBe('moonshot')
    })

    it('should throw a clear error when provider is omitted instead of inferring from model id', () => {
      expect(() => createProvider('gpt-4o', mockConfig, undefined as unknown as string)).toThrow('Provider is required')
    })

    it('should throw for an unconfigured custom provider', () => {
      expect(() => createProvider('kimi-k2', mockConfig, 'moonshot')).toThrow('Unknown provider: moonshot')
    })

    it('should throw for missing API provider config', () => {
      const configWithoutOpenAI: MagpieConfig = {
        ...mockConfig,
        providers: { anthropic: { api_key: 'key' } }
      }
      expect(() => createProvider('gpt-4o', configWithoutOpenAI, 'openai')).toThrow('Provider openai not configured')
    })

    it('should create claude-code provider from explicit provider', () => {
      const provider = createProvider('claude-code', mockConfig, 'claude-code')
      expect(provider.name).toBe('claude-code')
    })

    it('should create codex-cli provider from explicit provider', () => {
      const provider = createProvider('codex-cli', mockConfig, 'codex-cli')
      expect(provider.name).toBe('codex-cli')
    })

    it('should pass model as cliModel for explicit CLI providers', () => {
      const provider = createProvider('gpt-5.5', mockConfig, 'codex-cli')
      expect(provider.name).toBe('codex-cli')
      expect((provider as unknown as { cliModel?: string }).cliModel).toBe('gpt-5.5')
    })

    it('should pass base_url through to API providers', () => {
      const configWithBaseUrl: MagpieConfig = {
        ...mockConfig,
        providers: {
          anthropic: { api_key: 'ant-key', base_url: 'https://my-proxy.example.com' },
          openai: { api_key: 'oai-key', base_url: 'https://my-openai-proxy.example.com/v1' },
        }
      }
      const anthropicProvider = createProvider('claude-sonnet-4-20250514', configWithBaseUrl, 'anthropic')
      expect(anthropicProvider.name).toBe('anthropic')

      const openaiProvider = createProvider('gpt-4o', configWithBaseUrl, 'openai')
      expect(openaiProvider.name).toBe('openai')
    })
  })

  describe('normalizeOllamaBaseURL', () => {
    it('should append /v1 for root Ollama URLs', () => {
      expect(normalizeOllamaBaseURL('http://localhost:11434')).toBe('http://localhost:11434/v1')
      expect(normalizeOllamaBaseURL('http://localhost:11434/')).toBe('http://localhost:11434/v1')
    })

    it('should preserve query strings when appending /v1', () => {
      expect(normalizeOllamaBaseURL('http://localhost:11434?foo=bar')).toBe('http://localhost:11434/v1?foo=bar')
    })

    it('should preserve URLs that already include /v1', () => {
      expect(normalizeOllamaBaseURL('http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
      expect(normalizeOllamaBaseURL('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1')
    })

    it('should preserve custom proxy paths', () => {
      expect(normalizeOllamaBaseURL('https://proxy.example.com/ollama')).toBe('https://proxy.example.com/ollama')
    })

    it('should reject invalid URLs with a helpful protocol hint', () => {
      expect(() => normalizeOllamaBaseURL('localhost:11434')).toThrow('Include http:// or https://')
    })
  })
})
