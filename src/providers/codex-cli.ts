import { spawn } from 'child_process'
import type { AIProvider, Message, CliProviderOptions, ChatStreamOptions } from './types.js'
import { notifyProviderActivity } from './types.js'
import { CliSessionHelper } from './session-helper.js'
import { preparePromptForCli } from '../utils/prompt-file.js'
import { withRetry } from '../utils/retry.js'
import { terminateProcess } from './process-control.js'
import { logger } from '../utils/logger.js'

export class CodexCliProvider implements AIProvider {
  name = 'codex-cli'
  private cwd: string
  private timeout: number  // ms, 0 = no timeout
  private cliModel?: string
  private allowDangerousBypass: boolean
  private allowWrite: boolean
  private allowNetwork: boolean
  private session = new CliSessionHelper()
  // Codex gets its session ID from the first response (thread_id in JSONL)
  private sessionEnabled = false

  get sessionId() { return this.session.sessionId }

  constructor(options?: CliProviderOptions) {
    // No API key needed for Codex CLI (uses subscription)
    this.cwd = process.cwd()
    this.timeout = 15 * 60 * 1000  // 15 minutes default
    this.cliModel = options?.cliModel
    this.allowDangerousBypass = options?.cliSecurity?.allowDangerousBypass === true
    this.allowWrite = options?.cliSecurity?.allowWrite === true
    this.allowNetwork = options?.cliSecurity?.allowNetwork === true
    if (this.allowDangerousBypass) {
      logger.warn('Dangerous Codex CLI mode is enabled; reviewers may execute commands or modify files.')
    }
  }

  setCwd(cwd: string) {
    this.cwd = cwd
  }

  startSession(name?: string): void {
    this.sessionEnabled = true
    this.session.start(name)
    this.session.sessionId = undefined  // Will be set from first response's JSONL
  }

  endSession(): void {
    this.sessionEnabled = false
    this.session.end()
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const prompt = this.sessionEnabled && !this.session.shouldSendFullHistory()
      ? this.session.buildPromptLastOnly(messages)
      : this.session.buildPrompt(messages, systemPrompt)
    try {
      const result = await withRetry(() => this.runCodex(prompt))
      this.session.markMessageSent()
      return result
    } catch (err) {
      this.startSession(this.session.sessionName)
      throw err
    }
  }

  async *chatStream(messages: Message[], systemPrompt?: string, options?: ChatStreamOptions): AsyncGenerator<string, void, unknown> {
    const prompt = this.sessionEnabled && !this.session.shouldSendFullHistory()
      ? this.session.buildPromptLastOnly(messages)
      : this.session.buildPrompt(messages, systemPrompt)
    try {
      yield* this.runCodexStream(prompt, options)
      this.session.markMessageSent()
    } catch (err) {
      this.startSession(this.session.sessionName)
      throw err
    }
  }

  private buildArgs(): string[] {
    const globalArgs = this.allowNetwork
      ? ['--search', '-c', 'sandbox_workspace_write.network_access=true']
      : []
    const baseArgs = ['--json']
    if (this.allowDangerousBypass) {
      globalArgs.push('--dangerously-bypass-approvals-and-sandbox')
    } else {
      // Codex only enables shell network access through the workspace-write sandbox.
      globalArgs.push('--sandbox', this.allowWrite || this.allowNetwork ? 'workspace-write' : 'read-only')
      globalArgs.push('--ask-for-approval', 'never')
    }
    if (this.cliModel) {
      baseArgs.push('--model', this.cliModel)
    }
    if (this.sessionEnabled && this.sessionId) {
      // Resume existing session
      return [...globalArgs, 'exec', 'resume', this.sessionId, ...baseArgs, '-']
    }
    // New session or no session
    return [...globalArgs, 'exec', ...baseArgs, '-']
  }

