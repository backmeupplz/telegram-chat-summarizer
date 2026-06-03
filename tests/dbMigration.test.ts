import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'bun:test'

describe('database migrations', () => {
  test('adds chat username column to existing databases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chad-summary-db-'))
    const dbPath = join(dir, 'chat-summaries.sqlite')

    try {
      const legacyDb = new Database(dbPath)
      legacyDb.exec(`
        CREATE TABLE chats (
          chat_id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          type TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id INTEGER NOT NULL,
          telegram_message_id INTEGER NOT NULL,
          user_id INTEGER,
          username TEXT,
          display_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          message_date INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (chat_id, telegram_message_id),
          FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
        );
      `)
      legacyDb.close()

      const moduleUrl = pathToFileURL(join(process.cwd(), 'src/db.ts')).href
      const script = `
        process.env.TELEGRAM_BOT_TOKEN = 'test-token'
        process.env.FIREWORKS_API_KEY = 'test-key'
        process.env.DATABASE_PATH = ${JSON.stringify(dbPath)}
        const dbModule = await import(${JSON.stringify(moduleUrl)})
        dbModule.ensureChat(-1001234567890, 'Test Chat', 'supergroup', 'testchat')
        const info = dbModule.getChatInfo(-1001234567890)
        if (!info || info.username !== 'testchat') {
          throw new Error('migration did not preserve chat username')
        }
        dbModule.closeDb()
      `
      const result = Bun.spawnSync({
        cmd: ['bun', '--eval', script],
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(result.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.stderr)).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
