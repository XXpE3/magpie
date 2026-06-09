// tests/state/state-manager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StateManager } from '../../src/state/state-manager.js'
import type { ReviewSession, FeatureAnalysis } from '../../src/state/types.js'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

describe('StateManager', () => {
  let tempDir: string
  let manager: StateManager

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'magpie-test-'))
    manager = new StateManager(tempDir)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('should create .magpie directory on init', async () => {
    await manager.init()
    const { existsSync } = await import('fs')
    expect(existsSync(join(tempDir, '.magpie', 'sessions'))).toBe(true)
    expect(existsSync(join(tempDir, '.magpie', 'cache'))).toBe(true)
  })

  it('should save and load session', async () => {
    await manager.init()

    const session: ReviewSession = {
      id: 'test-123',
      startedAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      status: 'in_progress',
      config: { focusAreas: ['security'], selectedFeatures: ['write'] },
      plan: { features: [], totalFeatures: 3, selectedCount: 1 },
      progress: { currentFeatureIndex: 0, completedFeatures: [], featureResults: {} }
    }

    await manager.saveSession(session)
    const loaded = await manager.loadSession('test-123')

    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe('test-123')
    expect(loaded!.status).toBe('in_progress')
  })

  it('should restore nested feature result reviewedAt dates', async () => {
    await manager.init()

    const reviewedAt = '2024-02-03T04:05:06.000Z'
    const session: ReviewSession = {
      id: 'nested-date',
      startedAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-02'),
      status: 'in_progress',
      config: { focusAreas: ['security'], selectedFeatures: ['write'] },
      plan: { features: [], totalFeatures: 1, selectedCount: 1 },
      progress: {
        currentFeatureIndex: 1,
        completedFeatures: ['write'],
        featureResults: {
          write: {
            featureId: 'write',
            issues: [],
            summary: 'done',
            reviewedAt: new Date(reviewedAt)
          }
        }
      }
    }

    await manager.saveSession(session)
    const loaded = await manager.loadSession('nested-date')

    expect(loaded!.progress.featureResults.write.reviewedAt).toBeInstanceOf(Date)
    expect(loaded!.progress.featureResults.write.reviewedAt.toISOString()).toBe(reviewedAt)
  })

  it('should return null for non-existent session', async () => {
    await manager.init()
    const loaded = await manager.loadSession('non-existent')
    expect(loaded).toBeNull()
  })

  it('should find incomplete sessions', async () => {
    await manager.init()

    const session1: ReviewSession = {
      id: 'complete-1',
      startedAt: new Date(),
      updatedAt: new Date(),
      status: 'completed',
      config: { focusAreas: [], selectedFeatures: [] },
      plan: { features: [], totalFeatures: 0, selectedCount: 0 },
      progress: { currentFeatureIndex: 0, completedFeatures: [], featureResults: {} }
    }

    const session2: ReviewSession = {
      id: 'incomplete-1',
      startedAt: new Date(),
      updatedAt: new Date(),
      status: 'in_progress',
      config: { focusAreas: [], selectedFeatures: [] },
      plan: { features: [], totalFeatures: 0, selectedCount: 0 },
      progress: { currentFeatureIndex: 0, completedFeatures: [], featureResults: {} }
    }

    await manager.saveSession(session1)
    await manager.saveSession(session2)

    const incomplete = await manager.findIncompleteSessions()
    expect(incomplete).toHaveLength(1)
    expect(incomplete[0].id).toBe('incomplete-1')
  })

  it('should save and load feature analysis cache', async () => {
    await manager.init()

    const analysis: FeatureAnalysis = {
      features: [
        { id: 'write', name: 'Write', description: 'Write operations', entryPoints: ['insert.ts'], files: [], estimatedTokens: 1000 }
      ],
      uncategorized: [],
      analyzedAt: new Date('2024-01-01'),
      codebaseHash: 'abc123'
    }

    await manager.saveFeatureAnalysis(analysis)
    const loaded = await manager.loadFeatureAnalysis()

    expect(loaded).not.toBeNull()
    expect(loaded!.features).toHaveLength(1)
    expect(loaded!.codebaseHash).toBe('abc123')
  })

  it('should return null when no cache exists', async () => {
    await manager.init()
    const loaded = await manager.loadFeatureAnalysis()
    expect(loaded).toBeNull()
  })

  it('should list all sessions regardless of status', async () => {
    await manager.init()

    const sessions: ReviewSession[] = [
      {
        id: 'complete-1',
        startedAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
        status: 'completed',
        config: { focusAreas: [], selectedFeatures: ['f1'] },
        plan: { features: [], totalFeatures: 1, selectedCount: 1 },
        progress: { currentFeatureIndex: 1, completedFeatures: ['f1'], featureResults: {} }
      },
      {
        id: 'in-progress-1',
        startedAt: new Date('2024-01-02'),
        updatedAt: new Date('2024-01-03'),
        status: 'in_progress',
        config: { focusAreas: [], selectedFeatures: ['f1', 'f2'] },
        plan: { features: [], totalFeatures: 2, selectedCount: 2 },
        progress: { currentFeatureIndex: 0, completedFeatures: [], featureResults: {} }
      },
      {
        id: 'paused-1',
        startedAt: new Date('2024-01-03'),
        updatedAt: new Date('2024-01-04'),
        status: 'paused',
        config: { focusAreas: [], selectedFeatures: ['f1'] },
        plan: { features: [], totalFeatures: 1, selectedCount: 1 },
        progress: { currentFeatureIndex: 0, completedFeatures: [], featureResults: {} }
      }
    ]

    for (const session of sessions) {
      await manager.saveSession(session)
    }

    const allSessions = await manager.listAllSessions()
    expect(allSessions).toHaveLength(3)

    // Should be sorted by updatedAt descending
    expect(allSessions[0].id).toBe('paused-1')
    expect(allSessions[1].id).toBe('in-progress-1')
    expect(allSessions[2].id).toBe('complete-1')
  })

  it('should load legacy discussion messages without round state', async () => {
    const { homedir } = await import('os')
    const discussionsDir = join(homedir(), '.magpie', 'discussions')
    const sessionId = `legacy-round-state-${Date.now()}`
    const filePath = join(discussionsDir, `${sessionId}.json`)

    await mkdir(discussionsDir, { recursive: true })
    await writeFile(filePath, JSON.stringify({
      id: sessionId,
      title: 'Legacy discussion',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      status: 'active',
      reviewerIds: ['reviewer-a'],
      rounds: [{
        roundNumber: 2,
        topic: 'topic',
        analysis: 'analysis',
        messages: [{
          reviewerId: 'reviewer-a',
          content: 'legacy message',
          timestamp: '2024-01-01T00:00:00.000Z',
        }],
        conclusion: 'conclusion',
        tokenUsage: [],
        timestamp: '2024-01-01T00:00:00.000Z',
      }],
    }, null, 2))

    try {
      const loaded = await manager.loadDiscussSession(sessionId)

      expect(loaded).not.toBeNull()
      expect(loaded!.rounds[0].messages[0]).toMatchObject({
        reviewerId: 'reviewer-a',
        content: 'legacy message',
        round: 2,
        phase: 'review',
        status: 'success',
      })
      expect(loaded!.rounds[0].messages[0].timestamp).toBeInstanceOf(Date)
    } finally {
      await rm(filePath, { force: true })
    }
  })

  it('should save sessions through a temp file rename', async () => {
    vi.resetModules()
    const mkdirMock = vi.fn().mockResolvedValue(undefined)
    const writeFileMock = vi.fn().mockResolvedValue(undefined)
    const renameMock = vi.fn().mockResolvedValue(undefined)

    vi.doMock('fs/promises', () => ({
      mkdir: mkdirMock,
      readFile: vi.fn(),
      writeFile: writeFileMock,
      readdir: vi.fn(),
      rename: renameMock
    }))

    try {
      const { StateManager: MockedStateManager } = await import('../../src/state/state-manager.js')
      const atomicManager = new MockedStateManager('/repo')
      const session: ReviewSession = {
        id: 'atomic-1',
        startedAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        status: 'in_progress',
        config: { focusAreas: [], selectedFeatures: [] },
        plan: { features: [], totalFeatures: 0, selectedCount: 0 },
        progress: { currentFeatureIndex: 0, completedFeatures: [], featureResults: {} }
      }

      await atomicManager.saveSession(session)

      const tempPath = writeFileMock.mock.calls[0][0]
      expect(tempPath).toMatch(/^\/repo\/\.magpie\/sessions\/atomic-1\.json\..+\.tmp$/)
      expect(renameMock).toHaveBeenCalledWith(tempPath, '/repo/.magpie/sessions/atomic-1.json')
    } finally {
      vi.doUnmock('fs/promises')
      vi.resetModules()
    }
  })
})
