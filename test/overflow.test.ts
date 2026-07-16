// SPDX-License-Identifier: BSD-2-Clause
// Overflow tests (core-foundation, group C — tasks 3.5/3.7).
// Boundaries are hand-traced against upstream NotifyBase._apply_overflow +
// smart_split @ v1.12.0. The golden split/truncate fixtures (group E/F) cover
// the fuller matrix; these lock the core algorithm.

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { AttachMemory } from '../src/attachment/memory.js'
import { NotifyFormat, NotifyType, OverflowMode } from '../src/common.js'
import { NotifyBase, type SendOptions } from '../src/core/notify-base.js'

/** Records every (body, title) chunk the overflow engine hands to send(). */
class RecordingBase extends NotifyBase {
  static override attachmentSupport = true
  readonly sent: Array<{ body: string; title: string }> = []

  override async send(
    body: string,
    title = '',
    _notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    this.sent.push({ body, title })
    return true
  }
}

/** body_maxlen shrunk to 10 so overflow is easy to trigger; title stays 250. */
class SizedPlugin extends RecordingBase {
  static override bodyMaxlen = 10
}

function make(): SizedPlugin {
  return new SizedPlugin({ schema: 'x', host: 'h' })
}

describe('overflow UPSTREAM (default, no split)', () => {
  test('body is delivered untouched except for tidy rstrip', async () => {
    const plugin = make()
    // 16 chars > body_maxlen but UPSTREAM never splits/truncates.
    await plugin.notify({ body: 'abcdefghijklmnop  ' })
    expect(plugin.sent).toEqual([{ body: 'abcdefghijklmnop', title: '' }])
  })
})

describe('overflow TRUNCATE', () => {
  test('over-long body is hard-truncated to body_maxlen, single chunk', async () => {
    const plugin = make()
    await plugin.notify({
      body: 'abcdefghijklmnop',
      overflow: OverflowMode.TRUNCATE,
    })
    expect(plugin.sent).toEqual([{ body: 'abcdefghij', title: '' }])
  })

  test('a body that fits is not modified', async () => {
    const plugin = make()
    await plugin.notify({ body: 'short', overflow: OverflowMode.TRUNCATE })
    expect(plugin.sent).toEqual([{ body: 'short', title: '' }])
  })

  test('truncates at a Unicode code-point boundary without an unpaired surrogate', async () => {
    const plugin = make()
    await plugin.notify({
      body: `${'a'.repeat(9)}😀x`,
      overflow: OverflowMode.TRUNCATE,
    })
    expect(plugin.sent).toEqual([{ body: `${'a'.repeat(9)}😀`, title: '' }])
    expect(Array.from(plugin.sent[0]?.body ?? '')).toHaveLength(10)
  })
})

