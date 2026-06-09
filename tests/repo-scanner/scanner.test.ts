// tests/repo-scanner/scanner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RepoScanner } from '../../src/repo-scanner/scanner.js'
import * as fs from 'fs'

vi.mock('fs')

describe('RepoScanner', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(fs.realpathSync).mockImplementation((p) => String(p) as any)
  })

  it('should scan directory and return file list', async () => {
    // Mock directory structure: /project/src/index.ts
    vi.mocked(fs.readdirSync).mockImplementation((p) => {
      if (String(p) === '/project') return ['src'] as any
      if (String(p) === '/project/src') return ['index.ts', 'utils.ts'] as any
      return [] as any
    })
    vi.mocked(fs.lstatSync).mockImplementation((p) => ({
      isSymbolicLink: () => false,
      isDirectory: () => String(p) === '/project/src',
      isFile: () => String(p).endsWith('.ts'),
      size: 1024,
      mtimeMs: 123
    }) as any)
    vi.mocked(fs.readFileSync).mockReturnValue('line1\nline2\nline3')

    const scanner = new RepoScanner('/project')
    const files = await scanner.scanFiles()

    expect(files.length).toBe(2)
    expect(files[0].relativePath).toBe('src/index.ts')
    expect(files[0].language).toBe('typescript')
    expect(files[0].lines).toBe(3)
  })

  it('should reject scan paths outside the repo root', async () => {
    const scanner = new RepoScanner('/project', { path: '../../etc' })

    await expect(scanner.scanFiles()).rejects.toThrow('Scan path must stay within repository root')
    expect(fs.readdirSync).not.toHaveBeenCalled()
  })

  it('should reject scan paths that resolve outside through symlink components', async () => {
    vi.mocked(fs.realpathSync).mockImplementation((p) => {
      const filePath = String(p)
      if (filePath === '/project/link/subdir') return '/etc/subdir' as any
      return filePath as any
    })

    const scanner = new RepoScanner('/project', { path: 'link/subdir' })

    await expect(scanner.scanFiles()).rejects.toThrow('Scan path must stay within repository root')
    expect(fs.readdirSync).not.toHaveBeenCalled()
  })

  it('should skip symlinks during scanning', async () => {
    vi.mocked(fs.readdirSync).mockImplementation((p) => {
      if (String(p) === '/project') return ['src', 'outside-link.ts'] as any
      if (String(p) === '/project/src') return ['index.ts'] as any
      return [] as any
    })
    vi.mocked(fs.lstatSync).mockImplementation((p) => {
      const filePath = String(p)
      return {
        isSymbolicLink: () => filePath === '/project/outside-link.ts',
        isDirectory: () => filePath === '/project/src',
        isFile: () => filePath.endsWith('.ts'),
        size: 1024,
        mtimeMs: 123
      } as any
    })
    vi.mocked(fs.readFileSync).mockReturnValue('line1\nline2')

    const scanner = new RepoScanner('/project')
    const files = await scanner.scanFiles()

    expect(files).toHaveLength(1)
    expect(files[0].relativePath).toBe('src/index.ts')
    expect(files.some(file => file.relativePath === 'outside-link.ts')).toBe(false)
  })

  it('should calculate repo stats', async () => {
    const scanner = new RepoScanner('/project')
    scanner['files'] = [
      { path: '/project/src/a.ts', relativePath: 'src/a.ts', language: 'typescript', lines: 100, size: 1024 },
      { path: '/project/src/b.ts', relativePath: 'src/b.ts', language: 'typescript', lines: 50, size: 512 }
    ]

    const stats = scanner.getStats()

    expect(stats.totalFiles).toBe(2)
    expect(stats.totalLines).toBe(150)
    expect(stats.languages.typescript).toBe(2)
  })

  it('should estimate tokens based on file content', () => {
    const scanner = new RepoScanner('/project')
    const tokens = scanner['estimateTokens'](1000) // 1000 characters
    expect(tokens).toBe(250) // ~4 chars per token
  })
})
