// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { Apprise } from '../src/core/apprise.js'
import type {
  TransportRequest,
  TransportResponse,
} from '../src/core/transport.js'
import {
  GotifyPriority,
  NotifyGotify,
  type NotifyGotifyArgs,
} from '../src/plugins/gotify.js'
import { runGolden } from './golden.js'

describe('gotify golden differential', () => {
  runGolden('fixtures/gotify.json', { bodyMode: 'json' })
})

const response = (status = 200): TransportResponse => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  headers: new Headers(),
  text: async () => '',
  arrayBuffer: async () => new ArrayBuffer(0),
})

const parse = (url: string): NotifyGotifyArgs =>
  NotifyGotify.parseUrl(url) as unknown as NotifyGotifyArgs

describe('gotify endpoint, token and priority contract', () => {
  test('token stays in X-Gotify-Key and custom path joins message once', async () => {
    let observed: TransportRequest | undefined
    const plugin = new NotifyGotify({
      ...parse(
        'gotify://gotify.example:8080/custom/api/SECRET_TOKEN?priority=high',
      ),
      transport: async (request) => {
        observed = request
        return response()
      },
    })

    await expect(plugin.send('body', 'title')).resolves.toBe(true)
    expect(observed?.url).toBe('http://gotify.example:8080/custom/api/message')
    expect(observed?.url).not.toContain('SECRET_TOKEN')
    expect(observed?.headers?.['X-Gotify-Key']).toBe('SECRET_TOKEN')
    expect(JSON.parse(String(observed?.body))).toEqual({
      priority: GotifyPriority.HIGH,
      title: 'title',
      message: 'body',
    })
  })

  test('canonical URL omits default port, preserves path, and masks token', () => {
    const plugin = new NotifyGotify(
      parse('gotifys://gotify.example:443/custom/TOKENVALUE'),
    )
    expect(plugin.url()).toContain(
      'gotifys://gotify.example/custom/TOKENVALUE/',
    )
    expect(plugin.url()).not.toContain(':443')
    expect(plugin.url(true)).toContain('/T...E/')
    expect(plugin.url(true)).not.toContain('TOKENVALUE')
  })

  test.each([
    ['1', GotifyPriority.LOW],
    ['4', GotifyPriority.MODERATE],
    ['normal', GotifyPriority.NORMAL],
    ['8', GotifyPriority.HIGH],
    ['10', GotifyPriority.EMERGENCY],
    ['invalid', GotifyPriority.NORMAL],
  ])('maps priority %s to %s', (value, expected) => {
    expect(
      new NotifyGotify(parse(`gotify://gotify.example/TOKEN?priority=${value}`))
        .priority,
    ).toBe(expected)
  })

  test('only HTTP 200 succeeds', async () => {
    const plugin = new NotifyGotify({
      ...parse('gotify://gotify.example/TOKEN'),
      transport: async () => response(204),
    })
    await expect(plugin.send('body')).resolves.toBe(false)
  })

  test('invalid token fails through plugin diagnostics without leaking a secret', () => {
    const events: Array<{ kind: string; message: string }> = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => events.push(event),
      }),
    })
    expect(app.add('gotify://gotify.example/TOKEN%20SECRET')).toBe(false)
    expect(events.map((event) => event.kind)).toContain('plugin-error')
    expect(events.map((event) => event.message).join('\n')).not.toContain(
      'TOKEN SECRET',
    )
  })
})
