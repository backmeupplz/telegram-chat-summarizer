import { config } from './config'
import type { StoredMessage } from './db'
import type { ChatMetadata } from './links'
import { buildMessageLink } from './links'

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null
    }
    delta?: {
      content?: string | null
    }
  }>
}

export async function summarizeMessages(params: {
  chatTitle: string
  windowLabel: string
  summaryRequest: string
  messages: StoredMessage[]
  chatMetadata: ChatMetadata
}) {
  let result = ''
  for await (const delta of streamSummaryMessages(params)) {
    result += delta
  }
  return result.trim()
}

export async function* streamSummaryMessages(params: {
  chatTitle: string
  windowLabel: string
  summaryRequest: string
  messages: StoredMessage[]
  chatMetadata: ChatMetadata
}) {
  const response = await fetch(config.FIREWORKS_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.FIREWORKS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.FIREWORKS_MODEL,
      temperature: config.AI_TEMPERATURE,
      max_tokens: config.AI_MAX_TOKENS,
      reasoning_effort: config.AI_REASONING_EFFORT,
      stream: true,
      messages: [
        {
          role: 'system',
          content: [
            'You summarize Telegram group chats.',
            'By default, write in the main language used by the chat messages.',
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
    const body = await response.text()
    throw new Error(
      'Fireworks request failed: ' + response.status + ' ' + body.slice(0, 300)
    )
  }

  if (!response.body) {
    throw new Error('Fireworks response did not contain a stream body')
  }

  yield* parseChatCompletionStream(response.body)
}

function buildSummaryPrompt(params: {
  chatTitle: string
  windowLabel: string
  summaryRequest: string
  messages: StoredMessage[]
  chatMetadata: ChatMetadata
}) {
  const lines = params.messages.map((message) => {
    const timestamp = new Date(message.messageDate * 1000).toISOString()
    const body = message.text.replace(/\s+/g, ' ').trim()
    const link = buildMessageLink(params.chatMetadata, message.telegramMessageId)
    const linkPart = link ? ` [url:${link}]` : ''
    return '[' + timestamp + '] ' + message.displayName + ': ' + body + linkPart
  })

  return [
    'Chat: ' + params.chatTitle,
    'Window: ' + params.windowLabel,
    'Summary request: ' + (params.summaryRequest || '(none)'),
    'Language: use the language people are using in the chat unless the summary request plainly asks for another language.',
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

async function* parseChatCompletionStream(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data:')) {
        continue
      }

      const payload = trimmed.slice('data:'.length).trim()
      if (payload === '[DONE]') {
        return
      }

      const data = JSON.parse(payload) as ChatCompletionResponse
      const content =
        data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content
      if (content) {
        yield content
      }
    }
  }

  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const payload = tail.slice('data:'.length).trim()
    if (payload && payload !== '[DONE]') {
      const data = JSON.parse(payload) as ChatCompletionResponse
      const content =
        data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content
      if (content) {
        yield content
      }
    }
  }
}
