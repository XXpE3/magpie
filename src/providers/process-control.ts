import { spawn, type ChildProcess } from 'child_process'

export interface RunCliProcessOptions {
  command: string
  args: string[]
  cwd: string
  stdin: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}

export interface RunCliProcessResult {
  stdout: string
  stderr: string
}

export function terminateProcess(child: Pick<ChildProcess, 'kill'>): void {
  try {
    child.kill('SIGTERM')
  } catch {
    // Process may already have exited.
  }

  const forceKill = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // Process may already have exited.
    }
  }, 5000)
  forceKill.unref()
}

export function runCliProcess(options: RunCliProcessOptions): Promise<RunCliProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timeout: NodeJS.Timeout | undefined

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      fn()
    }

    const fail = (err: Error) => settle(() => reject(err))

    const abort = () => {
      terminateProcess(child)
      fail(new Error(`${options.command} CLI aborted`))
    }

    const refreshTimeout = () => {
      if (options.timeoutMs <= 0) return
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(() => {
        terminateProcess(child)
        fail(new Error(`${options.command} CLI timed out after ${options.timeoutMs / 1000}s of inactivity${stderr ? ': ' + stderr.slice(-500) : ''}`))
      }, options.timeoutMs)
      timeout.unref()
    }

    if (options.signal?.aborted) {
      abort()
    } else {
      options.signal?.addEventListener('abort', abort, { once: true })
    }

    refreshTimeout()

    child.stdout.on('data', (data) => {
      stdout += data.toString()
      refreshTimeout()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
      refreshTimeout()
    })

    child.on('close', (code) => {
      if (code !== 0) {
        fail(new Error(`${options.command} CLI exited with code ${code}: ${stderr}`))
      } else {
        settle(() => resolve({ stdout, stderr }))
      }
    })

    child.on('error', (err) => {
      fail(new Error(`Failed to run ${options.command} CLI: ${err.message}`))
    })

    child.stdin.on('error', () => {})
    child.stdin.write(options.stdin)
    child.stdin.end()
  })
}
