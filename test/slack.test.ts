// SPDX-License-Identifier: BSD-2-Clause
// slack golden-differential tests (plugins-im, group C — tasks 4.1/4.2).
// Asserts fixtures/slack.json (upstream apprise v1.12.0): webhook default +
// webhook-attachment (warn-only, main message still sent) + bot chat.postMessage
// + the bot 4-request external upload flow (postMessage -> GET getUploadURL ->
// POST upload_url multipart -> POST completeUpload, expectedCount=4) + multi
// target with per-target thread_ts + email lookup + block-kit + footer/image.
//
// bodyMode 'json': JSON bodies compare key-order-independently; the multipart
// upload body compares byte-for-byte via its base64. `accept` stays in the diff
// ignore set — the lookupByEmail GET carries the transport-default `*/*` while
// every _send request sets `application/json`, so it is not uniformly comparable.

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { Apprise } from '../src/core/apprise.js'
import { NotifySlack, type NotifySlackArgs } from '../src/plugins/slack.js'
import { runGolden } from './golden.js'

runGolden('fixtures/slack.json', { bodyMode: 'json' })

const build = (url: string): NotifySlack =>
  new NotifySlack(NotifySlack.parseUrl(url) as unknown as NotifySlackArgs)

describe('slack url() round-trip', () => {
  test('webhook serialises with mode=hook and re-parses to equal tokens', () => {
    // `#` is pre-encoded to `%23` exactly as Apprise.add's url_to_dict does
    // (a bare `#` would be parsed as a URL fragment and dropped).
    const plugin = build(
      'slack://T1JJ3T3L2/A1BRTD4JD/TIiajkdnlazkcOXrIdevi7/%23general',
    )
    const serialised = plugin.url()
    expect(serialised.startsWith('slack://')).toBe(true)
    expect(serialised).toContain('mode=hook')

    const reparsed = build(serialised)
    expect(reparsed.mode).toBe('hook')
    expect(reparsed.tokenA).toBe('T1JJ3T3L2')
    expect(reparsed.tokenB).toBe('A1BRTD4JD')
    expect(reparsed.tokenC).toBe('TIiajkdnlazkcOXrIdevi7')
    expect(reparsed.channels).toEqual(['#general'])
    expect(new Apprise().add(serialised)).toBe(true)
  })

  test('bot serialises with mode=bot and re-parses to equal token', () => {
    const plugin = build(
      'slack://xoxb-1234-1234-4ddbc191d40ee098cbaae6f3523ada2d/%23c1',
    )
    const serialised = plugin.url()
    expect(serialised).toContain('mode=bot')

    const reparsed = build(serialised)
    expect(reparsed.mode).toBe('bot')
    expect(reparsed.accessToken).toBe(
      'xoxb-1234-1234-4ddbc191d40ee098cbaae6f3523ada2d',
    )
    expect(reparsed.channels).toEqual(['#c1'])
  })
})

describe('slack url(privacy) masks the token', () => {
  test('webhook token_a is Outer-masked under privacy', () => {
    const url = build('slack://T1JJ3T3L2/A1BRTD4JD/TIiajkdnlazkcOXrIdevi7').url(
      true,
    )
    expect(url).not.toContain('A1BRTD4JD')
    expect(url).toContain('A...D') // token_b Outer mask (first + ... + last)
  })

  test('bot access token is Outer-masked under privacy', () => {
    const url = build(
      'slack://xoxb-1234-1234-4ddbc191d40ee098cbaae6f3523ada2d/',
    ).url(true)
    expect(url).not.toContain('4ddbc191d40ee098cbaae6f3523ada2d')
    expect(url).toContain('x...d')
  })
})

describe('slack mode detection & validation', () => {
  test('a bot token auto-detects bot mode', () => {
    expect(build('slack://xoxb-1234-1234-abc/').mode).toBe('bot')
  })

  test('three path tokens auto-detect webhook mode', () => {
    expect(build('slack://T1/A2/B3').mode).toBe('hook')
  })

  test('a deferred mode (workflow) is rejected', () => {
    const kinds: string[] = []
    const asset = new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) })
    expect(new Apprise({ asset }).add('slack://T1/A2/B3?mode=workflow')).toBe(
      false,
    )
    expect(kinds).toContain('plugin-error')
  })

  test('an invalid webhook token is rejected', () => {
    const kinds: string[] = []
    const asset = new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) })
    expect(new Apprise({ asset }).add('slack://T1/A2/bad.token.here')).toBe(
      false,
    )
    expect(kinds).toContain('plugin-error')
  })

  test('a ?template= URL fails loud (Block-Kit templating deferred)', () => {
    // Parsed then rejected at construction rather than silently sending a
    // divergent, non-templated message.
    expect(new Apprise().add('slack://T1/A2/B3?template=mytemplate')).toBe(
      false,
    )
  })
})
