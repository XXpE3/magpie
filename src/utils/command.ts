import { execFileSync, type ExecFileSyncOptions } from 'child_process'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024

export interface RunCommandOptions {
  cwd?: string
  input?: string | Buffer
  maxBuffer?: number
  stdio?: ExecFileSyncOptions['stdio']
  timeout?: number
}

export function runCommand(command: string, args: string[], options: RunCommandOptions = {}): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf-8',
    input: options.input,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
  }) as string
}

export function runGit(args: string[], options?: RunCommandOptions): string {
  return runCommand('git', args, options)
}

export function runGh(args: string[], options?: RunCommandOptions): string {
  return runCommand('gh', args, options)
}

export function validatePRNumber(prNumber: string): string {
  if (!/^[1-9]\d*$/.test(prNumber)) {
    throw new Error(`Invalid PR number: ${prNumber}`)
  }
  return prNumber
}

export function validateGitHubRepo(repo: string): string {
  const parts = repo.split('/')
  if (parts.length !== 2) {
    throw new Error(`Invalid GitHub repo: ${repo}`)
  }

  const [owner, name] = parts
  const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
  const repoPattern = /^[A-Za-z0-9._-]+$/
  if (!ownerPattern.test(owner) || !repoPattern.test(name) || name.endsWith('.git')) {
    throw new Error(`Invalid GitHub repo: ${repo}`)
  }
  return repo
}

export function validateGitRemoteName(remote: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote) ||
    remote.includes('..') ||
    remote.includes('//') ||
    remote.includes('@{')
  ) {
    throw new Error(`Invalid git remote name: ${remote}`)
  }
  return remote
}

export function validateGitSha(sha: string): string {
  if (!/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error(`Invalid git SHA: ${sha}`)
  }
  return sha
}

export function parseGitHubPRUrl(prUrl: string): { repo: string; prNumber: string; url: string } {
  let parsed: URL
  try {
    parsed = new URL(prUrl)
  } catch {
    throw new Error(`Invalid PR URL: ${prUrl}`)
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error(`Invalid PR URL: ${prUrl}`)
  }

  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parts.length !== 4 || parts[2] !== 'pull') {
    throw new Error(`Invalid PR URL: ${prUrl}`)
  }

  const repo = validateGitHubRepo(`${parts[0]}/${parts[1]}`)
  const prNumber = validatePRNumber(parts[3])
  return { repo, prNumber, url: `https://github.com/${repo}/pull/${prNumber}` }
}
