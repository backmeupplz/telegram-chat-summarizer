const ALLOWED_TAGS = new Set([
  'b',
  'i',
  'u',
  's',
  'code',
  'pre',
  'a',
  'br',
  'p',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'strike',
  'del',
  'ins',
])

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr'])

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

    if (VOID_TAGS.has(tagName)) {
      result.push(`<${tagName} />`)
    } else {
      result.push(`<${tagName}>`)
      tagStack.push(tagName)
    }
    i = gt + 1
  }

  while (tagStack.length > 0) {
    const tag = tagStack.pop()!
    result.push(`</${tag}>`)
  }

  return result.join('')
}

export function fitTelegramHtml(text: string, limit = TELEGRAM_TEXT_LIMIT): string {
  if (text.length <= limit) {
    return text
  }
  return text.slice(0, limit - 20).trimEnd() + '\n\n[truncated]'
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
  return href.startsWith('https://t.me/') && !href.includes('\n') && !href.includes('\r')
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
