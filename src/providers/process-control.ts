import type { ChildProcess } from 'child_process'

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
