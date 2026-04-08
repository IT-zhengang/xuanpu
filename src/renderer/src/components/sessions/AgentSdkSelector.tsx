import { Bot, ChevronDown, Code2, TerminalSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/useSessionStore'
import { type ProjectAgentSdk } from '@/stores/useProjectStore'
import { useI18n } from '@/i18n/useI18n'

interface AgentSdkSelectorProps {
  value?: ProjectAgentSdk
  onChange?: (sdk: ProjectAgentSdk) => void
  sessionId?: string
  className?: string
}

const SDK_OPTIONS: Array<{
  id: ProjectAgentSdk
  labelKey: string
  shortLabelKey: string
  icon: typeof Bot
}> = [
  {
    id: 'opencode',
    labelKey: 'common.aiProviders.opencode',
    shortLabelKey: 'common.aiProvidersShort.opencode',
    icon: Bot
  },
  {
    id: 'claude-code',
    labelKey: 'common.aiProviders.claudeCode',
    shortLabelKey: 'common.aiProvidersShort.claudeCode',
    icon: Bot
  },
  {
    id: 'codex',
    labelKey: 'common.aiProviders.codex',
    shortLabelKey: 'common.aiProvidersShort.codex',
    icon: Code2
  },
  {
    id: 'terminal',
    labelKey: 'common.aiProviders.terminal',
    shortLabelKey: 'common.aiProvidersShort.terminal',
    icon: TerminalSquare
  }
]

export function AgentSdkSelector({
  value,
  onChange,
  sessionId,
  className
}: AgentSdkSelectorProps): React.JSX.Element {
  const { t } = useI18n()
  const sessionAgentSdk = useSessionStore((state) => {
    if (!sessionId) return null
    return state.getSessionById(sessionId)?.agent_sdk ?? null
  })

  const selectedSdk = value ?? sessionAgentSdk ?? 'opencode'
  const selectedOption = SDK_OPTIONS.find((option) => option.id === selectedSdk) ?? SDK_OPTIONS[0]
  const Icon = selectedOption.icon

  const handleChange = (sdk: ProjectAgentSdk): void => {
    if (onChange) {
      onChange(sdk)
      return
    }
    if (sessionId) {
      void useSessionStore.getState().setSessionAgentSdk(sessionId, sdk)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            'h-8 gap-1.5 rounded-full px-2.5 text-xs font-medium text-foreground',
            className
          )}
          data-testid="agent-sdk-selector"
        >
          <Icon className="h-3.5 w-3.5" />
          <span>{t(selectedOption.shortLabelKey)}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {SDK_OPTIONS.map((option) => {
          const OptionIcon = option.icon
          const active = option.id === selectedSdk

          return (
            <DropdownMenuItem
              key={option.id}
              onSelect={() => handleChange(option.id)}
              className={cn(active && 'bg-accent text-accent-foreground')}
              data-testid={`agent-sdk-option-${option.id}`}
            >
              <OptionIcon className="mr-2 h-4 w-4" />
              <span>{t(option.labelKey)}</span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
