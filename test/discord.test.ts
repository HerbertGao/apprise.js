// SPDX-License-Identifier: BSD-2-Clause
// discord golden-differential tests (plugins-im, group B — task 3.2).
// Asserts fixtures/discord.json (upstream apprise v1.12.0): default webhook
// POST (TEXT content), botname username override, ?tts, a single multipart
// attachment request, and truncate overflow. JSON bodies compare order/spacing
// agnostically; the multipart attachment body is stored as base64 and compared
// byte-for-byte regardless of bodyMode. Its boundary is pinned by the shared
// golden harness from the case's `seeds.boundary`. Also covers the url()
// round-trip and privacy masking.

import { describe, expect, test } from 'vitest'
import { Apprise } from '../src/core/apprise.js'
// Side-effect import registers the discord scheme.
import {
  NotifyDiscord,
  type NotifyDiscordArgs,
} from '../src/plugins/discord.js'
import { runGolden } from './golden.js'

describe('discord golden differential', () => {
  runGolden('fixtures/discord.json', { bodyMode: 'json' })
})

describe('discord url() round-trip', () => {
  test('serialises to discord:// (botname + params) and re-parses equal', () => {
    const url =
      'discord://Bob@10101010/abcdefghijklmnop?tts=yes&footer=yes&batch=no'
    const plugin = new NotifyDiscord(
      NotifyDiscord.parseUrl(url) as unknown as NotifyDiscordArgs,
    )
    const serialised = plugin.url()
    expect(serialised.startsWith('discord://')).toBe(true)
    expect(serialised).toContain('tts=yes')

    const reparsed = new NotifyDiscord(
      NotifyDiscord.parseUrl(serialised) as unknown as NotifyDiscordArgs,
    )
    expect(reparsed.webhookId).toBe(plugin.webhookId)
    expect(reparsed.webhookToken).toBe(plugin.webhookToken)
    expect(reparsed.user).toBe('Bob')
    expect(reparsed.tts).toBe(true)
    expect(reparsed.footer).toBe(true)
    expect(reparsed.batch).toBe(false)
    expect(new Apprise().add(serialised)).toBe(true)
  })
})

describe('discord url(privacy) masks the webhook id and token', () => {
  const build = () =>
    new NotifyDiscord(
      NotifyDiscord.parseUrl(
        'discord://10101010/SECRETTOKEN',
      ) as unknown as NotifyDiscordArgs,
    )

  test('url(true) masks the token (first+...+last), never verbatim', () => {
    const url = build().url(true)
    expect(url).not.toContain('SECRETTOKEN')
    expect(url).toContain('S...N')
  })

  test('url(false) emits the token verbatim', () => {
    expect(build().url(false)).toContain('SECRETTOKEN')
  })
})