describe('overflow SPLIT (smart_split natural boundaries)', () => {
  test('splits on the space boundary, not by length division', async () => {
    const plugin = make()
    // 19 chars; smart_split breaks after "aaaa bbbb " (last space in window).
    await plugin.notify({
      body: 'aaaa bbbb cccc dddd',
      overflow: OverflowMode.SPLIT,
    })
    expect(plugin.sent).toEqual([
      { body: 'aaaa bbbb', title: '' },
      { body: 'cccc dddd', title: '' },
    ])
  })

  test('with a title, each chunk repeats the title plus a [i/n] counter', async () => {
    const plugin = make()
    await plugin.notify({
      body: 'aaaa bbbb cccc dddd',
      title: 'T',
      overflow: OverflowMode.SPLIT,
    })
    expect(plugin.sent).toEqual([
      { body: 'aaaa bbbb', title: 'T [1/2]' },
      { body: 'cccc dddd', title: 'T [2/2]' },
    ])
  })

  test('priority 1: a newline beats a later space in the same window', async () => {
    const plugin = make()
    // "aa bb\ncc dd ee" (14 chars): the last \n in [0,10) is at 5 -> cut at 6.
    // (A space-priority cut would have landed at 9, giving "aa bb\ncc".)
    await plugin.notify({
      body: 'aa bb\ncc dd ee',
      overflow: OverflowMode.SPLIT,
    })
    expect(plugin.sent).toEqual([
      { body: 'aa bb', title: '' },
      { body: 'cc dd ee', title: '' },
    ])
  })

  test('priority 3: punctuation + whitespace, when no newline/space/tab exists', async () => {
    const plugin = make()
    // Upstream's PUNCT_SPLIT_PATTERN is [.!?:;] followed by [ \t\r\n\v\f]+. A
    // \n/\r would win at priority 1 and a space/tab at priority 2, so priority 3
    // is only ever reached via \v (or \f) — as here: "aaaa.\vbbbbbbbbb" (15
    // chars) matches ".\v" ending at 6, so the cut is at 6, NOT the hard limit 10.
    await plugin.notify({
      body: 'aaaa.\vbbbbbbbbb',
      overflow: OverflowMode.SPLIT,
    })
    expect(plugin.sent).toEqual([
      { body: 'aaaa.', title: '' },
      { body: 'bbbbbbbbb', title: '' },
    ])
  })

  test('hard-splits by Unicode code-point budget without corruption', async () => {
    const plugin = make()
    await plugin.notify({
      body: '😀'.repeat(12),
      overflow: OverflowMode.SPLIT,
    })
    expect(plugin.sent).toEqual([
      { body: '😀'.repeat(10), title: '' },
      { body: '😀'.repeat(2), title: '' },
    ])
    expect(plugin.sent.map(({ body }) => Array.from(body).length)).toEqual([
      10, 2,
    ])
  })
})

describe('title truncation to title_maxlen', () => {
  test('an over-long title is cut to title_maxlen then rstripped', async () => {
    const plugin = make() // title_maxlen 250
    // 249 "T"s, a space, then filler. title[:250].rstrip() -> 249 "T"s.
    const title = `${'T'.repeat(249)} ${'X'.repeat(50)}`
    await plugin.notify({
      body: 'short',
      title,
      overflow: OverflowMode.TRUNCATE,
    })
    expect(plugin.sent).toEqual([{ body: 'short', title: 'T'.repeat(249) }])
  })
})

// --- SPLIT: "display the title once, then continue title-less" ---------------
//
// Upstream base.py `_apply_overflow`, SPLIT branch:
//
//   if self.overflow_display_title_once is None:
//       overflow_display_title_once = bool(
//           self.overflow_amalgamate_title
//           and body_maxlen < self.overflow_display_count_threshold)
//
// i.e. the sub-mode auto-engages when the title is amalgamated into the body
// budget AND the COMPUTED body_maxlen is under the 130-char threshold. The first
// chunk then carries the title and is split at `body_maxlen` (which already made
// room for the title); every later chunk is title-less and split at the FULL
// `self.body_maxlen`. No shipped plugin reaches it (discord amalgamates but has
// body_maxlen 2000), so it is exercised here with a synthetic subclass.

/**
 * body_maxlen 100 / title_maxlen 50, amalgamated. With a 1-char title upstream
 * computes (base.py `_apply_overflow`):
 *   title_maxlen = min(len(title) + 12, 50, 100)   = 13
 *   body_maxlen  = (100 - 13) - overflow_buffer(0) = 87   (87 < 130 -> once)
 */
class TitleOncePlugin extends RecordingBase {
  static override bodyMaxlen = 100
  static override titleMaxlen = 50
  static override overflowAmalgamateTitle = true
}

// 25 words of 9 characters, single-space joined => 25*9 + 24 = 249 chars. Word
// boundaries are the only split candidates smart_split can find (no newline, no
// punctuation), which makes every boundary hand-derivable.
const WORDS = Array.from(
  { length: 25 },
  (_, i) => `${String(i + 1).padStart(2, '0')}xxxxxxx`,
)
const LONG_BODY = WORDS.join(' ')

