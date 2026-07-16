// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from 'vitest'
import {
  NotifyWxPusher,
  type NotifyWxPusherArgs,
} from '../src/plugins/wxpusher.js'
import { loadFixture, matchCase, runGolden } from './golden.js'

const WXPUSHER_IGNORED_HEADERS = new Set([
  'content-length',
  'accept-encoding',
  'connection',
  'host',
])

describe('wxpusher golden differential', () => {
  runGolden('fixtures/wxpusher.json', {
    bodyMode: 'json',
    exactContentType: true,
    ignoreHeaders: WXPUSHER_IGNORED_HEADERS,
  })
})

describe('wxpusher URL, targets, and semantic headers', () => {
  const build = (url: string) =>
    new NotifyWxPusher(
      NotifyWxPusher.parseUrl(url) as unknown as NotifyWxPusherArgs,
    )

  test('classifies topic/user targets and preserves invalid targets in url()', () => {
    const plugin = build('wxpusher://AT_appid/123/UID_bob/invalid/')
    expect(plugin.topics).toEqual([123])
    expect(plugin.users).toEqual(['UID_bob'])
    expect(plugin.invalidTargets).toEqual(['invalid'])
    expect(plugin.url()).toContain('/123/UID_bob/invalid/')
    expect(plugin.url(true)).toContain('wxpusher://****/')
  })

  test('query token turns authority into a target and flattens ?to=', () => {
    const plugin = build('wxpusher://456?token=AT_query&to=UID_query,789')
    expect(plugin.token).toBe('AT_query')
    expect(plugin.topics).toEqual([456, 789])
    expect(plugin.users).toEqual(['UID_query'])
    expect(plugin.url()).not.toContain('?token=')
    expect(plugin.url()).not.toContain('&to=')
  })

  test('sorts targets by Unicode code point like Python', () => {
    const plugin = new NotifyWxPusher({
      token: 'AT_appid',
      targets: ['UID_😀', 'UID_\uE000'],
    })
    expect(plugin.users).toEqual(['UID_\uE000', 'UID_😀'])
  })

  test('missing semantic Accept header makes the golden comparison RED', async () => {
    const source = loadFixture('fixtures/wxpusher.json').cases.find(
      ({ name }) => name === 'text-user-success',
    )
    if (!source?.expected.request) throw new Error('missing WxPusher fixture')
    const fixtureCase = structuredClone(source)
    delete fixtureCase.expected.request?.headers.Accept
    await expect(
      matchCase(fixtureCase, {
        bodyMode: 'json',
        exactContentType: true,
        ignoreHeaders: WXPUSHER_IGNORED_HEADERS,
      }),
    ).rejects.toThrow(/header "accept"/)
  })
})

describe('wxpusher response decoding', () => {
  const json = '{"code":1000}'
  const encoded = (width: 2 | 4, littleEndian: boolean): ArrayBuffer => {
    const bytes = new Uint8Array(json.length * width)
    const view = new DataView(bytes.buffer)
    for (let index = 0; index < json.length; index++) {
      if (width === 2) {
        view.setUint16(index * width, json.charCodeAt(index), littleEndian)
      } else {
        view.setUint32(index * width, json.charCodeAt(index), littleEndian)
      }
    }
    return bytes.buffer
  }

  test.each([
    ['UTF-16LE', encoded(2, true)],
    ['UTF-16BE', encoded(2, false)],
    ['UTF-32LE', encoded(4, true)],
    ['UTF-32BE', encoded(4, false)],
  ])('accepts valid %s JSON response bytes', async (_encoding, bytes) => {
    const plugin = new NotifyWxPusher({
      token: 'AT_appid',
      targets: 'UID_alice',
      transport: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: async () => '',
        arrayBuffer: async () => bytes,
      }),
    })
    expect(await plugin.notify({ body: 'test' })).toBe(true)
  })

  test.each([
    ['UTF-16', Uint8Array.from([0xff, 0xfe, 0x7b]).buffer],
    [
      'UTF-32',
      Uint8Array.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0xd8, 0x00]).buffer,
    ],
  ])('rejects malformed %s response bytes', async (_encoding, bytes) => {
    const plugin = new NotifyWxPusher({
      token: 'AT_appid',
      targets: 'UID_alice',
      transport: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: async () => '',
        arrayBuffer: async () => bytes,
      }),
    })
    expect(await plugin.notify({ body: 'test' })).toBe(false)
  })

  test('fails closed when exact response bytes are unavailable', async () => {
    let textRead = false
    const seen: unknown[] = []
    const plugin = new NotifyWxPusher({
      token: 'AT_appid',
      targets: 'UID_alice',
      transport: async (request) => {
        seen.push(request)
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          text: async () => {
            textRead = true
            return json
          },
        }
      },
    })
    expect(await plugin.notify({ body: 'test' })).toBe(false)
    expect(seen).toHaveLength(1)
    expect(textRead).toBe(false)
  })
})
