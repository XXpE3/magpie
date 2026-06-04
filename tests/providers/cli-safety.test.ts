import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
  },
}))

import { ClaudeCodeProvider } from '../../src/providers/claude-code.js'
import { CodexCliProvider } from '../../src/providers/codex-cli.js'
import { logger } from '../../src/utils/logger.js'

type ClaudeArgsBuilder = {
  buildArgs: (stream: boolean, disableTools?: boolean) => string[]
}

type CodexArgsBuilder = {
  buildArgs: () => string[]
}

describe('CLI provider safety defaults', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear()
  })

  it('uses read-only Claude Code tools by default', () => {
    const provider = new ClaudeCodeProvider()
    const args = (provider as unknown as ClaudeArgsBuilder).buildArgs(false)

    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).toContain('--permission-mode')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(args).toContain('--tools')
    expect(args).toContain('--allowedTools')
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Bash')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe([
      'Read',
      'Grep',
      'Glob',
      'Bash(git diff *)',
      'Bash(git show *)',
      'Bash(git log *)',
      'Bash(git status *)',
    ].join(','))
  })

  it('adds Claude Code dangerous bypass only when explicitly enabled', () => {
    const provider = new ClaudeCodeProvider({
      cliSecurity: { allowDangerousBypass: true },
    })
    const args = (provider as unknown as ClaudeArgsBuilder).buildArgs(false)

    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--permission-mode')
    expect(args).not.toContain('--tools')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Dangerous Claude Code mode'))
  })

  it('extends Claude Code tools from explicit write, network, and extra tool settings', () => {
    const provider = new ClaudeCodeProvider({
      cliSecurity: {
        allowWrite: true,
        allowNetwork: true,
        extraAllowedTools: ['Bash(git branch *)', ''],
      },
    })
    const args = (provider as unknown as ClaudeArgsBuilder).buildArgs(false)
    const availableTools = args[args.indexOf('--tools') + 1].split(',')
    const allowedTools = args[args.indexOf('--allowedTools') + 1].split(',')

    expect(availableTools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Bash',
      'Edit',
      'MultiEdit',
      'Write',
      'WebFetch',
      'WebSearch',
    ])
    expect(allowedTools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Bash(git diff *)',
      'Bash(git show *)',
      'Bash(git log *)',
      'Bash(git status *)',
      'Edit',
      'MultiEdit',
      'Write',
      'WebFetch',
      'WebSearch',
      'Bash(gh pr view *)',
      'Bash(gh pr diff *)',
      'Bash(git branch *)',
    ])
  })

  it('allows Claude Code GitHub Bash commands only when network is enabled', () => {
    const provider = new ClaudeCodeProvider({
      cliSecurity: { allowNetwork: true },
    })
    const args = (provider as unknown as ClaudeArgsBuilder).buildArgs(false)
    const allowedTools = args[args.indexOf('--allowedTools') + 1].split(',')

    expect(allowedTools).toContain('Bash(gh pr view *)')
    expect(allowedTools).toContain('Bash(gh pr diff *)')
    expect(allowedTools).not.toContain('Edit')
    expect(allowedTools).not.toContain('Write')
  })

  it('keeps disableTools stronger than Claude Code defaults', () => {
    const provider = new ClaudeCodeProvider()
    const args = (provider as unknown as ClaudeArgsBuilder).buildArgs(false, true)

    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(args).not.toContain('--allowedTools')
  })

  it('uses Codex CLI read-only sandbox by default', () => {
    const provider = new CodexCliProvider()
    const args = (provider as unknown as CodexArgsBuilder).buildArgs()

    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(args).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy=never',
      '--json',
      '-',
    ])
  })

  it('adds Codex CLI dangerous bypass only when explicitly enabled', () => {
    const provider = new CodexCliProvider({
      cliSecurity: { allowDangerousBypass: true },
    })
    const args = (provider as unknown as CodexArgsBuilder).buildArgs()

    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(args).not.toContain('--sandbox')
    expect(args).toEqual([
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      '-',
    ])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Dangerous Codex CLI mode'))
  })

  it('maps Codex CLI write and network settings to explicit CLI flags', () => {
    const provider = new CodexCliProvider({
      cliSecurity: {
        allowWrite: true,
        allowNetwork: true,
      },
    })
    const args = (provider as unknown as CodexArgsBuilder).buildArgs()

    expect(args).toEqual([
      '--search',
      'exec',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy=never',
      '--json',
      '-',
    ])
  })

  it('rejects Codex CLI network access without write access', () => {
    expect(() => new CodexCliProvider({
      cliSecurity: { allowNetwork: true },
    })).toThrow('allowNetwork requires allowWrite')
  })

  it('keeps Codex CLI safety flags before exec resume', () => {
    const provider = new CodexCliProvider()
    provider.startSession('test')
    const session = (provider as unknown as { session: { sessionId?: string } }).session
    session.sessionId = 'thread-123'

    const args = (provider as unknown as CodexArgsBuilder).buildArgs()

    expect(args).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy=never',
      '--json',
      'resume',
      'thread-123',
      '-',
    ])
  })
})
