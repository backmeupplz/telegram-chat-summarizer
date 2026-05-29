import { Database } from 'bun:sqlite'
import { config } from './config'

export type StoredMessage = {
  telegramMessageId: number
  userId: number | null
  username: string | null
  displayName: string
  kind: string
  text: string
  messageDate: number
}

const db = new Database(config.DATABASE_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    chat_id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
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

  CREATE INDEX IF NOT EXISTS messages_chat_id_date_idx ON messages(chat_id, message_date);
  CREATE INDEX IF NOT EXISTS messages_chat_id_id_idx ON messages(chat_id, id);
`)

export function ensureChat(chatId: number, title: string, type: string) {
  db.query(
    `INSERT INTO chats (chat_id, title, type)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       title = excluded.title,
       type = excluded.type,
       updated_at = CURRENT_TIMESTAMP`
  ).run(chatId, title || String(chatId), type)
}

export function addMessage(params: {
  chatId: number
  telegramMessageId: number
  userId: number | null
  username?: string
  displayName: string
  kind: string
  text: string
  messageDate: number
}) {
  db.query(
    `INSERT OR IGNORE INTO messages
       (chat_id, telegram_message_id, user_id, username, display_name, kind, text, message_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.chatId,
    params.telegramMessageId,
    params.userId,
    params.username ?? null,
    params.displayName,
    params.kind,
    params.text,
    params.messageDate
  )
}

export function recentMessages(params: {
  chatId: number
  limit: number
  sinceUnixSeconds?: number
}): StoredMessage[] {
  const rows = db
    .query(
      `SELECT telegram_message_id AS telegramMessageId,
              user_id AS userId,
              username,
              display_name AS displayName,
              kind,
              text,
              message_date AS messageDate
       FROM messages
       WHERE chat_id = ?
         AND (? IS NULL OR message_date >= ?)
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(
      params.chatId,
      params.sinceUnixSeconds ?? null,
      params.sinceUnixSeconds ?? null,
      params.limit
    ) as StoredMessage[]

  return rows.reverse()
}

export function closeDb() {
  db.close()
}
