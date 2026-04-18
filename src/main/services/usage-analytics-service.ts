import type { DatabaseService } from '../db/database'
import type { Session, UsageEntry, UsageSyncState } from '../db/types'
import { readClaudeTranscriptUsage } from './claude-transcript-reader'
import { createLogger } from './logger'
import {
  calculateUsageCost,
  resolvePricingModelKey,
  type UsageTokenCounts
} from '@shared/usage/pricing'
import {
  extractUsageCost,
  extractUsageMessageID,
  extractUsageModelRef,
  extractUsageTokens
} from '@shared/usage/message'
import type {
  UsageAnalyticsDashboard,
  UsageAnalyticsDashboardResult,
  UsageAnalyticsEngine,
  UsageAnalyticsEngineFilter,
  UsageAnalyticsFilters,
  UsageAnalyticsPartialSession,
  UsageAnalyticsResyncResult,
  UsageAnalyticsSessionSummary,
  UsageAnalyticsSessionSummaryResult,
  UsageAnalyticsTimelineRow
} from '@shared/types/usage-analytics'
import { getDatabase } from '../db'

const log = createLogger({ component: 'UsageAnalyticsService' })

type SupportedSession = Session & {
  project_name: string
  project_path: string
  worktree_name: string | null
  worktree_path: string | null
}

interface SessionSyncSnapshot {
  stale: boolean
  partial: boolean
  reason?: UsageAnalyticsPartialSession['reason']
  detail?: string
}

interface UsageAggregateTotals {
  total_cost: number
  total_tokens: number
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
}

interface SessionAggregate extends UsageAggregateTotals {
  session_id: string
  session_name: string
  engine: UsageAnalyticsEngine
  project_id: string
  project_name: string
  project_path: string
  worktree_name: string | null
  model_label: string | null
  last_used_at: string | null
  started_at: string
  updated_at: string
  duration_seconds: number
  partial: boolean
}

interface AggregatedUsageSnapshot {
  totals: UsageAggregateTotals
  sessions: SessionAggregate[]
  partial_sessions: UsageAnalyticsPartialSession[]
  stale_session_count: number
  supported_session_count: number
  last_resynced_at: string | null
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function toRangeBounds(range: UsageAnalyticsFilters['range']): {
  dateFrom: string | null
  dateTo: string | null
} {
  if (range === 'all') {
    return { dateFrom: null, dateTo: null }
  }

  const today = startOfLocalDay(new Date())

  if (range === 'today') {
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return {
      dateFrom: today.toISOString(),
      dateTo: tomorrow.toISOString()
    }
  }

  const days = range === '7d' ? 6 : 29
  const dateFrom = new Date(today)
  dateFrom.setDate(dateFrom.getDate() - days)

  const dateTo = new Date(today)
  dateTo.setDate(dateTo.getDate() + 1)

  return {
    dateFrom: dateFrom.toISOString(),
    dateTo: dateTo.toISOString()
  }
}

function toSupportedAgentSdks(filter: UsageAnalyticsEngineFilter): UsageAnalyticsEngine[] {
  return filter === 'all' ? ['claude-code', 'codex'] : [filter]
}

function sumTokens(tokens: UsageTokenCounts): number {
  return tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead
}

function createEmptyTotals(): UsageAggregateTotals {
  return {
    total_cost: 0,
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0
  }
}

function addEntryToTotals(
  totals: UsageAggregateTotals,
  entry: {
    cost: number
    total_tokens: number
    input_tokens: number
    output_tokens: number
    cache_write_tokens: number
    cache_read_tokens: number
  }
): void {
  totals.total_cost += entry.cost
  totals.total_tokens += entry.total_tokens
  totals.input_tokens += entry.input_tokens
  totals.output_tokens += entry.output_tokens
  totals.cache_write_tokens += entry.cache_write_tokens
  totals.cache_read_tokens += entry.cache_read_tokens
}

function findLastResyncedAt(syncStates: Map<string, UsageSyncState | null | undefined>): string | null {
  return (
    Array.from(syncStates.values())
      .map((state) => state?.last_synced_at ?? null)
      .filter((value): value is string => !!value)
      .sort((a, b) => b.localeCompare(a))[0] ?? null
  )
}

export class UsageAnalyticsService {
  constructor(private readonly db: DatabaseService) {}

