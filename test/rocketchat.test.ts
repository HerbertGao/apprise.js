// SPDX-License-Identifier: BSD-2-Clause
// rocketchat golden-differential tests (plugins-im, group E — task 6.2).
// Asserts fixtures/rocketchat.json (upstream apprise v1.12.0) across the three
// auth modes: basic (login → chat.postMessage → logout, expectedCount=3), token
// (single chat.postMessage with X-User-Id/X-Auth-Token), webhook (single POST to
// /hooks/{tokenA/tokenB}, avatar on), and basic multi-target (login + @user then
// #channel + logout, expectedCount=4 — send order users→channels, NOT URL order).
//
// The basic cases mix body encodings in ONE request sequence: the login body is
// form-urlencoded, the postMessage bodies are JSON, the logout has no body. The
// shared `matchCase` takes a single bodyMode per case, so single-request cases go
// through it (JSON) while the mixed multi-request cases use the per-request
// comparator below (form for login, JSON for postMessage, empty for logout),
// driving the SAME fixture + canned responses.

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import type { NotifyType } from '../src/common.js'
import { Apprise } from '../src/core/apprise.js'
import {
  setTransport,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../src/core/transport.js'
import {
  NotifyRocketChat,
  type NotifyRocketChatArgs,
} from '../src/plugins/rocketchat.js'
import {
  type CannedResponse,
  type FixtureBody,
  type FixtureCase,
  type FixtureRequest,
  loadFixture,
  matchCase,
} from './golden.js'

const fixture = loadFixture('fixtures/rocketchat.json')

// --- per-request helpers (mirroring golden.ts, but chosen per request) -------

const IGNORE: ReadonlySet<string> = new Set([
  'content-length',
  'accept-encoding',
  'accept',
  'connection',
  'host',
])
// login/logout inherit requests' non-semantic default UA (python-requests) which
// the plugin never sets, so the golden recorder captures no UA there — ignore it
// ONLY for those two. chat.postMessage/hooks set the semantic 'Apprise' UA, so it
// IS asserted (both here for multi-target cases and via matchCase for singles).
const IGNORE_WITH_UA: ReadonlySet<string> = new Set([...IGNORE, 'user-agent'])

function makeResponse(spec: CannedResponse | undefined): TransportResponse {
  const status = spec?.status ?? 200
  let bodyText: string
  if (spec === undefined) {
    bodyText = '{}'
  } else if (spec.body == null) {
    bodyText = ''
  } else if (spec.body.base64 !== undefined) {
    bodyText = Buffer.from(spec.body.base64, 'base64').toString()
  } else {
    bodyText = spec.body.text ?? ''
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: new Headers(spec?.headers ?? {}),
    text: async () => bodyText,
  }
}

async function driveCase(c: FixtureCase): Promise<TransportRequest[]> {
  const seeds = c.seeds ?? {}
  const asset = new AppriseAsset({
    uid: seeds.uid ?? 'itest-uid-0',
    recursion: seeds.recursion ?? 0,
  })
  const app = new Apprise({ asset })
  expect(app.add(c.input.url), 'instantiation should succeed').toBe(true)

  const canned = c.input.responses ?? []
  const requests: TransportRequest[] = []
  const transport: Transport = async (req) => {
    const idx = requests.length
    requests.push(req)
    return makeResponse(canned[idx])
  }
  setTransport(transport)
  try {
    await app.notify({
      title: c.input.title ?? '',
      body: c.input.body ?? '',
      type: (c.input.type ?? 'info') as NotifyType,
    })
  } finally {
    setTransport(null)
  }
  return requests
}

function headerValue(
  headers: Record<string, string> | undefined,
  key: string,
): string | undefined {
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === key) {
      return v
    }
  }
  return undefined
}

function compareHeaders(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
  ignore: ReadonlySet<string>,
): void {
  const keys = new Set(
    [...Object.keys(actual ?? {}), ...Object.keys(expected)]
      .map((k) => k.toLowerCase())
      .filter((k) => !ignore.has(k)),
  )
  for (const key of keys) {
    let a = headerValue(actual, key)
    let e = headerValue(expected, key)
    if (key === 'content-type') {
      a = a?.split(';')[0]?.trim()
      e = e?.split(';')[0]?.trim()
    }
    expect(a, `header "${key}"`).toBe(e)
  }
}

function bodyToString(body: TransportRequest['body']): string | null {
  if (body == null) {
    return null
  }
  return typeof body === 'string' ? body : Buffer.from(body).toString()
}

/** Parse a form body into an ordered pair list (per golden.ts). */
function parseForm(body: string): Array<[string, string]> {
  if (body === '') {
    return []
  }
  return body.split('&').map((pair) => {
    const eq = pair.indexOf('=')
    const k = eq === -1 ? pair : pair.slice(0, eq)
    const v = eq === -1 ? '' : pair.slice(eq + 1)
    return [
      decodeURIComponent(k.replace(/\+/g, ' ')),
      decodeURIComponent(v.replace(/\+/g, ' ')),
    ] as [string, string]
  })
}

