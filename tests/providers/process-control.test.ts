import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCliProcess, terminateProcess } from '../../src/providers/process-control.js'

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

  it('runs a CLI process with stdin and captures stdout and stderr', async () => {
    const result = await runCliProcess({
      command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout); process.stderr.write("err")'],
      cwd: process.cwd(),
      stdin: 'hello',
      timeoutMs: 1000,
    })

    expect(result.stdout).toBe('hello')
    expect(result.stderr).toBe('err')
  })

  it('times out inactive CLI processes', async () => {
    await expect(runCliProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 1000)'],
      cwd: process.cwd(),
      stdin: '',
      timeoutMs: 20,
    })).rejects.toThrow('timed out')
  })

  it('aborts CLI processes', async () => {
    const controller = new AbortController()
    const run = runCliProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      stdin: '',
      timeoutMs: 1000,
      signal: controller.signal,
    })

    controller.abort()

    await expect(run).rejects.toThrow('aborted')
  })
})