  async fetchDashboard(filters: UsageAnalyticsFilters): Promise<UsageAnalyticsDashboardResult> {
    try {
      const engines = toSupportedAgentSdks(filters.engine)
      const { dateFrom, dateTo } = toRangeBounds(filters.range)
      const sessions = this.getSupportedSessions().filter((session) =>
        engines.includes(session.agent_sdk as UsageAnalyticsEngine)
      )

      await this.syncSessions(sessions, false)

      const entries = this.db.listUsageEntries({ agentSdks: engines, dateFrom, dateTo })
      const syncStates = this.getSupportedSyncStates()
      const sessionMap = new Map(sessions.map((session) => [session.id, session] as const))
      const sessionEntries = new Map<string, UsageEntry[]>()

      for (const entry of entries) {
        const bucket = sessionEntries.get(entry.session_id) ?? []
        bucket.push(entry)
        sessionEntries.set(entry.session_id, bucket)
      }

      const snapshot = this.buildAggregatedSnapshot({
        sessions,
        sessionEntries,
        syncStates
      })

      const engineMap = new Map<
        UsageAnalyticsEngine,
        { total_cost: number; total_tokens: number; sessionIds: Set<string> }
      >()
      const modelMap = new Map<
        string,
        {
          engine: UsageAnalyticsEngine
          model_key: string
          model_label: string
          total_cost: number
          total_tokens: number
          input_tokens: number
          output_tokens: number
          cache_write_tokens: number
          cache_read_tokens: number
          sessionIds: Set<string>
        }
      >()
      const projectMap = new Map<
        string,
        {
          engine: UsageAnalyticsEngine | 'all'
          project_id: string
          project_name: string
          project_path: string
          total_cost: number
          total_tokens: number
          sessionIds: Set<string>
          last_used_at: string
        }
      >()
      const timelineMap = new Map<string, UsageAnalyticsTimelineRow & { sessionIds: Set<string> }>()

      for (const entry of entries) {
        const session = sessionMap.get(entry.session_id)
        if (!session || !engines.includes(entry.agent_sdk)) continue

        const engineBucket = engineMap.get(entry.agent_sdk) ?? {
          total_cost: 0,
          total_tokens: 0,
          sessionIds: new Set<string>()
        }
        engineBucket.total_cost += entry.cost
        engineBucket.total_tokens += entry.total_tokens
        engineBucket.sessionIds.add(entry.session_id)
        engineMap.set(entry.agent_sdk, engineBucket)

        const modelKey = `${entry.agent_sdk}::${entry.model_id ?? 'unknown'}`
        const modelBucket = modelMap.get(modelKey) ?? {
          engine: entry.agent_sdk,
          model_key: resolvePricingModelKey(entry.model_id ?? entry.model_label ?? 'unknown'),
          model_label: entry.model_label ?? entry.model_id ?? 'Unknown',
          total_cost: 0,
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_read_tokens: 0,
          sessionIds: new Set<string>()
        }
        modelBucket.total_cost += entry.cost
        modelBucket.total_tokens += entry.total_tokens
        modelBucket.input_tokens += entry.input_tokens
        modelBucket.output_tokens += entry.output_tokens
        modelBucket.cache_write_tokens += entry.cache_write_tokens
        modelBucket.cache_read_tokens += entry.cache_read_tokens
        modelBucket.sessionIds.add(entry.session_id)
        modelMap.set(modelKey, modelBucket)

        const projectKey =
          filters.engine === 'all' ? session.project_id : `${entry.agent_sdk}::${session.project_id}`
        const projectBucket = projectMap.get(projectKey) ?? {
          engine: filters.engine === 'all' ? 'all' : entry.agent_sdk,
          project_id: session.project_id,
          project_name: session.project_name,
          project_path: session.project_path,
          total_cost: 0,
          total_tokens: 0,
          sessionIds: new Set<string>(),
          last_used_at: entry.occurred_at
        }
        projectBucket.total_cost += entry.cost
        projectBucket.total_tokens += entry.total_tokens
        projectBucket.sessionIds.add(entry.session_id)
        if (entry.occurred_at > projectBucket.last_used_at) {
          projectBucket.last_used_at = entry.occurred_at
        }
        projectMap.set(projectKey, projectBucket)

        const dateKey = formatDateKey(new Date(entry.occurred_at))
        const timelineBucket = timelineMap.get(dateKey) ?? {
          date: dateKey,
          total_cost: 0,
          total_tokens: 0,
          total_sessions: 0,
          sessionIds: new Set<string>()
        }
        timelineBucket.total_cost += entry.cost
        timelineBucket.total_tokens += entry.total_tokens
        timelineBucket.sessionIds.add(entry.session_id)
        timelineBucket.total_sessions = timelineBucket.sessionIds.size
        timelineMap.set(dateKey, timelineBucket)
      }

      const dashboard: UsageAnalyticsDashboard = {
        filters,
        generated_at: new Date().toISOString(),
        total_cost: snapshot.totals.total_cost,
        total_tokens: snapshot.totals.total_tokens,
        total_sessions: snapshot.sessions.length,
        total_input_tokens: snapshot.totals.input_tokens,
        total_output_tokens: snapshot.totals.output_tokens,
        total_cache_write_tokens: snapshot.totals.cache_write_tokens,
        total_cache_read_tokens: snapshot.totals.cache_read_tokens,
        by_engine: engines.map((engine) => {
          const bucket = engineMap.get(engine)
          return {
            engine,
            total_cost: bucket?.total_cost ?? 0,
            total_tokens: bucket?.total_tokens ?? 0,
            total_sessions: bucket?.sessionIds.size ?? 0
          }
        }),
        by_model: Array.from(modelMap.values())
          .map((bucket) => ({
            engine: bucket.engine,
            model_key: bucket.model_key,
            model_label: bucket.model_label,
            total_cost: bucket.total_cost,
            total_tokens: bucket.total_tokens,
            input_tokens: bucket.input_tokens,
            output_tokens: bucket.output_tokens,
            cache_write_tokens: bucket.cache_write_tokens,
            cache_read_tokens: bucket.cache_read_tokens,
            session_count: bucket.sessionIds.size
          }))
          .sort((a, b) => b.total_cost - a.total_cost),
        by_project: Array.from(projectMap.values())
          .map((bucket) => ({
            engine: bucket.engine,
            project_id: bucket.project_id,
            project_name: bucket.project_name,
            project_path: bucket.project_path,
            total_cost: bucket.total_cost,
            total_tokens: bucket.total_tokens,
            session_count: bucket.sessionIds.size,
            last_used_at: bucket.last_used_at
          }))
          .sort((a, b) => b.total_cost - a.total_cost),
        sessions: snapshot.sessions
          .map(({ duration_seconds: _durationSeconds, partial: _partial, ...session }) => session)
          .sort((a, b) => (b.last_used_at ?? b.updated_at).localeCompare(a.last_used_at ?? a.updated_at)),
        timeline: Array.from(timelineMap.values())
          .map(({ sessionIds: _sessionIds, ...bucket }) => bucket)
          .sort((a, b) => a.date.localeCompare(b.date)),
        partial_sessions: snapshot.partial_sessions.sort((a, b) =>
          a.session_name.localeCompare(b.session_name)
        ),
        sync: {
          stale_session_count: snapshot.stale_session_count,
          partial_session_count: snapshot.partial_sessions.length,
          supported_session_count: snapshot.supported_session_count,
          last_resynced_at: snapshot.last_resynced_at
        }
      }

      return { success: true, data: dashboard }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('Failed to fetch usage dashboard', { error: message })
      return { success: false, error: message }
    }
  }

