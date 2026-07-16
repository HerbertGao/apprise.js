// SPDX-License-Identifier: BSD-2-Clause

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { NotifyFeishu, type NotifyFeishuArgs } from '../src/plugins/feishu.js'
import { loadFixture, runGolden } from './golden.js'

const FEISHU_IGNORED_HEADERS = new Set([
  'content-length',
  'accept-encoding',
  'accept',
  'connection',
  'host',
])

describe('feishu golden differential', () => {
  runGolden('fixtures/feishu.json', {
    bodyMode: 'json',
    exactContentType: true,
    ignoreHeaders: FEISHU_IGNORED_HEADERS,
  })
})

describe('feishu URL, budget, and registration isolation', () => {
  const build = (url: string) =>
    new NotifyFeishu(NotifyFeishu.parseUrl(url) as unknown as NotifyFeishuArgs)

  test('normalizes query token and outer-masks privacy', () => {
    const plugin = build('feishu://?token=query_token-1')
    expect(plugin.token).toBe('query_token-1')
    expect(plugin.url()).toContain('feishu://query_token-1/')
    expect(plugin.url()).not.toContain('?token=')
    expect(plugin.url(true)).toContain('feishu://q...1/')
  })

  test('retains the independent Feishu length budget', () => {
    const plugin = build('feishu://abc123')
    expect(plugin.titleMaxlen).toBe(0)
    expect(plugin.bodyMaxlen).toBe(19_985)
  })

  test('the shared 19986-character cross case truncates to 19985', () => {
    const fixtureCase = loadFixture('fixtures/feishu.json').cases.find(
      ({ name }) => name === 'cross-body-19986-truncate',
    )
    const encoded = fixtureCase?.expected.request?.body?.base64
    expect(encoded).toBeDefined()
    const payload = JSON.parse(Buffer.from(encoded ?? '', 'base64').toString())
    expect(payload.content.text).toHaveLength(19_985)
  })

  test('shared base contains no registration and public entry does not import Lark', () => {
    const base = readFileSync(
      fileURLToPath(
        new URL('../src/plugins/feishu-lark-base.ts', import.meta.url),
      ),
      'utf8',
    )
    const entry = readFileSync(
      fileURLToPath(new URL('../src/plugins/feishu.ts', import.meta.url)),
      'utf8',
    )
    expect(base).not.toContain('registerPlugin')
    expect(entry).not.toMatch(/from ['"][^'"]*\/lark(?:\.js)?['"]/)
  })
})
