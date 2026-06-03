import { Bot, type Context } from 'grammy'
import { config } from './config'
import { addMessage, ensureChat, getChatInfo, recentMessages } from './db'
import { streamSummaryMessages } from './ai'
import { resolveSummaryWindow } from './summaryArgs'
import { sanitizeTelegramHtml, fitTelegramHtml } from './htmlSafe'
import { buildMessageLink, type ChatMetadata } from './links'

export const botCommands = [
  { command: 'start', description: 'Show how the summarizer works' },
  { command: 'help', description: 'Show usage examples' },
  { command: 'summary', description: 'Summarize the last 24 hours by default' },
]

const helpText = [
  'I store group messages and summarize recent topics on demand.',
  '',
  'Commands:',
  '/summary - summarize messages from the last 24 hours',
  '/summary 24h - summarize messages from the last 24 hours',
  '/summary 7d - summarize messages from the last 7 days',
  '/summary 100 - summarize the latest 100 messages',
  '',
  'I need permission to read normal group messages so I can build useful summaries.',
].join('\n')

const runningSummaries = new Set<number>()
const SUMMARY_EDIT_INTERVAL_MS = 1200
const SUMMARY_MIN_FIRST_EDIT_CHARS = 40
const TELEGRAM_TEXT_LIMIT = 3900
const TELEGRAM_HTML_LIMIT = 4096

export function createBot() {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN)

  bot.command('start', async (ctx) => {
    if (isGroup(ctx)) {
      registerChat(ctx)
    }
    await ctx.reply(helpText)
  })

  bot.command('help', async (ctx) => {
    if (isGroup(ctx)) {
      registerChat(ctx)
    }
    await ctx.reply(helpText)
  })

  bot.command('summary', async (ctx) => {
    if (!isGroup(ctx)) {
      await ctx.reply('Add me to a group first, then run /summary there.')
      return
    }

    registerChat(ctx)
    await sendSummary(ctx)
  })

  bot.on('message:new_chat_members', async (ctx) => {
    if (!ctx.chat || !isGroup(ctx)) {
      return
    }

    registerChat(ctx)
    const me = await bot.api.getMe()
    const addedMe = ctx.message.new_chat_members.some((member) => member.id === me.id)
    if (addedMe) {
      await ctx.reply(helpText)
    }
  })

  bot.on('message', async (ctx) => {
    if (!isGroup(ctx) || !ctx.chat || !ctx.message || ctx.from?.is_bot) {
      return
    }

    const content = messageContent(ctx)
    if (!content) {
      return
    }

    registerChat(ctx)
    addMessage({
      chatId: ctx.chat.id,
      telegramMessageId: ctx.message.message_id,
      userId: ctx.from?.id ?? null,
      username: ctx.from?.username,
      displayName: ctx.from ? formatDisplayName(ctx.from) : 'Unknown',
      kind: content.kind,
      text: content.text,
      messageDate: ctx.message.date,
    })
  })

  return bot
}

export async function setBotCommandMenu(bot: Pick<Bot, 'api'>) {
  await bot.api.setMyCommands(botCommands)
}

async function sendSummary(ctx: Context) {
  if (!ctx.chat) {
    return
  }

  if (runningSummaries.has(ctx.chat.id)) {
    await ctx.reply('A summary is already running for this group.')
    return
  }

  runningSummaries.add(ctx.chat.id)
  let placeholderMessageId: number | null = null
  try {
    const placeholder = await ctx.reply('Summarizing...', {
      reply_parameters: ctx.message
        ? { message_id: ctx.message.message_id }
        : undefined,
    })
    placeholderMessageId = placeholder.message_id

    const summaryRequest = String(ctx.match ?? '').trim()
    const window = resolveSummaryWindow(summaryRequest, Math.floor(Date.now() / 1000), {
      defaultMessages: config.SUMMARY_DEFAULT_MESSAGES,
      maxMessages: config.SUMMARY_MAX_MESSAGES,
    })
    const messages = recentMessages({
      chatId: ctx.chat.id,
      limit: window.limit,
      sinceUnixSeconds: window.sinceUnixSeconds,
    }).filter((message) => !message.text.startsWith('/summary'))

    if (messages.length < 1) {
      await editSummaryMessagePlain(
        ctx,
        placeholder.message_id,
        'I do not have any stored group messages to summarize yet. Make sure I can read normal group messages.'
      )
      return
    }

    const chatMeta = chatMetadata(ctx)

    let accumulated = ''
    let lastEditAt = 0
    for await (const delta of streamSummaryMessages({
      chatTitle: chatTitle(ctx),
      windowLabel: window.label,
      summaryRequest,
      messages,
      chatMetadata: chatMeta,
    })) {
      accumulated += delta
      if (accumulated.length < SUMMARY_MIN_FIRST_EDIT_CHARS) {
        continue
      }

      const now = Date.now()
      if (now - lastEditAt >= SUMMARY_EDIT_INTERVAL_MS) {
        lastEditAt = now
        await editSummaryMessagePlain(ctx, placeholder.message_id, accumulated + ' ...')
      }
    }

    const finalText = accumulated.trim() || 'Kimi returned an empty summary.'
    await sendFinalSummary(ctx, placeholder.message_id, finalText)
  } catch (error) {
    console.error('summary failed', {
      chatId: ctx.chat.id,
      error: error instanceof Error ? error.message : String(error),
    })
    const message = 'Summary failed. Check the bot logs for the Fireworks or Telegram error.'
    if (placeholderMessageId) {
      await editSummaryMessagePlain(ctx, placeholderMessageId, message)
    } else {
      await ctx.reply(message)
    }
  } finally {
    runningSummaries.delete(ctx.chat.id)
  }
}