  async fetchSessionSummary(sessionId: string): Promise<UsageAnalyticsSessionSummaryResult> {
    try {
      const session = this.getSupportedSessions().find((item) => item.id === sessionId)

      if (!session) {
        return { success: false, error: 'Session not found or unsupported' }
      }

      await this.syncSession(session, true)

      const syncStates = this.getSupportedSyncStates()
      const aggregate = this.buildSessionAggregate(
        session,
        this.db.getUsageEntriesBySession(session.id),
        this.getSessionSyncSnapshot(session, syncStates.get(session.id))
      )

      const summary: UsageAnalyticsSessionSummary = {
        session_id: aggregate.session_id,
        engine: aggregate.engine,
        total_cost: aggregate.total_cost,
        total_tokens: aggregate.total_tokens,
        input_tokens: aggregate.input_tokens,
        output_tokens: aggregate.output_tokens,
        cache_write_tokens: aggregate.cache_write_tokens,
        cache_read_tokens: aggregate.cache_read_tokens,
        duration_seconds: aggregate.duration_seconds,
        last_used_at: aggregate.last_used_at,
        latest_model_label: aggregate.model_label,
        partial: aggregate.partial
      }

      return { success: true, data: summary }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('Failed to fetch session usage summary', { sessionId, error: message })
      return { success: false, error: message }
    }
  }

