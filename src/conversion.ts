// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/conversion.py).

import MarkdownIt from 'markdown-it'
import { NotifyFormat } from './common.js'

// nl2br (breaks) + tables mirror upstream's Python `markdown` extensions
// ['markdown.extensions.nl2br', 'markdown.extensions.tables']. Tables are on
// by default in markdown-it's default preset; `breaks` turns a single newline
// into <br>.
// ponytail: md->html is BEST-EFFORT, NOT byte-faithful to the Python `markdown`
// library — the two renderers differ (trailing `\n`, `<br>` vs `<br />`, ...).
// Reachable via a `?format=html` target with a markdown source body, but NOT
// covered by the golden diff; the unit tests assert THIS renderer's own output,
// they are not an upstream oracle. A byte-faithful md->html would need a
// different markdown engine (out of scope this batch).
const md = new MarkdownIt({ breaks: true })

type Converter = (content: string) => string

function pairKey(from: NotifyFormat, to: NotifyFormat): string {
  return `${from}->${to}`
}

// Upstream registers four converter pairs (conversion.py:88-93):
//   markdown->html, text->html, html->text, html->markdown
// - html->text  : faithful (HTMLConverter).
// - text->html  : faithful (escape_html, convert_new_lines=True) — see below.
// - markdown->html : BEST-EFFORT (markdown-it; not byte-faithful, see above).
// - html->markdown : NOT IMPLEMENTED this batch (upstream HTMLMarkdownConverter
//   is ~1400 lines, out of scope). It has NO registered converter here, so it
//   PASSES THROUGH unchanged — this is a deliberate non-faithful degradation
//   (upstream would produce CommonMark), reachable via a `?format=markdown`
//   target with an html source body. Do not mistake the passthrough for
//   coverage.
const CONVERTERS = new Map<string, Converter>([
  [pairKey(NotifyFormat.HTML, NotifyFormat.TEXT), htmlToText],
  [pairKey(NotifyFormat.TEXT, NotifyFormat.HTML), textToHtml],
  [pairKey(NotifyFormat.MARKDOWN, NotifyFormat.HTML), markdownToHtml],
])

/**
 * Convert `content` between notify formats (upstream `convert_between`).
 * Any pair without a registered converter — including `markdown->text` and
 * every identity pair — returns the content untouched.
 */
export function convertBetween(
  from: NotifyFormat,
  to: NotifyFormat,
  content: string,
): string {
  const convert = CONVERTERS.get(pairKey(from, to))
  return convert ? convert(content) : content
}

/** markdown -> HTML (upstream `markdown_to_html`). Best-effort, see file note. */
export function markdownToHtml(content: string): string {
  return md.render(content)
}

/**
 * text -> HTML (upstream `text_to_html` = `URLBase.escape_html(content,
 * convert_new_lines=True)`, url.py:569-594 with the default `whitespace=True`).
 * The replacement order is load-bearing (sax_escape `&`/`<`/`>` then the `'`/`"`
 * entities, then tab/space, then newline) so entities are never double-escaped.
 */
export function textToHtml(content: string): string {
  if (!content) {
    return ''
  }
  return content
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;')
    .replaceAll('"', '&quot;')
    .replaceAll('\t', '&emsp;')
    .replaceAll(' ', '&nbsp;')
    .replaceAll('\n', '<br/>')
}

// --- html -> text (upstream conversion.py HTMLConverter) --------------------

// Tags that begin on a fresh output line and are consolidated into single
// newlines by _finalize (upstream HTMLConverter.BLOCK_TAGS).
const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'div',
  'td',
  'th',
  'code',
  'pre',
  'label',
  'li',
])

// Tags whose inner text is ignored (upstream HTMLConverter.IGNORE_TAGS).
const IGNORE_TAGS = new Set([
  'form',
  'input',
  'textarea',
  'select',
  'ul',
  'ol',
  'style',
  'link',
  'meta',
  'title',
  'html',
  'head',
  'script',
])

// Sentinel marking a block-tag boundary (upstream BLOCK_END = {}).
const BLOCK_END = Symbol('block-end')
type Token = string | typeof BLOCK_END

