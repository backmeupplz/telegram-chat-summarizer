import { Bot, type Context } from 'grammy'
import { config } from './config'
import { addMessage, ensureChat, recentMessages } from './db'
import { summarizeMessages } from './ai'
import { resolveSummaryWindow } from './summaryArgs'

const helpText = [
  'I store group messages and summarize recent topics on demand.',
  '',
  'Commands:',
  '/summary - summarize the latest messages',
  '/summary 24h - summarize messages from the last 24 hours',
  '/summary 7d - summarize messages from the last 7 days',
  '/summary 100 - summarize the latest 100 messages',
  '',
  'BotFather privacy mode must be disabled so I can see normal group messages.',
].join('\n')

const runningSummaries = new Set<number>()

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

async function sendSummary(ctx: Context) {
  if (!ctx.chat) {
    return
  }

  if (runningSummaries.has(ctx.chat.id)) {
    await ctx.reply('A summary is already running for this group.')
    return
  }

  runningSummaries.add(ctx.chat.id)
  try {
    const window = resolveSummaryWindow(String(ctx.match ?? ''), Math.floor(Date.now() / 1000), {
      defaultMessages: config.SUMMARY_DEFAULT_MESSAGES,
      maxMessages: config.SUMMARY_MAX_MESSAGES,
    })
    const messages = recentMessages({
      chatId: ctx.chat.id,
      limit: window.limit,
      sinceUnixSeconds: window.sinceUnixSeconds,
    }).filter((message) => !message.text.startsWith('/summary'))

    if (messages.length < 3) {
      await ctx.reply(
        'I do not have enough stored group messages for a useful summary yet. Make sure BotFather privacy mode is disabled.'
      )
      return
    }

    await ctx.reply('Summarizing...')
    const summary = await summarizeMessages({
      chatTitle: chatTitle(ctx),
      windowLabel: window.label,
      messages,
    })
    await replyInChunks(ctx, summary)
  } catch (error) {
    console.error('summary failed', {
      chatId: ctx.chat.id,
      error: error instanceof Error ? error.message : String(error),
    })
    await ctx.reply('Summary failed. Check the bot logs for the Fireworks or Telegram error.')
  } finally {
    runningSummaries.delete(ctx.chat.id)
  }
}

function registerChat(ctx: Context) {
  if (!ctx.chat) {
    return
  }
  ensureChat(ctx.chat.id, chatTitle(ctx), ctx.chat.type)
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
  return kind === 'unknown' ? null : { kind, text: `[${kind}]` }
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

async function replyInChunks(ctx: Context, text: string) {
  const maxLength = 3900
  for (let offset = 0; offset < text.length; offset += maxLength) {
    await ctx.reply(text.slice(offset, offset + maxLength))
  }
}