  async resync(): Promise<UsageAnalyticsResyncResult> {
    const sessions = this.getSupportedSessions()
    return this.syncSessions(sessions, true)
  }

  private getSessionSyncSnapshot(
    session: SupportedSession,
    syncState:
      | ReturnType<DatabaseService['getUsageSyncState']>
      | undefined
  ): SessionSyncSnapshot {
    if (session.agent_sdk === 'claude-code') {
      if (!session.worktree_path) {
        return {
          stale: false,
          partial: true,
          reason: 'missing-worktree',
          detail: 'Session no longer has a worktree path for transcript lookup.'
        }
      }

      if (!session.opencode_session_id) {
        return {
          stale: false,
          partial: true,
          reason: 'missing-source',
          detail: 'Session does not have a Claude transcript id.'
        }
      }
    }

    if (!syncState) {
      return { stale: true, partial: false }
    }

    if (syncState.status === 'partial') {
      return {
        stale: false,
        partial: true,
        reason: 'missing-source',
        detail: syncState.last_error ?? 'Source data is incomplete.'
      }
    }

    if (syncState.status === 'error') {
      return {
        stale: false,
        partial: true,
        reason: 'sync-error',
        detail: syncState.last_error ?? 'Analytics sync failed.'
      }
    }

    if (!syncState.last_synced_at) {
      return { stale: true, partial: false }
    }

    if (session.updated_at > syncState.last_synced_at) {
      return { stale: true, partial: false }
    }

    return { stale: false, partial: false }
  }

  private getSupportedSessions(): SupportedSession[] {
    return this.db.getUsageAnalyticsSessions(['claude-code', 'codex'])
  }

  private getSupportedSyncStates(): Map<string, ReturnType<DatabaseService['getUsageSyncState']>> {
    return new Map(this.db.getUsageSyncStates().map((state) => [state.session_id, state] as const))
  }

