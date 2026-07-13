// SPDX-License-Identifier: BSD-2-Clause
// Golden-differential MULTI-request self-test (plugins-im, group A — task 1.3).
//
// Two legs exercise the multi-request infrastructure (harness capture + diff +
// store determinism) WITHOUT coupling to any Wave-2 plugin:
//
//   A. runGolden over a harness-DERIVED fixture (`_multireq_smoke`): a real
//      `json://…?overflow=split` capture that upstream splits into 2 ordered
//      POSTs. Proves the Python harness emits `requests`+`expectedCount` and the
//      TS diff replays the same sequence via the existing custom-json plugin.
//   B. an inline login→send→send fake plugin mirroring matrix: 1 login POST +
//      N room PUTs whose txnId comes from the store counter. Proves per-request
//      canned-response replay, the store-driven txnId counter pinned from a
//      seed, the independent `expectedCount` oracle, and per-field comparison.

import { describe, expect, test } from 'vitest'
import { NotifyBase } from '../src/core/notify-base.js'
import { PersistentStoreStub } from '../src/core/store.js'
import { request } from '../src/core/transport.js'
import { type PluginConstructor, registerPlugin } from '../src/registry.js'
import { type ParsedUrlResults, URLBase } from '../src/url.js'
// Side-effect import: registers the `json`/`jsons` schemes for leg A.
import '../src/plugins/custom-json.js'
import { type FixtureCase, matchCase, runGolden } from './golden.js'

// --- Leg A: harness-derived overflow=split (decoupled, existing plugin) ------

runGolden('fixtures/_multireq_smoke.json', { bodyMode: 'json' })

// --- Leg B: inline login→send→send with the store-driven txnId counter -------

/** 1 login POST (token from the canned response) + N room PUTs whose txnId
 *  comes from the store counter, mirroring matrix `_send_server_notification`. */
class LoginSendPlugin extends NotifyBase {
  override async send(body: string): Promise<boolean> {
    const store = new PersistentStoreStub()
    const login = await request({
      method: 'POST',
      url: 'http://fake.local/login',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: this.user }),
    })
    const token = (JSON.parse(await login.text()) as { token: string }).token
    store.set('access_token', token)
    let txn = store.get<number>('transaction_id', 0)
    for (const room of ['!aaa', '!bbb']) {
      await request({
        method: 'PUT',
        url: `http://fake.local/rooms/${room}/send/${txn}`,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ msgtype: 'm.text', body }),
      })
      txn += 1
      store.set('transaction_id', txn)
    }
    return true
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    return URLBase.parseUrl(url)
  }
}

registerPlugin('multireqstore', LoginSendPlugin as unknown as PluginConstructor)

/** A login+send case with the txnId counter pinned to start at `txnStart`. */
function loginCase(name: string, txnStart: number): FixtureCase {
  const put = (room: string, txn: number) => ({
    method: 'PUT',
    url: `http://fake.local/rooms/${room}/send/${txn}`,
    headers: {
      Authorization: 'Bearer TOKEN0',
      'Content-Type': 'application/json',
    },
    body: { text: '{"msgtype":"m.text","body":"hi"}' },
  })
  return {
    name,
    input: {
      url: 'multireqstore://user:pass@fake.local',
      body: 'hi',
      type: 'info',
      responses: [
        { status: 200, body: { text: '{"token":"TOKEN0"}' } },
        { status: 200, body: { text: '{}' } },
        { status: 200, body: { text: '{}' } },
      ],
    },
    seeds: { txn: txnStart },
    expected: {
      requests: [
        {
          method: 'POST',
          url: 'http://fake.local/login',
          headers: { 'Content-Type': 'application/json' },
          body: { text: '{"user":"user"}' },
        },
        put('!aaa', txnStart),
        put('!bbb', txnStart + 1),
      ],
      expectedCount: 3,
    },
  }
}

describe('multi-request golden: login→send→send with store txnId counter', () => {
  test('3 ordered requests; token from the login response; txn from start 0', async () => {
    await expect(
      matchCase(loginCase('txn-start-0', 0), { bodyMode: 'json' }),
    ).resolves.toBeUndefined()
  })

  test('txnId counter starts from a pinned NON-zero seed', async () => {
    await expect(
      matchCase(loginCase('txn-start-7', 7), { bodyMode: 'json' }),
    ).resolves.toBeUndefined()
  })

  test('count oracle rejects a fixture claiming fewer requests than produced', async () => {
    const c = loginCase('bad-count', 0)
    c.expected.requests = c.expected.requests?.slice(0, 2)
    c.expected.expectedCount = 2 // internally consistent, but the plugin sends 3
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow()
  })

  test('per-request comparison rejects a mismatched txnId in the URL', async () => {
    const c = loginCase('bad-txn', 0)
    // Corrupt the second PUT's txnId (should be 1, claim 9).
    const reqs = c.expected.requests ?? []
    reqs[2] = {
      method: 'PUT',
      url: 'http://fake.local/rooms/!bbb/send/9',
      headers: {
        Authorization: 'Bearer TOKEN0',
        'Content-Type': 'application/json',
      },
      body: { text: '{"msgtype":"m.text","body":"hi"}' },
    }
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow()
  })
})
