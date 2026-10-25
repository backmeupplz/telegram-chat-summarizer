import { closeDb } from './db'
import { createBot, setBotCommandMenu } from './bot'
import { startWithHandover } from './handover'

const bot = createBot()
const me = await bot.api.getMe()
await setBotCommandMenu(bot)

await startWithHandover(
  bot,
  {
    allowed_updates: ['message', 'my_chat_member'],
    onStart: () => console.log(`Starting Telegram chat summarizer bot as @${me.username ?? me.id}`),
  },
  () => {
    console.log('Stopping Telegram chat summarizer bot')
    closeDb()
  }
)
