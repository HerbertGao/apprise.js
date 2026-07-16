// SPDX-License-Identifier: BSD-2-Clause

import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { AppriseAttachment } from '../src/attachment/base.js'
import { AttachMemory } from '../src/attachment/memory.js'
import { Apprise } from '../src/core/apprise.js'
import type {
  TransportRequest,
  TransportResponse,
} from '../src/core/transport.js'
import {
  python314Gzip,
  setPushoverEntropySourceForTest,
} from '../src/internal/pushover-codec.js'
import {
  NotifyPushover,
  type NotifyPushoverArgs,
} from '../src/plugins/pushover.js'
import {
  type FixtureCase,
  loadFixture,
  matchCase,
  PUSH_HEADER_PROFILES,
} from './golden.js'

const fixture = loadFixture('fixtures/pushover.json')

async function withStrictEntropy(
  seeds: readonly string[],
  run: () => Promise<void>,
): Promise<void> {
  const queue = seeds.map((seed) => Buffer.from(seed, 'hex'))
  let violation: Error | null = null
  setPushoverEntropySourceForTest((size) => {
    if (size !== 16) {
      violation = new Error(
        `Pushover entropy requested ${size} bytes instead of 16`,
      )
      throw violation
    }
    const next = queue.shift()
    if (!next) {
      violation = new Error('Pushover entropy queue exhausted')
      throw violation
    }
    return next
  })
  try {
    await run()
    if (violation) throw violation
    if (queue.length !== 0) {
      throw new Error(`Pushover entropy queue has ${queue.length} seed(s) left`)
    }
  } finally {
    setPushoverEntropySourceForTest(null)
  }
}

describe.sequential('pushover golden differential', () => {
  for (const c of fixture.cases) {
    test(c.name, async () => {
      const run = async (): Promise<void> => {
        await matchCase(c, {
          bodyMode: 'form',
          headerProfile: PUSH_HEADER_PROFILES.pushover,
        })
      }
      const entropy = c.seeds?.entropyHex
      if (entropy) await withStrictEntropy(entropy, run)
      else await run()
    })
  }
})

const parse = (url: string): NotifyPushoverArgs =>
  NotifyPushover.parseUrl(url) as unknown as NotifyPushoverArgs

const response = (status = 200): TransportResponse => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  headers: new Headers(),
  text: async () => '',
  arrayBuffer: async () => new ArrayBuffer(0),
})

function expectedRequest(c: FixtureCase): string {
  const body = c.expected.request?.body?.text
  if (typeof body !== 'string') throw new Error(`${c.name} is not a form case`)
  return body
}

