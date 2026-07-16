// SPDX-License-Identifier: BSD-2-Clause

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { Apprise } from '../src/core/apprise.js'
import { NotifyLark, type NotifyLarkArgs } from '../src/plugins/lark.js'
import { loadFixture, runGolden } from './golden.js'

const LARK_IGNORED_HEADERS = new Set([
  'content-length',
  'accept-encoding',
  'accept',
  'connection',
  'host',
])

describe('lark golden differential', () => {
  runGolden('fixtures/lark.json', {
    bodyMode: 'json',
    exactContentType: true,
    ignoreHeaders: LARK_IGNORED_HEADERS,
  })
})

describe('lark URL, native fallback, budget, and registration isolation', () => {
  const build = (url: string) =>
    new NotifyLark(NotifyLark.parseUrl(url) as unknown as NotifyLarkArgs)

  test('normalizes query token and uses secret privacy', () => {
    const plugin = build('lark://?token=query-token-1')
    expect(plugin.token).toBe('query-token-1')
    expect(plugin.url()).toContain('lark://query-token-1/')
    expect(plugin.url()).not.toContain('?token=')
    expect(plugin.url(true)).toContain('lark://****/')
  })

  test('retains the independent inherited Lark length budget', () => {
    const plugin = build('lark://abcd-1234')
    expect(plugin.titleMaxlen).toBe(250)
    expect(plugin.bodyMaxlen).toBe(32_768)
  })

  test('the shared 19986-character cross case remains untruncated', () => {
    const fixtureCase = loadFixture('fixtures/lark.json').cases.find(
      ({ name }) => name === 'cross-body-19986-retained',
    )
    const text = fixtureCase?.expected.request?.body?.text
    expect(text).toBeDefined()
    expect(JSON.parse(text ?? '{}').content.text).toHaveLength(19_986)
  })

  test('accepts only the exact HTTPS native webhook shape', () => {
    const good = 'https://open.larksuite.com/open-apis/bot/v2/hook/abcd-1234'
    expect(NotifyLark.parseNativeUrl(good)).not.toBeNull()
    expect(new Apprise().add(good)).toBe(true)

    const kinds: string[] = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => kinds.push(event.kind),
      }),
    })
    for (const url of [
      'https://open.larksuite.com.evil/open-apis/bot/v2/hook/abcd-1234',
      'https://open.larksuite.com/open-apis/bot/v2/wrong/abcd-1234',
      'http://open.larksuite.com/open-apis/bot/v2/hook/abcd-1234',
      'https://open.larksuite.com/open-apis/bot/v2/hook/',
    ]) {
      expect(NotifyLark.parseNativeUrl(url)).toBeNull()
      expect(app.add(url)).toBe(false)
    }
    expect(kinds).toHaveLength(4)
    expect(new Set(kinds)).toEqual(new Set(['unregistered-scheme']))
  })

  test('shared base contains no registration and public entry does not import Feishu', () => {
    const base = readFileSync(
      fileURLToPath(
        new URL('../src/plugins/feishu-lark-base.ts', import.meta.url),
      ),
      'utf8',
    )
    const entry = readFileSync(
      fileURLToPath(new URL('../src/plugins/lark.ts', import.meta.url)),
      'utf8',
    )
    expect(base).not.toContain('registerPlugin')
    expect(entry).not.toMatch(/from ['"][^'"]*\/feishu(?:\.js)?['"]/)
  })
})