  private buildSessionAggregate(
    session: SupportedSession,
    entries: UsageEntry[],
    syncSnapshot: SessionSyncSnapshot
  ): SessionAggregate {
    const totals = createEmptyTotals()
    let lastUsedAt: string | null = null
    let latestModelLabel: string | null = null

    // NOTE: entries may arrive in either ASC (per-session lookup) or DESC
    // (dashboard's listUsageEntries) order. Always pick the entry with the
    // greatest occurred_at as the source of truth for last_used_at and the
    // latest model label, instead of relying on iteration order.
    for (const entry of entries) {
      addEntryToTotals(totals, entry)
      if (lastUsedAt === null || entry.occurred_at > lastUsedAt) {
        lastUsedAt = entry.occurred_at
        if (entry.model_label) {
          latestModelLabel = entry.model_label
        }
      } else if (latestModelLabel === null && entry.model_label) {
        latestModelLabel = entry.model_label
      }
    }

    const endAt = lastUsedAt ?? session.updated_at

    return {
      session_id: session.id,
      session_name: session.name ?? 'Untitled',
      engine: session.agent_sdk as UsageAnalyticsEngine,
      project_id: session.project_id,
      project_name: session.project_name,
      project_path: session.project_path,
      worktree_name: session.worktree_name,
      model_label: latestModelLabel,
      last_used_at: lastUsedAt,
      started_at: session.created_at,
      updated_at: session.updated_at,
      duration_seconds: Math.max(
        0,
        Math.round((new Date(endAt).getTime() - new Date(session.created_at).getTime()) / 1000)
      ),
      partial: syncSnapshot.partial,
      ...totals
    }
  }

  private buildAggregatedSnapshot(filters: {
    sessions: SupportedSession[]
    sessionEntries: Map<string, UsageEntry[]>
    syncStates: Map<string, UsageSyncState | null | undefined>
  }): AggregatedUsageSnapshot {
    const totals = createEmptyTotals()
    const aggregatedSessions: SessionAggregate[] = []
    const partialSessions: UsageAnalyticsPartialSession[] = []
    let staleCount = 0

    for (const session of filters.sessions) {
      const syncSnapshot = this.getSessionSyncSnapshot(session, filters.syncStates.get(session.id))
      if (syncSnapshot.stale) staleCount += 1
      if (syncSnapshot.partial && syncSnapshot.reason) {
        partialSessions.push({
          session_id: session.id,
          session_name: session.name ?? 'Untitled',
          engine: session.agent_sdk as UsageAnalyticsEngine,
          reason: syncSnapshot.reason,
          ...(syncSnapshot.detail ? { detail: syncSnapshot.detail } : {})
        })
      }

      const entries = filters.sessionEntries.get(session.id) ?? []
      if (entries.length === 0) continue

      const aggregate = this.buildSessionAggregate(session, entries, syncSnapshot)
      if (aggregate.total_tokens <= 0 && aggregate.total_cost <= 0) continue

      aggregatedSessions.push(aggregate)
      addEntryToTotals(totals, {
        cost: aggregate.total_cost,
        total_tokens: aggregate.total_tokens,
        input_tokens: aggregate.input_tokens,
        output_tokens: aggregate.output_tokens,
        cache_write_tokens: aggregate.cache_write_tokens,
        cache_read_tokens: aggregate.cache_read_tokens
      })
    }

    return {
      totals,
      sessions: aggregatedSessions,
      partial_sessions: partialSessions,
      stale_session_count: staleCount,
      supported_session_count: filters.sessions.length,
      last_resynced_at: findLastResyncedAt(filters.syncStates)
    }
  }

  private async syncSessions(
    sessions: SupportedSession[],
    force: boolean
  ): Promise<UsageAnalyticsResyncResult> {
    const syncedSessionIds: string[] = []
    const partialSessionIds: string[] = []

    for (const session of sessions) {
      const result = await this.syncSession(session, force)
      if (result === 'partial') {
        partialSessionIds.push(session.id)
      } else if (result === 'synced') {
        syncedSessionIds.push(session.id)
      }
    }

    return {
      success: true,
      synced_session_ids: syncedSessionIds,
      partial_session_ids: partialSessionIds
    }
  }

