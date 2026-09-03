import { afterEach, describe, expect, test } from 'bun:test'
import type { StoredMessage } from '../src/db'

process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.LLM_API_KEY = 'test-key'
process.env.LLM_BASE_URL = 'https://openrouter.example/api/v1'
process.env.LLM_MODEL = 'openrouter/free'
process.env.DATABASE_PATH = './data/test-ai.sqlite'

const { reasoningOptions, summarizeMessages } = await import('../src/ai')
const originalFetch = globalThis.fetch

const params = {
  chatTitle: 'Test chat',
  windowLabel: 'last 24h',
  summaryRequest: '',
  messages: [
    {
      telegramMessageId: 1,
      threadId: null,
      userId: 1,
      username: 'test-user',
      displayName: 'Test user',
      kind: 'text',
      text: 'Test message',
      messageDate: 1_700_000_000,
    } satisfies StoredMessage,
  ],
  chatMetadata: { chatId: -100, type: 'supergroup' as const, username: null },
}

function streamResponse(content: string) {
  const payload = content
    ? `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`
    : 'data: {"choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n'
  return new Response(payload, { status: 200 })
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('summarizeMessages', () => {
  test('uses provider-neutral low reasoning settings for OpenRouter', () => {
    expect(reasoningOptions('https://openrouter.ai/api/v1', true)).toEqual({
      reasoning: { effort: 'low', exclude: true },
    })
  })

  test('keeps the legacy reasoning flag for other compatible endpoints', () => {
    expect(reasoningOptions('https://example.com/v1', true)).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    })
  })

  test('retries once when the first stream has no visible content', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return streamResponse(calls === 1 ? '' : 'Recovered summary')
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params)).toBe('Recovered summary')
    expect(calls).toBe(2)
  })

  test('fails generically after two empty streams', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return streamResponse('')
    }) as unknown as typeof fetch

    await expect(summarizeMessages(params)).rejects.toThrow(
      'LLM returned no visible summary content after 2 attempts'
    )
    expect(calls).toBe(2)
  })
})
