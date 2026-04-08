import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '../../../src/renderer/src/stores/useProjectStore'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useSettingsStore } from '../../../src/renderer/src/stores/useSettingsStore'

const mockSessionCreate = vi.fn()
const mockSessionUpdate = vi.fn()
const mockAgentSetModel = vi.fn().mockResolvedValue({ success: true })

describe('project runtime configuration', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()

    useSettingsStore.setState({
      defaultAgentSdk: 'opencode',
      selectedModel: null,
      selectedModelByProvider: {
        opencode: { providerID: 'openai', modelID: 'gpt-4.1' },
        codex: { providerID: 'openai', modelID: 'gpt-5-codex' },
        'claude-code': { providerID: 'anthropic', modelID: 'claude-sonnet-4' }
      },
      defaultModels: null
    })

    useProjectStore.setState({
      projects: [],
      isLoading: false,
      error: null,
      selectedProjectId: null,
      expandedProjectIds: new Set(),
      editingProjectId: null,
      settingsProjectId: null
    })

    useSessionStore.setState({
      sessionsByWorktree: new Map(),
      tabOrderByWorktree: new Map(),
      modeBySession: new Map(),
      pendingMessages: new Map(),
      pendingPlans: new Map(),
      pendingFollowUpMessages: new Map(),
      isLoading: false,
      error: null,
      activeSessionId: null,
      activeWorktreeId: null,
      activeSessionByWorktree: {},
      sessionsByConnection: new Map(),
      tabOrderByConnection: new Map(),
      activeSessionByConnection: {},
      activeConnectionId: null,
      inlineConnectionSessionId: null,
      closedTerminalSessionIds: new Set()
    })

    Object.defineProperty(window, 'db', {
      value: {
        session: {
          create: mockSessionCreate,
          update: mockSessionUpdate,
          getActiveByWorktree: vi.fn().mockResolvedValue([]),
          getActiveByConnection: vi.fn().mockResolvedValue([])
        }
      },
      configurable: true,
      writable: true
    })

    Object.defineProperty(window, 'agentOps', {
      value: {
        setModel: mockAgentSetModel
      },
      configurable: true,
      writable: true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('new sessions inherit project runtime and model before global defaults', async () => {
    useProjectStore.setState({
      projects: [
        {
          id: 'proj-1',
          name: 'Demo',
          path: '/tmp/demo',
          description: null,
          tags: null,
          language: 'TypeScript',
          agent_sdk: 'codex',
          model_provider_id: 'openai',
          model_id: 'gpt-5-codex-pro',
          model_variant: 'high',
          custom_icon: null,
          setup_script: null,
          run_script: null,
          archive_script: null,
          auto_assign_port: false,
          sort_order: 0,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      ]
    })

    mockSessionCreate.mockResolvedValue({
      id: 'sess-1',
      worktree_id: 'wt-1',
      project_id: 'proj-1',
      connection_id: null,
      name: 'Session 1',
      status: 'active',
      opencode_session_id: null,
      agent_sdk: 'codex',
      mode: 'build',
      model_provider_id: 'openai',
      model_id: 'gpt-5-codex-pro',
      model_variant: 'high',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null
    })

    await useSessionStore.getState().createSession('wt-1', 'proj-1')

    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        agent_sdk: 'codex',
        model_provider_id: 'openai',
        model_id: 'gpt-5-codex-pro',
        model_variant: 'high'
      })
    )
  })

  it('switching a session runtime clears stale backend session ids and reapplies runtime model', async () => {
    useProjectStore.setState({
      projects: [
        {
          id: 'proj-1',
          name: 'Demo',
          path: '/tmp/demo',
          description: null,
          tags: null,
          language: 'TypeScript',
          agent_sdk: 'claude-code',
          model_provider_id: 'anthropic',
          model_id: 'claude-opus-4-1',
          model_variant: null,
          custom_icon: null,
          setup_script: null,
          run_script: null,
          archive_script: null,
          auto_assign_port: false,
          sort_order: 0,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      ]
    })

    useSessionStore.setState({
      sessionsByWorktree: new Map([
        [
          'wt-1',
          [
            {
              id: 'sess-1',
              worktree_id: 'wt-1',
              project_id: 'proj-1',
              connection_id: null,
              name: 'Session 1',
              status: 'active',
              opencode_session_id: 'backend-123',
              agent_sdk: 'opencode',
              mode: 'build',
              model_provider_id: 'openai',
              model_id: 'gpt-4.1',
              model_variant: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              completed_at: null
            }
          ]
        ]
      ])
    })

    await useSessionStore.getState().setSessionAgentSdk('sess-1', 'claude-code')

    expect(mockSessionUpdate).toHaveBeenCalledWith('sess-1', {
      agent_sdk: 'claude-code',
      opencode_session_id: null,
      model_provider_id: 'anthropic',
      model_id: 'claude-opus-4-1',
      model_variant: null
    })

    expect(mockAgentSetModel).toHaveBeenCalledWith({
      providerID: 'anthropic',
      modelID: 'claude-opus-4-1',
      variant: undefined,
      runtimeId: 'claude-code'
    })

    const session = useSessionStore.getState().getSessionById('sess-1')
    expect(session?.agent_sdk).toBe('claude-code')
    expect(session?.opencode_session_id).toBeNull()
    expect(session?.model_provider_id).toBe('anthropic')
    expect(session?.model_id).toBe('claude-opus-4-1')
  })
})
