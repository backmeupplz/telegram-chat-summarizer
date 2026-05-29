import { config } from './config'
import type { StoredMessage } from './db'

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null
    }
  }>
}

export async function summarizeMessages(params: {
  chatTitle: string
  windowLabel: string
  messages: StoredMessage[]
}) {
  const response = await fetch(`${config.FIREWORKS_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.FIREWORKS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.FIREWORKS_MODEL,
      temperature: config.AI_TEMPERATURE,
      max_tokens: config.AI_MAX_TOKENS,
      messages: [
        {
          role: 'system',
          content: [
            'You summarize Telegram group chats.',
            'Write in the main language used by the chat messages.',
            'Be concise, concrete, and useful.',
            'Group related chatter into topics instead of listing messages one by one.',
            'Do not invent facts that are not in the messages.',
            'Avoid quoting private message text unless it is necessary for clarity.',
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
      `Fireworks request failed: ${response.status} ${body.slice(0, 300)}`
    )
  }

  const data = (await response.json()) as ChatCompletionResponse
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) {
    throw new Error('Fireworks response did not contain message content')
  }

  return content
}

function buildSummaryPrompt(params: {
  chatTitle: string
  windowLabel: string
  messages: StoredMessage[]
}) {
  const lines = params.messages.map((message) => {
    const timestamp = new Date(message.messageDate * 1000).toISOString()
    const body = message.text.replace(/\s+/g, ' ').trim()
    return `[${timestamp}] ${message.displayName}: ${body}`
  })

  return [
    `Chat: ${params.chatTitle}`,
    `Window: ${params.windowLabel}`,
    '',
    'Return:',
    '- 3-7 bullets with the latest topics',
    '- any decisions or plans',
    '- open questions or follow-ups, only if present',
    '',
    'Messages:',
    lines.join('\n'),
  ].join('\n')
}
