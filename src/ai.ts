import { config } from './config'
import type { StoredMessage } from './db'
import type { ChatMetadata } from './links'
import { buildMessageLink } from './links'
import { CUT_OFF_NOTE, normalizeModelTelegramHtml, stripHalfWrittenTag } from './htmlSafe'

type ChatCompletionResponse = {
  model?: string
  error?: { code?: number | string; message?: string }
  choices?: Array<{
    finish_reason?: string | null
    message?: {
      content?: string | null
    }
    delta?: {
      content?: string | null
    }
  }>
}

// Why a summary could not be produced, in categories that are safe to show in
// the chat. `detail` is for logs only and may contain provider text.
export type SummaryFailureKind = 'empty' | 'provider'

export class SummaryLlmError extends Error {
  constructor(
    readonly kind: SummaryFailureKind,
    message: string,
    readonly status?: number,
    // Parsed Retry-After of an HTTP failure, if the provider sent one.
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'SummaryLlmError'
  }
}

export const SUMMARY_ATTEMPTS = 3
// Hard ceiling for the escalated completion budget, whatever AI_MAX_TOKENS is.
const MAX_ESCALATED_TOKENS = 16_000
// An attempt is aborted when the upstream goes quiet, not because a slow but
// healthy stream takes long: the idle timer restarts on every byte received,
// including OpenRouter's ": OPENROUTER PROCESSING" keepalive comments. Before
// the first visible text the limit is longer, for providers that reason in
// silence.
const IDLE_TIMEOUT_MS = 60_000
const FIRST_CONTENT_IDLE_FACTOR = 3
// Backstop for a stream that never goes quiet but never finishes either
// (endless keepalives, a trickle of tokens). Slow free models stream ~15-50
// tokens/s, so the cap leaves room for the whole budget at ~20 tokens/s.
const ATTEMPT_TIMEOUT_MS = 300_000
const ATTEMPT_TIMEOUT_MS_PER_TOKEN = 50
// The bot handles updates one at a time, so all attempts together (backoffs
// included) are bounded too; later attempts get only the time that is left.
const SUMMARY_DEADLINE_MS = 600_000
// Not worth starting an attempt with less time than this left.
const MIN_ATTEMPT_MS = 15_000

export function attemptTimeoutMs(maxTokens: number) {
  return Math.max(ATTEMPT_TIMEOUT_MS, maxTokens * ATTEMPT_TIMEOUT_MS_PER_TOKEN)
}

type TimeoutKind = 'idle' | 'deadline'

// Aborts an attempt when its stream has been idle too long or its hard cap is
// reached, and remembers which of the two fired.
class AttemptWatchdog {
  readonly controller = new AbortController()
  fired: TimeoutKind | null = null
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly hardTimer: ReturnType<typeof setTimeout>

  constructor(
    private readonly idleMs: number,
    hardMs: number
  ) {
    this.hardTimer = setTimeout(() => this.fire('deadline'), hardMs)
    this.touch(false)
  }

  get signal() {
    return this.controller.signal
  }

  // Called whenever the upstream shows progress.
  touch(hasContent: boolean) {
    clearTimeout(this.idleTimer)
    if (this.fired) {
      return
    }
    const limit = hasContent ? this.idleMs : this.idleMs * FIRST_CONTENT_IDLE_FACTOR
    this.idleTimer = setTimeout(() => this.fire('idle'), limit)
  }

  dispose() {
    clearTimeout(this.idleTimer)
    clearTimeout(this.hardTimer)
  }

  private fire(kind: TimeoutKind) {
    if (this.fired) {
      return
    }
    this.fired = kind
    this.dispose()
    this.controller.abort(
      new DOMException(`LLM attempt ${kind === 'idle' ? 'went idle' : 'hit its time cap'}`, 'TimeoutError')
    )
  }
}
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529])
// Wait before retrying a provider failure (429/5xx, network, timeout,
// mid-stream error): Retry-After when sent, capped, otherwise a short pause.
// Empty or cut-off answers retry immediately.
const DEFAULT_RETRY_DELAY_MS = 2_000
const MAX_RETRY_DELAY_MS = 5_000
// Appended when a cut-off answer is published because no attempt finished.
export { CUT_OFF_NOTE }

