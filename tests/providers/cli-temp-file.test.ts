import { existsSync } from 'fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeCodeProvider } from '../../src/providers/claude-code.js'
import { CodexCliProvider } from '../../src/providers/codex-cli.js'
import { GeminiCliProvider } from '../../src/providers/gemini-cli.js'
import { QwenCodeProvider } from '../../src/providers/qwen-code.js'
import { runCliProcess, type RunCliProcessOptions } from '../../src/providers/process-control.js'
import type { AIProvider } from '../../src/providers/types.js'

vi.mock('../../src/providers/process-control.js', () => ({
  runCliProcess: vi.fn(),
  terminateProcess: vi.fn(),
}))

const largePrompt = 'x'.repeat(200 * 1024)

function extractPromptPath(stdin: string): string {
  const match = stdin.match(/Please read the file at: (\/[^\n]+)/)
  if (!match) throw new Error(`missing temp file path in stdin: ${stdin}`)
  return match[1]
}

describe('CLI temp-file prompts', () => {
  beforeEach(() => {
    vi.mocked(runCliProcess).mockReset()
  })

  it.each([
    {
      name: 'codex',
      provider: () => new CodexCliProvider(),
      stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n',
    },
    {
      name: 'gemini',
      provider: () => new GeminiCliProvider(),
      stdout: '{"response":"ok"}',
    },
    {
      name: 'qwen',
      provider: () => new QwenCodeProvider(),
      stdout: 'ok',
    },
  ])('keeps temp-file prompting for $name when disableTools cannot be enforced', async ({ provider, stdout }) => {
    let promptPath = ''
    let existedDuringRun = false
    vi.mocked(runCliProcess).mockImplementation(async (options: RunCliProcessOptions) => {
      promptPath = extractPromptPath(options.stdin)
      existedDuringRun = existsSync(promptPath)
      return { stdout, stderr: '' }
    })

    const result = await provider().chat([{ role: 'user', content: largePrompt }], undefined, { disableTools: true })

    expect(result).toBe('ok')
    expect(existedDuringRun).toBe(true)
    expect(existsSync(promptPath)).toBe(false)
  })

  it('still rejects temp-file prompting when Claude Code tools are disabled', async () => {
    const provider: AIProvider = new ClaudeCodeProvider()

    await expect(provider.chat([{ role: 'user', content: largePrompt }], undefined, { disableTools: true }))
      .rejects.toThrow('Prompt is too large for CLI stdin')
    expect(runCliProcess).not.toHaveBeenCalled()
  })
})
