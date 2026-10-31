const ALLOWED_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'code',
  'pre',
  'a',
])

const TELEGRAM_TEXT_LIMIT = 4096

export function sanitizeTelegramHtml(input: string): string {
  const result: string[] = []
  let i = 0
  const len = input.length
  const tagStack: string[] = []

  while (i < len) {
    const lt = input.indexOf('<', i)
    if (lt === -1) {
      result.push(escapeHtmlEntities(input.slice(i)))
      break
    }

    result.push(escapeHtmlEntities(input.slice(i, lt)))
    const gt = input.indexOf('>', lt + 1)
    if (gt === -1) {
      result.push(escapeHtmlEntities(input.slice(lt)))
      break
    }

    const rawTag = input.slice(lt + 1, gt)
    const tagInfo = parseTag(rawTag)

    if (!tagInfo) {
      result.push(escapeHtmlEntities(input.slice(lt, gt + 1)))
      i = gt + 1
      continue
    }

    const tagName = tagInfo.name
    if (!ALLOWED_TAGS.has(tagName)) {
      i = gt + 1
      continue
    }

    if (tagInfo.closing) {
      if (tagStack.length > 0 && tagStack[tagStack.length - 1] === tagName) {
        tagStack.pop()
        result.push(`</${tagName}>`)
      }
      i = gt + 1
      continue
    }

    if (tagName === 'a') {
      const href = tagInfo.attrs.get('href')
      if (!href || !isSafeHref(href)) {
        i = gt + 1
        continue
      }
      const safeHref = escapeHtmlAttribute(href)
      result.push(`<a href="${safeHref}">`)
      tagStack.push(tagName)
      i = gt + 1
      continue
    }

    result.push(`<${tagName}>`)
    tagStack.push(tagName)
    i = gt + 1
  }

  while (tagStack.length > 0) {
    const tag = tagStack.pop()!
    result.push(`</${tag}>`)
  }

  return result.join('')
}

export function normalizeModelTelegramHtml(input: string): string {
  const normalized = input
    .replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '<a href="$2">$1</a>')

  return sanitizeTelegramHtml(normalized)
}

// Marks a summary that was cut off by the token limit or the attempt timeout.
export const CUT_OFF_NOTE = '\n\n<i>(summary cut off)</i>'

// Tags a model may start: the allowed ones plus common HTML the sanitizer drops.
const KNOWN_TAGS = [
  ...ALLOWED_TAGS,
  'br', 'p', 'li', 'ul', 'ol', 'span', 'blockquote', 'tg-spoiler',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]

// Drops a tag the model was cut off half-way through (`<cod`, `</a`, `<li`,
// `<a href="https://t.me/x`, `<a href="…"`), but keeps prose such as
// `a<b then c` or `<3`.
export function stripHalfWrittenTag(text: string): string {
  const match = text.match(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*|)(\s[^<>]*)?$/)
  if (!match) {
    return text
  }
  const name = match[2].toLowerCase()
  const attrs = match[3]
  const halfTag = attrs === undefined
    ? KNOWN_TAGS.some((tag) => tag.startsWith(name))
    : KNOWN_TAGS.includes(name) && !match[1] &&
      /^(?:\s+[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(?:[a-z-]+(?:\s*=\s*(?:"[^"]*|'[^']*)?)?)?$/i.test(attrs)
  return halfTag ? text.slice(0, match.index) : text
}

// Renders model output as Telegram HTML. A trailing cut-off note is split off
// and appended after sanitizing, so it never ends up inside a tag the cut-off
// text left open (bold, or an entity nested in <code>/<pre>).
export function renderSummaryHtml(text: string): string {
  const note = CUT_OFF_NOTE.trim()
  if (!text.endsWith(note)) {
    return normalizeModelTelegramHtml(text)
  }
  const body = normalizeModelTelegramHtml(text.slice(0, -note.length).trimEnd())
  return body ? body + '\n\n' + note : note
}

export function fitTelegramHtml(text: string, limit = TELEGRAM_TEXT_LIMIT): string {
  if (text.length <= limit) {
    return text
  }
  const suffix = '\n\n[truncated]'
  const plain = htmlToPlainText(text).slice(0, limit - suffix.length).trimEnd() + suffix
  return escapeHtmlEntities(plain)
}

function parseTag(raw: string): { name: string; closing: boolean; attrs: Map<string, string> } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const closing = trimmed.startsWith('/')
  const withoutSlash = closing ? trimmed.slice(1) : trimmed

  const firstSpace = withoutSlash.search(/\s/)
  const name = (firstSpace === -1 ? withoutSlash : withoutSlash.slice(0, firstSpace)).toLowerCase()

  if (!/^[a-z][a-z0-9]*$/.test(name)) {
    return null
  }

  const attrs = new Map<string, string>()
  if (!closing && firstSpace !== -1) {
    const attrString = withoutSlash.slice(firstSpace)
    const attrRegex = /([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
    let m: RegExpExecArray | null
    while ((m = attrRegex.exec(attrString)) !== null) {
      const key = m[1].toLowerCase()
      const value = m[2] !== undefined ? m[2] : m[3]
      attrs.set(key, value)
    }
  }

  return { name, closing, attrs }
}

function isSafeHref(href: string): boolean {
  return /^https:\/\/t\.me\/(?:c\/\d+|[A-Za-z0-9_]{5,32})\/\d+$/.test(href)
}

function escapeHtmlEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
