// SPDX-License-Identifier: BSD-2-Clause
// Self-test for the golden-differential diff tool (core-foundation, group E —
// task 5.3). A synthetic NotifyBase subclass emits a KNOWN request; we assert
// the matcher (a) passes on a byte-compatible fixture (incl. JSON key-order
// independence), (b) fails on a mismatched header / body / url / method, and
// (c) handles both noRequest branches (instantiation-failed and no-request),
// rejecting a noRequest expectation that actually produced a request.

import { describe, expect, test } from 'vitest'
import { NotifyBase } from '../src/core/notify-base.js'
import { request } from '../src/core/transport.js'
import { type PluginConstructor, registerPlugin } from '../src/registry.js'
import { type ParsedUrlResults, URLBase } from '../src/url.js'
import { type FixtureCase, type FixtureRequest, matchCase } from './golden.js'

/** Emits a fixed request regardless of body (so the fixture is fully known). */
class SynthPlugin extends NotifyBase {
  static override attachmentSupport = true

  override async send(body: string, title = ''): Promise<boolean> {
    const res = await request({
      method: 'POST',
      url: 'http://synth.local/x',
      headers: { 'User-Agent': 'Apprise', 'Content-Type': 'application/json' },
      // Key order here differs from the fixture below on purpose.
      body: JSON.stringify({ title, message: body }),
    })
    return res.status >= 200 && res.status < 300
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    return URLBase.parseUrl(url)
  }
}

registerPlugin('synth', SynthPlugin as unknown as PluginConstructor)

const baseRequest: FixtureRequest = {
  method: 'POST',
  url: 'http://synth.local/x',
  headers: { 'User-Agent': 'Apprise', 'Content-Type': 'application/json' },
  // Different key order from what send() emits — must still match in json mode.
  body: { text: '{"message":"hello","title":"hi"}' },
}

function requestCase(name: string, request: FixtureRequest): FixtureCase {
  return {
    name,
    input: { url: 'synth://host/x', title: 'hi', body: 'hello', type: 'info' },
    expected: { request },
  }
}

describe('golden diff tool self-test (task 5.3)', () => {
  test('matches a byte-compatible request (JSON key-order independent)', async () => {
    await expect(
      matchCase(requestCase('good', baseRequest), { bodyMode: 'json' }),
    ).resolves.toBeUndefined()
  })

  test('fails on a mismatched semantic header', async () => {
    const bad = requestCase('bad-header', {
      ...baseRequest,
      headers: { 'User-Agent': 'Wrong', 'Content-Type': 'application/json' },
    })
    await expect(matchCase(bad, { bodyMode: 'json' })).rejects.toThrow()
  })

  test('fails on a mismatched body field', async () => {
    const bad = requestCase('bad-body', {
      ...baseRequest,
      body: { text: '{"message":"WRONG","title":"hi"}' },
    })
    await expect(matchCase(bad, { bodyMode: 'json' })).rejects.toThrow()
  })

  test('fails on a mismatched url', async () => {
    const bad = requestCase('bad-url', {
      ...baseRequest,
      url: 'http://synth.local/other',
    })
    await expect(matchCase(bad, { bodyMode: 'json' })).rejects.toThrow()
  })

  test('fails on a mismatched method', async () => {
    const bad = requestCase('bad-method', { ...baseRequest, method: 'PUT' })
    await expect(matchCase(bad, { bodyMode: 'json' })).rejects.toThrow()
  })

  test('noRequest: instantiation-failed passes for an unknown scheme', async () => {
    const c: FixtureCase = {
      name: 'inst-fail',
      input: { url: 'nope-unregistered://x' },
      expected: { noRequest: { reason: 'instantiation-failed' } },
    }
    await expect(matchCase(c, { bodyMode: 'json' })).resolves.toBeUndefined()
  })

  test('noRequest: no-request passes when empty content sends nothing', async () => {
    const c: FixtureCase = {
      name: 'no-request',
      input: { url: 'synth://host/x', title: '', body: '' },
      expected: { noRequest: { reason: 'no-request' } },
    }
    await expect(matchCase(c, { bodyMode: 'json' })).resolves.toBeUndefined()
  })

  test('rejects a noRequest expectation that actually produced a request', async () => {
    const c: FixtureCase = {
      name: 'wrong-no-request',
      input: { url: 'synth://host/x', body: 'hi' },
      expected: { noRequest: { reason: 'instantiation-failed' } },
    }
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow()
  })
})
