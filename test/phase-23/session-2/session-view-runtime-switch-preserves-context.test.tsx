import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { SessionView } from '../../../src/renderer/src/components/sessions/SessionView'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStatusStore } from '../../../src/renderer/src/stores/useWorktreeStatusStore'
import { useSettingsStore } from '../../../src/renderer/src/stores/useSettingsStore'

function createSessionRecord(
  overrides: Partial<{
    opencode_session_id: string | null
    model_provider_id: string | null
    model_id: string | null
    model_variant: string | null
  }> = {}
) {
  return {
    id: 'session-1',
    worktree_id: 'wt-1',
    project_id: 'proj-1',
    connection_id: null,
    name: 'Runtime Session',
    status: 'active' as const,
    opencode_session_id: 'opc-session-1',
    agent_sdk: 'opencode' as const,
    mode: 'build' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    ...overrides
  }
}

describe('SessionView runtime switch continuity', () => {
  const mockSessionUpdate = vi.fn().mockResolvedValue(null)
  const mockAgentConnect = vi.fn()
  const mockAgentPrompt = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()

    useSettingsStore.setState({
      defaultAgentSdk: 'opencode',
      locale: 'en',
      selectedModel: null,
      selectedModelByProvider: {
        opencode: { providerID: 'openai', modelID: 'gpt-4.1' },
        codex: { providerID: 'openai', modelID: 'gpt-5-codex' },
        'claude-code': { providerID: 'anthropic', modelID: 'claude-sonnet-4' }
      }
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
          update: mockSessionUpdate,
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
        }
      },
      configurable: true,
      writable: true
    })

    mockAgentConnect.mockResolvedValue({ success: true, sessionId: 'opc-session-2' })
    mockAgentPrompt.mockResolvedValue({ success: true })

    Object.defineProperty(window, 'agentOps', {
      value: {
        connect: mockAgentConnect,
        reconnect: vi.fn().mockResolvedValue({ success: true, sessionStatus: 'idle' }),
        prompt: mockAgentPrompt,
        command: vi.fn().mockResolvedValue({ success: true }),
        getMessages: vi.fn().mockResolvedValue({ success: true, messages: [] }),
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
        onStream: vi.fn().mockImplementation(() => () => {}),
        undo: vi.fn().mockResolvedValue({ success: true }),
        redo: vi.fn().mockResolvedValue({ success: true }),
        disconnect: vi.fn().mockResolvedValue({ success: true }),
        abort: vi.fn().mockResolvedValue({ success: true }),
        fork: vi.fn().mockResolvedValue({ success: true }),
        questionReply: vi.fn().mockResolvedValue({ success: true }),
        questionReject: vi.fn().mockResolvedValue({ success: true }),
        permissionReply: vi.fn().mockResolvedValue({ success: true }),
        modelInfo: vi.fn().mockResolvedValue({ success: true })
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
  })

  it('reconnects before sending after a model/runtime switch clears the backend session id', async () => {
    const user = userEvent.setup()

    render(
      <TooltipProvider>
        <SessionView sessionId="session-1" />
      </TooltipProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('message-input')).toBeInTheDocument()
    })

    act(() => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          [
            'wt-1',
            [
              createSessionRecord({
                opencode_session_id: null,
                model_provider_id: 'openai',
                model_id: 'gpt-4.1'
              })
            ]
          ]
        ])
      })
    })

    await user.type(screen.getByTestId('message-input'), 'Keep the existing messages')
    await user.click(screen.getByTestId('send-button'))

    await waitFor(() => {
      expect(mockAgentConnect).toHaveBeenCalledWith('/tmp/worktree-default', 'session-1')
    })

    await waitFor(() => {
      expect(mockAgentPrompt).toHaveBeenCalledWith(
        '/tmp/worktree-default',
        'opc-session-2',
        expect.any(Array),
        expect.objectContaining({ providerID: 'openai', modelID: 'gpt-4.1' }),
        undefined
      )
    })

    expect(mockSessionUpdate).toHaveBeenCalledWith('session-1', {
      opencode_session_id: 'opc-session-2'
    })
  })

  it('adopts a new runtime session id returned by reconnect and persists it', async () => {
    const reconnectMock = vi.fn().mockResolvedValue({
      success: true,
      sessionId: 'opc-session-2',
      sessionStatus: 'idle'
    })
    const getMessagesMock = vi.fn().mockResolvedValue({ success: true, messages: [] })

    Object.defineProperty(window, 'agentOps', {
      value: {
        ...window.agentOps,
        reconnect: reconnectMock,
        getMessages: getMessagesMock
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
      expect(reconnectMock).toHaveBeenCalledWith('/tmp/worktree-default', 'opc-session-1', 'session-1')
    })

    await waitFor(() => {
      expect(getMessagesMock).toHaveBeenCalledWith('/tmp/worktree-default', 'opc-session-2')
    })

    await waitFor(() => {
      expect(mockSessionUpdate).toHaveBeenCalledWith('session-1', {
        opencode_session_id: 'opc-session-2'
      })
    })

    expect(useSessionStore.getState().getSessionById('session-1')?.opencode_session_id).toBe(
      'opc-session-2'
    )
  })
})