export function retryDelayMs(failure: SummaryLlmError) {
  if (failure.retryAfterMs === undefined) {
    return DEFAULT_RETRY_DELAY_MS
  }
  return Math.min(Math.max(failure.retryAfterMs, 0), MAX_RETRY_DELAY_MS)
}

// Retry-After is either delay-seconds or an HTTP date.
export function parseRetryAfter(value: string | null, now = Date.now()) {
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed) * 1000
  }
  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? undefined : Math.max(date - now, 0)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type StreamOutcome = {
  content: string
  finishReason: string | null
  model: string | null
  error: string | null
  errorStatus: number | undefined
  // The stream stopped because the idle timeout or the attempt's cap fired.
  timedOut: TimeoutKind | null
  malformedChunks: number
}

export function reasoningOptions(
  baseUrl: string = config.LLM_BASE_URL,
  disableReasoning: boolean = config.DISABLE_REASONING
) {
  if (!disableReasoning) {
    return {}
  }

  if (baseUrl.includes('openrouter.ai')) {
    return { reasoning: { effort: 'low', exclude: true } }
  }

  return { chat_template_kwargs: { enable_thinking: false } }
}

type SummaryParams = {
  chatTitle: string
  windowLabel: string
  summaryRequest: string
  messages: StoredMessage[]
  chatMetadata: ChatMetadata
}

type SummaryOptions = {
  // Test hooks; production uses the constants above.
  attemptTimeoutMs?: number
  idleTimeoutMs?: number
  deadlineMs?: number
  sleep?: (ms: number) => Promise<void>
}

// The text of a cut-off answer worth publishing: without a tag the model was
// half-way through, and only if something visible is left after sanitizing.
function publishableCutOff(text: string) {
  const kept = stripHalfWrittenTag(text).trimEnd()
  const visible = normalizeModelTelegramHtml(kept)
    .replace(/<[^>]*>/g, '')
    .trim()
  return visible ? kept : ''
}

export async function summarizeMessages(params: SummaryParams, options: SummaryOptions = {}) {
  let result = ''
  for await (const delta of streamSummaryMessages(params, options)) {
    result += delta
  }
  return result.trim()
}

