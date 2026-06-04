import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'
import {
  parseGitHubPRUrl,
  runGh,
  runGit,
  validateGitHubRepo,
  validateGitRemoteName,
  validatePRNumber,
} from '../../src/utils/command'

vi.mock('child_process', () => ({
  execFileSync: vi.fn()
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(execFileSync).mockReturnValue('ok' as never)
})

describe('command helpers', () => {
  it('runs gh with an argument array and no shell option', () => {
    const prUrl = 'https://github.com/owner/repo/pull/1; touch /tmp/pwned'

    runGh(['pr', 'view', prUrl, '--json', 'title'])

    expect(execFileSync).toHaveBeenCalledWith('gh', ['pr', 'view', prUrl, '--json', 'title'], expect.objectContaining({
      encoding: 'utf-8',
    }))
    expect(vi.mocked(execFileSync).mock.calls[0][2]).not.toHaveProperty('shell')
  })

  it('runs git with an argument array and no shell option', () => {
    runGit(['remote', 'get-url', 'origin'])

    expect(execFileSync).toHaveBeenCalledWith('git', ['remote', 'get-url', 'origin'], expect.objectContaining({
      encoding: 'utf-8',
    }))
    expect(vi.mocked(execFileSync).mock.calls[0][2]).not.toHaveProperty('shell')
  })

  it('accepts valid PR numbers and rejects injected PR numbers', () => {
    expect(validatePRNumber('42')).toBe('42')
    expect(() => validatePRNumber('0')).toThrow('Invalid PR number')
    expect(() => validatePRNumber('42; rm -rf /')).toThrow('Invalid PR number')
    expect(() => validatePRNumber('abc')).toThrow('Invalid PR number')
  })

  it('accepts owner/name repos and rejects injected repos', () => {
    expect(validateGitHubRepo('owner/repo')).toBe('owner/repo')
    expect(validateGitHubRepo('Owner-1/repo.name_2')).toBe('Owner-1/repo.name_2')
    expect(() => validateGitHubRepo('owner/repo; rm -rf /')).toThrow('Invalid GitHub repo')
    expect(() => validateGitHubRepo('owner/repo.git')).toThrow('Invalid GitHub repo')
    expect(() => validateGitHubRepo('owner/name/extra')).toThrow('Invalid GitHub repo')
  })

  it('accepts safe remote names and rejects injected remotes', () => {
    expect(validateGitRemoteName('origin')).toBe('origin')
    expect(validateGitRemoteName('team/upstream-1')).toBe('team/upstream-1')
    expect(() => validateGitRemoteName('origin; rm -rf /')).toThrow('Invalid git remote name')
    expect(() => validateGitRemoteName('-c')).toThrow('Invalid git remote name')
    expect(() => validateGitRemoteName('team//origin')).toThrow('Invalid git remote name')
  })

  it('parses whitelisted GitHub PR URLs and rejects hostile URLs', () => {
    expect(parseGitHubPRUrl('https://github.com/owner/repo/pull/42')).toEqual({
      repo: 'owner/repo',
      prNumber: '42',
      url: 'https://github.com/owner/repo/pull/42',
    })
    expect(parseGitHubPRUrl('https://github.com/owner/repo/pull/42/files')).toEqual({
      repo: 'owner/repo',
      prNumber: '42',
      url: 'https://github.com/owner/repo/pull/42',
    })
    expect(parseGitHubPRUrl('https://github.com/owner/repo/pull/42/commits')).toEqual({
      repo: 'owner/repo',
      prNumber: '42',
      url: 'https://github.com/owner/repo/pull/42',
    })

    expect(() => parseGitHubPRUrl('http://github.com/owner/repo/pull/42')).toThrow('Invalid PR URL')
    expect(() => parseGitHubPRUrl('https://evil.example/owner/repo/pull/42')).toThrow('Invalid PR URL')
    expect(() => parseGitHubPRUrl('https://github.com/owner/repo/pull/42;rm')).toThrow('Invalid PR number')
  })
})
