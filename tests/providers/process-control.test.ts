import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminateProcess } from '../../src/providers/process-control.js'

describe('terminateProcess', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends SIGTERM then schedules SIGKILL', async () => {
    vi.useFakeTimers()
    const child = { kill: vi.fn() }

    terminateProcess(child)

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')

    await vi.advanceTimersByTimeAsync(5000)

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
