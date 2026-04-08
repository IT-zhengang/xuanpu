import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { platform } from 'os'

export interface DetectedApp {
  id: string
  name: string
  command: string
  available: boolean
}

interface AppDefinition {
  id: string
  name: string
  commands: string[]
  appPaths?: string[]
}

export function detectEditors(): DetectedApp[] {
  const currentPlatform = platform()
  const editors: DetectedApp[] = []

  const editorDefs: AppDefinition[] = [
    {
      id: 'vscode',
      name: 'Visual Studio Code',
      appPaths:
        currentPlatform === 'darwin' ? ['/Applications/Visual Studio Code.app'] : undefined,
      commands:
        currentPlatform === 'darwin'
          ? [
              '/usr/local/bin/code',
              '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
            ]
          : currentPlatform === 'win32'
            ? ['code.cmd', 'code']
            : ['code']
    },
    {
      id: 'cursor',
      name: 'Cursor',
      appPaths: currentPlatform === 'darwin' ? ['/Applications/Cursor.app'] : undefined,
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/cursor', '/Applications/Cursor.app/Contents/Resources/app/bin/cursor']
          : currentPlatform === 'win32'
            ? ['cursor.cmd', 'cursor']
            : ['cursor']
    },
    {
      id: 'sublime',
      name: 'Sublime Text',
      appPaths: currentPlatform === 'darwin' ? ['/Applications/Sublime Text.app'] : undefined,
      commands:
        currentPlatform === 'darwin'
          ? [
              '/usr/local/bin/subl',
              '/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'
            ]
          : currentPlatform === 'win32'
            ? ['subl.exe']
            : ['subl']
    },
    {
      id: 'webstorm',
      name: 'WebStorm',
      appPaths: currentPlatform === 'darwin' ? ['/Applications/WebStorm.app'] : undefined,
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/webstorm', '/Applications/WebStorm.app/Contents/MacOS/webstorm']
          : currentPlatform === 'win32'
            ? ['webstorm64.exe', 'webstorm.cmd']
            : ['webstorm']
    },
    {
      id: 'idea',
      name: 'IntelliJ IDEA',
      appPaths:
        currentPlatform === 'darwin'
          ? ['/Applications/IntelliJ IDEA.app', '/Applications/IntelliJ IDEA CE.app']
          : undefined,
      commands:
        currentPlatform === 'darwin'
          ? [
              '/usr/local/bin/idea',
              '/opt/homebrew/bin/idea',
              '/Applications/IntelliJ IDEA.app/Contents/MacOS/idea',
              '/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea'
            ]
          : currentPlatform === 'win32'
            ? ['idea64.exe', 'idea.exe', 'idea.cmd']
            : ['idea', 'idea-community', 'idea-ultimate', 'intellij-idea-community']
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      appPaths: currentPlatform === 'darwin' ? ['/Applications/Antigravity.app'] : undefined,
      commands:
        currentPlatform === 'darwin'
          ? [
              '/usr/local/bin/agy',
              '/opt/homebrew/bin/agy',
              '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
              '/Applications/Antigravity.app/Contents/Resources/app/bin/agy'
            ]
          : currentPlatform === 'win32'
            ? ['agy.cmd', 'antigravity.cmd', 'agy.exe', 'antigravity.exe', 'agy']
            : ['agy', 'antigravity']
    },
    {
      id: 'zed',
      name: 'Zed',
      appPaths: currentPlatform === 'darwin' ? ['/Applications/Zed.app'] : undefined,
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/zed', '/Applications/Zed.app/Contents/MacOS/zed']
          : currentPlatform === 'win32'
            ? ['zed.exe']
            : ['zed']
    }
  ]

  for (const def of editorDefs) {
    let available = false
    let resolvedCommand = ''

    if (currentPlatform === 'darwin' && def.appPaths?.some((appPath) => existsSync(appPath))) {
      available = true
    }

    for (const cmd of def.commands) {
      if (existsSync(cmd)) {
        available = true
        resolvedCommand = cmd
        break
      }
      // Try which/where
      try {
        const result = execSync(currentPlatform === 'win32' ? `where ${cmd}` : `which ${cmd}`, {
          encoding: 'utf-8',
          timeout: 2000
        }).trim()
        if (result) {
          available = true
          resolvedCommand = result.split('\n')[0].replace(/\r$/, '')
          break
        }
      } catch {
        // Not found
      }
    }

    editors.push({
      id: def.id,
      name: def.name,
      command: resolvedCommand || def.commands[0],
      available
    })
  }

  return editors
}

export function detectTerminals(): DetectedApp[] {
  const currentPlatform = platform()
  const terminals: DetectedApp[] = []

  const terminalDefs =
    currentPlatform === 'darwin'
      ? [
          {
            id: 'terminal',
            name: 'Terminal',
            commands: ['/System/Applications/Utilities/Terminal.app']
          },
          { id: 'iterm', name: 'iTerm2', commands: ['/Applications/iTerm.app'] },
          { id: 'warp', name: 'Warp', commands: ['/Applications/Warp.app'] },
          {
            id: 'alacritty',
            name: 'Alacritty',
            commands: ['/Applications/Alacritty.app', '/usr/local/bin/alacritty']
          },
          {
            id: 'kitty',
            name: 'kitty',
            commands: ['/Applications/kitty.app', '/usr/local/bin/kitty']
          },
          {
            id: 'ghostty',
            name: 'Ghostty',
            commands: ['/Applications/Ghostty.app', '/usr/local/bin/ghostty']
          }
        ]
      : currentPlatform === 'win32'
        ? [
            { id: 'terminal', name: 'Windows Terminal', commands: ['wt.exe'] },
            { id: 'powershell', name: 'PowerShell', commands: ['pwsh.exe', 'powershell.exe'] },
            { id: 'cmd', name: 'Command Prompt', commands: ['cmd.exe'] }
          ]
        : [
            { id: 'terminal', name: 'Default Terminal', commands: ['x-terminal-emulator'] },
            { id: 'alacritty', name: 'Alacritty', commands: ['alacritty'] },
            { id: 'kitty', name: 'kitty', commands: ['kitty'] }
          ]

  for (const def of terminalDefs) {
    let available = false
    let resolvedCommand = ''

    for (const cmd of def.commands) {
      if (existsSync(cmd)) {
        available = true
        resolvedCommand = cmd
        break
      }
      try {
        const result = execSync(currentPlatform === 'win32' ? `where ${cmd}` : `which ${cmd}`, {
          encoding: 'utf-8',
          timeout: 2000
        }).trim()
        if (result) {
          available = true
          resolvedCommand = result.split('\n')[0].replace(/\r$/, '')
          break
        }
      } catch {
        // Not found
      }
    }

    terminals.push({
      id: def.id,
      name: def.name,
      command: resolvedCommand || def.commands[0],
      available
    })
  }

  return terminals
}
