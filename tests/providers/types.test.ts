// tests/providers/types.test.ts
import { describe, it, expect } from 'vitest'
import { notifyProviderActivity } from '../../src/providers/types'
import type { AIProvider, Message, ProviderOptions } from '../../src/providers/types'

describe('Provider Types', () => {
  const testCapabilities = {
    canReadRepo: false,
    canUseTools: false,
    canDisableTools: false,
    supportsStreaming: true,
    supportsAbort: false,
    supportsSession: false,
  }

  it('should define correct message structure', () => {
    const message: Message = {
      role: 'user',
      content: 'Hello'
    }
    expect(message.role).toBe('user')
  })

  it('should define provider interface', () => {
    const mockProvider: AIProvider = {
      name: 'test',
      capabilities: testCapabilities,
      chat: async () => 'response',
      chatStream: async function* () { yield 'chunk' }
    }
    expect(mockProvider.name).toBe('test')
    expect(mockProvider.capabilities.supportsStreaming).toBe(true)
  })

  it('should isolate activity callback failures', () => {
    expect(() => notifyProviderActivity({
      onActivity: () => { throw new Error('observer failed') }
    }, { kind: 'stdout' })).not.toThrow()
  })
})
