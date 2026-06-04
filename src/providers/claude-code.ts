import { spawn } from 'child_process'
import type { AIProvider, Message, CliProviderOptions, ChatOptions, ChatStreamOptions } from './types.js'
import { notifyProviderActivity } from './types.js'
import { CliSessionHelper } from './session-helper.js'
import { preparePromptForCli } from '../utils/prompt-file.js'
import { withRetry } from '../utils/retry.js'
import { terminateProcess } from './process-control.js'
import { logger } from '../utils/logger.js'

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']
const LOCAL_READ_ONLY_BASH_TOOLS = [
  'Bash(git diff *)',
  'Bash(git show *)',
  'Bash(git log *)',
  'Bash(git status *)',
]
const NETWORK_READ_ONLY_BASH_TOOLS = [
  'Bash(gh pr view *)',
  'Bash(gh pr diff *)',
]
const WRITE_TOOLS = ['Edit', 'MultiEdit', 'Write']
const NETWORK_TOOLS = ['WebFetch', 'WebSearch']

export class ClaudeCodeProvider implements AIProvider {
  name = 'claude-code'
  private cwd: string
  private timeout: number  // ms, 0 = no timeout
  private cliModel?: string
  private allowDangerousBypass: boolean
  private allowWrite: boolean
  private allowNetwork: boolean
  private extraAllowedTools: string[]
  private session = new CliSessionHelper()

  get sessionId() { return this.session.sessionId }

  constructor(options?: CliProviderOptions) {
    // No API key needed for Claude Code CLI
    // Use current working directory so claude can access the repo
    this.cwd = process.cwd()
    this.timeout = 15 * 60 * 1000  // 15 minutes default
    this.cliModel = options?.cliModel
    this.allowDangerousBypass = options?.cliSecurity?.allowDangerousBypass === true
    this.allowWrite = options?.cliSecurity?.allowWrite === true
    this.allowNetwork = options?.cliSecurity?.allowNetwork === true
    this.extraAllowedTools = options?.cliSecurity?.extraAllowedTools || []
    if (this.allowDangerousBypass) {
      logger.warn('Dangerous Claude Code mode is enabled; reviewers may execute commands or modify files.')
    }
  }

  setCwd(cwd: string) {
    this.cwd = cwd
  }

  startSession(name?: string): void {
    this.session.start(name)
  }

  endSession(): void {
    this.session.end()
  }

  async chat(messages: Message[], systemPrompt?: string, options?: ChatOptions): Promise<string> {
    const prompt = this.session.shouldSendFullHistory()
      ? this.session.buildPrompt(messages, systemPrompt)
      : this.session.buildPromptLastOnly(messages)
    try {
      const result = await withRetry(() => this.runClaude(prompt, systemPrompt, options))
      this.session.markMessageSent()
      return result
    } catch (err) {
      this.session.start(this.session.sessionName)
      throw err
    }
  }

  async *chatStream(messages: Message[], systemPrompt?: string, options?: ChatStreamOptions): AsyncGenerator<string, void, unknown> {
    const prompt = this.session.shouldSendFullHistory()
      ? this.session.buildPrompt(messages, systemPrompt)
      : this.session.buildPromptLastOnly(messages)
    try {
      yield* this.runClaudeStream(prompt, systemPrompt, options)
      this.session.markMessageSent()
    } catch (err) {
      // Reset to a fresh session ID so the next round doesn't try to --resume
      // or --session-id a dead/stuck session
      this.session.start(this.session.sessionName)
      throw err
    }
  }

  // Spawn env: clear CLAUDECODE to avoid nested session detection when run from Claude Code
  private spawnEnv() {
    const env = { ...process.env }
    delete env.CLAUDECODE
    return env
  }

  private buildAvailableTools(): string[] {
    const tools = new Set([...READ_ONLY_TOOLS, 'Bash'])
    if (this.allowWrite) {
      for (const tool of WRITE_TOOLS) tools.add(tool)
    }
    if (this.allowNetwork) {
      for (const tool of NETWORK_TOOLS) tools.add(tool)
    }
    for (const tool of this.extraAllowedTools) {
      const trimmed = tool.trim()
      const toolName = trimmed.split('(', 1)[0]
      if (toolName) tools.add(toolName)
    }
    return [...tools]
  }

  private buildAllowedTools(): string[] {
    const tools = new Set([...READ_ONLY_TOOLS, ...LOCAL_READ_ONLY_BASH_TOOLS])
    if (this.allowWrite) {
      for (const tool of WRITE_TOOLS) tools.add(tool)
    }
    if (this.allowNetwork) {
      for (const tool of NETWORK_TOOLS) tools.add(tool)
      for (const tool of NETWORK_READ_ONLY_BASH_TOOLS) tools.add(tool)
    }
    for (const tool of this.extraAllowedTools) {
      const trimmed = tool.trim()
      if (trimmed) tools.add(trimmed)
    }
    return [...tools]
  }

