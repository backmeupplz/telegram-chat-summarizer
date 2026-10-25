import type { Update } from 'grammy/types'
import { closeDb } from './db'
import { createBot, setBotCommandMenu } from './bot'
import { pollWithHandover } from './handover'

const bot = createBot()
const me = await bot.api.getMe()
await setBotCommandMenu(bot)

// The newest update fetched: bot.stop() only confirms up to the update being
// handled, so stopping confirms the rest of the batch for the next poller
let fetched = 0
bot.api.config.use(async (prev, method, payload, signal) => {
  const response = await prev(method, payload, signal)
  if (method === 'getUpdates' && response.ok) {
    for (const update of response.result as Update[]) {
      fetched = Math.max(fetched, update.update_id)
    }
  }
  return response
})

let polling: Promise<void> | undefined
await pollWithHandover(
  () => {
    console.log(`Starting Telegram chat summarizer bot as @${me.username ?? me.id}`)
    polling = bot.start({
      allowed_updates: ['message', 'my_chat_member'],
    })
  },
  async () => {
    console.log('Stopping Telegram chat summarizer bot')
    await bot.stop()
    await bot.api.getUpdates({ offset: fetched + 1, limit: 1, timeout: 0 })
  },
  async () => {
    // The batch fetched last finishes before the database closes
    await polling
    closeDb()
  }
)
