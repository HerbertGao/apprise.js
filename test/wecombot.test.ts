// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { Apprise } from '../src/core/apprise.js'
import {
  NotifyWeComBot,
  type NotifyWeComBotArgs,
} from '../src/plugins/wecombot.js'
import { runGolden } from './golden.js'

const WECOMBOT_IGNORED_HEADERS = new Set([
  'content-length',
  'accept-encoding',
  'accept',
  'connection',
  'host',
])

describe('wecombot golden differential', () => {
  runGolden('fixtures/wecombot.json', {
    bodyMode: 'json',
    exactContentType: true,
    ignoreHeaders: WECOMBOT_IGNORED_HEADERS,
  })
})

describe('wecombot URL and native fallback', () => {
  const build = (url: string) =>
    new NotifyWeComBot(
      NotifyWeComBot.parseUrl(url) as unknown as NotifyWeComBotArgs,
    )

  test('normalizes ?key= and masks it in privacy mode', () => {
    const plugin = build('wecombot://?key=query_key-1')
    expect(plugin.key).toBe('query_key-1')
    expect(plugin.url()).toContain('wecombot://query_key-1/')
    expect(plugin.url()).not.toContain('?key=')
    expect(plugin.url(true)).toContain('wecombot://q...1/')
  })

  test('accepts the upstream native schemes, slash, and trailing params', () => {
    for (const url of [
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=BOTKEY',
      'http://qyapi.weixin.qq.com/cgi-bin/webhook/send/?key=BOTKEY/&data=123',
    ]) {
      expect(NotifyWeComBot.parseNativeUrl(url)).not.toBeNull()
      expect(new Apprise().add(url)).toBe(true)
    }
  })

  test('rejects look-alike host, wrong path, and missing/empty key', () => {
    const kinds: string[] = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => kinds.push(event.kind),
      }),
    })
    for (const url of [
      'https://qyapi.weixin.qq.com.evil/cgi-bin/webhook/send?key=BOTKEY',
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/wrong?key=BOTKEY',
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send',
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=',
    ]) {
      expect(NotifyWeComBot.parseNativeUrl(url)).toBeNull()
      expect(app.add(url)).toBe(false)
    }
    expect(kinds).toHaveLength(4)
    expect(new Set(kinds)).toEqual(new Set(['unregistered-scheme']))
  })
})
