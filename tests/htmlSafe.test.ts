import { describe, expect, test } from 'bun:test'
import { sanitizeTelegramHtml, fitTelegramHtml } from '../src/htmlSafe'

describe('sanitizeTelegramHtml', () => {
  test('allows safe tags', () => {
    const input = '<b>bold</b> <i>italic</i> <u>underline</u> <s>strike</s>'
    expect(sanitizeTelegramHtml(input)).toBe(input)
  })

  test('allows code and pre', () => {
    const input = '<code>inline</code> <pre>block</pre>'
    expect(sanitizeTelegramHtml(input)).toBe(input)
  })

  test('allows safe a href to t.me', () => {
    const input = '<a href="https://t.me/mygroup/42">ref</a>'
    expect(sanitizeTelegramHtml(input)).toBe(input)
  })

  test('strips unsupported tags but keeps text', () => {
    const input = '<div>hello</div> <script>alert(1)</script>'
    expect(sanitizeTelegramHtml(input)).toBe('hello alert(1)')
  })

  test('strips tags that Telegram HTML does not support', () => {
    const input = '<p>Topic</p><ul><li>one</li></ul><br>done'
    expect(sanitizeTelegramHtml(input)).toBe('Topiconedone')
  })

  test('strips a with unsafe href but keeps text', () => {
    const input = '<a href="https://evil.com">bad</a> safe'
    expect(sanitizeTelegramHtml(input)).toBe('bad safe')
  })

  test('strips a with javascript href but keeps text', () => {
    const input = '<a href="javascript:alert(1)">bad</a>'
    expect(sanitizeTelegramHtml(input)).toBe('bad')
  })

  test('escapes unclosed tags', () => {
    const input = 'hello <b>world'
    expect(sanitizeTelegramHtml(input)).toBe('hello <b>world</b>')
  })

  test('escapes raw angle brackets', () => {
    const input = '5 < 10 && 10 > 5'
    expect(sanitizeTelegramHtml(input)).toBe('5 &lt; 10 &amp;&amp; 10 &gt; 5')
  })

  test('closes mismatched tags', () => {
    const input = '<b><i>text</b>'
    expect(sanitizeTelegramHtml(input)).toBe('<b><i>text</i></b>')
  })

  test('handles nested same tags', () => {
    const input = '<b>outer <b>inner</b> outer</b>'
    expect(sanitizeTelegramHtml(input)).toBe('<b>outer <b>inner</b> outer</b>')
  })

  test('escapes text inside allowed tags', () => {
    const input = '<b>hello & goodbye</b>'
    expect(sanitizeTelegramHtml(input)).toBe('<b>hello &amp; goodbye</b>')
  })

  test('strips unsupported attributes', () => {
    const input = '<b onclick="evil()">text</b>'
    expect(sanitizeTelegramHtml(input)).toBe('<b>text</b>')
  })

  test('strips unsupported a attributes', () => {
    const input = '<a href="https://t.me/mygroup/1" target="_blank">link</a>'
    expect(sanitizeTelegramHtml(input)).toBe('<a href="https://t.me/mygroup/1">link</a>')
  })

  test('strips malformed t.me message links', () => {
    const input = '<a href="https://t.me/+invite/1">bad</a> <a href="https://t.me/c/123/4">ok</a>'
    expect(sanitizeTelegramHtml(input)).toBe('bad <a href="https://t.me/c/123/4">ok</a>')
  })

  test('handles empty input', () => {
    expect(sanitizeTelegramHtml('')).toBe('')
  })

  test('handles malformed tags without closing bracket', () => {
    const input = 'hello <b world'
    expect(sanitizeTelegramHtml(input)).toBe('hello &lt;b world')
  })

  test('handles model-generated broken html', () => {
    const input = '<b>Topic 1</b> <a href="https://t.me/mygroup/1">link</a> <i>text</i> <div>extra</div>'
    expect(sanitizeTelegramHtml(input)).toBe('<b>Topic 1</b> <a href="https://t.me/mygroup/1">link</a> <i>text</i> extra')
  })
})

describe('fitTelegramHtml', () => {
  test('returns short text unchanged', () => {
    expect(fitTelegramHtml('hello')).toBe('hello')
  })

  test('truncates long text', () => {
    const long = 'a'.repeat(5000)
    const result = fitTelegramHtml(long)
    expect(result.endsWith('\n\n[truncated]')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(4096)
  })

  test('does not slice through html tags while truncating', () => {
    const long = '<b>' + 'a'.repeat(5000) + '</b>'
    const result = fitTelegramHtml(long)
    expect(result).not.toContain('<b>')
    expect(result).not.toContain('</b>')
    expect(result.endsWith('\n\n[truncated]')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(4096)
  })
})
