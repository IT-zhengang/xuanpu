import type { SessionModelRef, TokenInfo } from '@/stores/useContextStore'
import {
  extractCost,
  extractMessageUsageId,
  extractModelRef,
  extractModelUsage,
  extractTokens
} from './token-utils'

export interface SessionUsageModelLimit {
  modelID: string
  providerID?: string
  contextWindow: number
}

export interface SessionUsageSnapshot {
  totalCost: number
  tokens: TokenInfo | null
  modelRef?: SessionModelRef
  modelLimits: SessionUsageModelLimit[]
}

export interface CompletedSessionUsageUpdate {
  usageMessageId: string | null
  cost: number
  tokens: TokenInfo | null
  modelRef?: SessionModelRef
  modelLimits: SessionUsageModelLimit[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function collectModelLimits(
  messageData: Record<string, unknown>,
  limitMap: Map<string, SessionUsageModelLimit>
): void {
  const modelUsageEntries = extractModelUsage(messageData)
  if (!modelUsageEntries) return

  for (const entry of modelUsageEntries) {
    if (entry.contextWindow <= 0) continue

    const key = `${entry.providerID ?? '*'}::${entry.modelID}`
    limitMap.set(key, {
      modelID: entry.modelID,
      providerID: entry.providerID,
      contextWindow: entry.contextWindow
    })
  }
}

export function buildSessionUsageSnapshot(messages: unknown[]): SessionUsageSnapshot {
  let totalCost = 0
  let tokens: TokenInfo | null = null
  let modelRef: SessionModelRef | undefined
  const modelLimits = new Map<string, SessionUsageModelLimit>()

  for (let i = messages.length - 1; i >= 0; i--) {
    const rawMessage = messages[i]
    if (typeof rawMessage !== 'object' || rawMessage === null) continue

    const messageRecord = rawMessage as Record<string, unknown>
    const info = asRecord(messageRecord.info)
    const role = info?.role ?? messageRecord.role
    if (role !== 'assistant') continue

    totalCost += extractCost(messageRecord)
    collectModelLimits(messageRecord, modelLimits)

    if (!tokens) {
      const extractedTokens = extractTokens(messageRecord)
      if (extractedTokens) {
        tokens = extractedTokens
        modelRef = extractModelRef(messageRecord) ?? undefined
      }
    }
  }

  return {
    totalCost,
    tokens,
    ...(modelRef ? { modelRef } : {}),
    modelLimits: Array.from(modelLimits.values())
  }
}

export function extractCompletedSessionUsageUpdate(
  messageData: Record<string, unknown>
): CompletedSessionUsageUpdate | null {
  const info = asRecord(messageData.info)
  if (!info?.time || !asRecord(info.time)?.completed) return null

  const modelLimits = new Map<string, SessionUsageModelLimit>()
  collectModelLimits(messageData, modelLimits)

  return {
    usageMessageId: extractMessageUsageId(messageData),
    cost: extractCost(messageData),
    tokens: extractTokens(messageData),
    modelRef: extractModelRef(messageData) ?? undefined,
    modelLimits: Array.from(modelLimits.values())
  }
}
