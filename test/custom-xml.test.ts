// SPDX-License-Identifier: BSD-2-Clause
// custom-xml golden-differential tests (core-foundation, group F — task 6.3).
// Asserts fixtures/custom-xml.json (captured from upstream apprise v1.12.0) with
// bodyMode 'raw' (the SOAP envelope must match byte-for-byte, including the XML
// declaration, namespaces, escape_html output for `<`/`&`/`'`/`"`, and the
// base64-embedded attachment): default POST + secure scheme, credentials
// (user:pass@ and the user@ `user:None` quirk), `?method=` override + illegal
// method (noRequest), and the `+`/`:` prefixes.
//
// The `-` (GET params) prefix is a faithful upstream QUIRK: parsed and echoed by
// url() but NEVER sent (upstream send() passes no params=). It therefore has NO
// golden fixture and is verified by the url()/wire unit tests below instead.

import { afterEach, describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { Apprise } from '../src/core/apprise.js'
import { setTransport, type TransportRequest } from '../src/core/transport.js'
import { NotifyXML, type NotifyXMLArgs } from '../src/plugins/custom-xml.js'
import { runGolden } from './golden.js'

describe('custom-xml golden differential', () => {
  runGolden('fixtures/custom-xml.json', { bodyMode: 'raw' })
})

describe('custom-xml `-` params (parsed + url()-echoed, never sent)', () => {
  afterEach(() => {
    setTransport(null)
  })

  test('url() renders the xml:// scheme, echoes -k=v, and round-trips', () => {
    const results = NotifyXML.parseUrl('xml://localhost/path?-k=v')
    expect(results).not.toBeNull()
    const plugin = new NotifyXML(results as unknown as NotifyXMLArgs)
    expect(plugin.params).toEqual(new Map([['k', 'v']]))

    const url = plugin.url()
    // url() MUST render the plugin's own scheme, NOT the http/https wire scheme.
    expect(url.startsWith('xml://')).toBe(true)
    expect(url).toContain('-k=v')
    // Round-trip: the serialised URL re-parses into an equivalent instance.
    expect(new Apprise().add(url)).toBe(true)
  })

  test('url() renders xmls:// for a secure instance', () => {
    const results = NotifyXML.parseUrl('xmls://localhost/path')
    expect(results).not.toBeNull()
    const plugin = new NotifyXML(results as unknown as NotifyXMLArgs)
    const url = plugin.url()
    expect(url.startsWith('xmls://')).toBe(true)
    expect(new Apprise().add(url)).toBe(true)
  })

  test('a `:` rename colliding with a built-in emits ONE element (CR2)', async () => {
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
    // :Message=Version renames the Message element onto the built-in Version
    // element's name. Upstream builds payload_base as a dict, so only ONE
    // <Version> survives (last value wins); the old Array emitted two.
    expect(app.add('xml://localhost/path?:Message=Version')).toBe(true)
    expect(await app.notify({ title: 'hi', body: 'the-body' })).toBe(true)
    expect(seen).toHaveLength(1)
    const body = String((seen[0] as TransportRequest).body)
    expect((body.match(/<Version>/g) ?? []).length).toBe(1)
    // Last write wins (dict semantics): the surviving <Version> carries the body.
    expect(body).toContain('<Version>the-body</Version>')
    expect(body).not.toContain('<Version>1.1</Version>')
  })

  test('GET/HEAD fails loud: xml://host?method=get add() true, notify() false', async () => {
    // Parses & constructs (url() round-trips), but send() throws rather than
    // silently shipping an empty GET; the throw folds via allSettled to false.
    const kinds: string[] = []
    const asset = new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) })
    const app = new Apprise({ asset })
    expect(app.add('xml://localhost/path?method=get')).toBe(true)
    expect(await app.notify({ body: 'hi' })).toBe(false)
    // The thrown send is surfaced as a diagnostic, not swallowed into a bare false.
    expect(kinds).toContain('unhandled-exception')
  })

  test('the -k param does NOT appear in the wire request URL', async () => {
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
    expect(app.add('xml://localhost/path?-k=v')).toBe(true)
    expect(await app.notify({ body: 'hi' })).toBe(true)
    expect(seen).toHaveLength(1)
    const req = seen[0] as TransportRequest
    expect(req.url).toBe('http://localhost/path')
    expect(req.url).not.toContain('k=v')
  })
})
