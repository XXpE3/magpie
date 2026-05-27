import { describe, expect, it, vi } from 'vitest'
import { GeminiProvider } from '../../src/providers/gemini.js'

let lastSendMessageStreamArgs: unknown[] = []

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogleGenerativeAI {
    constructor(_apiKey: string) {}

    getGenerativeModel() {
      return {
        startChat() {
          return {
            sendMessage: vi.fn().mockResolvedValue({ response: { text: () => 'Mock response' } }),
            sendMessageStream: vi.fn((...args: unknown[]) => {
              lastSendMessageStreamArgs = args
              return Promise.resolve({
                stream: (async function *() {
                  yield { text: () => 'chunk1' }
                  yield { text: () => 'chunk2' }
                })()
              })
            })
          }
        }
      }
    }
  }
}))

describe('GeminiProvider', () => {
  it('passes AbortSignal to streaming requests', async () => {
    const provider = new GeminiProvider({ apiKey: 'test', model: 'gemini-test' })
    const controller = new AbortController()
    const chunks: string[] = []

    for await (const chunk of provider.chatStream([{ role: 'user', content: 'Hello' }], undefined, { signal: controller.signal })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual(['chunk1', 'chunk2'])
    expect(lastSendMessageStreamArgs).toEqual(['Hello', { signal: controller.signal }])
  })
})
