import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canRunDatabaseTests,
  createTestDatabase,
  getDatabaseLoadError
} from '../utils/db-test-utils'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

const mockReadClaudeTranscriptUsage = vi.fn()

vi.mock('../../src/main/services/claude-transcript-reader', () => ({
  readClaudeTranscriptUsage: (...args: unknown[]) => mockReadClaudeTranscriptUsage(...args)
}))

import { UsageAnalyticsService } from '../../src/main/services/usage-analytics-service'

const describeDb = canRunDatabaseTests() ? describe : describe.skip

describeDb('UsageAnalyticsService', () => {
  let cleanup: (() => void) | null = null
  let service: UsageAnalyticsService
  let db: ReturnType<typeof createTestDatabase>['db']

  beforeEach(() => {
    const setup = createTestDatabase()
    cleanup = setup.cleanup
    db = setup.db
    service = new UsageAnalyticsService(db)
    mockReadClaudeTranscriptUsage.mockReset()
  })

  afterEach(() => {
    cleanup?.()
    cleanup = null
  })

  it('aggregates Codex entries into dashboard totals and remains idempotent', async () => {
    const project = db.createProject({ name: 'Xuanpu', path: '/tmp/xuanpu' })
    const worktree = db.createWorktree({
      project_id: project.id,
      path: '/tmp/xuanpu',
      name: 'bloodhound',
      branch_name: 'feat/cost-pill',
      is_default: true
    })
    const session = db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      name: 'Codex usage session',
      opencode_session_id: 'codex-1',
      agent_sdk: 'codex',
      model_provider_id: 'codex',
      model_id: 'gpt-5.4'
    })

    db.createSessionMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'done',
      opencode_message_id: 'msg-1',
      opencode_message_json: JSON.stringify({
        id: 'msg-1',
        timestamp: '2026-04-04T08:00:00.000Z',
        cost: 0.42,
        tokens: {
          input: 1200,
          output: 300,
          cacheRead: 200,
          cacheWrite: 100
        },
        model: 'codex/gpt-5.4'
      }),
      created_at: '2026-04-04T08:00:00.000Z'
    })

    await service.resync()
    await service.resync()

    const entries = db.getUsageEntriesBySession(session.id)
    expect(entries).toHaveLength(1)
    expect(entries[0].cost).toBe(0.42)

    const dashboard = await service.fetchDashboard({ range: 'all', engine: 'all' })
    expect(dashboard.success).toBe(true)
    expect(dashboard.data?.total_cost).toBe(0.42)
    expect(dashboard.data?.total_sessions).toBe(1)
    expect(dashboard.data?.by_engine.find((row) => row.engine === 'codex')?.total_cost).toBe(0.42)
    expect(dashboard.data?.by_project[0].project_name).toBe('Xuanpu')
    expect(dashboard.data?.sessions[0].session_name).toBe('Codex usage session')
  })

  it('syncs Claude transcript usage into session summary totals', async () => {
    const project = db.createProject({ name: 'Claude Project', path: '/tmp/claude-project' })
    const worktree = db.createWorktree({
      project_id: project.id,
      path: '/tmp/claude-project',
      name: 'main',
      branch_name: 'main',
      is_default: true
    })
    const session = db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      name: 'Claude usage session',
      opencode_session_id: 'claude-1',
      agent_sdk: 'claude-code',
      model_provider_id: 'claude-code',
      model_id: 'sonnet'
    })

    mockReadClaudeTranscriptUsage.mockResolvedValue({
      entries: [
        {
          sourceMessageId: 'assistant-1',
          occurredAt: '2026-04-04T08:00:00.000Z',
          model: 'claude-sonnet-4-6',
          inputTokens: 1000,
          outputTokens: 200,
          cacheWriteTokens: 100,
          cacheReadTokens: 50,
          totalTokens: 1350,
          cost: 0.006875
        }
      ],
      filePath: '/tmp/mock-transcript.jsonl',
      mtimeMs: 123
    })

    const summary = await service.fetchSessionSummary(session.id)
    expect(summary.success).toBe(true)
    expect(summary.data?.total_cost).toBeCloseTo(0.006875, 10)
    expect(summary.data?.total_tokens).toBe(1350)
    expect(summary.data?.latest_model_label).toBe('claude-sonnet-4-6')
    expect(db.getUsageEntriesBySession(session.id)).toHaveLength(1)
  })

  it('marks missing Claude transcript data as partial instead of zero-cost data', async () => {
    const project = db.createProject({ name: 'Missing Transcript', path: '/tmp/missing-transcript' })
    const worktree = db.createWorktree({
      project_id: project.id,
      path: '/tmp/missing-transcript',
      name: 'main',
      branch_name: 'main',
      is_default: true
    })

    db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      name: 'Missing transcript session',
      opencode_session_id: 'claude-missing',
      agent_sdk: 'claude-code'
    })

    mockReadClaudeTranscriptUsage.mockResolvedValue({
      entries: [],
      filePath: '/tmp/missing.jsonl',
      mtimeMs: null
    })

    await service.resync()
    const dashboard = await service.fetchDashboard({ range: 'all', engine: 'all' })

    expect(dashboard.success).toBe(true)
    expect(dashboard.data?.partial_sessions).toHaveLength(1)
    expect(dashboard.data?.total_cost).toBe(0)
  })

  it('fetchDashboard syncs stale sessions before aggregating totals', async () => {
    const project = db.createProject({ name: 'Fresh Dashboard', path: '/tmp/fresh-dashboard' })
    const worktree = db.createWorktree({
      project_id: project.id,
      path: '/tmp/fresh-dashboard',
      name: 'main',
      branch_name: 'main',
      is_default: true
    })
    const session = db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      name: 'Fresh codex session',
      opencode_session_id: 'codex-fresh',
      agent_sdk: 'codex',
      model_provider_id: 'codex',
      model_id: 'gpt-5.4'
    })

    db.createSessionMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'fresh',
      opencode_message_id: 'msg-1',
      opencode_message_json: JSON.stringify({
        id: 'msg-1',
        timestamp: '2026-04-06T08:00:00.000Z',
        cost: 0.15,
        tokens: {
          input: 800,
          output: 200,
          cacheRead: 50,
          cacheWrite: 25
        },
        model: 'codex/gpt-5.4'
      }),
      created_at: '2026-04-06T08:00:00.000Z'
    })

    const dashboard = await service.fetchDashboard({ range: 'all', engine: 'all' })

    expect(dashboard.success).toBe(true)
    expect(dashboard.data?.total_cost).toBeCloseTo(0.15, 10)
    expect(dashboard.data?.sync.stale_session_count).toBe(0)
    expect(db.getUsageEntriesBySession(session.id)).toHaveLength(1)
  })

  it('keeps session summary and dashboard session rows on the same aggregation baseline', async () => {
    const project = db.createProject({ name: 'Unified Project', path: '/tmp/unified-project' })
    const worktree = db.createWorktree({
      project_id: project.id,
      path: '/tmp/unified-project',
      name: 'main',
      branch_name: 'main',
      is_default: true
    })
    const session = db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      name: 'Unified session',
      opencode_session_id: 'codex-unified',
      agent_sdk: 'codex',
      model_provider_id: 'codex',
      model_id: 'gpt-5.4'
    })

    db.createSessionMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'first',
      opencode_message_id: 'msg-1',
      opencode_message_json: JSON.stringify({
        id: 'msg-1',
        timestamp: '2026-04-04T08:00:00.000Z',
        cost: 0.1,
        tokens: {
          input: 1000,
          output: 200,
          cacheRead: 50,
          cacheWrite: 25
        },
        model: 'codex/gpt-5.4'
      }),
      created_at: '2026-04-04T08:00:00.000Z'
    })

    db.createSessionMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'second',
      opencode_message_id: 'msg-2',
      opencode_message_json: JSON.stringify({
        id: 'msg-2',
        timestamp: '2026-04-05T09:30:00.000Z',
        cost: 0.2,
        tokens: {
          input: 1500,
          output: 300,
          cacheRead: 75,
          cacheWrite: 50
        },
        model: 'codex/gpt-5.4'
      }),
      created_at: '2026-04-05T09:30:00.000Z'
    })

    await service.resync()

    const summary = await service.fetchSessionSummary(session.id)
    const dashboard = await service.fetchDashboard({ range: 'all', engine: 'all' })
    const sessionRow = dashboard.data?.sessions.find((row) => row.session_id === session.id)

    expect(summary.success).toBe(true)
    expect(sessionRow).toBeTruthy()
    expect(sessionRow?.total_cost).toBeCloseTo(summary.data?.total_cost ?? 0, 10)
    expect(sessionRow?.total_tokens).toBe(summary.data?.total_tokens)
    expect(sessionRow?.input_tokens).toBe(summary.data?.input_tokens)
    expect(sessionRow?.output_tokens).toBe(summary.data?.output_tokens)
    expect(sessionRow?.cache_write_tokens).toBe(summary.data?.cache_write_tokens)
    expect(sessionRow?.cache_read_tokens).toBe(summary.data?.cache_read_tokens)
    expect(sessionRow?.last_used_at).toBe(summary.data?.last_used_at)
    expect(sessionRow?.model_label).toBe(summary.data?.latest_model_label)
  })

  it('keeps dashboard model and timeline breakdowns entry-based while session summary stays session-based', async () => {
    const project = db.createProject({ name: 'Breakdown Project', path: '/tmp/breakdown-project' })
    const worktree = db.createWorktree({
      project_id: project.id,
      path: '/tmp/breakdown-project',
      name: 'main',
      branch_name: 'main',
      is_default: true
    })
    const session = db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      name: 'Breakdown session',
      opencode_session_id: 'codex-breakdown',
      agent_sdk: 'codex',
      model_provider_id: 'codex',
      model_id: 'gpt-5.4'
    })

    db.createSessionMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'first',
      opencode_message_id: 'msg-1',
      opencode_message_json: JSON.stringify({
        id: 'msg-1',
        timestamp: '2026-04-04T08:00:00.000Z',
        cost: 0.1,
        tokens: {
          input: 1000,
          output: 200,
          cacheRead: 0,
          cacheWrite: 0
        },
        model: 'codex/gpt-5.4'
      }),
      created_at: '2026-04-04T08:00:00.000Z'
    })

    db.createSessionMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'second',
      opencode_message_id: 'msg-2',
      opencode_message_json: JSON.stringify({
        id: 'msg-2',
        timestamp: '2026-04-05T08:00:00.000Z',
        cost: 0.05,
        tokens: {
          input: 500,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0
        },
        model: 'codex/gpt-5.3-codex'
      }),
      created_at: '2026-04-05T08:00:00.000Z'
    })

    await service.resync()

    const summary = await service.fetchSessionSummary(session.id)
    const dashboard = await service.fetchDashboard({ range: 'all', engine: 'all' })

    expect(summary.data?.latest_model_label).toBe('codex/gpt-5.3-codex')
    expect(dashboard.data?.by_model).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model_label: 'codex/gpt-5.4', total_cost: 0.1 }),
        expect.objectContaining({ model_label: 'codex/gpt-5.3-codex', total_cost: 0.05 })
      ])
    )
    expect(dashboard.data?.timeline).toEqual([
      {
        date: '2026-04-04',
        total_cost: 0.1,
        total_tokens: 1200,
        total_sessions: 1
      },
      {
        date: '2026-04-05',
        total_cost: 0.05,
        total_tokens: 600,
        total_sessions: 1
      }
    ])
  })

  it('uses the requested date range consistently for dashboard totals and session rows', async () => {
    const project = db.createProject({ name: 'Date Range Project', path: '/tmp/date-range-project' })
    const worktree = db.createWorktree({
      project_id: project.id,
      path: '/tmp/date-range-project',
      name: 'main',
      branch_name: 'main',
      is_default: true
    })
    const session = db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      name: 'Date range session',
      opencode_session_id: 'codex-range',
      agent_sdk: 'codex',
      model_provider_id: 'codex',
      model_id: 'gpt-5.4'
    })

    db.createSessionMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'older',
      opencode_message_id: 'msg-1',
      opencode_message_json: JSON.stringify({
        id: 'msg-1',
        timestamp: '2026-03-01T08:00:00.000Z',
        cost: 0.4,
        tokens: {
          input: 1000,
          output: 200,
          cacheRead: 0,
          cacheWrite: 0
        },
        model: 'codex/gpt-5.4'
      }),
      created_at: '2026-03-01T08:00:00.000Z'
    })

    db.createSessionMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'recent',
      opencode_message_id: 'msg-2',
      opencode_message_json: JSON.stringify({
        id: 'msg-2',
        timestamp: '2026-04-09T08:00:00.000Z',
        cost: 0.1,
        tokens: {
          input: 500,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0
        },
        model: 'codex/gpt-5.4'
      }),
      created_at: '2026-04-09T08:00:00.000Z'
    })

    await service.resync()

    const dashboard = await service.fetchDashboard({ range: 'today', engine: 'all' })

    expect(dashboard.success).toBe(true)
    expect(dashboard.data?.total_cost).toBeCloseTo(0.1, 10)
    expect(dashboard.data?.total_tokens).toBe(600)
    expect(dashboard.data?.sessions).toHaveLength(1)
    expect(dashboard.data?.sessions[0].total_cost).toBeCloseTo(0.1, 10)
    expect(dashboard.data?.sessions[0].total_tokens).toBe(600)
  })
})

if (!canRunDatabaseTests()) {
  describe('UsageAnalyticsService database availability', () => {
    it('skips database-backed tests when better-sqlite3 is unavailable', () => {
      expect(getDatabaseLoadError()).toBeTruthy()
    })
  })
}
