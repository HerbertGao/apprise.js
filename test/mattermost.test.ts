// SPDX-License-Identifier: BSD-2-Clause
// mattermost golden-differential tests (plugins-im, group B — task 2.2).
// Asserts fixtures/mattermost.json (upstream apprise v1.12.0, WEBHOOK mode):
// default POST to /hooks/{token}, secure scheme, host:port + sub-path, the
// `?channel=` override, and truncate overflow. Body is JSON (order/spacing
// agnostic). Also covers the url() round-trip and privacy masking of the token.

import { describe, expect, test } from 'vitest'
import { Apprise } from '../src/core/apprise.js'
// Side-effect import registers the mmost/mmosts schemes.
import {
  NotifyMattermost,
  type NotifyMattermostArgs,
} from '../src/plugins/mattermost.js'
import { runGolden } from './golden.js'

describe('mattermost golden differential', () => {
  runGolden('fixtures/mattermost.json', { bodyMode: 'json' })
})

describe('mattermost url() round-trip', () => {
  test('serialises to mmost:// and re-parses to an equivalent instance', () => {
    const url = 'mmost://host/token1?channel=general&image=no'
    const plugin = new NotifyMattermost(
      NotifyMattermost.parseUrl(url) as unknown as NotifyMattermostArgs,
    )
    const serialised = plugin.url()
    expect(serialised.startsWith('mmost://')).toBe(true)

    const reparsed = new NotifyMattermost(
      NotifyMattermost.parseUrl(serialised) as unknown as NotifyMattermostArgs,
    )
    expect(reparsed.token).toBe(plugin.token)
    expect(reparsed.targets).toEqual(plugin.targets)
    expect(reparsed.includeImage).toBe(plugin.includeImage)
    expect(new Apprise().add(serialised)).toBe(true)
  })

  test('bot mode is deferred: ?mode=bot / ?team= throw at construction', () => {
    expect(new Apprise().add('mmost://host/token1?mode=bot')).toBe(false)
    expect(new Apprise().add('mmost://host/token1?team=myteam')).toBe(false)
  })
})

describe('mattermost url(privacy) masks the token', () => {
  const build = () =>
    new NotifyMattermost(
      NotifyMattermost.parseUrl(
        'mmost://host/SECRETTOKEN',
      ) as unknown as NotifyMattermostArgs,
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