describe.sequential('pushover E2EE codec and strict entropy seam', () => {
  test.each([
    ['', '1f8b08000000000002ff03000000000000000000'],
    [
      'encrypted body',
      '1f8b08000000000002ff4bcd4b2eaa2c28494d5148ca4fa90400ee3c71770e000000',
    ],
    [
      '你好 pushover',
      '1f8b08000000000002ff7bb277c1d3a57b150a4a8b33f2cb528b0051d7f4d70f000000',
    ],
  ])('matches Python 3.14 gzip bytes for %j', (plaintext, expected) => {
    expect(python314Gzip(Buffer.from(plaintext)).toString('hex')).toBe(expected)
  })

  test('consumes fields in message/title/url/url_title order and authenticates with the AES key', () => {
    const c = fixture.cases.find(
      (candidate) => candidate.name === 'e2ee-all-fields',
    )
    if (!c) throw new Error('missing e2ee fixture')
    const form = new URLSearchParams(expectedRequest(c))
    const fields = ['message', 'title', 'url', 'url_title'] as const
    const seeds = c.seeds?.entropyHex ?? []
    const key = Buffer.from(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'hex',
    )
    fields.forEach((field, index) => {
      const wire = Buffer.from(form.get(field) ?? '', 'base64')
      expect(wire.subarray(0, 16).toString('hex')).toBe(seeds[index])
      const authenticated = wire.subarray(0, -32)
      expect(wire.subarray(-32)).toEqual(
        createHmac('sha256', key).update(authenticated).digest(),
      )
    })
    expect(form.get('encrypted')).toBe('1')
  })

  test('rejects insufficient entropy without sending plaintext and restores the seam', async () => {
    let requests = 0
    const plugin = new NotifyPushover({
      ...parse(
        'pover://USERKEY@APPTOKEN/device?key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ),
      transport: async () => {
        requests += 1
        return response()
      },
    })
    await expect(
      withStrictEntropy(['000102030405060708090a0b0c0d0e0f'], async () => {
        await expect(plugin.send('body', 'title')).resolves.toBe(false)
      }),
    ).rejects.toThrow('queue exhausted')
    expect(requests).toBe(0)

    await expect(plugin.send('body', 'title')).resolves.toBe(true)
    expect(requests).toBe(1)
  })

  test('rejects surplus entropy after an otherwise successful send', async () => {
    const plugin = new NotifyPushover({
      ...parse(
        'pover://USERKEY@APPTOKEN/device?key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ),
      transport: async () => response(),
    })
    await expect(
      withStrictEntropy(
        [
          '000102030405060708090a0b0c0d0e0f',
          '101112131415161718191a1b1c1d1e1f',
          '202122232425262728292a2b2c2d2e2f',
        ],
        async () => {
          await expect(plugin.send('body', 'title')).resolves.toBe(true)
        },
      ),
    ).rejects.toThrow('1 seed(s) left')
  })

  test('the empty-body attachment cross-case exposes plaintext filenames', () => {
    const c = fixture.cases.find(
      (candidate) => candidate.name === 'e2ee-empty-body-multi-attachment',
    )
    const requests = c?.expected.requests ?? []
    expect(requests).toHaveLength(2)
    const bodies = requests.map((request) =>
      Buffer.from(request.body?.base64 ?? '', 'base64').toString('latin1'),
    )
    expect(bodies[0]).toContain('name="message"\r\n\r\nvisible-one.png')
    expect(bodies[1]).toContain('name="message"\r\n\r\nvisible-two.jpg')
    expect(
      bodies.every((body) => body.includes('name="encrypted"\r\n\r\n1')),
    ).toBe(true)
  })
})

describe('pushover targets, attachments and privacy', () => {
  test('the public plugin module does not expose deterministic entropy seams', async () => {
    const publicModule = await import('../src/plugins/pushover.js')
    expect(publicModule).not.toHaveProperty('setPushoverEntropySourceForTest')
    expect(publicModule).not.toHaveProperty('python314Gzip')
  })

  test('oversized images fail before transport', async () => {
    const attachment = new AttachMemory({
      content: Buffer.alloc(5_242_881),
      name: 'too-large.png',
      mimetype: 'image/png',
    })
    let requests = 0
    const plugin = new NotifyPushover({
      ...parse('pover://USERKEY@APPTOKEN/device'),
      transport: async () => {
        requests += 1
        return response()
      },
    })
    await expect(
      plugin.send('body', 'title', undefined, {
        attach: new AppriseAttachment(attachment),
      }),
    ).resolves.toBe(false)
    expect(requests).toBe(0)
  })

  test('unsupported attachments fall back to form delivery', async () => {
    const requests: TransportRequest[] = []
    const plugin = new NotifyPushover({
      ...parse('pover://USERKEY@APPTOKEN/device'),
      transport: async (request) => {
        requests.push(request)
        return response()
      },
    })
    await expect(
      plugin.send('body', 'title', undefined, {
        attach: new AppriseAttachment(
          new AttachMemory({ content: 'text', name: 'note.txt' }),
        ),
      }),
    ).resolves.toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers?.['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
  })

  test('masks user key, token and encryption key in private URLs and diagnostics', () => {
    const raw =
      'pover://USERSECRET@TOKENSECRET/device?key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const plugin = new NotifyPushover(parse(raw))
    const privateUrl = plugin.url(true)
    expect(privateUrl).not.toContain('USERSECRET')
    expect(privateUrl).not.toContain('TOKENSECRET')
    expect(privateUrl).not.toContain(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    )

    const messages: string[] = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => messages.push(event.message),
      }),
    })
    expect(app.add(raw)).toBe(true)
    expect(messages.join('\n')).not.toContain('TOKENSECRET')
  })
})
