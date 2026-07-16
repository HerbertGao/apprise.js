// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { AppriseAttachment } from '../src/attachment/base.js'
import {
  AttachMemory,
  setAttachMemoryUuidSeed,
} from '../src/attachment/memory.js'
import { Apprise } from '../src/core/apprise.js'
import type {
  TransportRequest,
  TransportResponse,
} from '../src/core/transport.js'
import {
  NotifyNtfy,
  type NotifyNtfyArgs,
  NtfyAuth,
  NtfyMode,
} from '../src/plugins/ntfy.js'
import {
  type FixtureCase,
  loadFixture,
  matchCase,
  PUSH_HEADER_PROFILES,
} from './golden.js'

const fixture = loadFixture('fixtures/ntfy.json')

async function withUuid(seed: string, run: () => Promise<void>): Promise<void> {
  setAttachMemoryUuidSeed(seed)
  try {
    await run()
  } finally {
    setAttachMemoryUuidSeed(null)
  }
}

describe.sequential('ntfy golden differential', () => {
  for (const c of fixture.cases) {
    test(c.name, async () => {
      const run = async (): Promise<void> => {
        await matchCase(c, {
          bodyMode: 'json',
          headerProfile: PUSH_HEADER_PROFILES.ntfy,
        })
      }
      if (c.seeds?.uuid) await withUuid(c.seeds.uuid, run)
      else await run()
    })
  }
})

const parse = (url: string): NotifyNtfyArgs =>
  NotifyNtfy.parseUrl(url) as unknown as NotifyNtfyArgs

const response = (status = 200, body = ''): TransportResponse => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'OK',
  headers: new Headers(),
  text: async () => body,
  arrayBuffer: async () => Uint8Array.from(Buffer.from(body)).buffer,
})

function namedCase(name: string): FixtureCase {
  const c = fixture.cases.find((candidate) => candidate.name === name)
  if (!c) throw new Error(`missing ntfy fixture ${name}`)
  return c
}

