import { describe, expect, test } from 'bun:test'
import { buildMessageLink, internalChatId } from '../src/links'

describe('buildMessageLink', () => {
  test('public group with username', () => {
    const link = buildMessageLink(
      { chatId: -1001234567890, type: 'supergroup', username: 'mygroup' },
      42
    )
    expect(link).toBe('https://t.me/mygroup/42')
  })

  test('private supergroup without username', () => {
    const link = buildMessageLink(
      { chatId: -1001234567890, type: 'supergroup', username: null },
      42
    )
    expect(link).toBe('https://t.me/c/1234567890/42')
  })

  test('private channel without username', () => {
    const link = buildMessageLink(
      { chatId: -1009876543210, type: 'channel', username: null },
      99
    )
    expect(link).toBe('https://t.me/c/9876543210/99')
  })

  test('normal group returns null', () => {
    const link = buildMessageLink(
      { chatId: -123456789, type: 'group', username: null },
      1
    )
    expect(link).toBeNull()
  })

  test('private chat returns null', () => {
    const link = buildMessageLink(
      { chatId: 123456789, type: 'private', username: 'someuser' },
      1
    )
    expect(link).toBeNull()
  })

  test('forum topic message in private supergroup includes thread id', () => {
    const link = buildMessageLink(
      { chatId: -1001234567890, type: 'supergroup', username: null },
      42,
      7
    )
    expect(link).toBe('https://t.me/c/1234567890/7/42')
  })

  test('forum topic message in public supergroup includes thread id', () => {
    const link = buildMessageLink(
      { chatId: -1001234567890, type: 'supergroup', username: 'mygroup' },
      42,
      7
    )
    expect(link).toBe('https://t.me/mygroup/7/42')
  })

  test('topic root message (msg id equals thread id) stays two-segment', () => {
    const link = buildMessageLink(
      { chatId: -1001234567890, type: 'supergroup', username: null },
      7,
      7
    )
    expect(link).toBe('https://t.me/c/1234567890/7')
  })

  test('null thread id keeps two-segment link', () => {
    const link = buildMessageLink(
      { chatId: -1001234567890, type: 'supergroup', username: null },
      42,
      null
    )
    expect(link).toBe('https://t.me/c/1234567890/42')
  })
})

describe('internalChatId', () => {
  test('strips -100 prefix for supergroup', () => {
    expect(internalChatId(-1001234567890)).toBe(1234567890)
  })

  test('strips -100 prefix for channel', () => {
    expect(internalChatId(-1009876543210)).toBe(9876543210)
  })

  test('returns null for normal group', () => {
    expect(internalChatId(-123456789)).toBeNull()
  })

  test('returns null for positive id', () => {
    expect(internalChatId(123456789)).toBeNull()
  })
})
