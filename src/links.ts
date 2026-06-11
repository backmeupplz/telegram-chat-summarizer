export type ChatMetadata = {
  chatId: number
  type: string
  username: string | null
}

export function buildMessageLink(
  meta: ChatMetadata,
  telegramMessageId: number,
  threadId?: number | null
): string | null {
  if (meta.type !== 'group' && meta.type !== 'supergroup' && meta.type !== 'channel') {
    return null
  }

  // Forum topic messages need the topic thread id as a path segment, otherwise
  // Telegram cannot resolve the message and the link looks broken.
  const messagePath =
    threadId && threadId !== telegramMessageId
      ? `${threadId}/${telegramMessageId}`
      : `${telegramMessageId}`

  if (meta.username) {
    return `https://t.me/${meta.username}/${messagePath}`
  }

  if (meta.type === 'channel' || meta.type === 'supergroup') {
    const internalId = internalChatId(meta.chatId)
    if (internalId !== null) {
      return `https://t.me/c/${internalId}/${messagePath}`
    }
  }

  return null
}

export function internalChatId(chatId: number): number | null {
  if (chatId < 0) {
    const withoutPrefix = -chatId
    if (withoutPrefix >= 1000000000000) {
      return withoutPrefix - 1000000000000
    }
  }
  return null
}
