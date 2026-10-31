import { describe, expect, test } from 'bun:test'
import {
  sanitizeTelegramHtml,
  normalizeModelTelegramHtml,
  fitTelegramHtml,
  renderSummaryHtml,
  stripHalfWrittenTag,
  CUT_OFF_NOTE,
} from '../src/htmlSafe'

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

describe('normalizeModelTelegramHtml', () => {
  test('converts screenshot-shaped Markdown into Telegram HTML', () => {
    const input = [
      '**Veydrift Group Chat Summary (Last 24h)**',
      '',
      '- **War & Raids**: Members are conducting frequent raids.',
      '- **Resource Management**: Chucky is gathering debris.',
    ].join('\n')

    expect(normalizeModelTelegramHtml(input)).toBe([
      '<b>Veydrift Group Chat Summary (Last 24h)</b>',
      '',
      '- <b>War &amp; Raids</b>: Members are conducting frequent raids.',
      '- <b>Resource Management</b>: Chucky is gathering debris.',
    ].join('\n'))
  })

  test('preserves safe HTML and normalizes Markdown message links', () => {
    const input = '<b>Existing HTML</b> and [ref](https://t.me/mygroup/42)'
    expect(normalizeModelTelegramHtml(input)).toBe(
      '<b>Existing HTML</b> and <a href="https://t.me/mygroup/42">ref</a>'
    )
  })
})

describe('renderSummaryHtml', () => {
  const note = '<i>(summary cut off)</i>'

  test('leaves a summary without the cut-off note alone', () => {
    expect(renderSummaryHtml('<b>Topic</b> & more')).toBe(normalizeModelTelegramHtml('<b>Topic</b> & more'))
  })

  test('appends the note at top level after a cut inside <b>', () => {
    expect(renderSummaryHtml('<b>Topic one: the long discu' + CUT_OFF_NOTE)).toBe(
      '<b>Topic one: the long discu</b>\n\n' + note
    )
  })

  test('appends the note outside an open <code> or <pre>', () => {
    expect(renderSummaryHtml('<code>foo bar' + CUT_OFF_NOTE)).toBe('<code>foo bar</code>\n\n' + note)
    expect(renderSummaryHtml('<pre>x y' + CUT_OFF_NOTE)).toBe('<pre>x y</pre>\n\n' + note)
  })

  test('appends the note outside an open <a href>', () => {
    expect(renderSummaryHtml('see <a href="https://t.me/hypersnap/12">this mess' + CUT_OFF_NOTE)).toBe(
      'see <a href="https://t.me/hypersnap/12">this mess</a>\n\n' + note
    )
  })

  test('escapes & once', () => {
    expect(renderSummaryHtml('A & B' + CUT_OFF_NOTE)).toBe('A &amp; B\n\n' + note)
  })
})

describe('stripHalfWrittenTag', () => {
  test('drops a half-written allowed tag', () => {
    expect(stripHalfWrittenTag('x <cod')).toBe('x ')
    expect(stripHalfWrittenTag('x </a')).toBe('x ')
    expect(stripHalfWrittenTag('x <')).toBe('x ')
    expect(stripHalfWrittenTag('x <a href="https://t.me/c')).toBe('x ')
    expect(stripHalfWrittenTag("x <a href='https")).toBe('x ')
    expect(stripHalfWrittenTag('x <a href="https://t.me/x/1"')).toBe('x ')
    expect(stripHalfWrittenTag('x <code class="language-py')).toBe('x ')
    expect(stripHalfWrittenTag('x <b ')).toBe('x ')
    expect(stripHalfWrittenTag('x <li')).toBe('x ')
    expect(stripHalfWrittenTag('x <blockquo')).toBe('x ')
    expect(stripHalfWrittenTag('x <tg-spoi')).toBe('x ')
  })

  test('keeps prose with a <', () => {
    expect(stripHalfWrittenTag('if a<b then the team picks c')).toBe('if a<b then the team picks c')
    expect(stripHalfWrittenTag('team <a lot of them')).toBe('team <a lot of them')
    expect(stripHalfWrittenTag('yes <3 no')).toBe('yes <3 no')
    expect(stripHalfWrittenTag('x < y')).toBe('x < y')
    expect(stripHalfWrittenTag('a <table')).toBe('a <table')
  })
})
