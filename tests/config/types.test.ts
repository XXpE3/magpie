// tests/config/types.test.ts
import { describe, it, expect } from 'vitest'
import type { MagpieConfig } from '../../src/config/types'

describe('Config Types', () => {
  it('should allow valid config structure', () => {
    const config: MagpieConfig = {
      providers: {
        anthropic: { api_key: 'test-key' },
        deepseek: {
          type: 'openai',
          api_key: 'deepseek-key',
          base_url: 'https://api.deepseek.com/v1',
        }
      },
      defaults: {
        max_rounds: 3,
        output_format: 'markdown'
      },
      reviewers: {
        'security-expert': {
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          prompt: 'You are a security expert'
        },
        deepseek: {
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          prompt: 'You are a reviewer'
        },
        qwen: {
          provider: 'ollama',
          model: 'qwen3.5:397b-cloud'
        }
      },
      summarizer: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        prompt: 'You are a neutral summarizer'
      },
      analyzer: {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        prompt: 'Analyze the change'
      },
      contextGatherer: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-v4-pro'
      }
    }
    expect(config.defaults.max_rounds).toBe(3)
    expect(config.reviewers.deepseek.provider).toBe('deepseek')
  })
})
