// SPDX-License-Identifier: BSD-2-Clause
// Synthetic calibration for push-plugin semantic headers and multipart seams.

import { describe, expect, test } from 'vitest'
import { chooseBoundary } from '../src/core/multipart.js'
import { NotifyBase } from '../src/core/notify-base.js'
import { type PluginConstructor, registerPlugin } from '../src/registry.js'
import { type ParsedUrlResults, URLBase } from '../src/url.js'
import {
  type FixtureCase,
  type FixtureRequest,
  matchCase,
  PUSH_HEADER_PROFILES,
  validateFixture,
} from './golden.js'

class MissingHeadersPlugin extends NotifyBase {
  override async send(): Promise<boolean> {
    const response = await this.request({
      method: 'POST',
      url: 'https://headers.synthetic/send',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    return response.status === 200
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    return URLBase.parseUrl(url)
  }
}

class UserOnlyBasicPlugin extends MissingHeadersPlugin {
  override async send(): Promise<boolean> {
    const response = await this.request({
      method: 'POST',
      url: 'https://headers.synthetic/send',
      headers: {
        Authorization: 'Basic dXNlcjo=',
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    return response.status === 200
  }
}

class MultipartPlugin extends MissingHeadersPlugin {
  override async send(): Promise<boolean> {
    const boundary = chooseBoundary()
    const response = await this.request({
      method: 'POST',
      url: 'https://headers.synthetic/multipart',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: `--${boundary}\r\nbody\r\n--${boundary}--\r\n`,
    })
    return response.status === 200
  }
}

registerPlugin(
  'synthmissingheaders',
  MissingHeadersPlugin as unknown as PluginConstructor,
)
registerPlugin(
  'synthuserbasic',
  UserOnlyBasicPlugin as unknown as PluginConstructor,
)
registerPlugin(
  'synthmultipart',
  MultipartPlugin as unknown as PluginConstructor,
)

const request = (headers: Record<string, string>): FixtureRequest => ({
  method: 'POST',
  url: 'https://headers.synthetic/send',
  headers,
  body: { text: '{}' },
})

function headerCase(
  headers: Record<string, string>,
  scheme = 'synthmissingheaders',
): FixtureCase {
  return {
    name: 'headers',
    input: { url: `${scheme}://host`, body: 'x' },
    expected: { request: request(headers) },
  }
}

describe('push semantic header profiles', () => {
  test.each([
    ['pushover', 'Authorization', 'Basic dG9rZW46'],
    ['pushbullet', 'Authorization', 'Basic dG9rZW46'],
    ['ntfy', 'X-Priority', '5'],
    ['gotify', 'X-Gotify-Key', 'secret'],
    ['bark', 'Authorization', 'Basic dXNlcjpwYXNz'],
  ])('missing %s semantic header is RED', async (plugin, key, value) => {
    const c = headerCase({ 'Content-Type': 'application/json', [key]: value })
    await expect(
      matchCase(c, {
        bodyMode: 'json',
        ignoreHeaders: new Set([key.toLowerCase()]),
        headerProfile: PUSH_HEADER_PROFILES[plugin],
      }),
    ).rejects.toThrow(new RegExp(key.toLowerCase()))
  })

  test.each([
    'bark',
    'ntfy',
  ])('%s user-only Basic Auth remains semantic', async (plugin) => {
    const c = headerCase(
      {
        Authorization: 'Basic dXNlcjo=',
        'Content-Type': 'application/json; charset=utf-8',
      },
      'synthuserbasic',
    )
    await expect(
      matchCase(c, {
        bodyMode: 'json',
        headerProfile: PUSH_HEADER_PROFILES[plugin],
      }),
    ).resolves.toBeUndefined()
  })
})

describe('multipart boundary contract', () => {
  const boundary = '00112233445566778899aabbccddeeff'
  const multipartCase = (): FixtureCase => ({
    name: 'multipart',
    input: { url: 'synthmultipart://host', body: 'x' },
    seeds: { boundary },
    expected: {
      request: {
        method: 'POST',
        url: 'https://headers.synthetic/multipart',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: { text: `--${boundary}\r\nbody\r\n--${boundary}--\r\n` },
      },
    },
  })

  test('multipart fixtures require a non-empty boundary seed', () => {
    const c = multipartCase()
    delete c.seeds
    expect(() => validateFixture({ plugin: 'legacy', cases: [c] })).toThrow(
      /seeds\.boundary/,
    )
  })

  test('header-only boundary mismatch is RED and the seam restores', async () => {
    const c = multipartCase()
    if (!c.expected.request)
      throw new Error('multipart fixture request missing')
    c.expected.request.headers['Content-Type'] =
      'multipart/form-data; boundary=ffeeddccbbaa99887766554433221100'
    await expect(matchCase(c, { bodyMode: 'raw' })).rejects.toThrow(
      /content-type/,
    )
    expect(chooseBoundary()).not.toBe(boundary)
  })
})