export async function* streamSummaryMessages(
  params: SummaryParams,
  options: SummaryOptions = {}
) {
  // Reasoning models spend hidden reasoning tokens out of max_tokens, so on a
  // large window they can hit the limit before writing any (or all) visible
  // text (finish_reason "length"). Routers like openrouter/free pick a
  // different model per request, so a retry can also land on a model that
  // answers. Each retry after a cut-off answer doubles the budget; transient
  // provider failures (429/5xx, network, timeout, mid-stream error) retry too.
  const wait = options.sleep ?? sleep
  let maxTokens = config.AI_MAX_TOKENS
  let truncated = ''
  // Set once an attempt reached the model and got an empty, reasoning-only or
  // cut-off answer. That stays the user-facing reason even when a later
  // attempt fails at the provider, since it is the likelier root cause.
  let modelAnsweredUnusably = false
  // A non-retryable HTTP error (401 bad key, 402 no credits...) is the real
  // cause whatever came before, so it is reported as is.
  let stoppedOnFatalError = false
  let lastFailure = new SummaryLlmError('empty', 'LLM returned no visible summary content')
  const attemptReasons: string[] = []
  let backoffMs = 0
  const deadline = Date.now() + (options.deadlineMs ?? SUMMARY_DEADLINE_MS)
  for (let attempt = 1; attempt <= SUMMARY_ATTEMPTS; attempt += 1) {
    if (backoffMs > 0) {
      await wait(backoffMs)
      backoffMs = 0
    }
    const remainingMs = deadline - Date.now()
    if (attempt > 1 && remainingMs < MIN_ATTEMPT_MS) {
      console.warn('LLM summary out of time, not retrying', { attempt, remainingMs })
      break
    }
    const attemptBudget = maxTokens
    let outcome: StreamOutcome
    try {
      outcome = await requestSummaryStream(params, maxTokens, {
        idleMs: options.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
        hardMs: Math.min(options.attemptTimeoutMs ?? attemptTimeoutMs(maxTokens), remainingMs),
      })
    } catch (error) {
      const failure = toSummaryLlmError(error)
      // A 400 right after raising the budget is most likely a context or
      // max-output limit of the routed model: retry at the configured budget.
      const budgetRejected = failure.status === 400 && maxTokens > config.AI_MAX_TOKENS
      const retryable =
        failure.status === undefined || RETRYABLE_STATUSES.has(failure.status) || budgetRejected
      attemptReasons.push(failure.status ? 'http-' + failure.status : 'request-error')
      lastFailure = failure
      if (budgetRejected) {
        maxTokens = config.AI_MAX_TOKENS
      } else if (retryable) {
        backoffMs = retryDelayMs(failure)
      }
      console.warn('LLM summary attempt failed', {
        attempt,
        maxTokens: attemptBudget,
        status: failure.status,
        error: failure.message,
        retrying: retryable && attempt < SUMMARY_ATTEMPTS,
        ...(backoffMs ? { backoffMs } : {}),
      })
      if (!retryable) {
        stoppedOnFatalError = true
        break
      }
      continue
    }

    const candidate = outcome.content
    const readable = Boolean(candidate.trim()) && !looksLikeReasoningLeak(candidate)
    const visible = readable && !outcome.error
    if (visible && outcome.finishReason !== 'length') {
      yield candidate
      return
    }
    // Text cut off by the token limit or the attempt timeout is the start of
    // a real summary and is kept as a (marked) fallback for when no attempt
    // finishes. A fragment that ended in a provider error is dropped, and so is
    // one with nothing visible left once a half-written tag is removed.
    const cutOff = readable && (outcome.timedOut || (visible && outcome.finishReason === 'length'))
    const cutOffText = cutOff ? publishableCutOff(candidate) : ''
    if (cutOffText.length > truncated.length) {
      truncated = cutOffText
    }

    const reason = outcome.timedOut
      ? 'timeout-' + outcome.timedOut
      : outcome.error
        ? 'provider-error'
        : visible
          ? 'truncated'
          : candidate.trim()
            ? 'reasoning-leak'
            : 'empty'
    attemptReasons.push(reason)
    if (outcome.error) {
      lastFailure = new SummaryLlmError(
        'provider',
        'LLM stream error: ' + outcome.error,
        outcome.errorStatus
      )
      backoffMs = retryDelayMs(lastFailure)
      // The model was still working (e.g. reasoning) when the attempt ran out
      // of time: that is an unusable answer, not a provider failure.
      if (outcome.timedOut) {
        modelAnsweredUnusably = true
      }
    } else {
      modelAnsweredUnusably = true
      lastFailure = new SummaryLlmError('empty', 'LLM returned no visible summary content')
    }
    console.warn('LLM returned no usable visible summary content', {
      attempt,
      reason,
      model: outcome.model,
      finishReason: outcome.finishReason,
      maxTokens,
      contentChars: candidate.length,
      malformedChunks: outcome.malformedChunks,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(backoffMs ? { backoffMs } : {}),
    })

    // The attempt used its whole time cap while text was still arriving: the
    // model is just slow, and an identical retry would be cut off the same way
    // (later attempts only get less time). Publish what it wrote instead.
    if (outcome.timedOut === 'deadline' && cutOffText) {
      break
    }

    if (outcome.finishReason === 'length') {
      maxTokens = Math.max(maxTokens, Math.min(maxTokens * 2, MAX_ESCALATED_TOKENS))
    }
  }

  // A cut-off summary beats no summary at all, but say that it is cut off.
  if (truncated) {
    console.warn('LLM summary publishing a cut-off answer', {
      chars: truncated.length,
      attempts: attemptReasons,
    })
    // renderSummaryHtml appends the note after sanitizing the text.
    yield truncated + CUT_OFF_NOTE
    return
  }

  const attempts = attemptReasons.length
  const suffix = ` after ${attempts} attempt${attempts === 1 ? '' : 's'}`
  console.warn('LLM summary failed on every attempt', { attempts: attemptReasons })
  if (modelAnsweredUnusably && !stoppedOnFatalError && lastFailure.kind !== 'empty') {
    throw new SummaryLlmError(
      'empty',
      'LLM returned no visible summary content' + suffix + ' (last: ' + lastFailure.message + ')'
    )
  }
  throw new SummaryLlmError(lastFailure.kind, lastFailure.message + suffix, lastFailure.status)
}

