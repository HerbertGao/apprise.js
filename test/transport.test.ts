// SPDX-License-Identifier: BSD-2-Clause
// Transport seam tests (core-foundation, group C — task 3.3).
// The seam must be injectable so the golden-differential suite (group E) can
// intercept and record the final wire request without hitting the network.

import { afterEach, describe, expect, test } from 'vitest'
import {
  request,
  setTransport,
  type TransportRequest,
} from '../src/core/transport.js'

afterEach(() => {
  // Restore the default native-fetch transport between tests.
  setTransport(null)
})

describe('transport seam', () => {
  test('an injected transport records the request and returns its response', async () => {
    const seen: TransportRequest[] = []
    setTransport(async (req) => {
      seen.push(req)
      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => 'recorded',
      }
    })

    const res = await request({
      method: 'POST',
      url: 'https://example.test/hook',
      headers: { 'X-Apprise': '1' },
      body: 'payload',
    })

    expect(res.status).toBe(201)
    expect(await res.text()).toBe('recorded')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: 'https://example.test/hook',
      headers: { 'X-Apprise': '1' },
      body: 'payload',
    })
  })

  test('setTransport(null) restores the default without error', () => {
    expect(() => setTransport(null)).not.toThrow()
  })

  test('the default transport drops a GET/HEAD body but keeps POST (fetch limit)', async () => {
    // nativeFetchTransport is the active default here (afterEach reset it). Stub
    // the global fetch to capture the init it receives.
    const inits: (RequestInit | undefined)[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      inits.push(init)
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: async () => '',
      }
    }) as unknown as typeof fetch
    try {
      await request({ method: 'GET', url: 'https://example.test/', body: 'x' })
      await request({ method: 'HEAD', url: 'https://example.test/', body: 'x' })
      await request({ method: 'POST', url: 'https://example.test/', body: 'x' })
    } finally {
      globalThis.fetch = original
    }
    expect(inits[0]?.body).toBeUndefined()
    expect(inits[1]?.body).toBeUndefined()
    expect(inits[2]?.body).toBe('x')
  })
})
