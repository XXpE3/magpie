import { describe, it, expect, vi } from 'vitest'
import { OpenAIProvider } from '../../src/providers/openai'

let lastConstructorOptions: Record<string, unknown> = {}
let lastCreateArgs: unknown[] = []

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn((...args: unknown[]) => {
          lastCreateArgs = args
          const body = args[0] as { stream?: boolean }
          if (body?.stream) {
            return Promise.resolve({
              async *[Symbol.asyncIterator]() {
                yield { choices: [{ delta: { content: 'chunk1' } }] }
                yield { choices: [{ delta: { content: 'chunk2' } }] }
              },
              controller: { abort: vi.fn() }
            })
          }
          return Promise.resolve({
            choices: [{ message: { content: 'Mock response' } }]
          })
        })
      }
    }
    constructor(options: Record<string, unknown>) {
      lastConstructorOptions = options
    }
  }
}))

describe('OpenAIProvider', () => {
  it('should have correct name', () => {
    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-4o' })
    expect(provider.name).toBe('openai')
  })

  it('should support a custom provider name', () => {
    const provider = new OpenAIProvider({ apiKey: 'test', model: 'glm-5.1:cloud', name: 'ollama' })
    expect(provider.name).toBe('ollama')
  })

  it('should call chat and return response', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-4o' })
    const result = await provider.chat([{ role: 'user', content: 'Hello' }])
    expect(result).toBe('Mock response')
  })

  it('should pass baseURL to SDK when provided', () => {
    new OpenAIProvider({ apiKey: 'test', model: 'gpt-4o', baseURL: 'https://my-proxy.example.com/v1' })
    expect(lastConstructorOptions.baseURL).toBe('https://my-proxy.example.com/v1')
  })

  it('should not set baseURL when not provided', () => {
    new OpenAIProvider({ apiKey: 'test', model: 'gpt-4o' })
    expect(lastConstructorOptions.baseURL).toBeUndefined()
  })
  it('should pass AbortSignal to streaming requests', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-4o' })
    const controller = new AbortController()
    const chunks: string[] = []

    for await (const chunk of provider.chatStream([{ role: 'user', content: 'Hello' }], undefined, { signal: controller.signal })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual(['chunk1', 'chunk2'])
    expect(lastCreateArgs[1]).toEqual({ signal: controller.signal })
  })
})
