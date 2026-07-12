// SPDX-License-Identifier: BSD-2-Clause
// apprise-api golden-differential tests (core-foundation, group F — task 6.4).
// Asserts fixtures/apprise-api.json (upstream apprise v1.12.0): default form
// encoding + secure scheme, credentials (user:pass@ and the user@ `user:None`
// quirk), the `?method=json` payload-encoding path (still POST) with and without
// a base64-embedded attachment, illegal method / invalid token (noRequest), and
// that ONLY the `+` header prefix is honoured (`-`/`:` are ignored).
//
// apprise-api's `Accept: application/json` is SEMANTIC, so the ignore set below
// omits `accept` (the header is compared). X-Apprise-ID / X-Apprise-Recursion-
// Count are pinned via the seeded asset and are likewise compared. Body encoding
// differs per case (form by default, JSON when ?method=json), so each case picks
// its bodyMode rather than sharing one runGolden mode.
//
// Multipart delivery (method=form WITH an attachment) is a real code path that
// is DEFERRED this batch (design Open Question / task 6.7); the smoke test at the
// bottom pins the batch-1 refusal so the path is not left zero-verified.

import { afterEach, describe, expect, test } from 'vitest'
import { AppriseAttachment } from '../src/attachment/base.js'
import { AttachMemory } from '../src/attachment/memory.js'
import { Apprise } from '../src/core/apprise.js'
import { setTransport, type TransportRequest } from '../src/core/transport.js'
import {
  NotifyAppriseAPI,
  type NotifyAppriseAPIArgs,
} from '../src/plugins/apprise-api.js'
import { type BodyMode, loadFixture, matchCase } from './golden.js'

// Transport-default headers to ignore — the DEFAULT set MINUS `accept` (which is
// semantic here). Everything else the plugin sets is compared.
const IGNORE: ReadonlySet<string> = new Set([
  'content-length',
  'accept-encoding',
  'connection',
  'host',
])

describe('apprise-api golden differential', () => {
  const fixture = loadFixture('fixtures/apprise-api.json')
  for (const c of fixture.cases) {
    // `?method=json` selects JSON body encoding; everything else is form.
    const bodyMode: BodyMode = c.input.url.includes('method=json')
      ? 'json'
      : 'form'
    test(c.name, async () => {
      await matchCase(c, { bodyMode, ignoreHeaders: IGNORE })
    })
  }
})

describe('apprise-api url() round-trip', () => {
  test('serialises to apprise:// (token re-appended) and re-parses equal', () => {
    const url = 'apprise://user@localhost/abc123?method=json&+X-H=1'
    const plugin = new NotifyAppriseAPI(
      NotifyAppriseAPI.parseUrl(url) as unknown as NotifyAppriseAPIArgs,
    )
    const serialised = plugin.url()
    expect(serialised.startsWith('apprise://')).toBe(true)
    expect(serialised).toContain('method=json')

    const reparsed = new NotifyAppriseAPI(
      NotifyAppriseAPI.parseUrl(serialised) as unknown as NotifyAppriseAPIArgs,
    )
    expect(reparsed.token).toBe(plugin.token)
    expect(reparsed.method).toBe(plugin.method)
    expect(reparsed.headers).toEqual(plugin.headers)
    expect(new Apprise().add(serialised)).toBe(true)
  })
})

describe('apprise-api url(privacy) masks both token and password (C2-2)', () => {
  const build = () =>
    new NotifyAppriseAPI(
      NotifyAppriseAPI.parseUrl(
        'apprise://user:pass@localhost/SECRETTOKEN',
      ) as unknown as NotifyAppriseAPIArgs,
    )

  test('url(true) leaks neither the token nor the password verbatim', () => {
    const url = build().url(true)
    expect(url).not.toContain('SECRETTOKEN') // token: Outer-masked
    expect(url).not.toContain('pass') // password: Secret-masked
    expect(url).toContain('****') // password mask
    expect(url).toContain('S...N') // token mask (first+...+last)
  })

  test('url(false) emits the token and password verbatim', () => {
    const url = build().url(false)
    expect(url).toContain('SECRETTOKEN')
    expect(url).toContain('user:pass@')
  })
})

describe('apprise-api success is EXACTLY 200 (not any 2xx)', () => {
  afterEach(() => {
    setTransport(null)
  })

  const drive = async (status: number): Promise<boolean> => {
    setTransport(async () => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'x',
      headers: new Headers(),
      text: async () => '{}',
    }))
    const app = new Apprise()
    expect(app.add('apprise://localhost/abc123')).toBe(true)
    return app.notify({ body: 'hi' })
  }

  test('200 -> true', async () => {
    expect(await drive(200)).toBe(true)
  })

  test('201 -> false (upstream requires == requests.codes.ok)', async () => {
    expect(await drive(201)).toBe(false)
  })

  test('202 -> false', async () => {
    expect(await drive(202)).toBe(false)
  })
})

describe('apprise-api multipart attachment (method=form, batch-1 deferred)', () => {
  afterEach(() => {
    setTransport(null)
  })

  test('a form-method attachment is refused (false) and emits NO wire request', async () => {
    const seen: TransportRequest[] = []
    setTransport(async (req) => {
      seen.push(req)
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: async () => '{}',
      }
    })

    const app = new Apprise()
    // Default method is form -> attachment would go multipart (deferred).
    expect(app.add('apprise://localhost/abc123')).toBe(true)
    const attach = new AppriseAttachment(
      new AttachMemory({ content: 'x', name: 'a.txt' }),
    )
    expect(await app.notify({ body: 'hi', attach })).toBe(false)
    expect(
      seen,
      'multipart path must not put a request on the wire',
    ).toHaveLength(0)
  })
})
