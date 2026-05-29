import { describe, expect, test } from 'bun:test'
import { resolveSummaryWindow } from '../src/summaryArgs'

const defaults = { defaultMessages: 200, maxMessages: 500 }
const now = 1_700_000_000

describe('resolveSummaryWindow', () => {
  test('defaults to latest messages', () => {
    expect(resolveSummaryWindow('', now, defaults)).toEqual({
      label: 'latest 200 messages',
      limit: 200,
    })
  })

  test('parses hour duration', () => {
    expect(resolveSummaryWindow('24h', now, defaults)).toEqual({
      label: 'last 24h',
      limit: 500,
      sinceUnixSeconds: now - 24 * 60 * 60,
    })
  })

  test('parses day duration', () => {
    expect(resolveSummaryWindow('7 days', now, defaults)).toEqual({
      label: 'last 7d',
      limit: 500,
      sinceUnixSeconds: now - 7 * 24 * 60 * 60,
    })
  })

  test('parses and clamps message count', () => {
    expect(resolveSummaryWindow('999 messages', now, defaults)).toEqual({
      label: 'latest 500 messages',
      limit: 500,
    })
  })
})