  private async syncSession(
    session: SupportedSession,
    force: boolean
  ): Promise<'synced' | 'partial' | 'skipped'> {
    const syncState = this.db.getUsageSyncState(session.id)
    if (!force) {
      const snapshot = this.getSessionSyncSnapshot(session, syncState)
      // A session may report `partial`/`error` even though `stale === false`,
      // because the snapshot doubles as the UI status. We still need to retry
      // those cases on the next dashboard fetch — otherwise a single transient
      // failure (e.g. transcript file not flushed yet, fresh codex message
      // partially persisted) leaves the session permanently empty until the
      // user clicks Resync. We intentionally skip "data inherently missing"
      // partials (no worktree path / no opencode session id) since retrying
      // those would just reload transcripts for nothing.
      const isInherentlyPartial =
        session.agent_sdk === 'claude-code' &&
        (!session.worktree_path || !session.opencode_session_id)
      const shouldRetryPartial =
        !isInherentlyPartial &&
        (syncState?.status === 'error' || syncState?.status === 'partial')
      if (!snapshot.stale && !shouldRetryPartial) return 'skipped'
    }

    try {
      if (session.agent_sdk === 'claude-code') {
        return await this.syncClaudeSession(session)
      }

      return await this.syncCodexSession(session)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.recordSyncError(session, message)
      log.warn('Failed to sync usage analytics session', {
        sessionId: session.id,
        agentSdk: session.agent_sdk,
        error: message
      })
      return 'partial'
    }
  }

  private recordSyncError(session: SupportedSession, errorMessage: string): void {
    this.db.upsertUsageSyncState({
      session_id: session.id,
      agent_sdk: session.agent_sdk as UsageAnalyticsEngine,
      source_kind: session.agent_sdk === 'claude-code' ? 'claude-transcript' : 'codex-message',
      source_ref: session.opencode_session_id ?? session.id,
      status: 'error',
      entry_count: this.db.getUsageEntriesBySession(session.id).length,
      last_synced_at: new Date().toISOString(),
      last_error: errorMessage
    })
  }

  private async syncClaudeSession(session: SupportedSession): Promise<'synced' | 'partial'> {
    if (!session.worktree_path || !session.opencode_session_id) {
      this.db.upsertUsageSyncState({
        session_id: session.id,
        agent_sdk: 'claude-code',
        source_kind: 'claude-transcript',
        status: 'partial',
        entry_count: 0,
        last_synced_at: new Date().toISOString(),
        last_error: !session.worktree_path
          ? 'Missing worktree path for Claude transcript.'
          : 'Missing Claude transcript session id.'
      })
      return 'partial'
    }

    const transcript = await readClaudeTranscriptUsage(session.worktree_path, session.opencode_session_id)

    if (transcript.mtimeMs === null) {
      this.db.deleteUsageEntriesForSession(session.id, 'claude-transcript')
      this.db.upsertUsageSyncState({
        session_id: session.id,
        agent_sdk: 'claude-code',
        source_kind: 'claude-transcript',
        source_ref: transcript.filePath,
        source_mtime_ms: null,
        status: 'partial',
        entry_count: 0,
        last_synced_at: new Date().toISOString(),
        last_error: 'Claude transcript file is missing.'
      })
      return 'partial'
    }

    this.db.deleteUsageEntriesForSession(session.id, 'claude-transcript')
    for (const entry of transcript.entries) {
      this.db.upsertUsageEntry({
        session_id: session.id,
        project_id: session.project_id,
        worktree_id: session.worktree_id,
        agent_sdk: 'claude-code',
        source_kind: 'claude-transcript',
        source_message_id: entry.sourceMessageId,
        provider_id: 'claude-code',
        model_id: resolvePricingModelKey(entry.model, 'claude-code'),
        model_label: entry.model,
        input_tokens: entry.inputTokens,
        output_tokens: entry.outputTokens,
        cache_write_tokens: entry.cacheWriteTokens,
        cache_read_tokens: entry.cacheReadTokens,
        total_tokens: entry.totalTokens,
        cost: entry.cost,
        occurred_at: entry.occurredAt
      })
    }

    this.db.upsertUsageSyncState({
      session_id: session.id,
      agent_sdk: 'claude-code',
      source_kind: 'claude-transcript',
      source_ref: transcript.filePath,
      source_mtime_ms: transcript.mtimeMs,
      status: 'synced',
      entry_count: transcript.entries.length,
      last_synced_at: new Date().toISOString(),
      last_error: null
    })

    return 'synced'
  }

