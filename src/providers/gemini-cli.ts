import { spawn } from 'child_process'
import type { AIProvider, Message, CliProviderOptions, ChatOptions, ChatStreamOptions } from './types.js'
import { notifyProviderActivity } from './types.js'
import { CliSessionHelper } from './session-helper.js'
import { preparePromptForCli } from '../utils/prompt-file.js'
import { withRetry } from '../utils/retry.js'
import { runCliProcess, terminateProcess } from './process-control.js'

export class GeminiCliProvider implements AIProvider {
  name = 'gemini-cli'
  capabilities = {
    canReadRepo: true,
    canUseTools: true,
    canDisableTools: false,
    supportsStreaming: true,
    supportsAbort: true,
    supportsSession: true,
  }
  private cwd: string
  private timeout: number  // ms, 0 = no timeout
  private cliModel?: string
  private session = new CliSessionHelper()
  // Gemini gets its session ID from the first response (session_id in JSON)
  private sessionEnabled = false

  get sessionId() { return this.session.sessionId }

  constructor(options?: CliProviderOptions) {
    // No API key needed for Gemini CLI (uses Google account)
    this.cwd = process.cwd()
    this.timeout = 15 * 60 * 1000  // 15 minutes default
    this.cliModel = options?.cliModel
  }

  setCwd(cwd: string) {
    this.cwd = cwd
  }

  startSession(name?: string): void {
    this.sessionEnabled = true
    this.session.start(name)
    this.session.sessionId = undefined  // Will be set from first response's JSON
  }

  endSession(): void {
    this.sessionEnabled = false
    this.session.end()
  }

  async chat(messages: Message[], systemPrompt?: string, options?: ChatOptions): Promise<string> {
    const prompt = this.sessionEnabled && !this.session.shouldSendFullHistory()
      ? this.session.buildPromptLastOnly(messages)
      : this.session.buildPrompt(messages, systemPrompt)
    try {
      const result = await withRetry(() => this.runGemini(prompt, options))
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
      yield* this.runGeminiStream(prompt, options)
      this.session.markMessageSent()
    } catch (err) {
      this.startSession(this.session.sessionName)
      throw err
    }
  }

  private runGemini(prompt: string, options?: ChatOptions): Promise<string> {
    const { prompt: stdinPrompt, cleanup } = preparePromptForCli(prompt, { allowTempFile: !options?.disableTools })
    const args = ['-y', '-o', 'json', '-p', '-']
    if (this.cliModel) {
      args.push('--model', this.cliModel)
    }
    if (this.sessionEnabled && this.sessionId) {
      args.push('--resume', this.sessionId)
    }

    return runCliProcess({
      command: 'gemini',
      args,
      cwd: this.cwd,
      stdin: stdinPrompt,
      timeoutMs: this.timeout,
    }).then(({ stdout }) => {
      try {
        const json = JSON.parse(stdout.trim())
        if (this.sessionEnabled && json.session_id) {
          this.session.sessionId = json.session_id
        }
        return json.response || ''
      } catch {
        return stdout.trim()
      }
    }).finally(cleanup)
  }

  private async *runGeminiStream(prompt: string, options?: ChatStreamOptions): AsyncGenerator<string, void, unknown> {
    const { prompt: stdinPrompt, cleanup } = preparePromptForCli(prompt, { allowTempFile: !options?.disableTools })

    const args = ['-y', '-o', 'stream-json', '-p', '-']
    if (this.cliModel) {
      args.push('--model', this.cliModel)
    }
    if (this.sessionEnabled && this.sessionId) {
      args.push('--resume', this.sessionId)
    }

    const child = spawn('gemini', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const chunks: string[] = []
    let resolveNext: ((value: { chunk: string | null }) => void) | null = null
    let done = false
    let error: Error | null = null
    let lastActivity = Date.now()
    let lineBuf = ''  // Buffer for NDJSON line parsing
    let stderrBuf = ''

    // Timeout checker - kill if no activity for too long
    const timeoutChecker = this.timeout > 0 ? setInterval(() => {
      if (Date.now() - lastActivity > this.timeout) {
        terminateProcess(child)
        done = true
        const stderr = stderrBuf.trim()
        error = new Error(`Gemini CLI timed out after ${this.timeout / 1000}s of inactivity${stderr ? ': ' + stderr.slice(-500) : ''}`)
        if (resolveNext) {
          resolveNext({ chunk: null })
        }
      }
    }, 10000) : null  // Check every 10s
    const abortStream = () => {
      if (done) return
      terminateProcess(child)
      done = true
      error = new Error('Gemini CLI stream aborted')
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
      notifyProviderActivity(options, { kind: 'output', label: 'assistant message' })
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

      // Parse complete NDJSON lines
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() || ''  // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          notifyProviderActivity(options, { kind: 'tool', label: event.type })
          if (event.type === 'init' && event.session_id && this.sessionEnabled) {
            this.session.sessionId = event.session_id
          } else if (event.type === 'message' && event.role === 'assistant' && event.content) {
            pushChunk(event.content)
          }
        } catch {
          // Not valid JSON, ignore
        }
      }
    })

    child.stderr.on('data', (data) => {
      lastActivity = Date.now()  // Activity on stderr also counts
      notifyProviderActivity(options, { kind: 'stderr' })
      stderrBuf += data.toString()
      if (stderrBuf.length > 10000) stderrBuf = stderrBuf.slice(-10000)
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
          if (event.type === 'init' && event.session_id && this.sessionEnabled) {
            this.session.sessionId = event.session_id
          } else if (event.type === 'message' && event.role === 'assistant' && event.content) {
            pushChunk(event.content)
          }
        } catch {
          // ignore
        }
      }
      done = true
      if (code !== 0 && !error) {
        const stderr = stderrBuf.trim()
        error = new Error(`Gemini CLI exited with code ${code}${stderr ? ': ' + stderr.slice(-500) : ''}`)
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
      error = new Error(`Failed to run gemini CLI: ${err.message}`)
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
