import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../../src/providers/anthropic.js'
import { ClaudeCodeProvider } from '../../src/providers/claude-code.js'
import { CodexCliProvider } from '../../src/providers/codex-cli.js'
import { GeminiProvider } from '../../src/providers/gemini.js'
import { GeminiCliProvider } from '../../src/providers/gemini-cli.js'
import { MiniMaxProvider } from '../../src/providers/minimax.js'
import { MockProvider } from '../../src/providers/mock.js'
import { OpenAIProvider } from '../../src/providers/openai.js'
import { QwenCodeProvider } from '../../src/providers/qwen-code.js'

describe('provider capabilities', () => {
  it('declares API provider capabilities', () => {
    const providers = [
      new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-20250514' }),
      new GeminiProvider({ apiKey: 'test', model: 'gemini-pro' }),
      new MiniMaxProvider({ apiKey: 'test', model: 'MiniMax-M2.5' }),
      new OpenAIProvider({ apiKey: 'test', model: 'gpt-4o' }),
      new MockProvider(),
    ]

    for (const provider of providers) {
      expect(provider.capabilities.canReadRepo).toBe(false)
      expect(provider.capabilities.canUseTools).toBe(false)
      expect(provider.capabilities.canDisableTools).toBe(false)
      expect(provider.capabilities.supportsStreaming).toBe(true)
    }
  })

  it('declares CLI provider capabilities', () => {
    expect(new ClaudeCodeProvider().capabilities).toEqual({
      canReadRepo: true,
      canUseTools: true,
      canDisableTools: true,
      supportsStreaming: true,
      supportsAbort: true,
      supportsSession: true,
    })

    for (const provider of [
      new CodexCliProvider(),
      new GeminiCliProvider(),
      new QwenCodeProvider(),
    ]) {
      expect(provider.capabilities).toEqual({
        canReadRepo: true,
        canUseTools: true,
        canDisableTools: false,
        supportsStreaming: true,
        supportsAbort: true,
        supportsSession: true,
      })
    }
  })
})