describe('overflow SPLIT — title displayed once (amalgamated, body_maxlen < 130)', () => {
  test('first chunk carries the title (split at 87), the rest are title-less (split at 100)', async () => {
    const plugin = new TitleOncePlugin({ schema: 'x', host: 'h' })
    await plugin.notify({
      body: LONG_BODY,
      title: 'T',
      overflow: OverflowMode.SPLIT,
    })

    // smart_split(body, 87): last space inside [0,87) is at index 79 -> the cut
    // is at 80, consuming words 1..8 (79 chars + the trailing space).
    // remainder = body[80:] (words 9..25, 169 chars).
    // smart_split(remainder, 100): last space inside [0,100) is at 99 -> cut at
    // 100, consuming words 9..18 (99 chars + trailing space); the 69-char tail
    // (words 19..25) fits and closes the list.
    expect(plugin.sent).toEqual([
      { body: WORDS.slice(0, 8).join(' '), title: 'T' },
      { body: WORDS.slice(8, 18).join(' '), title: '' },
      { body: WORDS.slice(18).join(' '), title: '' },
    ])
  })

  test('a body that fits the reduced budget is a single titled chunk', async () => {
    const plugin = new TitleOncePlugin({ schema: 'x', host: 'h' })
    // 87 chars exactly == body_maxlen -> no split at all.
    const body = 'b'.repeat(87)
    await plugin.notify({ body, title: 'T', overflow: OverflowMode.SPLIT })
    expect(plugin.sent).toEqual([{ body, title: 'T' }])
  })
})

/** Explicit override: title-once WITHOUT amalgamation (body_maxlen == 10). */
class TitleOnceForced extends RecordingBase {
  static override bodyMaxlen = 10
  static override overflowDisplayTitleOnce = true
}

describe('overflow SPLIT — overflowDisplayTitleOnce=true override', () => {
  test('the explicit flag wins over the auto-detection (no [i/n] counter)', async () => {
    const plugin = new TitleOnceForced({ schema: 'x', host: 'h' })
    await plugin.notify({
      body: 'aaaa bbbb cccc dddd',
      title: 'T',
      overflow: OverflowMode.SPLIT,
    })
    // Same body/limit as the counter test above, but the title is emitted once
    // and the continuation chunk is title-less (upstream's `else` branch).
    expect(plugin.sent).toEqual([
      { body: 'aaaa bbbb', title: 'T' },
      { body: 'cccc dddd', title: '' },
    ])
  })
})

/**
 * The `overflow_amalgamate_title and body_maxlen <= 0` edge case. body_maxlen 13
 * with a 1-char title gives title_maxlen = min(1+12, 250, 13) = 13, so
 * body_maxlen = (13 - 13) - 0 = 0: there is NO room for body next to the title.
 * Upstream falls into the title-once branch EVEN with the flag forced off, and
 * emits a title-only first chunk followed by the full body split at body_maxlen.
 */
class AmalgamateNoRoom extends RecordingBase {
  static override bodyMaxlen = 13
  static override overflowAmalgamateTitle = true
  static override overflowDisplayTitleOnce = false
}

describe('overflow SPLIT — amalgamated title leaves no body room (body_maxlen <= 0)', () => {
  test('emits a title-only chunk, then the whole body title-less', async () => {
    const plugin = new AmalgamateNoRoom({ schema: 'x', host: 'h' })
    await plugin.notify({
      body: 'aaaa bbbb cccc dddd',
      title: 'T',
      overflow: OverflowMode.SPLIT,
    })
    expect(plugin.sent).toEqual([
      { body: '', title: 'T' },
      { body: 'aaaa bbbb', title: '' },
      { body: 'cccc dddd', title: '' },
    ])
  })
})

// --- SPLIT counter details ---------------------------------------------------

