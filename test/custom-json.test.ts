// SPDX-License-Identifier: BSD-2-Clause
// custom-json golden-differential tests (core-foundation, group E — task 6.1).
// Every case in fixtures/custom-json.json (captured from upstream apprise
// v1.12.0) is asserted field-by-field against the TS NotifyJSON plugin: default
// POST + secure scheme, credentials (user:pass@ and user@ with the `user:None`
// byte quirk), `?method=` override + illegal method (noRequest), the
// `+`/`-`/`:` prefixes, and a base64-embedded attachment.

import { afterEach, describe, expect, test } from 'vitest'
import { AppriseAttachment } from '../src/attachment/base.js'
import { AttachMemory } from '../src/attachment/memory.js'
import { Apprise } from '../src/core/apprise.js'
import { setTransport, type TransportRequest } from '../src/core/transport.js'
// Side-effect import registers the json/jsons schemes.
import { NotifyJSON, type NotifyJSONArgs } from '../src/plugins/custom-json.js'
import { runGolden } from './golden.js'

describe('custom-json golden differential', () => {
  runGolden('fixtures/custom-json.json', { bodyMode: 'json' })
})

describe('custom-json url() round-trip', () => {
  test('serialises to json:// and re-parses to an equivalent instance', () => {
    const url =
      'json://user:pass@localhost/path?method=PUT&+X-Token=abc&-baz=qux&:foo=bar'
    const plugin = new NotifyJSON(
      NotifyJSON.parseUrl(url) as unknown as NotifyJSONArgs,
    )
    const serialised = plugin.url()
    expect(serialised.startsWith('json://')).toBe(true)
    expect(serialised).toContain('method=PUT')

    const reparsed = new NotifyJSON(
      NotifyJSON.parseUrl(serialised) as unknown as NotifyJSONArgs,
    )
    expect(reparsed.method).toBe(plugin.method)
    expect(reparsed.headers).toEqual(plugin.headers)
    expect(reparsed.params).toEqual(plugin.params)
    expect(reparsed.payloadExtras).toEqual(plugin.payloadExtras)
    expect(new Apprise().add(serialised)).toBe(true)
  })
})

describe('TRUNCATE overflow clamps >1 attachment to the first', () => {
  afterEach(() => {
    setTransport(null)
  })

  test('?overflow=truncate + 2 attachments embeds ONLY the first', async () => {
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
    expect(app.add('json://localhost/path?overflow=truncate')).toBe(true)
    const attach = new AppriseAttachment([
      new AttachMemory({ content: 'first', name: 'a.txt' }),
      new AttachMemory({ content: 'second', name: 'b.txt' }),
    ])
    expect(await app.notify({ body: 'hi', attach })).toBe(true)
    expect(seen).toHaveLength(1)

    const body = JSON.parse((seen[0] as TransportRequest).body as string) as {
      attachments: Array<{ filename: string }>
    }
    expect(body.attachments).toHaveLength(1)
    expect(body.attachments[0]?.filename).toBe('a.txt')
  })
})
