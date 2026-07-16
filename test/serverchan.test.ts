// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { Apprise } from '../src/core/apprise.js'
import {
  NotifyServerChan,
  type NotifyServerChanArgs,
} from '../src/plugins/serverchan.js'
import { runGolden } from './golden.js'

const SERVERCHAN_IGNORED_HEADERS = new Set([
  'content-length',
  'accept-encoding',
  'accept',
  'connection',
  'host',
  'user-agent',
])

describe('serverchan golden differential', () => {
  runGolden('fixtures/serverchan.json', {
    bodyMode: 'form',
    exactContentType: true,
    ignoreHeaders: SERVERCHAN_IGNORED_HEADERS,
  })
})

describe('serverchan URL contract', () => {
  const build = (url: string) =>
    new NotifyServerChan(
      NotifyServerChan.parseUrl(url) as unknown as NotifyServerChanArgs,
    )

  test('round-trips and outer-masks the token', () => {
    const plugin = build('schan://12345678')
    expect(plugin.url()).toBe('schan://12345678')
    expect(plugin.url(true)).toBe('schan://1...8')
    expect(new Apprise().add(plugin.url())).toBe(true)
  })

  test('preserves the upstream hyphen prefix-extraction distinction', () => {
    expect(build('schan://abc-def').token).toBe('abc')
    const kinds: string[] = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => kinds.push(event.kind),
      }),
    })
    expect(app.add('schan://abc-def/')).toBe(false)
    expect(kinds).toContain('plugin-error')
  })

  test('rejects an invalid token', () => {
    const kinds: string[] = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => kinds.push(event.kind),
      }),
    })
    expect(app.add('schan://a_bd_/')).toBe(false)
    expect(kinds).toContain('plugin-error')
  })

  test('reports a missing token as a constructor failure', () => {
    const diagnostics: string[] = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => diagnostics.push(`${event.level}/${event.kind}`),
      }),
    })
    expect(app.add('schan://')).toBe(false)
    expect(diagnostics).toContain('error/plugin-error')
  })
})