describe('overflow SPLIT — counter sizing (upstream overflow_max_display_count_width)', () => {
  test('the title is truncated to make room for the [i/n] suffix', async () => {
    const plugin = make() // body_maxlen 10, title_maxlen 250
    const title = 'T'.repeat(250)
    await plugin.notify({
      body: 'aaaa bbbb cccc dddd',
      title,
      overflow: OverflowMode.SPLIT,
    })
    // count=2 -> digits=1 -> overflow_display_count_width = 4 + 1*2 = 6 (<= 12),
    // so t_max = title_maxlen(250) - 6 = 244 and the title is cut to 244 chars.
    const cut = 'T'.repeat(244)
    expect(plugin.sent).toEqual([
      { body: 'aaaa bbbb', title: `${cut} [1/2]` },
      { body: 'cccc dddd', title: `${cut} [2/2]` },
    ])
  })

  test('too many chunks for the counter width -> repeated title, no counter', async () => {
    // body_maxlen 1 with no natural boundary -> one chunk per character.
    class OneCharPlugin extends RecordingBase {
      static override bodyMaxlen = 1
    }
    const plugin = new OneCharPlugin({ schema: 'x', host: 'h' })
    await plugin.notify({
      body: 'a'.repeat(10000),
      title: 'T',
      overflow: OverflowMode.SPLIT,
    })
    // count=10000 -> digits=5 -> width = 4 + 5*2 = 14 > overflow_max_display
    // _count_width (12), so upstream sets show_counter=False and repeats the
    // bare title on every chunk.
    expect(plugin.sent).toHaveLength(10000)
    expect(plugin.sent[0]).toEqual({ body: 'a', title: 'T' })
    expect(plugin.sent[9999]).toEqual({ body: 'a', title: 'T' })
    expect(plugin.sent.every((c) => c.title === 'T')).toBe(true)
  })
})

describe('overflow SPLIT — body_maxlen of 0 (smart_split limit <= 0)', () => {
  test('upstream smart_split returns [""] -> a single empty chunk', async () => {
    class ZeroBody extends RecordingBase {
      static override bodyMaxlen = 0
    }
    const plugin = new ZeroBody({ schema: 'x', host: 'h' })
    await plugin.notify({ body: 'anything', overflow: OverflowMode.SPLIT })
    expect(plugin.sent).toEqual([{ body: '', title: '' }])
  })
})

// --- smart_split content-aware adjustments -----------------------------------
//
// Upstream utils/format.py: HTML bodies run `html_adjust` (never cut an entity
// in half), MARKDOWN bodies run `html_adjust` THEN `markdown_adjust` (never cut
// `[label](url)`, `![alt](url)` or `<url|label>`).

describe('smart_split — HTML entity protection (html_adjust)', () => {
  const BODY = 'abcdefgh&amp;xyz' // 16 chars; & at 8, ; at 12

  test('a TEXT body is cut at the hard limit, straight through the entity', async () => {
    const plugin = make() // notify_format TEXT, body_maxlen 10
    await plugin.notify({ body: BODY, overflow: OverflowMode.SPLIT })
    // No boundary in [0,10) -> hard split at 10, mid-entity.
    expect(plugin.sent).toEqual([
      { body: 'abcdefgh&a', title: '' },
      { body: 'mp;xyz', title: '' },
    ])
  })

  test('an HTML body moves the cut back to the "&" so the entity survives', async () => {
    class HtmlSized extends RecordingBase {
      static override bodyMaxlen = 10
      static override notifyFormat: NotifyFormat = NotifyFormat.HTML
    }
    const plugin = new HtmlSized({ schema: 'x', host: 'h' })
    await plugin.notify({ body: BODY, overflow: OverflowMode.SPLIT })
    // html_adjust: amp_index=8, semi_index=12, 8 < split(10) <= 12 -> cut at 8.
    expect(plugin.sent).toEqual([
      { body: 'abcdefgh', title: '' },
      { body: '&amp;xyz', title: '' },
    ])
  })
})

