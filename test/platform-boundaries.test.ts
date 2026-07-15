// SPDX-License-Identifier: BSD-2-Clause
// Platform-boundary adversarial input coverage (issue #9 item ③).
//
// #9 twice caught a bug of one shape: a user-controllable value reaches a Web
// API that rejects it, the rejection is indistinguishable from a legitimate
// `notify()===false`, and it happens in a path the normal tests never execute
// (`fetch` GET-with-body, `AbortSignal.timeout` on a non-integer). The guard is
// a boundary TABLE at every "user value → Web API" seam.
//
// Two of the four seams are already tabled elsewhere and are NOT duplicated here:
//   - AbortSignal.timeout(ms)  ← ?cto=/?rto= floats   → test/timeout.test.ts
//   - fetch(method, body)      ← plugin method + body → test/transport.test.ts
// This file covers the remaining two:
//   - fetch headers            ← custom `+header` family (arbitrary user name/value)
//   - fetch(url)               ← plugin host/path
//
// The #9 discipline (item ②): a failure-path assertion states the MECHANISM,
// never a bare boolean. A header the platform rejects MUST surface as
// notify()=false WITH an `unhandled-exception` diagnostic — a bare `false` is
// exactly the black hole the two bugs hid in; a malformed target MUST be
// rejected at add() (parse time), not throw uncaught out of notify().

import { afterEach, describe, expect, test, vi } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { Apprise } from '../src/core/apprise.js'
import { setTransport } from '../src/core/transport.js'
import '../src/plugins/custom-json.js'

afterEach(() => {
  setTransport(null)
  vi.restoreAllMocks()
})

/**
 * A `fetch` stand-in that validates exactly where the platform does: `new URL()`
 * on the target and `new Headers()` on the header record both throw on invalid
 * input BEFORE any socket — the same `TypeError` native `fetch` raises (anchored
 * against the real platform by the `real native fetch` test below). Valid input
 * resolves 200. Deterministic and offline while faithfully exercising the send
 * path's error handling.
 */
function validatingFetch(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    new URL(url)
    new Headers(init?.headers)
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => '{}',
    }
  }) as unknown as typeof fetch
}

/** add() + notify() a single URL through the default transport, capturing the
 *  diagnostic kinds the instance emitted. */
async function drive(
  url: string,
  fetchImpl: typeof fetch = validatingFetch(),
): Promise<{ added: boolean; notified: boolean; kinds: string[] }> {
  const kinds: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl)
  const apprise = new Apprise({
    asset: new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) }),
  })
  const added = apprise.add(url)
  if (!added) {
    return { added, notified: false, kinds }
  }
  const notified = await apprise.notify({ body: 'hi' })
  return { added, notified, kinds }
}

describe('fetch headers — user-controllable header name/value (custom `+` family)', () => {
  // A `?+Name=Value` puts an arbitrary header on the wire request. rocketchat's
  // URL-derived `X-User-Id`/`X-Auth-Token` route through the same fetch-headers
  // seam; the `+` family is the general surface, so it tables the whole class.

  // The platform REJECTS these — must be a DISTINGUISHABLE failure (false + a
  // diagnostic), never a bare false and never an uncaught throw out of notify().
  test.each([
    ['newline in value', 'json://localhost/?+X-Foo=bar%0Abaz'],
    ['space in name', 'json://localhost/?+X%20Foo=bar'],
    ['unicode in name', 'json://localhost/?+X-Caf%C3%A9=bar'],
    ['NUL control char in value', 'json://localhost/?+X-Foo=a%00b'],
  ])('a header the platform rejects (%s) → false + diagnostic', async (_l, url) => {
    const { added, notified, kinds } = await drive(url)
    expect(added).toBe(true) // parses fine — the value only bites at send()
    expect(notified).toBe(false)
    // The mechanism: had the send path swallowed the throw into a silent false,
    // THIS is the assertion that reddens — the #9 black-hole regression guard.
    expect(kinds).toContain('unhandled-exception')
  })

  // The platform ACCEPTS these — they ride through to a real (stubbed) send.
  test.each([
    ['unicode in value (Latin-1)', 'json://localhost/?+X-Foo=caf%C3%A9'],
    ['empty value', 'json://localhost/?+X-Foo='],
  ])('a header the platform accepts (%s) → notify=true', async (_l, url) => {
    const { notified, kinds } = await drive(url)
    expect(notified).toBe(true)
    expect(kinds).not.toContain('unhandled-exception')
  })

  test('real native fetch rejects an invalid header and the send path diagnoses it', async () => {
    // No stub: the real platform validates the header and throws BEFORE any
    // socket (verified ~50ms, no network). Anchors validatingFetch() above to
    // real fetch — if native validation ever diverged, this would drift.
    const { added, notified, kinds } = await drive(
      'json://localhost/?+X-Foo=bar%0Abaz',
      globalThis.fetch, // real fetch (restored in afterEach)
    )
    expect(added).toBe(true)
    expect(notified).toBe(false)
    expect(kinds).toContain('unhandled-exception')
  })
})

describe('fetch(url) — user-controllable host/path', () => {
  // A target the platform cannot represent is rejected at add() (parseUrl), so it
  // never reaches fetch — add()=false, not a throw escaping notify().
  test.each([
    ['space in host', 'json://loc alhost/p'],
    ['unicode host', 'json://café.example/p'],
  ])('a malformed target (%s) is rejected at add()', async (_l, url) => {
    const { added } = await drive(url)
    expect(added).toBe(false)
  })

  test('a well-formed target notifies', async () => {
    const { added, notified, kinds } = await drive('json://localhost/p')
    expect(added).toBe(true)
    expect(notified).toBe(true)
    expect(kinds).not.toContain('unhandled-exception')
  })
})