/** Choose the body comparison mode from the fixture request's Content-Type. */
function compareBody(actual: string | null, expected: FixtureRequest): void {
  const body = expected.body as FixtureBody | null
  if (body == null) {
    expect(actual == null || actual === '', 'body should be empty').toBe(true)
    return
  }
  const text = body.text ?? ''
  const ct = (headerValue(expected.headers, 'content-type') ?? '').toLowerCase()
  if (ct.includes('urlencoded')) {
    expect(parseForm(actual ?? ''), 'form body').toEqual(parseForm(text))
  } else {
    // JSON (chat.postMessage / hooks) — key-order-independent.
    expect(JSON.parse(actual ?? 'null'), 'json body').toEqual(JSON.parse(text))
  }
}

function compareRequest(
  actual: TransportRequest,
  expected: FixtureRequest,
): void {
  expect(actual.method, 'method').toBe(expected.method)
  expect(actual.url, 'url').toBe(expected.url)
  // Only login/logout carry the non-semantic requests-default UA; assert the
  // 'Apprise' UA on chat.postMessage (and any other request).
  const ignore = /\/(login|logout)$/.test(expected.url)
    ? IGNORE_WITH_UA
    : IGNORE
  compareHeaders(actual.headers, expected.headers, ignore)
  compareBody(bodyToString(actual.body), expected)
}

// --- drive every fixture case ------------------------------------------------

describe('rocketchat golden differential', () => {
  for (const c of fixture.cases) {
    test(c.name, async () => {
      if (c.expected.requests) {
        // Multi-request sequence with mixed body encodings + count oracle.
        const expectedReqs = c.expected.requests
        expect(c.expected.expectedCount, 'expectedCount matches').toBe(
          expectedReqs.length,
        )
        const requests = await driveCase(c)
        expect(
          requests,
          `expected ${expectedReqs.length} requests`,
        ).toHaveLength(expectedReqs.length)
        for (let i = 0; i < expectedReqs.length; i++) {
          compareRequest(
            requests[i] as TransportRequest,
            expectedReqs[i] as FixtureRequest,
          )
        }
      } else {
        // Single-request cases (token / webhook) are pure JSON.
        await matchCase(c, { bodyMode: 'json' })
      }
    })
  }
})

// --- mode detection + url() round-trip / privacy -----------------------------

function build(url: string): NotifyRocketChat {
  return new NotifyRocketChat(
    NotifyRocketChat.parseUrl(url) as unknown as NotifyRocketChatArgs,
  )
}

describe('rocketchat auth-mode detection', () => {
  test('basic: {user}:{pass<=32}@ with a channel', () => {
    // %23 == '#' (Apprise.add does /# -> /%23; parseUrl here gets the encoded form).
    expect(build('rocket://user:pass@localhost/%23general').mode).toBe('basic')
  })

  test('token: password > 32 chars', () => {
    const pw = 'a'.repeat(36)
    expect(build(`rocket://user:${pw}@localhost/%23c`).mode).toBe('token')
  })

  test('webhook: two-segment tokenA/tokenB@host', () => {
    expect(build('rocket://tokenaaa/tokenbbb@localhost').mode).toBe('webhook')
    expect(build('rocket://tokenaaa/tokenbbb@localhost').webhook).toBe(
      'tokenaaa/tokenbbb',
    )
  })

  test('single-segment WEBHOOK@host is NOT a webhook (falls to basic → rejected)', () => {
    // No `/` -> not a webhook; basic needs user+password -> construction fails.
    const kinds: string[] = []
    const asset = new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) })
    expect(new Apprise({ asset }).add('rocket://webhooktoken@localhost')).toBe(
      false,
    )
    expect(kinds).toContain('plugin-error')
  })

  test('basic multi-target parses @user and #channel', () => {
    const p = build('rocket://user:pass@localhost/%23alpha/@bravo')
    expect(p.channels).toEqual(['alpha'])
    expect(p.users).toEqual(['bravo'])
  })
})

describe('rocketchat url() round-trip + privacy masking', () => {
  test('basic: password masked under privacy, verbatim otherwise, re-parses', () => {
    const p = build('rocket://user:secretpass@localhost/%23general')
    const priv = p.url(true)
    expect(priv).not.toContain('secretpass')
    expect(priv).toContain('****')
    expect(p.url(false)).toContain('secretpass')
    expect(new Apprise().add(p.url(false))).toBe(true)
  })

  test('token: token masked under privacy', () => {
    const pw = 'a'.repeat(36)
    const p = build(`rocket://user:${pw}@localhost/%23c`)
    expect(p.url(true)).not.toContain(pw)
    expect(p.url(true)).toContain('****')
  })

  test('webhook: webhook token masked under privacy, re-parses', () => {
    const p = build('rocket://tokenaaa/tokenbbb@localhost')
    expect(p.url(true)).not.toContain('tokenaaa')
    expect(p.url(true)).toContain('****')
    // Non-privacy emits `tokenaaa%2Ftokenbbb`, which re-parses to a webhook.
    expect(new Apprise().add(p.url(false))).toBe(true)
  })
})
