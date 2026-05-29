import { closeDb } from './db'
import { createBot } from './bot'

const bot = createBot()
const me = await bot.api.getMe()

console.log(`Starting Telegram chat summarizer bot as @${me.username ?? me.id}`)

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

await bot.start({
  allowed_updates: ['message', 'my_chat_member'],
})

async function shutdown() {
  console.log('Stopping Telegram chat summarizer bot')
  await bot.stop()
  closeDb()
  process.exit(0)
}