function registerChat(ctx: Context) {
  if (!ctx.chat) {
    return
  }
  const username = 'username' in ctx.chat && ctx.chat.username ? ctx.chat.username : null
  ensureChat(ctx.chat.id, chatTitle(ctx), ctx.chat.type, username)
}

function chatMetadata(ctx: Context): ChatMetadata {
  const chat = ctx.chat!
  const username = 'username' in chat && chat.username ? chat.username : null
  return {
    chatId: chat.id,
    type: chat.type,
    username: username,
  }
}

function isGroup(ctx: Context) {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup'
}

function chatTitle(ctx: Context) {
  return 'title' in ctx.chat! && ctx.chat.title ? ctx.chat.title : String(ctx.chat!.id)
}

function messageContent(ctx: Context): { kind: string; text: string } | null {
  const message = ctx.message
  if (!message) {
    return null
  }

  if ('text' in message && message.text) {
    return { kind: 'text', text: message.text.trim() }
  }
  if ('caption' in message && message.caption) {
    return { kind: mediaKind(message), text: message.caption.trim() }
  }

  const kind = mediaKind(message)
  return kind === 'unknown' ? null : { kind, text: '[' + kind + ']' }
}

function mediaKind(message: NonNullable<Context['message']>) {
  if ('photo' in message) return 'photo'
  if ('video' in message) return 'video'
  if ('animation' in message) return 'animation'
  if ('audio' in message) return 'audio'
  if ('voice' in message) return 'voice'
  if ('video_note' in message) return 'video_note'
  if ('sticker' in message) return 'sticker'
  if ('document' in message) return 'document'
  if ('poll' in message) return 'poll'
  if ('location' in message) return 'location'
  return 'unknown'
}

function formatDisplayName(user: NonNullable<Context['from']>) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id)
}

async function sendFinalSummary(ctx: Context, messageId: number, text: string) {
  if (!ctx.chat) {
    return
  }

  const safeHtml = sanitizeTelegramHtml(text)
  const fitted = fitTelegramHtml(safeHtml, TELEGRAM_HTML_LIMIT)

  try {
    await ctx.api.editMessageText(ctx.chat.id, messageId, fitted, {
      parse_mode: 'HTML',
    })
  } catch (htmlError) {
    console.error('HTML edit failed, falling back to plain text', {
      chatId: ctx.chat.id,
      error: htmlError instanceof Error ? htmlError.message : String(htmlError),
    })
    const plain = toPlainTelegramText(text)
    const plainFitted = fitTelegramText(plain, TELEGRAM_TEXT_LIMIT)
    await ctx.api.editMessageText(ctx.chat.id, messageId, plainFitted).catch(() => undefined)
  }
}

async function editSummaryMessagePlain(ctx: Context, messageId: number, text: string) {
  if (!ctx.chat) {
    return
  }

  await ctx.api
    .editMessageText(ctx.chat.id, messageId, fitTelegramText(toPlainTelegramText(text)))
    .catch(() => undefined)
}

function fitTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT) {
  if (text.length <= limit) {
    return text
  }
  return text.slice(0, limit - 20).trimEnd() + '\n\n[truncated]'
}

function toPlainTelegramText(text: string) {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*(\s|$)/g, '$1$2$3')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/^\s{0,3}[-*+]\s+/, '')
    )
    .join('\n')
    .trim()
}