function toSummaryLlmError(error: unknown) {
  if (error instanceof SummaryLlmError) {
    return error
  }
  const message = error instanceof Error ? error.name + ': ' + error.message : String(error)
  return new SummaryLlmError('provider', 'LLM request failed: ' + message)
}

async function requestSummaryStream(
  params: SummaryParams,
  maxTokens: number,
  limits: { idleMs: number; hardMs: number }
): Promise<StreamOutcome> {
  // The watchdog covers the whole attempt, including reading the stream body.
  const watchdog = new AttemptWatchdog(limits.idleMs, limits.hardMs)
  try {
    return await sendSummaryRequest(params, maxTokens, watchdog)
  } finally {
    watchdog.dispose()
  }
}

async function sendSummaryRequest(
  params: SummaryParams,
  maxTokens: number,
  watchdog: AttemptWatchdog
): Promise<StreamOutcome> {
  const response = await fetch(config.LLM_BASE_URL + '/chat/completions', {
    method: 'POST',
    signal: watchdog.signal,
    headers: {
      Authorization: 'Bearer ' + config.LLM_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.LLM_MODEL,
      temperature: config.AI_TEMPERATURE,
      max_tokens: maxTokens,
      ...reasoningOptions(),
      stream: true,
      messages: [
        {
          role: 'system',
          content: [
            'You summarize Telegram group chats.',
            'Before writing, check which human language is most prevalent in the provided message history and use that language for the summary.',
            'Do not assume Russian or any other language from names, chat titles, Telegram UI, or prior context.',
            'If the /summary request contains a plain-language language or style instruction, honor it naturally.',
            'Do not require special command syntax for language selection.',
            'Return Telegram-safe HTML only.',
            'Allowed tags: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">.',
            'Do not use Markdown, headings, tables, images, or unsupported HTML tags.',
            'Be concise, concrete, and useful.',
            'Group related chatter into topics instead of listing messages one by one.',
            'Do not invent facts that are not in the messages.',
            'Avoid quoting private message text unless it is necessary for clarity.',
            'When referencing a specific message, you may include a compact source link using the provided message URLs.',
            'Only include links for the most relevant messages; do not link every message.',
          ].join(' '),
        },
        {
          role: 'user',
          content: buildSummaryPrompt(params),
        },
      ],
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new SummaryLlmError(
      'provider',
      'LLM request failed: ' + response.status + ' ' + body.slice(0, 300),
      response.status,
      parseRetryAfter(response.headers.get('retry-after'))
    )
  }

  if (!response.body) {
    throw new SummaryLlmError('provider', 'LLM response did not contain a stream body')
  }

  watchdog.touch(false)
  return readChatCompletionStream(response.body, watchdog)
}

export function looksLikeReasoningLeak(text: string) {
  const normalized = text.trimStart()
  const planningMarkers = [
    /\banalyze user input\b/i,
    /\bdetermine prevalent language\b/i,
    /\bscan messages for (?:key )?topics\b/i,
    /\boutput format:\s*telegram-safe html only\b/i,
  ]
  return (
    /^(?:here(?:'|\u2019)s|here is)\s+(?:a|my|the)\s+(?:thinking|reasoning|analysis)\s+process\b/i.test(
      normalized
    ) ||
    /^<(?:think|analysis)>/i.test(normalized) ||
    planningMarkers.filter((marker) => marker.test(normalized)).length >= 2
  )
}

function buildSummaryPrompt(params: SummaryParams) {
  const lines = params.messages.map((message) => {
    const timestamp = new Date(message.messageDate * 1000).toISOString()
    const body = message.text.replace(/\s+/g, ' ').trim()
    const link = buildMessageLink(
      params.chatMetadata,
      message.telegramMessageId,
      message.threadId
    )
    const linkPart = link ? ` [url:${link}]` : ''
    return '[' + timestamp + '] ' + message.displayName + ': ' + body + linkPart
  })

  return [
    'Chat: ' + params.chatTitle,
    'Window: ' + params.windowLabel,
    'Summary request: ' + (params.summaryRequest || '(none)'),
    'Language guidance: unless the summary request asks for a specific language or style, infer the summary language from the most prevalent human language in the Messages section below.',
    'Prefer the language used by the majority of substantive message text; ignore usernames, bot names, links, timestamps, command names, and Telegram UI language for this decision.',
    'Do not translate the summary away from that prevalent message language.',
    '',
    'Return Telegram-safe HTML only.',
    'Allowed tags: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">.',
    'Use 3-7 short lines covering the latest topics.',
    'Include decisions or plans when present.',
    'Include open questions or follow-ups only when present.',
    'When referencing a specific message, include a compact link like <a href="URL">ref</a> using only the URLs provided in the prompt.',
    'Do not invent links.',
    '',
    'Messages:',
    lines.join('\n'),
  ].join('\n')
}

// A terminal finish_reason other than a cut-off or an error, with no error
// chunk seen: the model's answer is complete.
function finishedCleanly(outcome: StreamOutcome) {
  return (
    !outcome.error &&
    outcome.finishReason !== null &&
    outcome.finishReason !== 'length' &&
    outcome.finishReason !== 'error'
  )
}

// Reads an OpenAI-compatible SSE stream. Besides the text it keeps the
// finish_reason and model (for logs and the retry budget) and a mid-stream
// error: OpenRouter reports failures after the 200 status as a chunk with an
// `error` field and finish_reason "error". A malformed line is counted and
// skipped instead of failing the whole summary.
export async function readChatCompletionStream(
  body: ReadableStream<Uint8Array>,
  // The attempt's watchdog (its only abort source): told about every read so
  // its idle timer restarts while the stream makes progress.
  watchdog?: Pick<AttemptWatchdog, 'touch' | 'fired'>
): Promise<StreamOutcome> {
  const outcome: StreamOutcome = {
    content: '',
    finishReason: null,
    model: null,
    error: null,
    errorStatus: undefined,
    timedOut: null,
    malformedChunks: 0,
  }
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''

  // Returns true on the [DONE] sentinel.
  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) {
      return false
    }

    const payload = trimmed.slice('data:'.length).trim()
    if (!payload) {
      return false
    }
    if (payload === '[DONE]') {
      return true
    }

    let data: ChatCompletionResponse
    try {
      data = JSON.parse(payload) as ChatCompletionResponse
    } catch {
      outcome.malformedChunks += 1
      return false
    }
    // Valid JSON that is not an object (`null`, a number, a string) is just
    // as unusable as a broken line.
    if (!data || typeof data !== 'object') {
      outcome.malformedChunks += 1
      return false
    }

    outcome.model ??= typeof data.model === 'string' ? data.model : null
    if (data.error) {
      outcome.error =
        String(data.error.code ?? 'error') + ' ' + String(data.error.message ?? '').slice(0, 300)
      const status = Number(data.error.code)
      outcome.errorStatus = Number.isInteger(status) && status >= 100 ? status : undefined
    }
    const choice = data.choices?.[0]
    if (choice?.finish_reason) {
      outcome.finishReason = choice.finish_reason
      if (choice.finish_reason === 'error') {
        outcome.error ??= 'finish_reason error'
      }
    }
    const content = choice?.delta?.content ?? choice?.message?.content
    if (content) {
      outcome.content += content
    }
    return false
  }

  try {
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (error) {
        // The model already finished (e.g. "stop") and only the [DONE]
        // sentinel was missing: the answer is complete, whatever happened to
        // the connection afterwards.
        if (finishedCleanly(outcome)) {
          return outcome
        }
        // Timeout or connection reset mid-stream: keep what arrived so far.
        // Text that was still streaming cleanly when the timeout fired is a
        // cut-off answer, not a provider failure.
        outcome.timedOut = outcome.error ? null : (watchdog?.fired ?? null)
        outcome.error =
          'stream read failed: ' +
          (error instanceof Error ? error.name + ': ' + error.message : String(error))
        return outcome
      }
      const { done, value } = chunk
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (handleLine(line)) {
          return outcome
        }
      }
      // Any bytes count as progress, keepalive comments included; the cap
      // still bounds a stream that never finishes.
      watchdog?.touch(Boolean(outcome.content))
    }

    buffer += decoder.decode()
    handleLine(buffer)
    return outcome
  } finally {
    // Also drops the connection when [DONE] arrived before the body closed.
    await reader.cancel().catch(() => undefined)
  }
}