  private buildArgs(stream: boolean, disableTools?: boolean): string[] {
    const args = ['-p', '-']
    if (this.allowDangerousBypass) {
      args.push('--dangerously-skip-permissions')
    }
    if (this.cliModel) {
      args.push('--model', this.cliModel)
    }
    if (disableTools) {
      args.push('--tools', '')
    } else if (!this.allowDangerousBypass) {
      args.push('--tools', this.buildAvailableTools().join(','))
      args.push('--allowedTools', this.buildAllowedTools().join(','))
    }
    if (stream) {
      args.push('--output-format', 'stream-json', '--verbose')
    }
    return args
  }

  private runClaude(prompt: string, systemPrompt?: string, options?: ChatOptions): Promise<string> {
    const { prompt: stdinPrompt, cleanup } = preparePromptForCli(prompt)

    return new Promise((resolve, reject) => {
      const args = this.buildArgs(false, options?.disableTools)
      if (this.session.sessionId) {
        if (this.session.isFirstMessage) {
          args.push('--session-id', this.session.sessionId)
          if (systemPrompt) {
            args.push('--system-prompt', systemPrompt)
          }
        } else {
          args.push('--resume', this.session.sessionId)
        }
      }

      const child = spawn('claude', args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.spawnEnv()
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
          reject(new Error(`Claude CLI exited with code ${code}: ${error}`))
        } else {
          resolve(output.trim())
        }
      })

      child.on('error', (err) => {
        cleanup()
        reject(new Error(`Failed to run claude CLI: ${err.message}`))
      })

      // Write prompt to stdin and close
      // Suppress EPIPE: if child exits early, close handler reports the real error
      child.stdin.on('error', () => {})
      child.stdin.write(stdinPrompt)
      child.stdin.end()
    })
  }

  private async *runClaudeStream(prompt: string, systemPrompt?: string, options?: ChatStreamOptions): AsyncGenerator<string, void, unknown> {
    const { prompt: stdinPrompt, cleanup } = preparePromptForCli(prompt)

    // Use --output-format stream-json --verbose so that tool activity (Read, Bash, etc.)
    // produces stdout events, preventing the inactivity timeout from killing Claude
    // while it's actively investigating code.
    const args = this.buildArgs(true, options?.disableTools)
    if (this.session.sessionId) {
      if (this.session.isFirstMessage) {
        args.push('--session-id', this.session.sessionId)
        if (systemPrompt) {
          args.push('--system-prompt', systemPrompt)
        }
      } else {
        args.push('--resume', this.session.sessionId)
      }
    }

    const child = spawn('claude', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.spawnEnv()
    })

    const chunks: string[] = []
    let resolveNext: ((value: { chunk: string | null }) => void) | null = null
    let done = false
    let error: Error | null = null
    let lastActivity = Date.now()
    let lineBuf = ''

    // Timeout checker - kill if no activity for too long
    const timeoutChecker = this.timeout > 0 ? setInterval(() => {
      if (Date.now() - lastActivity > this.timeout) {
        terminateProcess(child)
        done = true
        error = new Error(`Claude CLI timed out after ${this.timeout / 1000}s of inactivity`)
        if (resolveNext) {
          resolveNext({ chunk: null })
        }
      }
    }, 10000) : null  // Check every 10s
    const abortStream = () => {
      if (done) return
      terminateProcess(child)
      done = true
      error = new Error('Claude CLI stream aborted')
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


    child.stdout.on('data', (data) => {
      lastActivity = Date.now()
      notifyProviderActivity(options, { kind: 'stdout' })
      // Parse stream-json: each line is a JSON event.
      // Every event (tool_use, tool_result, assistant, etc.) updates lastActivity.
      // We only yield the final result text to the caller.
      lineBuf += data.toString()
      let idx
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, idx).trim()
        lineBuf = lineBuf.slice(idx + 1)
        if (!line) continue
        try {
          const event = JSON.parse(line)
          notifyProviderActivity(options, { kind: 'tool', label: event.type })
          if (event.type === 'result' && typeof event.result === 'string') {
            const chunk = event.result
            notifyProviderActivity(options, { kind: 'output', label: 'result' })
            if (resolveNext) {
              resolveNext({ chunk })
              resolveNext = null
            } else {
              chunks.push(chunk)
            }
          }
        } catch {
          // Not valid JSON, ignore
        }
      }
    })

    let stderrOutput = ''
    child.stderr.on('data', (data) => {
      lastActivity = Date.now()  // Activity on stderr also counts
      notifyProviderActivity(options, { kind: 'stderr' })
      stderrOutput += data.toString()
    })

    child.on('close', (code) => {
      cleanup()
      if (timeoutChecker) clearInterval(timeoutChecker)
      cleanupAbort()
      done = true
      if (code !== 0 && !error) {
        error = new Error(`Claude CLI exited with code ${code}${stderrOutput ? ': ' + stderrOutput.slice(0, 500) : ''}`)
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
      error = new Error(`Failed to run claude CLI: ${err.message}`)
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
