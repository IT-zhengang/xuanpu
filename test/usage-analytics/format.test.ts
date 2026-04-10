import { describe, expect, it } from 'vitest'
import {
  formatUsageCurrency,
  formatUsageDateTime,
  formatUsageDurationSeconds,
  formatUsageTokens
} from '../../src/renderer/src/lib/usage-format'

describe('usage format helpers', () => {
  it('formats currency with configurable precision', () => {
    expect(formatUsageCurrency(12.3456)).toBe('$12.35')
    expect(formatUsageCurrency(12.3456, 4)).toBe('$12.3456')
  })

  it('formats large token counts compactly', () => {
    expect(formatUsageTokens(950)).toBe('950')
    expect(formatUsageTokens(12_300)).toBe('12.3K')
    expect(formatUsageTokens(4_200_000)).toBe('4.20M')
  })

  it('formats durations in a compact human-readable form', () => {
    expect(formatUsageDurationSeconds(9)).toBe('9s')
    expect(formatUsageDurationSeconds(125)).toBe('2m 5s')
    expect(formatUsageDurationSeconds(3720)).toBe('1h 2m')
  })

  it('formats timestamps using the local date formatter', () => {
    expect(formatUsageDateTime('2026-04-09T12:00:00.000Z')).toBe(
      new Date('2026-04-09T12:00:00.000Z').toLocaleString()
    )
  })
})
