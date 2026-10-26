import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'bun:test'

test('recentMessages only returns messages from the requested topic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chad-summary-threads-'))
  try {
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/db.ts')).href
    const script = `
      process.env.TELEGRAM_BOT_TOKEN = 'test-token'
      process.env.LLM_API_KEY = 'test-key'
      process.env.LLM_BASE_URL = 'https://example.com/v1'
      process.env.LLM_MODEL = 'test-model'
      process.env.DATABASE_PATH = ${JSON.stringify(join(dir, 'db.sqlite'))}
      const db = await import(${JSON.stringify(moduleUrl)})
      db.ensureChat(-100123, 'Forum', 'supergroup', null)
      const add = (id, threadId) => db.addMessage({ chatId: -100123, telegramMessageId: id, userId: 1, displayName: 'A', kind: 'text', text: 'm' + id, messageDate: 1, threadId })
      add(1, null); add(2, 10); add(3, 20); add(4, 10); add(5, null)
      const ids = (threadId) => db.recentMessages({ chatId: -100123, threadId, limit: 100 }).map((m) => m.telegramMessageId).join(',')
      console.log(JSON.stringify([ids(null), ids(10), ids(20), ids(30)]))
      db.closeDb()
    `
    const result = Bun.spawnSync({ cmd: ['bun', '--eval', script], stdout: 'pipe', stderr: 'pipe' })
    expect(new TextDecoder().decode(result.stderr)).toBe('')
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual(['1,5', '2,4', '3', ''])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
