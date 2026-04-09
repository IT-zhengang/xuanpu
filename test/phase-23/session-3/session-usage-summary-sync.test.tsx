import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { SessionView } from '../../../src/renderer/src/components/sessions/SessionView'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStatusStore } from '../../../src/renderer/src/stores/useWorktreeStatusStore'
import { useSettingsStore } from '../../../src/renderer/src/stores/useSettingsStore'
import { useContextStore } from '../../../src/renderer/src/stores/useContextStore'

function createSessionRecord() {
  return {
    id: 'session-1',
    worktree_id: 'wt-1',
    project_id: 'proj-1',
    connection_id: null,
    name: 'Usage Sync Session',
    status: 'active' as const,
    opencode_session_id: 'opc-session-1',
    agent_sdk: 'claude-code' as const,
    mode: 'build' as const,
    model_provider_id: 'anthropic',
    model_id: 'claude-sonnet-4-5-20250929',
    model_variant: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null
  }
}

describe('Session usage summary refresh ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()

    useSettingsStore.setState({
      defaultAgentSdk: 'claude-code',
      locale: 'en',
      selectedModel: null,
      selectedModelByProvider: {
        opencode: { providerID: 'openai', modelID: 'gpt-4.1' },
        codex: { providerID: 'openai', modelID: 'gpt-5-codex' },
        'claude-code': {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5-20250929'
        }
      }
    })

    useContextStore.setState({
      tokensBySession: {},
      modelBySession: {},
      costBySession: {},
      modelLimits: {}
    })

    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt-1', [createSessionRecord()]]]),
      tabOrderByWorktree: new Map([['wt-1', ['session-1']]]),
      modeBySession: new Map([['session-1', 'build']]),
      pendingMessages: new Map(),
      pendingPlans: new Map(),
      pendingFollowUpMessages: new Map(),
      isLoading: false,
      error: null,
      activeSessionId: 'session-1',
      activeWorktreeId: 'wt-1',
      activeSessionByWorktree: { 'wt-1': 'session-1' },
      sessionsByConnection: new Map(),
      tabOrderByConnection: new Map(),
      activeSessionByConnection: {},
      activeConnectionId: null,
      inlineConnectionSessionId: null,
      closedTerminalSessionIds: new Set()
    })
    useWorktreeStatusStore.setState({ sessionStatuses: {}, lastMessageTimeByWorktree: {} })

    Object.defineProperty(window, 'db', {
      value: {
        session: {
          get: vi.fn().mockResolvedValue(createSessionRecord()),
          update: vi.fn().mockResolvedValue(null),
          updateDraft: vi.fn().mockResolvedValue(undefined),
          getDraft: vi.fn().mockResolvedValue(null)
        },
        worktree: {
          get: vi.fn().mockResolvedValue({
            id: 'wt-1',
            project_id: 'proj-1',
            name: 'WT',
            branch_name: 'main',
            path: '/tmp/worktree-default',
            status: 'active',
            is_default: true,
            created_at: new Date().toISOString(),
            last_accessed_at: new Date().toISOString()
          }),
          update: vi.fn().mockResolvedValue(null),
          updateModel: vi.fn().mockResolvedValue(undefined)
        },
        sessionMessage: {
          list: vi.fn().mockResolvedValue([]),
          upsertManyByOpenCode: vi.fn()
        },
        sessionActivity: {
          list: vi.fn().mockResolvedValue([])
        }
      },
      configurable: true,
      writable: true
    })

    Object.defineProperty(window, 'loggingOps', {
      value: {
        createResponseLog: vi.fn().mockResolvedValue('/tmp/log.jsonl'),
        appendResponseLog: vi.fn().mockResolvedValue(undefined)
      },
      configurable: true,
      writable: true
    })

    Object.defineProperty(window, 'systemOps', {
      value: {
        isLogMode: vi.fn().mockResolvedValue(false),
        getLogDir: vi.fn().mockResolvedValue('/tmp/logs'),
        getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
        getAppPaths: vi.fn().mockResolvedValue({ userData: '/tmp', home: '/tmp', logs: '/tmp/logs' })
      },
      configurable: true,
      writable: true
    })
  })

  it('waits for transcript metadata persistence before refreshing the session summary', async () => {
    let streamCallback: ((event: Record<string, unknown>) => void) | null = null
    let persistRound = 0
    let resolveSecondPersist: (() => void) | null = null
    let secondPersistResolved = false

    const transcript = [
      {
        id: 'user-1',
        role: 'user',
        content: 'How much did this turn cost?',
        timestamp: '2026-04-09T08:00:00.000Z',
        parts: [{ type: 'text', text: 'How much did this turn cost?' }]
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'It cost 2 cents.',
        timestamp: '2026-04-09T08:00:01.000Z',
        parts: [{ type: 'text', text: 'It cost 2 cents.' }],
        info: {
          id: 'assistant-1',
          role: 'assistant',
          time: { created: Date.now() - 1000 },
          tokens: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 50 },
          cost: 0.02,
          modelID: 'claude-sonnet-4-5-20250929',
          providerID: 'anthropic'
        }
      }
    ]

    const upsertManyByOpenCodeMock = vi.fn().mockImplementation(() => {
      persistRound += 1
      if (persistRound === 1) {
        return Promise.resolve(undefined)
      }

      return new Promise<void>((resolve) => {
        resolveSecondPersist = () => {
          secondPersistResolved = true
          resolve()
        }
      })
    })

    const fetchSessionSummaryMock = vi.fn().mockImplementation(async () => ({
      success: true,
      data: {
        session_id: 'session-1',
        engine: 'claude-code',
        total_cost: secondPersistResolved ? 0.02 : 0,
        total_tokens: secondPersistResolved ? 1650 : 0,
        input_tokens: secondPersistResolved ? 1000 : 0,
        output_tokens: secondPersistResolved ? 500 : 0,
        cache_write_tokens: secondPersistResolved ? 50 : 0,
        cache_read_tokens: secondPersistResolved ? 100 : 0,
        duration_seconds: 5,
        last_used_at: '2026-04-09T08:00:01.000Z',
        latest_model_label: 'claude-sonnet-4-5-20250929',
        partial: false
      }
    }))

    Object.assign(window.db.sessionMessage, {
      upsertManyByOpenCode: upsertManyByOpenCodeMock
    })

    Object.defineProperty(window, 'usageAnalyticsOps', {
      value: {
        fetchSessionSummary: fetchSessionSummaryMock
      },
      configurable: true,
      writable: true
    })

    Object.defineProperty(window, 'agentOps', {
      value: {
        connect: vi.fn().mockResolvedValue({ success: true, sessionId: 'opc-session-1' }),
        reconnect: vi.fn().mockResolvedValue({
          success: true,
          sessionId: 'opc-session-1',
          sessionStatus: 'busy'
        }),
        prompt: vi.fn().mockResolvedValue({ success: true }),
        command: vi.fn().mockResolvedValue({ success: true }),
        getMessages: vi.fn().mockResolvedValue({ success: true, messages: transcript }),
        sessionInfo: vi
          .fn()
          .mockResolvedValue({ success: true, revertMessageID: null, revertDiff: null }),
        listModels: vi.fn().mockResolvedValue({ success: true, providers: [] }),
        setModel: vi.fn().mockResolvedValue({ success: true }),
        commands: vi.fn().mockResolvedValue({ success: true, commands: [] }),
        permissionList: vi.fn().mockResolvedValue({ success: true, permissions: [] }),
        capabilities: vi.fn().mockResolvedValue({
          success: true,
          capabilities: {
            supportsUndo: true,
            supportsRedo: true,
            supportsCommands: true,
            supportsPermissionRequests: true,
            supportsQuestionPrompts: true,
            supportsModelSelection: true,
            supportsReconnect: true,
            supportsPartialStreaming: true
          }
        }),
        onStream: vi.fn().mockImplementation((callback) => {
          streamCallback = callback as (event: Record<string, unknown>) => void
          return () => {}
        }),
        undo: vi.fn().mockResolvedValue({ success: true }),
        redo: vi.fn().mockResolvedValue({ success: true }),
        disconnect: vi.fn().mockResolvedValue({ success: true }),
        abort: vi.fn().mockResolvedValue({ success: true }),
        fork: vi.fn().mockResolvedValue({ success: true }),
        questionReply: vi.fn().mockResolvedValue({ success: true }),
        questionReject: vi.fn().mockResolvedValue({ success: true }),
        permissionReply: vi.fn().mockResolvedValue({ success: true }),
        commandApprovalReply: vi.fn().mockResolvedValue({ success: true }),
        modelInfo: vi.fn().mockResolvedValue({ success: true }),
        planApprove: vi.fn().mockResolvedValue({ success: true }),
        planReject: vi.fn().mockResolvedValue({ success: true })
      },
      configurable: true,
      writable: true
    })

    render(
      <TooltipProvider>
        <SessionView sessionId="session-1" />
      </TooltipProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(upsertManyByOpenCodeMock.mock.calls.length).toBeGreaterThan(0)
      expect(fetchSessionSummaryMock.mock.calls.length).toBeGreaterThan(0)
    })

    const initialPersistCalls = upsertManyByOpenCodeMock.mock.calls.length
    const initialSummaryCalls = fetchSessionSummaryMock.mock.calls.length

    expect(useContextStore.getState().costBySession['session-1']).toBeCloseTo(0.02)

    await act(async () => {
      streamCallback?.({
        sessionId: 'session-1',
        type: 'session.status',
        statusPayload: { type: 'idle' },
        data: { status: { type: 'idle' } }
      })
    })

    await waitFor(() => {
      expect(upsertManyByOpenCodeMock.mock.calls.length).toBe(initialPersistCalls + 1)
    })

    expect(fetchSessionSummaryMock.mock.calls.length).toBe(initialSummaryCalls)

    await act(async () => {
      resolveSecondPersist?.()
    })

    await waitFor(() => {
      expect(fetchSessionSummaryMock.mock.calls.length).toBe(initialSummaryCalls + 1)
    })

    await waitFor(() => {
      expect(screen.getByTestId('session-cost-pill')).toHaveTextContent('$0.0200')
    })
  })
})