describe.sequential('ntfy modes, size oracle, raw sequencing and privacy', () => {
  test.each([
    'http://ntfy.sh/topic',
    'https://ntfy.sh/topic',
  ])('native %s canonicalizes to secure cloud mode', (url) => {
    const parsed = NotifyNtfy.parseNativeUrl(url) as unknown as NotifyNtfyArgs
    const plugin = new NotifyNtfy(parsed)
    expect(plugin.mode).toBe(NtfyMode.CLOUD)
    expect(plugin.secure).toBe(true)
    expect(plugin.topics).toEqual(['topic'])
    expect(plugin.url()).toMatch(/^ntfys:\/\/topic\?/)
  })

  test('pins the 8000/8001 and non-ASCII branches to JSON/raw wire shapes', () => {
    const exact = namedCase('json-length-exactly-8000').expected.request
    const over = namedCase('json-length-8001-to-raw').expected.request
    const unicode = namedCase('unicode-python-length-to-raw').expected.request
    expect(exact?.headers['Content-Type']).toBe('application/json')
    expect(exact?.body?.text).toBeDefined()
    expect(over?.headers['Content-Type']).toBeUndefined()
    expect(over?.url).toContain('11111111-1111-4111-8111-111111111111.txt')
    expect(over?.body?.base64).toBeDefined()
    expect(unicode?.headers['Content-Type']).toBeUndefined()
    expect(unicode?.url).toContain('22222222-2222-4222-8222-222222222222.txt')
  })

  test('Python ensure_ascii categories route DEL, quotes and surrogate pairs by character length', async () => {
    const samples = ['\u007f'.repeat(1329), '"'.repeat(3986), '😀'.repeat(665)]
    for (const [index, body] of samples.entries()) {
      const requests: TransportRequest[] = []
      const plugin = new NotifyNtfy({
        ...parse('ntfys://t?image=no'),
        transport: async (request) => {
          requests.push(request)
          return response()
        },
      })
      await withUuid(
        `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`,
        async () => {
          await expect(plugin.send(body)).resolves.toBe(true)
        },
      )
      expect(requests).toHaveLength(1)
      expect(requests[0]?.headers?.['Content-Type']).toBeUndefined()
      expect(requests[0]?.url).toContain('.txt')
    }
  })

  test('a different UUID changes the full raw URL and the matcher rejects it', async () => {
    const c = namedCase('json-length-8001-to-raw')
    await expect(
      withUuid('99999999-9999-4999-8999-999999999999', async () => {
        await matchCase(c, {
          bodyMode: 'json',
          headerProfile: PUSH_HEADER_PROFILES.ntfy,
        })
      }),
    ).rejects.toThrow()

    await withUuid(c.seeds?.uuid ?? '', async () => {
      await matchCase(c, {
        bodyMode: 'json',
        headerProfile: PUSH_HEADER_PROFILES.ntfy,
      })
    })
  })

  test('two topics reset title/message on the first attachment and raw adds no Content-Type', () => {
    const requests =
      namedCase('two-topics-two-local-attachments').expected.requests ?? []
    expect(requests.map((request) => request.url)).toEqual([
      'https://ntfy.sh/topic-b?filename=push-one.png&title=Reset&message=per+topic+first',
      'https://ntfy.sh/topic-b?filename=hello.txt',
      'https://ntfy.sh/topic-a?filename=push-one.png&title=Reset&message=per+topic+first',
      'https://ntfy.sh/topic-a?filename=hello.txt',
    ])
    expect(
      requests.every((request) => !('Content-Type' in request.headers)),
    ).toBe(true)
  })

  test('local attachment failure short-circuits while JSON failure continues', () => {
    const raw = namedCase('local-attachment-failure-short-circuits')
    const json = namedCase('json-multi-topic-first-failure-continues')
    expect(raw.expected.requests).toHaveLength(2)
    expect(raw.expected.result).toBe(false)
    expect(json.expected.requests).toHaveLength(2)
    expect(json.expected.result).toBe(false)
  })

  test('legacy tags canonicalize to xtags and private credentials remain masked', () => {
    const tags = new NotifyNtfy(parse('ntfys://topic?tags=warning%2Cfire'))
    expect(tags.tags).toEqual(['fire', 'warning'])
    expect(tags.url()).toContain('xtags=fire%2Cwarning')
    expect(tags.url()).not.toMatch(/[?&]tags=/)

    const basic = new NotifyNtfy(
      parse(
        'ntfys://alice:secret@ntfy.private.example/topic?mode=private&auth=basic',
      ),
    )
    expect(basic.auth).toBe(NtfyAuth.BASIC)
    expect(basic.url(true)).not.toContain('secret')

    const tokenRaw =
      'ntfys://tk_SECRET@ntfy.private.example/topic?mode=private&auth=token'
    const token = new NotifyNtfy(parse(tokenRaw))
    expect(token.url(true)).not.toContain('tk_SECRET')

    const messages: string[] = []
    const app = new Apprise({
      asset: new AppriseAsset({
        diagnostic: (event) => messages.push(event.message),
      }),
    })
    expect(
      app.add(
        'ntfys://alice:secret@ntfy.private.example/topic?mode=private&auth=basic',
      ),
    ).toBe(true)
    expect(app.add(tokenRaw)).toBe(true)
    const diagnostics = messages.join('\n')
    expect(diagnostics).not.toContain('secret')
    expect(diagnostics).not.toContain('tk_SECRET')
  })

  test('local raw delivery accepts an in-memory attachment and preserves bytes', async () => {
    const requests: TransportRequest[] = []
    const plugin = new NotifyNtfy({
      ...parse('ntfys://topic?image=no'),
      transport: async (request) => {
        requests.push(request)
        return response()
      },
    })
    const bytes = Buffer.from([0, 1, 2, 255])
    const attach = new AppriseAttachment(
      new AttachMemory({ content: bytes, name: 'blob.bin' }),
    )
    await expect(
      plugin.send('body', 'title', undefined, { attach }),
    ).resolves.toBe(true)
    expect(Buffer.from(requests[0]?.body as Uint8Array)).toEqual(bytes)
    expect(requests[0]?.headers?.['Content-Type']).toBeUndefined()
  })
})
