// SPDX-License-Identifier: BSD-2-Clause
// telegram golden-differential tests (plugins-im, group D — task 5.2). Asserts
// fixtures/telegram.json (upstream apprise v1.12.0): default explicit chat,
// multi-target (sorted; sendMessage x2), ?format-driven parse_mode, ?silent,
// ?topic (message_thread_id), and an image+PDF attachment pair delivered as two
// ORDERED multipart requests (sendPhoto with caption, then sendDocument).
//
// JSON sendMessage bodies compare order-independently (bodyMode 'json'); the
// multipart bodies are `{base64}` and compare BYTE-for-byte regardless of mode.
// The shared golden harness pins each case's `seeds.boundary` before driving.

import { describe, expect, test } from 'vitest'
import { NotifyFormat } from '../src/common.js'
import { Apprise } from '../src/core/apprise.js'
import {
  NotifyTelegram,
  type NotifyTelegramArgs,
} from '../src/plugins/telegram.js'
import { runGolden } from './golden.js'

describe('telegram golden differential', () => {
  runGolden('fixtures/telegram.json', { bodyMode: 'json' })
})

describe('telegram url() serialisation', () => {
  const build = (url: string) =>
    new NotifyTelegram(
      NotifyTelegram.parseUrl(url) as unknown as NotifyTelegramArgs,
    )

  test('round-trips scheme, token, targets and params; re-parses equal', () => {
    const plugin = build('tgram://123456789:ABCdef_ghi-jkl/12345/@mychannel')
    const serialised = plugin.url()
    expect(serialised.startsWith('tgram://')).toBe(true)
    expect(serialised).toContain('123456789%3AABCdef_ghi-jkl')
    expect(serialised).toContain('/12345/@mychannel/')
    expect(serialised).toContain('mdv=v1')

    const reparsed = build(serialised)
    expect(reparsed.botToken).toBe(plugin.botToken)
    expect(reparsed.targets).toEqual(plugin.targets)
    expect(new Apprise().add(serialised)).toBe(true)
  })

  test('?topic is echoed and folded into the target as :topic', () => {
    const plugin = build('tgram://123456789:ABCdef_ghi-jkl/12345?topic=42')
    const serialised = plugin.url()
    expect(serialised).toContain('topic=42')
    expect(serialised).toContain('/12345:42/')
  })

  test('?format=markdown yields mdv=v1 / MARKDOWN parse mode', () => {
    const plugin = build(
      'tgram://123456789:ABCdef_ghi-jkl/12345?format=markdown',
    )
    expect(plugin.markdownVer).toBe('MARKDOWN')
    expect(plugin.url()).toContain('format=markdown')
  })
})

describe('telegram url(privacy) masks the bot token', () => {
  const build = () =>
    new NotifyTelegram(
      NotifyTelegram.parseUrl(
        'tgram://123456789:ABCdef_ghi-jkl/12345',
      ) as unknown as NotifyTelegramArgs,
    )

  test('url(true) Outer-masks the token (no verbatim leak)', () => {
    const url = build().url(true)
    expect(url).not.toContain('123456789')
    expect(url).not.toContain('ABCdef_ghi-jkl')
    expect(url).toContain('1...l') // first char + ... + last char
    expect(url).toContain('/12345/') // targets are not masked
  })

  test('url(false) emits the token verbatim (percent-encoded colon)', () => {
    expect(build().url(false)).toContain('123456789%3AABCdef_ghi-jkl')
  })
})

describe('telegram invalid bot token is rejected', () => {
  test('a non-token host is not instantiable', () => {
    // No digits:alnum token -> parse_url regex fails -> add() returns false.
    expect(new Apprise().add('tgram://not-a-valid-token/12345')).toBe(false)
  })
})

describe('telegram deferred combos fail loud (regression pins)', () => {
  test('?image=yes add()s but notify() folds to false (include_image throw)', async () => {
    // ?image= icon delivery is deferred; send() throws rather than silently drop
    // the icon, and allSettled folds the rejection to an overall false.
    const app = new Apprise()
    expect(app.add('tgram://123456789:ABCdef_ghi-jkl/12345?image=yes')).toBe(
      true,
    )
    expect(await app.notify({ title: 'hi', body: 'hello' })).toBe(false)
  })

  test('markdown target + HTML-source body folds to false (CommonMark deferral)', async () => {
    // notify_format==MARKDOWN AND body_format==HTML triggers the deferred
    // CommonMark->Telegram-Markdown conversion; send() throws and folds to false.
    const app = new Apprise()
    expect(
      app.add('tgram://123456789:ABCdef_ghi-jkl/12345?format=markdown'),
    ).toBe(true)
    expect(
      await app.notify({
        title: 'hi',
        body: 'hello',
        bodyFormat: NotifyFormat.HTML,
      }),
    ).toBe(false)
  })
})
