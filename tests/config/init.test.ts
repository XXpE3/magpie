import { describe, it, expect, afterEach } from 'vitest'
import { generateConfig, initConfig } from '../../src/config/init.js'
import { existsSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('Config Init', () => {
  const testDir = join(tmpdir(), 'magpie-init-test-' + Date.now())

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('should create config file with default content', () => {
    const configPath = join(testDir, '.magpie', 'config.yaml')
    const promptPath = join(testDir, '.magpie', 'prompt.txt')
    initConfig(testDir)

    expect(existsSync(configPath)).toBe(true)
    expect(existsSync(promptPath)).toBe(true)
    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain('providers:')
    expect(content).toContain('prompt_file: prompt.txt')
    expect(content).toContain('reviewers:')
    expect(readFileSync(promptPath, 'utf-8')).toContain('You are a thorough code reviewer')
  })

  it('should not overwrite existing config', () => {
    initConfig(testDir)
    expect(() => initConfig(testDir)).toThrow(/already exists/)
  })
})

describe('generateConfig', () => {
  it('should use the provider name as the codex-cli model in generated config', () => {
    const config = generateConfig(['codex-cli'])

    expect(config).toContain('model: codex-cli\n    provider: codex-cli')
    expect(config).not.toContain('model: gpt-5.5\n    provider: codex-cli')
  })

  it('should not hardcode an Ollama api_key', () => {
    const config = generateConfig(['ollama-glm'])

    expect(config).toContain('ollama:')
    expect(config).toContain('base_url: http://localhost:11434')
    expect(config).toContain('# api_key: ${OLLAMA_API_KEY}')
    expect(config).not.toContain('api_key: ollama')
  })

  it('should include explicit provider fields for API reviewers', () => {
    const config = generateConfig(['ollama-glm'])

    expect(config).toContain('model: glm-5.1:cloud\n    provider: ollama')
    expect(config).toContain('analyzer:\n  model: glm-5.1:cloud\n  provider: ollama')
    expect(config).toContain('summarizer:\n  model: glm-5.1:cloud\n  provider: ollama')
    expect(config).toContain('# provider: ollama')
  })
})
