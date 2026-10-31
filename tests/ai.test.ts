import { afterEach, describe, expect, test } from 'bun:test'
import type { StoredMessage } from '../src/db'

process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.LLM_API_KEY = 'test-key'
process.env.LLM_BASE_URL = 'https://openrouter.example/api/v1'
process.env.LLM_MODEL = 'openrouter/free'
process.env.DATABASE_PATH = './data/test-ai.sqlite'

const {
  attemptTimeoutMs,
  CUT_OFF_NOTE,
  looksLikeReasoningLeak,
  parseRetryAfter,
  readChatCompletionStream,
  reasoningOptions,
  summarizeMessages,
  SummaryLlmError,
} =
  await import('../src/ai')
const { summaryFailureMessage } = await import('../src/summaryFailure')
const { GrammyError } = await import('grammy')
const originalFetch = globalThis.fetch
// Retry backoff is real time in production; tests record it instead.
let delays: number[] = []
const fast = {
  sleep: async (ms: number) => {
    delays.push(ms)
  },
}

function sse(chunks: unknown[]) {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { status: 200 }
  )
}

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

function delta(content: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

// A stream that emits next(tick) every `everyMs` (null = send nothing that
// tick) until the attempt is aborted or the body is cancelled.
function tickingStream(signal: AbortSignal, everyMs: number, next: (tick: number) => string | null) {
  let timer: ReturnType<typeof setInterval> | undefined
  return new Response(
    new ReadableStream({
      start(controller) {
        let tick = 0
        timer = setInterval(() => {
          const chunk = next(tick++)
          if (chunk !== null) controller.enqueue(new TextEncoder().encode(chunk))
        }, everyMs)
        signal.addEventListener('abort', () => {
          clearInterval(timer)
          controller.error(signal.reason)
        })
      },
      cancel() {
        clearInterval(timer)
      },
    }),
    { status: 200 }
  )
}

// Sends `chunk`, then fails the next read like a reset connection.
function resetAfter(chunk: string) {
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(new TypeError('socket connection was closed unexpectedly'))
        return
      }
      sent = true
      controller.enqueue(new TextEncoder().encode(chunk))
    },
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  delays = []
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

    expect(await summarizeMessages(params, fast)).toBe('Recovered summary')
    expect(calls).toBe(2)
  })

  test('fails with an empty-answer error after three empty streams', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return streamResponse('')
    }) as unknown as typeof fetch

    const error = await summarizeMessages(params, fast).catch((e) => e)
    expect(error).toBeInstanceOf(SummaryLlmError)
    expect(error.kind).toBe('empty')
    expect(error.message).toBe('LLM returned no visible summary content after 3 attempts')
    expect(calls).toBe(3)
  })

  test('doubles max_tokens after reasoning used up the budget (finish_reason length)', async () => {
    const budgets: number[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      budgets.push(JSON.parse(String(init.body)).max_tokens)
      if (budgets.length < 3) {
        return sse([
          { model: 'some/reasoner:free', choices: [{ delta: { content: '' } }] },
          { choices: [{ delta: {}, finish_reason: 'length' }] },
        ])
      }
      return streamResponse('Third time lucky')
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('Third time lucky')
    expect(budgets).toEqual([1800, 3600, 7200])
  })

  test('keeps the budget when an empty answer finished normally', async () => {
    const budgets: number[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      budgets.push(JSON.parse(String(init.body)).max_tokens)
      return budgets.length === 1
        ? sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
        : streamResponse('Recovered')
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('Recovered')
    expect(budgets).toEqual([1800, 1800])
  })

  test('retries after a mid-stream provider error and drops its partial text', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return calls === 1
        ? sse([
            { choices: [{ delta: { content: 'Partial sum' } }] },
            {
              error: { code: 502, message: 'Upstream provider died' },
              choices: [{ delta: { content: '' }, finish_reason: 'error' }],
            },
          ])
        : streamResponse('Clean summary')
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('Clean summary')
    expect(calls).toBe(2)
  })

  test('never publishes a fragment that ended in a provider error', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return calls === 1
        ? sse([
            { choices: [{ delta: { content: '<b>Topic' } }] },
            { error: { code: 502, message: 'Upstream died' }, choices: [{ delta: {}, finish_reason: 'error' }] },
          ])
        : new Response('slow down', { status: 429 })
    }) as unknown as typeof fetch

    const error = await summarizeMessages(params, fast).catch((e) => e)
    expect(error).toBeInstanceOf(SummaryLlmError)
    expect(error.kind).toBe('provider')
    expect(error.status).toBe(429)
    expect(calls).toBe(3)
  })

  test('waits before retrying provider failures, honouring a capped Retry-After', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) return new Response('busy', { status: 429, headers: { 'Retry-After': '1' } })
      if (calls === 2) return new Response('busy', { status: 503, headers: { 'Retry-After': '120' } })
      return streamResponse('Finally')
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('Finally')
    expect(delays).toEqual([1000, 5000])
  })

  test('uses a default pause for network and mid-stream errors and none after the last attempt', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) throw new TypeError('socket hang up')
      return sse([{ error: { code: 502, message: 'Upstream died' }, choices: [{ delta: {}, finish_reason: 'error' }] }])
    }) as unknown as typeof fetch

    const error = await summarizeMessages(params, fast).catch((e) => e)
    expect(error.kind).toBe('provider')
    expect(calls).toBe(3)
    expect(delays).toEqual([2000, 2000])
  })

  test('retries empty and cut-off answers without waiting', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) return streamResponse('')
      if (calls === 2) return sse([{ choices: [{ delta: {}, finish_reason: 'length' }] }])
      return streamResponse('Done')
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('Done')
    expect(delays).toEqual([])
  })

  test('reports an empty answer when the model came back empty before a later provider error', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls < 3) return sse([{ choices: [{ delta: {}, finish_reason: 'length' }] }])
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }) as unknown as typeof fetch

    const error = await summarizeMessages(params, fast).catch((e) => e)
    expect(error).toBeInstanceOf(SummaryLlmError)
    expect(error.kind).toBe('empty')
    expect(error.message).toContain('LLM returned no visible summary content after 3 attempts (last:')
    expect(summaryFailureMessage(error)).toContain('no usable answer')
  })

  test('reports a non-retryable error even after an empty answer', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return calls === 1 ? streamResponse('') : new Response('out of credits', { status: 402 })
    }) as unknown as typeof fetch

    const error = await summarizeMessages(params, fast).catch((e) => e)
    expect(error.kind).toBe('provider')
    expect(error.status).toBe(402)
    expect(calls).toBe(2)
  })

  test('reports an empty answer when every attempt timed out while the model was silent', async () => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const signal = init.signal!
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': OPENROUTER PROCESSING\n\n'))
            signal.addEventListener('abort', () => controller.error(signal.reason))
          },
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    const error = await summarizeMessages(params, { ...fast, attemptTimeoutMs: 20 }).catch((e) => e)
    expect(error.kind).toBe('empty')
  })

  test('drops a half-written tag before appending the cut-off note', async () => {
    globalThis.fetch = (async () =>
      sse([
        { choices: [{ delta: { content: '<b>Topic</b> see <a href="https://exa' }, finish_reason: 'length' }] },
      ])) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('<b>Topic</b> see' + CUT_OFF_NOTE)
  })

  test('keeps a stray < that is not a tag when appending the cut-off note', async () => {
    globalThis.fetch = (async () =>
      sse([{ choices: [{ delta: { content: 'Vote: yes <3 no, then the team agreed' }, finish_reason: 'length' }] }])) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('Vote: yes <3 no, then the team agreed' + CUT_OFF_NOTE)
  })

  test('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('3')).toBe(3000)
    expect(parseRetryAfter('garbage')).toBeUndefined()
    const now = Date.parse('2026-10-31T12:00:00Z')
    expect(parseRetryAfter('Sat, 31 Oct 2026 12:00:04 GMT', now)).toBe(4000)
    expect(parseRetryAfter('Sat, 31 Oct 2026 11:00:00 GMT', now)).toBe(0)
  })

  test('reports a provider failure when every stream errors mid-way', async () => {
    globalThis.fetch = (async () =>
      sse([
        { error: { code: 429, message: 'Rate limited' }, choices: [{ delta: {}, finish_reason: 'error' }] },
      ])) as unknown as typeof fetch

    const error = await summarizeMessages(params, fast).catch((e) => e)
    expect(error).toBeInstanceOf(SummaryLlmError)
    expect(error.kind).toBe('provider')
  })

  test('skips malformed SSE lines instead of failing the summary', async () => {
    globalThis.fetch = (async () =>
      new Response(
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n' +
          'data: {not json\n\n' +
          ': OPENROUTER PROCESSING\n\n' +
          'data: {"choices":[{"delta":{"content":"world"}}]}\n\n' +
          'data: [DONE]',
        { status: 200 }
      )) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('Hello world')
  })

  test('counts a data: null line as malformed instead of losing the attempt', async () => {
    globalThis.fetch = (async () =>
      new Response(
        delta('Hello ') + 'data: null\n\n' + 'data: 42\n\n' + delta('world') + 'data: [DONE]\n\n',
        { status: 200 }
      )) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('Hello world')
    const outcome = await readChatCompletionStream(
      new Response(delta('Hi') + 'data: null\n\ndata: "x"\n\n').body!
    )
    expect(outcome.content).toBe('Hi')
    expect(outcome.malformedChunks).toBe(2)
    expect(outcome.error).toBeNull()
  })

  test('publishes a finished answer when the connection resets after stop but before [DONE]', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(
        resetAfter(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Complete summary' }, finish_reason: 'stop' }] })}\n\n`
        ),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('Complete summary')
    expect(calls).toBe(1)
    expect(delays).toEqual([])
  })

  test('publishes a finished answer without a cut-off note when the stream stalls after stop', async () => {
    let calls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls += 1
      return tickingStream(init.signal!, 5, (tick) =>
        tick === 0
          ? `data: ${JSON.stringify({ choices: [{ delta: { content: 'Complete summary' }, finish_reason: 'stop' }] })}\n\n`
          : null
      )
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, { ...fast, idleTimeoutMs: 15 })).toBe('Complete summary')
    expect(calls).toBe(1)
  })

  test('keeps a length cut-off when the connection resets after the finish chunk', async () => {
    const lengthChunk = (content: string) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'length' }] })}\n\n`
    const outcome = await readChatCompletionStream(resetAfter(lengthChunk('Partial')))
    expect(outcome.content).toBe('Partial')
    expect(outcome.finishReason).toBe('length')
    expect(outcome.error).toBeNull()

    const texts = ['short cut', 'the longest cut-off text', 'mid cut-off']
    const budgets: number[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      budgets.push(JSON.parse(String(init.body)).max_tokens)
      return new Response(resetAfter(lengthChunk(texts[budgets.length - 1])), { status: 200 })
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('the longest cut-off text' + CUT_OFF_NOTE)
    expect(budgets).toEqual([1800, 3600, 7200])
    expect(delays).toEqual([])
  })

  test('still fails a length chunk that came with an error when the connection then resets', async () => {
    const outcome = await readChatCompletionStream(
      resetAfter(
        `data: ${JSON.stringify({ error: { code: 502, message: 'Upstream died' }, choices: [{ delta: { content: 'Partial' }, finish_reason: 'length' }] })}\n\n`
      )
    )
    expect(outcome.finishReason).toBe('length')
    expect(outcome.error).toContain('stream read failed')
  })

  test('treats a body that closes cleanly before the answer finished as a cut-off and retries', async () => {
    const outcome = await readChatCompletionStream(new Response(delta('<b>Topic</b> half a')).body!)
    expect(outcome.content).toBe('<b>Topic</b> half a')
    expect(outcome.endedEarly).toBe(true)
    expect(outcome.error).toBeNull()

    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return calls === 1 ? new Response(delta('<b>Topic</b> half a')) : streamResponse('<b>Topic</b> Whole.')
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('<b>Topic</b> Whole.')
    expect(calls).toBe(2)
    expect(delays).toEqual([2000])
  })

  test('publishes the longest early-ended answer with the cut-off note when no attempt finishes', async () => {
    const texts = ['first cut', 'the longest early-ended text', 'mid text']
    let calls = 0
    globalThis.fetch = (async () => {
      const content = texts[calls]
      calls += 1
      return new Response(delta(content))
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('the longest early-ended text' + CUT_OFF_NOTE)
    expect(calls).toBe(3)
  })

  test('reports a provider failure when every body closes before any text', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(': OPENROUTER PROCESSING\n\n')
    }) as unknown as typeof fetch

    const error = await summarizeMessages(params, fast).catch((e) => e)
    expect(error).toBeInstanceOf(SummaryLlmError)
    expect(error.kind).toBe('provider')
    expect(error.message).toContain('ended before the answer finished')
    expect(calls).toBe(3)
  })

  test('still reports leaked reasoning as an unusable answer when its body closes early', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(delta('<think>Analyze the chat and'))
    }) as unknown as typeof fetch

    const error = await summarizeMessages(params, fast).catch((e) => e)
    expect(error).toBeInstanceOf(SummaryLlmError)
    expect(error.kind).toBe('empty')
    expect(summaryFailureMessage(error)).toContain('no usable answer')
    expect(calls).toBe(3)
    expect(delays).toEqual([])
  })

  test('accepts [DONE] without a finish_reason, and a finish_reason without [DONE], as complete', async () => {
    for (const body of [
      delta('No finish reason') + 'data: [DONE]',
      delta('No finish reason') + 'data: [DONE]\n\n',
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'No sentinel' }, finish_reason: 'stop' }] })}\n\n`,
    ]) {
      const outcome = await readChatCompletionStream(new Response(body).body!)
      expect(outcome.endedEarly).toBe(false)
      expect(outcome.error).toBeNull()
    }

    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(delta('No finish reason') + 'data: [DONE]')
    }) as unknown as typeof fetch
    expect(await summarizeMessages(params, fast)).toBe('No finish reason')
    expect(calls).toBe(1)
  })

  test('does not retry a non-retryable provider status', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('{"error":"bad key"}', { status: 401 })
    }) as unknown as typeof fetch

    const error = await summarizeMessages(params, fast).catch((e) => e)
    expect(error).toBeInstanceOf(SummaryLlmError)
    expect(error.kind).toBe('provider')
    expect(error.status).toBe(401)
    expect(calls).toBe(1)
  })

  test('retries 429/5xx responses and network failures', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) return new Response('busy', { status: 429 })
      if (calls === 2) throw new TypeError('socket hang up')
      return streamResponse('After retries')
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('After retries')
    expect(calls).toBe(3)
  })

  test('keeps the provider status when every attempt is rate limited', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('slow down', { status: 429 })
    }) as unknown as typeof fetch

    const error = await summarizeMessages(params, fast).catch((e) => e)
    expect(error.status).toBe(429)
    expect(calls).toBe(3)
    expect(summaryFailureMessage(error)).toContain('rate limiting')
  })

  test('falls back to the configured budget when a raised budget is rejected', async () => {
    const budgets: number[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      budgets.push(JSON.parse(String(init.body)).max_tokens)
      if (budgets.length === 1) return sse([{ choices: [{ delta: {}, finish_reason: 'length' }] }])
      if (budgets.length === 2) return new Response('max_tokens too large', { status: 400 })
      return streamResponse('Fits now')
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('Fits now')
    expect(budgets).toEqual([1800, 3600, 1800])
  })

  test('falls back to the configured budget when a raised budget is unaffordable (402)', async () => {
    const budgets: number[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      budgets.push(JSON.parse(String(init.body)).max_tokens)
      if (budgets.length === 1) return sse([{ choices: [{ delta: {}, finish_reason: 'length' }] }])
      if (budgets.length === 2) return new Response('insufficient credits for max_tokens', { status: 402 })
      return streamResponse('Fits now')
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('Fits now')
    expect(budgets).toEqual([1800, 3600, 1800])
    expect(delays).toEqual([])
  })

  test('does not retry a 400 at the configured budget', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('bad request', { status: 400 })
    }) as unknown as typeof fetch

    const error = await summarizeMessages(params, fast).catch((e) => e)
    expect(error.status).toBe(400)
    expect(calls).toBe(1)
  })

  test('retries a summary cut off at the token limit with a bigger budget', async () => {
    const budgets: number[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      budgets.push(JSON.parse(String(init.body)).max_tokens)
      return budgets.length === 1
        ? sse([{ choices: [{ delta: { content: '<b>Topic one</b> half a sen' }, finish_reason: 'length' }] }])
        : streamResponse('<b>Topic one</b> Full sentence.')
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('<b>Topic one</b> Full sentence.')
    expect(budgets).toEqual([1800, 3600])
  })

  test('publishes the longest cut-off summary when every attempt hits the limit', async () => {
    const texts = ['short cut', 'the longest cut-off text', 'mid cut-off']
    let calls = 0
    globalThis.fetch = (async () => {
      const content = texts[calls]
      calls += 1
      return sse([{ choices: [{ delta: { content }, finish_reason: 'length' }] }])
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('the longest cut-off text' + CUT_OFF_NOTE)
    expect(calls).toBe(3)
  })

  test('maps a mid-stream error code to the failure status', async () => {
    globalThis.fetch = (async () =>
      sse([
        { error: { code: 429, message: 'Rate limited upstream' }, choices: [{ delta: {}, finish_reason: 'error' }] },
      ])) as unknown as typeof fetch

    const error = await summarizeMessages(params, fast).catch((e) => e)
    expect(error.kind).toBe('provider')
    expect(error.status).toBe(429)
  })

  test('treats finish_reason error without an error object as a failed attempt', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return calls === 1
        ? sse([{ choices: [{ delta: { content: 'Partial' }, finish_reason: 'error' }] }])
        : streamResponse('Whole summary')
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('Whole summary')
    expect(calls).toBe(2)
  })

  test('times out a stalled attempt and retries', async () => {
    let calls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls += 1
      if (calls > 1) return streamResponse('Not stalled')
      const signal = init.signal!
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': OPENROUTER PROCESSING\n\n'))
            signal.addEventListener('abort', () => controller.error(signal.reason))
          },
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, { ...fast, idleTimeoutMs: 10 })).toBe('Not stalled')
    expect(calls).toBe(2)
  })

  test('gives larger budgets proportionally longer attempt caps', () => {
    expect(attemptTimeoutMs(1800)).toBe(300_000)
    expect(attemptTimeoutMs(3600)).toBe(300_000)
    expect(attemptTimeoutMs(7200)).toBe(360_000)
    expect(attemptTimeoutMs(16_000)).toBe(800_000)
  })

  test('lets a slow stream finish while it keeps sending chunks past the idle limit', async () => {
    let calls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls += 1
      return tickingStream(init.signal!, 12, (tick) =>
        tick < 15 ? delta('part' + tick + ' ') : tick === 15 ? 'data: [DONE]\n\n' : null
      )
    }) as unknown as typeof fetch

    const started = Date.now()
    const result = await summarizeMessages(params, { ...fast, idleTimeoutMs: 60 })
    expect(Date.now() - started).toBeGreaterThan(120)
    expect(result).toBe(Array.from({ length: 15 }, (_, tick) => 'part' + tick).join(' '))
    expect(calls).toBe(1)
  })

  test('counts keepalive comments as activity during a long silent reasoning phase', async () => {
    let calls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls += 1
      return tickingStream(init.signal!, 10, (tick) =>
        tick < 12 ? ': OPENROUTER PROCESSING\n\n' : tick === 12 ? delta('Thought it over') + 'data: [DONE]\n\n' : null
      )
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, { ...fast, idleTimeoutMs: 25 })).toBe('Thought it over')
    expect(calls).toBe(1)
  })

  test('times out a stream that goes silent', async () => {
    let calls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls += 1
      return tickingStream(init.signal!, 5, () => null)
    }) as unknown as typeof fetch

    const started = Date.now()
    const error = await summarizeMessages(params, { ...fast, idleTimeoutMs: 10 }).catch((e) => e)
    expect(error).toBeInstanceOf(SummaryLlmError)
    expect(error.kind).toBe('empty')
    expect(calls).toBe(3)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('caps an attempt that never goes quiet and never finishes', async () => {
    let calls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls += 1
      return tickingStream(init.signal!, 5, () => ': OPENROUTER PROCESSING\n\n')
    }) as unknown as typeof fetch

    const error = await summarizeMessages(params, { ...fast, idleTimeoutMs: 20, attemptTimeoutMs: 60 }).catch(
      (e) => e
    )
    expect(error.kind).toBe('empty')
    expect(calls).toBe(3)
  })

  test('publishes a slow answer cut by the attempt cap instead of retrying it identically', async () => {
    let calls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls += 1
      return tickingStream(init.signal!, 10, (tick) => delta(tick === 0 ? 'Slow summary' : '.'))
    }) as unknown as typeof fetch

    const result = await summarizeMessages(params, { ...fast, idleTimeoutMs: 1_000, attemptTimeoutMs: 60 })
    expect(result.startsWith('Slow summary.')).toBe(true)
    expect(result.endsWith(CUT_OFF_NOTE)).toBe(true)
    expect(calls).toBe(1)
  })

  test('stops retrying once the overall deadline is too close', async () => {
    let calls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls += 1
      return tickingStream(init.signal!, 5, () => null)
    }) as unknown as typeof fetch

    const error = await summarizeMessages(params, { ...fast, idleTimeoutMs: 1_000, deadlineMs: 40 }).catch(
      (e) => e
    )
    expect(error).toBeInstanceOf(SummaryLlmError)
    expect(calls).toBe(1)
  })

  test('fails instead of publishing a cut-off answer that is only a half-written tag', async () => {
    for (const fragment of ['<b', '<a href="https://t.me/x', '  ']) {
      globalThis.fetch = (async (_url: string, init: RequestInit) =>
        tickingStream(init.signal!, 5, (tick) => (tick === 0 ? delta(fragment) : null))) as unknown as typeof fetch

      const error = await summarizeMessages(params, { ...fast, idleTimeoutMs: 10 }).catch((e) => e)
      expect(error).toBeInstanceOf(SummaryLlmError)
      expect(error.kind).toBe('empty')
    }
  })

  test('keeps text streamed before a timeout as the fallback summary', async () => {
    let calls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls += 1
      const signal = init.signal!
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'Slow but useful summary' } }] })}\n\n`
              )
            )
            signal.addEventListener('abort', () => controller.error(signal.reason))
          },
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, { ...fast, idleTimeoutMs: 30 })).toBe(
      'Slow but useful summary' + CUT_OFF_NOTE
    )
    expect(calls).toBe(3)
  })

  test('publishes a saved cut-off summary instead of a later non-retryable error', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return calls === 1
        ? sse([{ choices: [{ delta: { content: 'Cut-off summary' }, finish_reason: 'length' }] }])
        : new Response('no endpoints', { status: 404 })
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe('Cut-off summary' + CUT_OFF_NOTE)
    expect(calls).toBe(2)
  })

  test('parses CRLF lines and JSON split across reads', async () => {
    const parts = [
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\r\n\r\ndata: {"choices":[{"delta":{"con',
      'tent":" there"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    ]
    const body = new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
        controller.close()
      },
    })
    const outcome = await readChatCompletionStream(body)
    expect(outcome.content).toBe('Hello there')
    expect(outcome.finishReason).toBe('stop')
    expect(outcome.malformedChunks).toBe(0)
  })

  test('retries instead of publishing model reasoning as the summary', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return streamResponse(
        calls === 1
          ? "Here's a thinking process:\n\n1. Analyze User Input:\n- Chat name: Veydrift"
          : '<b>Fleet update</b> Defenses are being rebuilt.'
      )
    }) as unknown as typeof fetch

    expect(await summarizeMessages(params, fast)).toBe(
      '<b>Fleet update</b> Defenses are being rebuilt.'
    )
    expect(calls).toBe(2)
  })

  test('detects common reasoning wrappers', () => {
    expect(looksLikeReasoningLeak("Here's a thinking process:\n1. Analyze the chat")).toBe(
      true
    )
    expect(looksLikeReasoningLeak('<think>Analyze the chat</think>')).toBe(true)
    expect(
      looksLikeReasoningLeak(
        '1. Analyze User Input:\n2. Determine Prevalent Language:\n3. Scan Messages for Key Topics:'
      )
    ).toBe(true)
    expect(looksLikeReasoningLeak('<b>War and raids</b> Fleets are rebuilding.')).toBe(
      false
    )
  })
})

describe('summaryFailureMessage', () => {
  test('names the failure category without provider details', () => {
    expect(summaryFailureMessage(new SummaryLlmError('empty', 'x'))).toContain(
      'the AI model returned no usable answer'
    )
    expect(
      summaryFailureMessage(new SummaryLlmError('provider', 'LLM request failed: 429 secret body', 429))
    ).toBe('Summary failed: the AI provider is rate limiting requests. Please try again in a few minutes.')
    const provider = summaryFailureMessage(
      new SummaryLlmError('provider', 'LLM request failed: 502 secret body', 502)
    )
    expect(provider).toBe('Summary failed: the AI provider returned an error (HTTP 502). Please try again later.')
    expect(provider).not.toContain('secret')
    expect(
      summaryFailureMessage(
        new GrammyError('Call to sendMessage failed', { ok: false, error_code: 400, description: 'Bad Request' }, 'sendMessage', {})
      )
    ).toContain('Telegram error')
    expect(summaryFailureMessage(new Error('disk'))).toContain('unexpected error')
  })
})