  private async syncCodexSession(session: SupportedSession): Promise<'synced'> {
    const messageRows = this.db.getSessionMessages(session.id)
    this.db.deleteUsageEntriesForSession(session.id, 'codex-message')

    const finalEntries = new Map<
      string,
      {
        occurredAt: string
        cost: number
        tokens: UsageTokenCounts
        modelID: string | null
        modelLabel: string | null
        providerID: string | null
      }
    >()

    for (const row of messageRows) {
      if (row.role !== 'assistant' || !row.opencode_message_json) continue

      try {
        const parsed = JSON.parse(row.opencode_message_json) as Record<string, unknown>
        const messageId = extractUsageMessageID(parsed) ?? row.opencode_message_id ?? row.id
        const tokens = extractUsageTokens(parsed)
        const modelRef = extractUsageModelRef(parsed)
        const explicitCost = extractUsageCost(parsed)

        if (!tokens && explicitCost <= 0) continue

        const resolvedTokens = tokens ?? {
          input: 0,
          output: 0,
          cacheWrite: 0,
          cacheRead: 0
        }
        const resolvedModel = modelRef?.modelID ?? session.model_id ?? 'unknown'
        const occurredAt =
          typeof parsed.timestamp === 'string' ? parsed.timestamp : row.created_at
        const cost =
          explicitCost > 0
            ? explicitCost
            : calculateUsageCost(resolvedModel, resolvedTokens, modelRef?.providerID ?? 'codex')

        finalEntries.set(messageId, {
          occurredAt,
          cost,
          tokens: resolvedTokens,
          modelID: resolvePricingModelKey(resolvedModel, modelRef?.providerID ?? 'codex'),
          modelLabel: modelRef?.displayName ?? resolvedModel,
          providerID: modelRef?.providerID ?? 'codex'
        })
      } catch {
        // Ignore malformed persisted message rows
      }
    }

    for (const [messageId, entry] of finalEntries.entries()) {
      this.db.upsertUsageEntry({
        session_id: session.id,
        project_id: session.project_id,
        worktree_id: session.worktree_id,
        agent_sdk: 'codex',
        source_kind: 'codex-message',
        source_message_id: messageId,
        provider_id: entry.providerID,
        model_id: entry.modelID,
        model_label: entry.modelLabel,
        input_tokens: entry.tokens.input,
        output_tokens: entry.tokens.output,
        cache_write_tokens: entry.tokens.cacheWrite,
        cache_read_tokens: entry.tokens.cacheRead,
        total_tokens: sumTokens(entry.tokens),
        cost: entry.cost,
        occurred_at: entry.occurredAt
      })
    }

    this.db.upsertUsageSyncState({
      session_id: session.id,
      agent_sdk: 'codex',
      source_kind: 'codex-message',
      source_ref: session.opencode_session_id ?? session.id,
      source_mtime_ms: new Date(session.updated_at).getTime(),
      status: 'synced',
      entry_count: finalEntries.size,
      last_synced_at: new Date().toISOString(),
      last_error: null
    })

    return 'synced'
  }
}

let usageAnalyticsService: UsageAnalyticsService | null = null

export function getUsageAnalyticsService(): UsageAnalyticsService {
  if (!usageAnalyticsService) {
    usageAnalyticsService = new UsageAnalyticsService(getDatabase())
  }
  return usageAnalyticsService
}
