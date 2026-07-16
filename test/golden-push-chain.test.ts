// SPDX-License-Identifier: BSD-2-Clause
// Synthetic response-driven binary chain used to calibrate the golden harness
// before the real Pushbullet plugin/fixture is introduced.

import { describe, expect, test } from 'vitest'
import { NotifyBase } from '../src/core/notify-base.js'
import { type PluginConstructor, registerPlugin } from '../src/registry.js'
import { type ParsedUrlResults, URLBase } from '../src/url.js'
import {
  type Fixture,
  type FixtureCase,
  type FixtureRequest,
  matchCase,
  validateFixture,
} from './golden.js'

const API = 'https://api.synthetic.push/v2'
const AUTH = 'Basic dG9rZW46'

type UploadFields = {
  file_name: string
  file_type: string
  file_url: string
  upload_url: string
}

class SyntheticPushChain extends NotifyBase {
  override async send(): Promise<boolean> {
    const prepared: UploadFields[] = []
    for (const [name, bytes] of [
      ['a.bin', new Uint8Array([0, 1])],
      ['b.bin', new Uint8Array([254, 255])],
    ] as const) {
      const metadata = await this.request({
        method: 'POST',
        url: `${API}/upload-request`,
        headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_name: name,
          file_type: 'application/octet-stream',
        }),
      })
      if (metadata.status !== 200 && metadata.status !== 204) return false

      let fields: Partial<UploadFields>
      try {
        fields = JSON.parse(await metadata.text()) as Partial<UploadFields>
      } catch {
        return false
      }
      if (
        typeof fields.file_name !== 'string' ||
        typeof fields.file_type !== 'string' ||
        typeof fields.file_url !== 'string' ||
        typeof fields.upload_url !== 'string'
      ) {
        return false
      }

      const upload = await this.request({
        method: 'POST',
        url: fields.upload_url,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
      })
      if (upload.status !== 200 && upload.status !== 204) return false
      prepared.push(fields as UploadFields)
    }

    let ok = true
    for (const fields of prepared) {
      const result = await this.request({
        method: 'POST',
        url: `${API}/pushes`,
        headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'file', file_url: fields.file_url }),
      })
      if (result.status !== 200 && result.status !== 204) ok = false
    }
    return ok
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    return URLBase.parseUrl(url)
  }
}

registerPlugin(
  'synthpushchain',
  SyntheticPushChain as unknown as PluginConstructor,
)

function response(fields: UploadFields) {
  return { status: 200, body: { text: JSON.stringify(fields) } }
}

const FIELDS_A: UploadFields = {
  file_name: 'a.bin',
  file_type: 'application/octet-stream',
  file_url: 'https://cdn.synthetic/a.bin',
  upload_url: 'https://upload.synthetic/a',
}
const FIELDS_B: UploadFields = {
  file_name: 'b.bin',
  file_type: 'application/octet-stream',
  file_url: 'https://cdn.synthetic/b.bin',
  upload_url: 'https://upload.synthetic/b',
}

function request(
  url: string,
  body: FixtureRequest['body'],
  headers: Record<string, string>,
): FixtureRequest {
  return { method: 'POST', url, headers, body }
}

function fullCase(): FixtureCase {
  return {
    name: 'full-chain',
    input: {
      url: 'synthpushchain://host',
      body: 'go',
      assertResult: true,
      responses: [
        response(FIELDS_A),
        { status: 204, body: null },
        response(FIELDS_B),
        { status: 200, body: { text: 'not-json-and-still-success' } },
        { status: 204, body: null },
        { status: 200, body: { text: 'also-not-json' } },
      ],
    },
    expected: {
      requests: [
        request(
          `${API}/upload-request`,
          {
            text: JSON.stringify({
              file_name: 'a.bin',
              file_type: 'application/octet-stream',
            }),
          },
          { Authorization: AUTH, 'Content-Type': 'application/json' },
        ),
        request(
          FIELDS_A.upload_url,
          { base64: Buffer.from([0, 1]).toString('base64') },
          { 'Content-Type': 'application/octet-stream' },
        ),
        request(
          `${API}/upload-request`,
          {
            text: JSON.stringify({
              file_name: 'b.bin',
              file_type: 'application/octet-stream',
            }),
          },
          { Authorization: AUTH, 'Content-Type': 'application/json' },
        ),
        request(
          FIELDS_B.upload_url,
          { base64: Buffer.from([254, 255]).toString('base64') },
          { 'Content-Type': 'application/octet-stream' },
        ),
        request(
          `${API}/pushes`,
          {
            text: JSON.stringify({ type: 'file', file_url: FIELDS_A.file_url }),
          },
          { Authorization: AUTH, 'Content-Type': 'application/json' },
        ),
        request(
          `${API}/pushes`,
          {
            text: JSON.stringify({ type: 'file', file_url: FIELDS_B.file_url }),
          },
          { Authorization: AUTH, 'Content-Type': 'application/json' },
        ),
      ],
      expectedCount: 6,
      result: true,
    },
  }
}

function validatePushCase(c: FixtureCase): void {
  validateFixture({ plugin: 'pushbullet', cases: [c] } satisfies Fixture)
}

describe('golden response-driven binary chain calibration', () => {
  test('accepts a complete six-request chain', async () => {
    const c = fullCase()
    validatePushCase(c)
    await expect(matchCase(c, { bodyMode: 'json' })).resolves.toBeUndefined()
  })

  test.each([
    'file_name',
    'file_type',
    'file_url',
    'upload_url',
  ] as const)('missing %s truncates the chain and must be RED against the full oracle', async (field) => {
    const c = fullCase()
    const partial = { ...FIELDS_B }
    delete partial[field]
    c.input.responses = [
      response(FIELDS_A),
      { status: 204, body: null },
      { status: 200, body: { text: JSON.stringify(partial) } },
    ]
    validatePushCase(c)
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow(
      /expected 6 wire requests/,
    )
  })

  test('rejects an unconsumed response tail', async () => {
    const c = fullCase()
    c.input.responses?.push({ status: 200 })
    validatePushCase(c)
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow(
      /response preset index 6 unconsumed/,
    )
  })

  test('rejects dynamic upload URL drift', async () => {
    const c = fullCase()
    const upload = c.expected.requests?.[3]
    if (!upload) throw new Error('missing synthetic upload request')
    upload.url = 'https://upload.synthetic/wrong'
    validatePushCase(c)
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow(/url/)
  })

  test('rejects a binary request count drift', async () => {
    const c = fullCase()
    c.expected.requests?.splice(1, 1)
    c.expected.expectedCount = 5
    validatePushCase(c)
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow(
      /expected 5 wire requests/,
    )
  })

  test('accepts an intentional missing-field short chain only with false result', async () => {
    const c = fullCase()
    c.name = 'intentional-missing-field'
    c.input.responses = [
      response(FIELDS_A),
      { status: 204, body: null },
      {
        status: 200,
        body: {
          text: JSON.stringify({
            file_name: FIELDS_B.file_name,
            file_type: FIELDS_B.file_type,
            file_url: FIELDS_B.file_url,
          }),
        },
      },
    ]
    c.expected.requests = c.expected.requests?.slice(0, 3)
    c.expected.expectedCount = 3
    c.expected.result = false
    validatePushCase(c)
    await expect(matchCase(c, { bodyMode: 'json' })).resolves.toBeUndefined()
  })
})