  // Parse JSONL output: extract thread_id and agent_message text
  private parseJsonlOutput(output: string): string {
    let text = ''
    for (const line of output.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event = JSON.parse(trimmed)
        if (event.type === 'thread.started' && event.thread_id && this.sessionEnabled) {
          this.session.sessionId = event.thread_id
        } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
          text += event.item.text
        }
      } catch {
        // Not valid JSON, ignore
      }
    }
    return text
  }

  private runCodex(prompt: string): Promise<string> {
    const { prompt: stdinPrompt, cleanup } = preparePromptForCli(prompt)

    return new Promise((resolve, reject) => {
      const args = this.buildArgs()
      const child = spawn('codex', args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      let output = ''
      let error = ''

      child.stdout.on('data', (data) => {
        output += data.toString()
      })

      child.stderr.on('data', (data) => {
        error += data.toString()
      })

      child.on('close', (code) => {
        cleanup()
        if (code !== 0) {
          reject(new Error(`Codex CLI exited with code ${code}: ${error}`))
        } else {
          resolve(this.parseJsonlOutput(output))
        }
      })

      child.on('error', (err) => {
        cleanup()
        reject(new Error(`Failed to run codex CLI: ${err.message}`))
      })

      // Write prompt to stdin and close
      // Suppress EPIPE: if child exits early, close handler reports the real error
      child.stdin.on('error', () => {})
      child.stdin.write(stdinPrompt)
      child.stdin.end()
    })
  }

  private async *runCodexStream(prompt: string, options?: ChatStreamOptions): AsyncGenerator<string, void, unknown> {
    const { prompt: stdinPrompt, cleanup } = preparePromptForCli(prompt)

    const args = this.buildArgs()
    const child = spawn('codex', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const chunks: string[] = []
    let resolveNext: ((value: { chunk: string | null }) => void) | null = null
    let done = false
    let error: Error | null = null
    let lastActivity = Date.now()
    let stderrOutput = ''
    let lineBuf = ''  // Buffer for JSONL line parsing

    // Timeout checker - kill if no activity for too long
    const timeoutChecker = this.timeout > 0 ? setInterval(() => {
      if (Date.now() - lastActivity > this.timeout) {
        terminateProcess(child)
        done = true
        error = new Error(`Codex CLI timed out after ${this.timeout / 1000}s of inactivity`)
        if (resolveNext) {
          resolveNext({ chunk: null })
        }
      }
    }, 10000) : null  // Check every 10s
    const abortStream = () => {
      if (done) return
      terminateProcess(child)
      done = true
      error = new Error('Codex CLI stream aborted')
      if (resolveNext) {
        resolveNext({ chunk: null })
        resolveNext = null
      }
    }
    const cleanupAbort = () => options?.signal?.removeEventListener('abort', abortStream)
    if (options?.signal?.aborted) {
      abortStream()
    } else {
      options?.signal?.addEventListener('abort', abortStream, { once: true })
    }


    const pushChunk = (chunk: string) => {
      notifyProviderActivity(options, { kind: 'output', label: 'agent message' })
      if (resolveNext) {
        resolveNext({ chunk })
        resolveNext = null
      } else {
        chunks.push(chunk)
      }
    }

    child.stdout.on('data', (data) => {
      lastActivity = Date.now()
      notifyProviderActivity(options, { kind: 'stdout' })
      lineBuf += data.toString()

      // Parse complete JSONL lines
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() || ''  // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          notifyProviderActivity(options, { kind: 'tool', label: event.type })
          if (event.type === 'thread.started' && event.thread_id && this.sessionEnabled) {
            this.session.sessionId = event.thread_id
          } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
            pushChunk(event.item.text)
          }
        } catch {
          // Not valid JSON, ignore
        }
      }
    })

    child.stderr.on('data', (data) => {
      lastActivity = Date.now()  // Activity on stderr also counts
      notifyProviderActivity(options, { kind: 'stderr' })
      stderrOutput += data.toString()
    })

    child.on('close', (code) => {
      cleanup()
      if (timeoutChecker) clearInterval(timeoutChecker)
      cleanupAbort()
      // Process any remaining data in line buffer
      if (lineBuf.trim()) {
        try {
          const event = JSON.parse(lineBuf.trim())
          notifyProviderActivity(options, { kind: 'tool', label: event.type })
          if (event.type === 'thread.started' && event.thread_id && this.sessionEnabled) {
            this.session.sessionId = event.thread_id
          } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
            pushChunk(event.item.text)
          }
        } catch {
          // ignore
        }
      }
      done = true
      if (code !== 0 && !error) {
        error = new Error(`Codex CLI exited with code ${code}${stderrOutput ? ': ' + stderrOutput : ''}`)
      }
      if (resolveNext) {
        resolveNext({ chunk: null })
      }
    })

    child.on('error', (err) => {
      cleanup()
      if (timeoutChecker) clearInterval(timeoutChecker)
      cleanupAbort()
      done = true
      error = new Error(`Failed to run codex CLI: ${err.message}`)
      if (resolveNext) {
        resolveNext({ chunk: null })
      }
    })

    // Write prompt to stdin and close
    // Suppress EPIPE: if child exits early, close handler reports the real error
    child.stdin.on('error', () => {})
    child.stdin.write(stdinPrompt)
    child.stdin.end()

    while (!done || chunks.length > 0) {
      if (chunks.length > 0) {
        yield chunks.shift()!
      } else if (!done) {
        const result = await new Promise<{ chunk: string | null }>((resolve) => {
          resolveNext = resolve
        })
        if (result.chunk !== null) {
          yield result.chunk
        }
      }
    }

    if (error) {
      throw error
    }
  }
}
