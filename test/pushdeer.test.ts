// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { Apprise } from '../src/core/apprise.js'
import {
  NotifyPushDeer,
  type NotifyPushDeerArgs,
} from '../src/plugins/pushdeer.js'
import { runGolden } from './golden.js'

const PUSHDEER_IGNORED_HEADERS = new Set([
  'content-length',
  'accept-encoding',
  'accept',
  'connection',
  'host',
  'user-agent',
])

describe('pushdeer golden differential', () => {
  runGolden('fixtures/pushdeer.json', {
    bodyMode: 'form',
    exactContentType: true,
    ignoreHeaders: PUSHDEER_IGNORED_HEADERS,
  })
})

describe('pushdeer URL and endpoint contract', () => {
  const build = (url: string) =>
    new NotifyPushDeer(
      NotifyPushDeer.parseUrl(url) as unknown as NotifyPushDeerArgs,
    )

  test('uses key-only cloud form and outer privacy', () => {
    const plugin = build('pushdeers://pushKey')
    expect(plugin.host).toBe('')
    expect(plugin.port).toBeNull()
    expect(plugin.secure).toBe(true)
    expect(plugin.url()).toBe('pushdeers://pushKey')
    expect(plugin.url(true)).toBe('pushdeers://p...y')
  })

  test('preserves self-hosted host and port', () => {
    const plugin = build('pushdeer://localhost:8080/pushKey')
    expect(plugin.host).toBe('localhost')
    expect(plugin.port).toBe(8080)
    expect(plugin.pushKey).toBe('pushKey')
    expect(plugin.url()).toBe('pushdeer://localhost:8080/pushKey')
  })

  test('registers both public schemes and rejects an invalid key', () => {
    expect(new Apprise().add('pushdeer://pushKey')).toBe(true)
    expect(new Apprise().add('pushdeers://pushKey')).toBe(true)
    const kinds: string[] = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => kinds.push(event.kind),
      }),
    })
    expect(app.add('pushdeer://bad_key')).toBe(false)
    expect(kinds).toContain('plugin-error')
  })
})
