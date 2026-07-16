// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { Apprise } from '../src/core/apprise.js'
import '../src/plugins/serverchan.js'
import '../src/plugins/dingtalk.js'
import '../src/plugins/wecombot.js'
import '../src/plugins/feishu.js'
import '../src/plugins/lark.js'
import '../src/plugins/wxpusher.js'
import '../src/plugins/pushdeer.js'

const VALID_URLS: Array<{ url: string; secrets: string[] }> = [
  { url: 'schan://ServerChanSecret123', secrets: ['ServerChanSecret123'] },
  {
    url: 'dingtalk://DingSecret123@DingToken123/',
    secrets: ['DingSecret123', 'DingToken123'],
  },
  { url: 'wecombot://WeComKey_123', secrets: ['WeComKey_123'] },
  { url: 'feishu://FeishuToken_123', secrets: ['FeishuToken_123'] },
  { url: 'lark://Lark-Token-123', secrets: ['Lark-Token-123'] },
  {
    url: 'wxpusher://AT_appid/UID_user/',
    secrets: ['AT_appid'],
  },
  { url: 'pushdeer://PushDeerSecret123', secrets: ['PushDeerSecret123'] },
]

describe('plugins-cn credential privacy and diagnostics', () => {
  test.each(VALID_URLS)('url(true) masks credentials in $url', ({
    url,
    secrets,
  }) => {
    const app = new Apprise({
      asset: new AppriseAsset({ diagnostic: () => {} }),
    })
    expect(app.add(url)).toBe(true)
    const masked = app.servers[0]?.url(true) ?? ''
    for (const secret of secrets) expect(masked).not.toContain(secret)
  })

  test.each([
    {
      url: 'schan://ServerChanSecret_Leak/',
      leak: 'ServerChanSecret_Leak',
      kind: 'plugin-error',
    },
    {
      url: 'dingtalk://DingSecretLeakValue@bad_token/',
      leak: 'DingSecretLeakValue',
      kind: 'plugin-error',
    },
    {
      url: 'wecombot://WeCom.Secret.Leak/',
      leak: 'WeCom.Secret.Leak',
      kind: 'plugin-error',
    },
    {
      url: 'feishu://Feishu.Secret.Leak/',
      leak: 'Feishu.Secret.Leak',
      kind: 'plugin-error',
    },
    {
      url: 'lark://Lark_Secret_Leak/',
      leak: 'Lark_Secret_Leak',
      kind: 'plugin-error',
    },
    {
      url: 'wxpusher://WxPusherSecretLeak/UID_user/',
      leak: 'WxPusherSecretLeak',
      kind: 'plugin-error',
    },
    {
      url: 'pushdeer://PushDeer_Secret_Leak',
      leak: 'PushDeer_Secret_Leak',
      kind: 'plugin-error',
    },
  ])('failure diagnostic masks $url', ({ url, leak, kind }) => {
    const events: Array<{ kind: string; message: string }> = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => events.push(event),
      }),
    })
    expect(app.add(url)).toBe(false)
    expect(events.map((event) => event.kind)).toContain(kind)
    for (const event of events) expect(event.message).not.toContain(leak)
  })

  test('native Lark look-alike failure masks a short path token', () => {
    const leak = 'abcd-1234'
    const events: Array<{ kind: string; message: string }> = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => events.push(event),
      }),
    })

    expect(
      app.add(`https://open.larksuite.com/open-apis/bot/v2/wrong/${leak}`),
    ).toBe(false)
    expect(events.map((event) => event.kind)).toContain('unregistered-scheme')
    for (const event of events) expect(event.message).not.toContain(leak)
  })

  test('Lark constructor failure masks an unrecognized query credential', () => {
    const leak = 'abcdefgh'
    const events: Array<{ kind: string; message: string }> = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => events.push(event),
      }),
    })

    expect(app.add(`lark://?access_token=${leak}`)).toBe(false)
    expect(events.map((event) => event.kind)).toContain('plugin-error')
    for (const event of events) expect(event.message).not.toContain(leak)
  })
})
