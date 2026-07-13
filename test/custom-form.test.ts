// SPDX-License-Identifier: BSD-2-Clause
// custom-form golden-differential tests (core-foundation, group E — task 6.2).
// Asserts fixtures/custom-form.json (upstream apprise v1.12.0) against the TS
// NotifyForm plugin: default POST form body + secure scheme, credentials, the
// distinct `?method=GET` path (payload rides the query, body omitted), and the
// `+`/`-`/`:` prefixes.
//
// Multipart attachment delivery is DEFERRED this batch (design Open Question /
// task 6.7). Because attachment_support=true is a real code path, the smoke
// test below pins batch-1 behaviour: an attachment is refused (returns false)
// and NO wire request is emitted, rather than sending a request that would
// diverge from upstream's multipart body.

import { afterEach, describe, expect, test } from 'vitest'
import { AppriseAttachment } from '../src/attachment/base.js'
import { AttachMemory } from '../src/attachment/memory.js'
import { Apprise } from '../src/core/apprise.js'
import { setTransport, type TransportRequest } from '../src/core/transport.js'
import { NotifyForm, type NotifyFormArgs } from '../src/plugins/custom-form.js'
import { runGolden } from './golden.js'

describe('custom-form golden differential', () => {
  runGolden('fixtures/custom-form.json', { bodyMode: 'form' })
})

describe('custom-form url() round-trip', () => {
  test('serialises to form:// (incl. a `:field` rename) and re-parses equal', () => {
    const url =
      'form://user@localhost/path?method=GET&+X-Token=abc&-tag=alpha&:message=msg&:extra=val'
    const plugin = new NotifyForm(
      NotifyForm.parseUrl(url) as unknown as NotifyFormArgs,
    )
    const serialised = plugin.url()
    expect(serialised.startsWith('form://')).toBe(true)
    expect(serialised).toContain('method=GET')

    const reparsed = new NotifyForm(
      NotifyForm.parseUrl(serialised) as unknown as NotifyFormArgs,
    )
    expect(reparsed.method).toBe(plugin.method)
    expect(reparsed.headers).toEqual(plugin.headers)
    expect(reparsed.params).toEqual(plugin.params)
    expect(reparsed.payloadExtras).toEqual(plugin.payloadExtras)
    // The `:message=msg` rename must survive the round-trip (payloadOverrides).
    expect(reparsed.payloadMap).toEqual(plugin.payloadMap)
    expect(new Apprise().add(serialised)).toBe(true)
  })
})

describe('custom-form body is quote_plus byte-faithful (C2-1)', () => {
  afterEach(() => {
    setTransport(null)
  })

  test('the form body encodes `*`->%2A, keeps `~`, space->+ (not URLSearchParams)', async () => {
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
    expect(app.add('form://localhost/path?:extra=a*b~c')).toBe(true)
    expect(await app.notify({ title: 'hi', body: 'hello body' })).toBe(true)
    expect(seen).toHaveLength(1)
    // Byte-exact match to upstream requests/quote_plus (fixtures/custom-form.json
    // form-body-encoding case). The golden `form` bodyMode decodes pairs, so this
    // exact-bytes assertion is what actually catches a `URLSearchParams` regress
    // (which would emit `a*b%7Ec` instead of `a%2Ab~c`).
    expect(String((seen[0] as TransportRequest).body)).toBe(
      'version=1.0&title=hi&message=hello+body&type=info&extra=a%2Ab~c',
    )
  })
})

describe('custom-form multipart attachment (batch-1 deferred behaviour)', () => {
  afterEach(() => {
    setTransport(null)
  })

  test('an attachment is refused (false) and emits NO wire request', async () => {
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
    expect(app.add('form://localhost/path')).toBe(true)
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