describe('smart_split — Markdown link protection (markdown_adjust)', () => {
  class MdSized extends RecordingBase {
    static override bodyMaxlen = 10
    static override notifyFormat: NotifyFormat = NotifyFormat.MARKDOWN
  }
  const build = () => new MdSized({ schema: 'x', host: 'h' })

  test('[label](url): the cut is moved back to the opening "["', async () => {
    const plugin = build()
    // "abcde[x](http://y) z" (20 chars). Hard split at 10 lands inside the link
    // ("[" at 5, ")" at 17) -> markdown_adjust returns 5.
    await plugin.notify({
      body: 'abcde[x](http://y) z',
      overflow: OverflowMode.SPLIT,
    })
    // The 2nd window starts at 5, where the adjustment would return 5 again;
    // upstream's `if split_at <= start` guard restores the hard split at 15.
    expect(plugin.sent).toEqual([
      { body: 'abcde', title: '' },
      { body: '[x](http:/', title: '' },
      { body: '/y) z', title: '' },
    ])
  })

  test('![alt](url): the cut is moved back to the "!" that opens the image', async () => {
    const plugin = build()
    // "abcdefghi![a](u) z" (18 chars): no "[" inside [0,10), but "!" at 9 is
    // followed by "[" -> link_start_idx = 9 and the cut moves to 9.
    await plugin.notify({
      body: 'abcdefghi![a](u) z',
      overflow: OverflowMode.SPLIT,
    })
    expect(plugin.sent).toEqual([
      { body: 'abcdefghi', title: '' },
      { body: '![a](u) z', title: '' },
    ])
  })

  test('<url|label>: the cut is moved back to the opening "<"', async () => {
    const plugin = build()
    // "abcdefgh<u|l> z" (15 chars): "<" at 8, "|" at 10, ">" at 12 and the hard
    // split (10) satisfies angle_start < split <= angle_end -> cut at 8.
    await plugin.notify({
      body: 'abcdefgh<u|l> z',
      overflow: OverflowMode.SPLIT,
    })
    expect(plugin.sent).toEqual([
      { body: 'abcdefgh', title: '' },
      { body: '<u|l> z', title: '' },
    ])
  })
})

// --- title amalgamation into the body (title_maxlen <= 0) --------------------
//
// Upstream base.py `_apply_overflow`: a service with no title support folds the
// title into the body, in a format-dependent way, and then clears the title.

describe('title amalgamation (title_maxlen = 0)', () => {
  test('TEXT: "{title}\\r\\n{body}"', async () => {
    class TextNoTitle extends RecordingBase {
      static override titleMaxlen = 0
    }
    const plugin = new TextNoTitle({ schema: 'x', host: 'h' })
    await plugin.notify({ body: 'B', title: 'T' })
    expect(plugin.sent).toEqual([{ body: 'T\r\nB', title: '' }])
  })

  test('HTML: "<b>{title}</b><br />\\r\\n{body}" (default_html_tag_id)', async () => {
    class HtmlNoTitle extends RecordingBase {
      static override titleMaxlen = 0
      static override notifyFormat: NotifyFormat = NotifyFormat.HTML
    }
    const plugin = new HtmlNoTitle({ schema: 'x', host: 'h' })
    await plugin.notify({ body: 'B', title: 'T' })
    expect(plugin.sent).toEqual([{ body: '<b>T</b><br />\r\nB', title: '' }])
  })

  describe('MARKDOWN', () => {
    class MdNoTitle extends RecordingBase {
      static override titleMaxlen = 0
      static override notifyFormat: NotifyFormat = NotifyFormat.MARKDOWN
    }
    const build = () => new MdNoTitle({ schema: 'x', host: 'h' })

    test('a TEXT source body renders the title as a "# " heading', async () => {
      const plugin = build()
      // title.lstrip("\r\n \t\v\f#-") strips the leading "## ".
      await plugin.notify({
        body: 'B',
        title: '## T',
        bodyFormat: NotifyFormat.TEXT,
      })
      expect(plugin.sent).toEqual([{ body: '# T\nB', title: '' }])
    })

    test('a title that lstrips to nothing is dropped entirely', async () => {
      const plugin = build()
      await plugin.notify({
        body: 'B',
        title: '###',
        bodyFormat: NotifyFormat.TEXT,
      })
      expect(plugin.sent).toEqual([{ body: 'B', title: '' }])
    })

    test('a MARKDOWN source body falls through to the plain "\\r\\n" join', async () => {
      const plugin = build()
      // body_format is neither TEXT nor HTML -> upstream's `else` branch.
      await plugin.notify({
        body: 'B',
        title: 'T',
        bodyFormat: NotifyFormat.MARKDOWN,
      })
      expect(plugin.sent).toEqual([{ body: 'T\r\nB', title: '' }])
    })
  })
})