/** HTML -> plain text (upstream `html_to_text` + HTMLConverter). */
export function htmlToText(content: string): string {
  const result: Token[] = []
  let doStore = true

  const onData = (data: string): void => {
    if (!doStore) {
      return
    }
    // Collapse whitespace before buffering (upstream WS_TRIM).
    result.push(data.replace(/\s+/g, ' '))
  }

  const onStart = (tag: string): void => {
    // Toggle storage according to the newly opened container.
    doStore = !IGNORE_TAGS.has(tag)

    if (BLOCK_TAGS.has(tag)) {
      result.push(BLOCK_END)
    }

    if (tag === 'li') {
      result.push('- ')
    } else if (tag === 'br') {
      result.push('\n')
    } else if (tag === 'hr') {
      // Remove spacing that would precede the rule.
      const last = result[result.length - 1]
      if (typeof last === 'string') {
        result[result.length - 1] = last.replace(/ +$/, '')
      }
      result.push('\n---\n')
    } else if (tag === 'blockquote') {
      result.push(' >')
    }
  }

  const onEnd = (tag: string): void => {
    // Resume storage after leaving an ignored container.
    doStore = true
    if (BLOCK_TAGS.has(tag)) {
      result.push(BLOCK_END)
    }
  }

  tokenizeHtml(content, onStart, onEnd, onData)

  // Combine and strip consecutive strings, collapsing block-end runs into
  // single newlines (upstream _finalize + close).
  const out: string[] = []
  let accum: string | null = null
  for (const item of result) {
    if (item === BLOCK_END) {
      if (accum === null) {
        continue
      }
      out.push(`${accum.trim()}\n`)
      accum = null
    } else if (accum !== null) {
      accum += item
    } else {
      accum = item
    }
  }
  if (accum !== null) {
    out.push(accum.trim())
  }

  return out.join('').trim()
}

/**
 * Minimal HTML tokenizer feeding the plain-text converter. Attributes are not
 * needed (the converter only inspects the tag name) so they are skipped.
 * ponytail: best-effort — well-formed HTML plus comments/doctype/PI are
 * handled; a raw `>` inside a quoted attribute value is an unhandled edge.
 */
function tokenizeHtml(
  html: string,
  onStart: (tag: string) => void,
  onEnd: (tag: string) => void,
  onData: (data: string) => void,
): void {
  let i = 0
  const n = html.length

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      onData(decodeEntities(html.slice(i)))
      break
    }
    if (lt > i) {
      onData(decodeEntities(html.slice(i, lt)))
    }

    // Comment: <!-- ... -->
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end === -1 ? n : end + 3
      continue
    }

    // Declaration (<!DOCTYPE ...>) or processing instruction (<? ... ?>)
    const next = html[lt + 1]
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', lt + 1)
      i = end === -1 ? n : end + 1
      continue
    }

    const gt = html.indexOf('>', lt + 1)
    if (gt === -1) {
      // Unterminated tag: treat the remainder as text.
      onData(decodeEntities(html.slice(lt)))
      break
    }

    let inner = html.slice(lt + 1, gt)
    if (inner.startsWith('/')) {
      const tag = firstToken(inner.slice(1))
      if (tag) {
        onEnd(tag.toLowerCase())
      }
    } else {
      const selfClose = inner.endsWith('/')
      if (selfClose) {
        inner = inner.slice(0, -1)
      }
      const tag = firstToken(inner)
      if (tag) {
        onStart(tag.toLowerCase())
        if (selfClose) {
          onEnd(tag.toLowerCase())
        }
      }
    }
    i = gt + 1
  }
}

/** First whitespace/slash-delimited token of a tag body (the tag name). */
function firstToken(inner: string): string {
  const token = inner.trim().split(/[\s/]/, 1)[0]
  return token ?? ''
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * Decode the common HTML entities. Python's HTMLParser (convert_charrefs=True)
 * decodes the full HTML5 set; batch-1 text only needs the common named and
 * numeric references.
 */
function decodeEntities(text: string): string {
  if (!text.includes('&')) {
    return text
  }
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi,
    (match, entity: string) => {
      if (entity[0] === '#') {
        const codePoint =
          entity[1] === 'x' || entity[1] === 'X'
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10)
        // A finite parse can still be an invalid code point (> U+10FFFF or a
        // lone surrogate) that String.fromCodePoint rejects with a RangeError;
        // leave such a malformed reference verbatim (NaN also fails the range).
        return codePoint >= 0 &&
          codePoint <= 0x10ffff &&
          !(codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? String.fromCodePoint(codePoint)
          : match
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match
    },
  )
}
