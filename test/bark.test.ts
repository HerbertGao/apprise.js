// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { Apprise } from '../src/core/apprise.js'
import type {
  TransportRequest,
  TransportResponse,
} from '../src/core/transport.js'
import {
  NotifyBark,
  type NotifyBarkArgs,
  NotifyBarkLevel,
} from '../src/plugins/bark.js'
import { runGolden } from './golden.js'

describe('bark golden differential', () => {
  runGolden('fixtures/bark.json', { bodyMode: 'json' })
})

const parse = (url: string): NotifyBarkArgs =>
  NotifyBark.parseUrl(url) as unknown as NotifyBarkArgs

const response = (status = 200): TransportResponse => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'OK',
  headers: new Headers(),
  text: async () => '',
  arrayBuffer: async () => new ArrayBuffer(0),
})

describe('bark targeted contract', () => {
  test('no targets short-circuits without a request', async () => {
    let calls = 0
    const plugin = new NotifyBark({
      ...parse('bark://bark.example'),
      transport: async () => {
        calls += 1
        return response()
      },
    })
    await expect(plugin.send('body')).resolves.toBe(false)
    expect(calls).toBe(0)
  })

  test('sends devices in upstream reverse-sorted order and aggregates failures', async () => {
    const requests: TransportRequest[] = []
    const plugin = new NotifyBark({
      ...parse('bark://bark.example/device-a/device-c/device-b?image=no'),
      transport: async (request) => {
        requests.push(request)
        return response(requests.length === 2 ? 500 : 200)
      },
    })
    await expect(plugin.send('fanout')).resolves.toBe(false)
    expect(
      requests.map((request) => JSON.parse(String(request.body)).device_key),
    ).toEqual(['device-c', 'device-b', 'device-a'])
  })

  test('custom icon wins over the asset image and markdown uses its own field', async () => {
    let request: TransportRequest | undefined
    const plugin = new NotifyBark({
      ...parse(
        'bark://bark.example/device?format=markdown&icon=https%3A%2F%2Fexample.com%2Fcustom.png',
      ),
      transport: async (value) => {
        request = value
        return response()
      },
    })
    await plugin.send('**body**')
    expect(JSON.parse(String(request?.body))).toMatchObject({
      markdown: '**body**',
      icon: 'https://example.com/custom.png',
    })
    expect(JSON.parse(String(request?.body))).not.toHaveProperty('body')
  })

  test('parameter parsing follows upstream fallback and retention edges', () => {
    const invalid = new NotifyBark(
      parse('bark://bark.example/device?sound=bad&level=z&volume=bad&badge=-1'),
    )
    expect(invalid.sound).toBeNull()
    expect(invalid.level).toBeNull()
    expect(invalid.volume).toBeNull()
    expect(invalid.badge).toBeNull()

    const retained = new NotifyBark(
      parse('bark://bark.example/device?level=critical&volume=11'),
    )
    expect(retained.level).toBe(NotifyBarkLevel.CRITICAL)
    expect(retained.volume).toBe(11)
  })

  test('privacy masks Basic password and CWE-312 diagnostics do not leak it', () => {
    const raw = 'bark://alice:secret@bark.example/device'
    const plugin = new NotifyBark(parse(raw))
    expect(plugin.url(true)).toContain('alice:****@')
    expect(plugin.url(true)).not.toContain('secret')

    const messages: string[] = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => messages.push(event.message),
      }),
    })
    expect(app.add(raw)).toBe(true)
    expect(messages.join('\n')).not.toContain('secret')
  })
})
