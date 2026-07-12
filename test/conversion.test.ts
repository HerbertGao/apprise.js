// SPDX-License-Identifier: BSD-2-Clause
// Format-conversion tests (core-foundation, group B — task 4.3/4.4).
// Oracles:
//   * html->text : hand-traced against upstream conversion.py HTMLConverter.
//   * text->html : FAITHFUL — asserted against upstream URLBase.escape_html(
//     content, convert_new_lines=True) output (captured from apprise 1.12.0).
//   * md->html   : BEST-EFFORT only — these assert markdown-it's OWN output for
//     the {breaks:true} config; they are NOT an upstream oracle. The Python
//     `markdown` library differs byte-for-byte (trailing `\n`, `<br>` vs
//     `<br />`), so md->html is explicitly not claimed upstream-faithful.
//   * html->markdown : NOT implemented this batch (passthrough); see below.

import { describe, expect, test } from 'vitest'
import { NotifyFormat } from '../src/common.js'
import {
  convertBetween,
  htmlToText,
  markdownToHtml,
  textToHtml,
} from '../src/conversion.js'

describe('convertBetween dispatch', () => {
  test('html -> text really converts', () => {
    expect(
      convertBetween(NotifyFormat.HTML, NotifyFormat.TEXT, '<p>Hi</p>'),
    ).toBe('Hi')
  })

  test('text -> html really converts (escape_html)', () => {
    expect(
      convertBetween(NotifyFormat.TEXT, NotifyFormat.HTML, 'a<b>&\'"x'),
    ).toBe('a&lt;b&gt;&amp;&apos;&quot;x')
  })

  test('markdown -> text is passthrough (no registered converter)', () => {
    const src = '# Hi\n**bold**'
    expect(convertBetween(NotifyFormat.MARKDOWN, NotifyFormat.TEXT, src)).toBe(
      src,
    )
  })

  test('html -> markdown is passthrough (NOT implemented this batch)', () => {
    // Deliberate non-faithful degradation: upstream would emit CommonMark; we
    // pass the html through unchanged (see conversion.ts CONVERTERS note).
    const src = '<p><strong>bold</strong></p>'
    expect(convertBetween(NotifyFormat.HTML, NotifyFormat.MARKDOWN, src)).toBe(
      src,
    )
  })

  test('identity pairs pass through untouched', () => {
    const src = 'plain body'
    expect(convertBetween(NotifyFormat.TEXT, NotifyFormat.TEXT, src)).toBe(src)
  })

  test('markdown -> html uses the markdown renderer', () => {
    expect(
      convertBetween(NotifyFormat.MARKDOWN, NotifyFormat.HTML, '# Hi'),
    ).toBe('<h1>Hi</h1>\n')
  })
})

describe('htmlToText (upstream HTMLConverter)', () => {
  test('single block', () => {
    expect(htmlToText('<p>Hi</p>')).toBe('Hi')
  })

  test('consecutive blocks become newline-separated lines', () => {
    expect(htmlToText('<p>Hello</p><p>World!</p>')).toBe('Hello\nWorld!')
  })

  test('inline tags keep text on one line', () => {
    expect(htmlToText('<b>bold</b> and <i>text</i>')).toBe('bold and text')
  })

  test('list items get a bullet prefix', () => {
    expect(htmlToText('<ul><li>a</li><li>b</li></ul>')).toBe('- a\n- b')
  })

  test('br inserts a hard newline', () => {
    expect(htmlToText('a<br/>b')).toBe('a\nb')
  })

  test('common entities are decoded', () => {
    expect(htmlToText('x &amp; y &lt;z&gt;')).toBe('x & y <z>')
  })

  test('ignored containers drop their own text', () => {
    expect(htmlToText('<title>gone</title><p>kept</p>')).toBe('kept')
  })
})

describe('textToHtml (upstream escape_html, convert_new_lines=True)', () => {
  // Oracle values captured from apprise 1.12.0
  // URLBase.escape_html(s, convert_new_lines=True) (whitespace default True).
  test('escapes the html-significant characters', () => {
    expect(textToHtml('a<b>&\'"x')).toBe('a&lt;b&gt;&amp;&apos;&quot;x')
  })

  test('newlines become <br/>', () => {
    expect(textToHtml('line1\nline2')).toBe('line1<br/>line2')
  })

  test('tabs -> &emsp; and spaces -> &nbsp;', () => {
    expect(textToHtml('tab\there sp')).toBe('tab&emsp;here&nbsp;sp')
  })

  test('empty stays empty', () => {
    expect(textToHtml('')).toBe('')
  })
})

// BEST-EFFORT: markdown-it's own output, NOT an upstream-faithful oracle.
describe('markdownToHtml (best-effort; markdown-it, NOT byte-faithful)', () => {
  test('single newline becomes <br> (nl2br)', () => {
    expect(markdownToHtml('Hello\nWorld')).toBe('<p>Hello<br>\nWorld</p>\n')
  })

  test('emphasis renders', () => {
    expect(markdownToHtml('**bold** text')).toBe(
      '<p><strong>bold</strong> text</p>\n',
    )
  })

  test('tables are enabled', () => {
    expect(markdownToHtml('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(
      '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n' +
        '<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n',
    )
  })
})