describe('body_max_line_count', () => {
  test('the body is clamped to the first N lines, re-joined with \\r\\n', async () => {
    class TwoLines extends RecordingBase {
      static override bodyMaxLineCount = 2
    }
    const plugin = new TwoLines({ schema: 'x', host: 'h' })
    await plugin.notify({ body: 'l1\nl2\nl3\nl4' })
    // upstream: "\r\n".join(re.split(r"\r*\n", body)[0:2])
    expect(plugin.sent).toEqual([{ body: 'l1\r\nl2', title: '' }])
  })
})

// --- notify() content / attachment guards ------------------------------------

describe('notify() guards (upstream _build_send_calls TypeErrors -> False)', () => {
  test('no body and no attachment -> false, nothing sent', async () => {
    const kinds: string[] = []
    const plugin = new SizedPlugin({
      schema: 'x',
      host: 'h',
      asset: new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) }),
    })
    expect(await plugin.notify({})).toBe(false)
    expect(plugin.sent).toHaveLength(0)
    // Pin the NotifyBase emit site (not just the boolean) — this kind is emitted
    // here, distinct from the same string at the Apprise aggregate level.
    expect(kinds).toContain('empty-content')
  })

  test('an attachment source that cannot be instantiated -> false, nothing sent', async () => {
    const kinds: string[] = []
    const plugin = new SizedPlugin({
      schema: 'x',
      host: 'h',
      asset: new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) }),
    })
    // An unregistered scheme makes AppriseAttachment throw (upstream: TypeError).
    expect(await plugin.notify({ body: 'x', attach: 'memory://nope' })).toBe(
      false,
    )
    expect(plugin.sent).toHaveLength(0)
    expect(kinds).toContain('bad-attachment')
  })

  test('a raw attachment is wrapped into a container and delivered', async () => {
    const plugin = make()
    expect(
      await plugin.notify({
        body: 'x',
        attach: new AttachMemory({ content: 'c', name: 'a.txt' }),
      }),
    ).toBe(true)
    expect(plugin.sent).toEqual([{ body: 'x', title: '' }])
  })

  test('an attachment-only notify is skipped when the plugin cannot send attachments', async () => {
    class NoAttach extends RecordingBase {
      static override attachmentSupport = false
    }
    const plugin = new NoAttach({ schema: 'x', host: 'h' })
    expect(
      await plugin.notify({
        attach: new AttachMemory({ content: 'c', name: 'a.txt' }),
      }),
    ).toBe(false)
    expect(plugin.sent).toHaveLength(0)
  })
})

describe('NotifyBase.send() skeleton', () => {
  test('rejects: the child class must implement it (upstream NotImplementedError)', async () => {
    const plugin = new NotifyBase({ schema: 'x', host: 'h' })
    await expect(plugin.send('body')).rejects.toThrow(
      'send() is not implemented by the child class.',
    )
  })
})
