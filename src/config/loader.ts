// src/config/loader.ts
import { readFileSync, existsSync } from 'fs'
import { parse } from 'yaml'
import { homedir } from 'os'
import { dirname, isAbsolute, join } from 'path'
import type { MagpieConfig, ReviewerConfig } from './types.js'
import { logger } from '../utils/logger.js'

export function expandEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, envVar) => {
    return process.env[envVar] || ''
  })
}

function expandEnvVarsInObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return expandEnvVars(obj)
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVarsInObject)
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVarsInObject(value)
    }
    return result
  }
  return obj
}

export function getConfigPath(customPath?: string): string {
  if (customPath) {
    return customPath
  }
  return join(homedir(), '.magpie', 'config.yaml')
}

export function loadConfig(configPath?: string): MagpieConfig {
  const path = getConfigPath(configPath)

  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`)
  }

  const content = readFileSync(path, 'utf-8')
  const parsed = parse(content)
  const expanded = expandEnvVarsInObject(parsed) as MagpieConfig

  applySharedReviewerPrompt(expanded, path)
  validateConfig(expanded, path)
  return expanded
}

function getSharedPromptPath(config: MagpieConfig, configPath: string): string {
  const promptFile = config.prompt_file || 'prompt.txt'
  return isAbsolute(promptFile) ? promptFile : join(dirname(configPath), promptFile)
}

function applySharedReviewerPrompt(config: MagpieConfig, configPath: string): void {
  if (!config.reviewers) return
  const missingPrompt = Object.values(config.reviewers).some(rc => !rc.prompt || typeof rc.prompt !== 'string')
  if (!missingPrompt) return

  const promptPath = getSharedPromptPath(config, configPath)
  if (!existsSync(promptPath)) return

  const prompt = readFileSync(promptPath, 'utf-8').trimEnd()
  if (prompt.trim() === '') {
    throw new Error(`Config error: shared prompt file is empty: ${promptPath}`)
  }

  for (const rc of Object.values(config.reviewers)) {
    if (!rc.prompt || typeof rc.prompt !== 'string') {
      rc.prompt = prompt
    }
  }
}

function validateReviewerConfig(name: string, rc: ReviewerConfig, promptPath?: string): void {
  if (!rc.provider || typeof rc.provider !== 'string') {
    throw new Error(`Config error: ${name} is missing a "provider" field`)
  }
  if (!rc.model || typeof rc.model !== 'string') {
    throw new Error(`Config error: ${name} is missing a "model" field`)
  }
  if (!rc.prompt || typeof rc.prompt !== 'string') {
    if (promptPath && name.startsWith('reviewers.')) {
      throw new Error(`Config error: ${name} is missing a "prompt" field and shared prompt file was not found: ${promptPath}`)
    }
    throw new Error(`Config error: ${name} is missing a "prompt" field`)
  }
}

function validateConfig(config: MagpieConfig, configPath: string): void {
  if (!config.defaults || config.defaults.max_rounds <= 0) {
    throw new Error('Config error: defaults.max_rounds must be > 0')
  }

  if (!config.reviewers || Object.keys(config.reviewers).length === 0) {
    throw new Error('Config error: at least one reviewer must be defined')
  }

  const promptPath = getSharedPromptPath(config, configPath)
  for (const [id, rc] of Object.entries(config.reviewers)) {
    validateReviewerConfig(`reviewers.${id}`, rc, promptPath)
  }

  if (!config.summarizer) {
    throw new Error('Config error: summarizer section is required')
  }
  validateReviewerConfig('summarizer', config.summarizer)

  if (!config.analyzer) {
    throw new Error('Config error: analyzer section is required')
  }
  validateReviewerConfig('analyzer', config.analyzer)

  // Warn (don't throw) if API keys look empty — CLI providers don't need them
  if (!config.providers) return
  for (const [name, prov] of Object.entries(config.providers)) {
    if (prov && 'api_key' in prov && !(prov as { api_key: string }).api_key) {
      logger.warn(`providers.${name}.api_key is empty (ok if using CLI provider)`)
    }
  }
}
