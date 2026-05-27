import { afterEach, describe, expect, it, vi } from 'vitest'
import { MiniMaxProvider } from '../../src/providers/minimax.js'

describe('MiniMaxProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('passes AbortSignal to streaming fetch requests', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Mock response' } }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new MiniMaxProvider({ apiKey: 'test', model: 'MiniMax-M2.5' })
    const chunks: string[] = []

    for await (const chunk of provider.chatStream([{ role: 'user', content: 'Hello' }], undefined, { signal: controller.signal })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual(['Mock response'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal })
  })
})
