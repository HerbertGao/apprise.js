// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { AppriseAttachment } from '../src/attachment/base.js'
import { AttachMemory } from '../src/attachment/memory.js'
import { Apprise } from '../src/core/apprise.js'
import type { TransportResponse } from '../src/core/transport.js'
import {
  NotifyPushBullet,
  type NotifyPushBulletArgs,
} from '../src/plugins/pushbullet.js'
import { loadFixture, runGolden } from './golden.js'

describe('pushbullet golden differential', () => {
  runGolden('fixtures/pushbullet.json', { bodyMode: 'json' })
})

const parse = (url: string): NotifyPushBulletArgs =>
  NotifyPushBullet.parseUrl(url) as unknown as NotifyPushBulletArgs

const response = (status: number, body: string): TransportResponse => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'OK',
  headers: new Headers(),
  text: async () => body,
  arrayBuffer: async () => Uint8Array.from(Buffer.from(body)).buffer,
})

describe('pushbullet chain, targeting and privacy', () => {
  test('the two-attachment/two-target fixture has the complete ten-request chain', () => {
    const fixture = loadFixture('fixtures/pushbullet.json')
    const c = fixture.cases.find(
      (candidate) => candidate.name === 'two-attachments-two-targets',
    )
    const requests = c?.expected.requests ?? []
    expect(c?.expected.expectedCount).toBe(10)
    expect(requests).toHaveLength(10)
    expect(requests.slice(0, 4).map((request) => request.url)).toEqual([
      'https://api.pushbullet.com/v2/upload-request',
      'https://upload.example/one',
      'https://api.pushbullet.com/v2/upload-request',
      'https://upload.example/hello',
    ])

    const delivery = requests
      .slice(4)
      .map(
        (request) =>
          JSON.parse(request.body?.text ?? '{}') as Record<string, unknown>,
      )
    expect(delivery[0]).toMatchObject({ type: 'note', channel_tag: 'alerts' })
    expect(delivery[3]).toMatchObject({
      type: 'note',
      email: 'person@example.com',
    })
    for (const payload of [
      delivery[1],
      delivery[2],
      delivery[4],
      delivery[5],
    ]) {
      expect(payload).toMatchObject({ type: 'file' })
      expect(payload).not.toHaveProperty('channel_tag')
      expect(payload).not.toHaveProperty('email')
      expect(payload).not.toHaveProperty('device_iden')
    }
    expect(delivery[1]).toHaveProperty('image_url')
    expect(delivery[2]).not.toHaveProperty('image_url')
  })

  test('upload-request fields fail closed before the dynamic upload', async () => {
    let calls = 0
    const plugin = new NotifyPushBullet({
      ...parse('pbul://ACCESS_TOKEN/device'),
      transport: async () => {
        calls += 1
        return response(
          200,
          '{"file_name":"one.png","file_type":"image/png","file_url":"https://files.example/one.png"}',
        )
      },
    })
    const attachment = new AppriseAttachment(
      new AttachMemory({
        content: Buffer.from([1, 2, 3]),
        name: 'one.png',
        mimetype: 'image/png',
      }),
    )
    await expect(
      plugin.send('body', 'title', undefined, { attach: attachment }),
    ).resolves.toBe(false)
    const fixture = loadFixture('fixtures/pushbullet.json')
    const c = fixture.cases.find(
      (candidate) => candidate.name === 'upload-request-missing-field',
    )
    expect(c?.expected.request).toBeDefined()
    expect(c?.expected.result).toBe(false)
    expect(plugin.targets).toEqual(['device'])
    expect(calls).toBe(1)
  })

  test('all-devices serialization removes the internal sentinel', () => {
    const plugin = new NotifyPushBullet(parse('pbul://ACCESS_TOKEN'))
    expect(plugin.targets).toEqual(['ALL_DEVICES'])
    expect(plugin.url()).toContain('pbul://ACCESS_TOKEN//?')
    expect(plugin.url()).not.toContain('ALL_DEVICES')
  })

  test('masks the access token in private URLs and diagnostics', () => {
    const raw = 'pbul://ACCESS_TOKEN_SECRET/device'
    const plugin = new NotifyPushBullet(parse(raw))
    expect(plugin.url(true)).not.toContain('ACCESS_TOKEN_SECRET')

    const messages: string[] = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => messages.push(event.message),
      }),
    })
    expect(app.add(raw)).toBe(true)
    expect(messages.join('\n')).not.toContain('ACCESS_TOKEN_SECRET')
  })
})
