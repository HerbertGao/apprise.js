// SPDX-License-Identifier: BSD-2-Clause
// Self-test for the golden-differential diff tool (core-foundation, group E —
// task 5.3). A synthetic NotifyBase subclass emits a KNOWN request; we assert
// the matcher (a) passes on a byte-compatible fixture (incl. JSON key-order
// independence), (b) fails on a mismatched header / body / url / method, and
// (c) handles both noRequest branches (instantiation-failed and no-request),
// rejecting a noRequest expectation that actually produced a request.

import { describe, expect, test, vi } from 'vitest'
import { NotifyBase } from '../src/core/notify-base.js'
import { request } from '../src/core/transport.js'
import { type PluginConstructor, registerPlugin } from '../src/registry.js'
import { type ParsedUrlResults, URLBase } from '../src/url.js'
import {
  type Fixture,
  type FixtureCase,
  type FixtureRequest,
  matchCase,
  validateFixture,
} from './golden.js'

/** Emits a fixed request regardless of body (so the fixture is fully known). */
class SynthPlugin extends NotifyBase {
  static override attachmentSupport = true

  override async send(body: string, title = ''): Promise<boolean> {
    const res = await request({
      method: 'POST',
      url: 'http://synth.local/x',
      headers: { 'User-Agent': 'Apprise', 'Content-Type': 'application/json' },
      // Key order here differs from the fixture below on purpose.
      body: JSON.stringify({ title, message: body }),
    })
    return res.status >= 200 && res.status < 300
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    return URLBase.parseUrl(url)
  }
}

registerPlugin('synth', SynthPlugin as unknown as PluginConstructor)

let shapeProbeParses = 0

class SynthShapeProbePlugin extends SynthPlugin {
  static override parseUrl(url: string): ParsedUrlResults | null {
    shapeProbeParses += 1
    return SynthPlugin.parseUrl(url)
  }
}

registerPlugin(
  'synthshapeprobe',
  SynthShapeProbePlugin as unknown as PluginConstructor,
)

/** Reports success without emitting a request, for result-ordering negatives. */
class SynthNoRequestTruePlugin extends SynthPlugin {
  override async notify(): Promise<boolean> {
    return true
  }
}

registerPlugin(
  'synthnoreqtrue',
  SynthNoRequestTruePlugin as unknown as PluginConstructor,
)

const baseRequest: FixtureRequest = {
  method: 'POST',
  url: 'http://synth.local/x',
  headers: { 'User-Agent': 'Apprise', 'Content-Type': 'application/json' },
  // Different key order from what send() emits — must still match in json mode.
  body: { text: '{"message":"hello","title":"hi"}' },
}

function requestCase(name: string, request: FixtureRequest): FixtureCase {
  return {
    name,
    input: { url: 'synth://host/x', title: 'hi', body: 'hello', type: 'info' },
    expected: { request },
  }
}

describe('golden diff tool self-test (task 5.3)', () => {
  test('matches a byte-compatible request (JSON key-order independent)', async () => {
    await expect(
      matchCase(requestCase('good', baseRequest), { bodyMode: 'json' }),
    ).resolves.toBeUndefined()
  })

  test('fails on a mismatched semantic header', async () => {
    const bad = requestCase('bad-header', {
      ...baseRequest,
      headers: { 'User-Agent': 'Wrong', 'Content-Type': 'application/json' },
    })
    await expect(matchCase(bad, { bodyMode: 'json' })).rejects.toThrow()
  })

  test('exact Content-Type comparison rejects a missing charset parameter', async () => {
    const bad = requestCase('bad-content-type-charset', {
      ...baseRequest,
      headers: {
        'User-Agent': 'Apprise',
        'Content-Type': 'application/json; charset=utf-8',
      },
    })
    await expect(
      matchCase(bad, { bodyMode: 'json', exactContentType: true }),
    ).rejects.toThrow(/header "content-type"/)
  })

  test('fails on a mismatched body field', async () => {
    const bad = requestCase('bad-body', {
      ...baseRequest,
      body: { text: '{"message":"WRONG","title":"hi"}' },
    })
    await expect(matchCase(bad, { bodyMode: 'json' })).rejects.toThrow()
  })

  test('fails on a mismatched url', async () => {
    const bad = requestCase('bad-url', {
      ...baseRequest,
      url: 'http://synth.local/other',
    })
    await expect(matchCase(bad, { bodyMode: 'json' })).rejects.toThrow()
  })

  test('fails on a mismatched method', async () => {
    const bad = requestCase('bad-method', { ...baseRequest, method: 'PUT' })
    await expect(matchCase(bad, { bodyMode: 'json' })).rejects.toThrow()
  })

  test('noRequest: instantiation-failed passes for an unknown scheme', async () => {
    const c: FixtureCase = {
      name: 'inst-fail',
      input: { url: 'nope-unregistered://x' },
      expected: { noRequest: { reason: 'instantiation-failed' } },
    }
    await expect(matchCase(c, { bodyMode: 'json' })).resolves.toBeUndefined()
  })

  test('noRequest: no-request passes when empty content sends nothing', async () => {
    const c: FixtureCase = {
      name: 'no-request',
      input: { url: 'synth://host/x', title: '', body: '' },
      expected: { noRequest: { reason: 'no-request' } },
    }
    await expect(matchCase(c, { bodyMode: 'json' })).resolves.toBeUndefined()
  })

  test('rejects an unknown noRequest reason', async () => {
    const c = {
      name: 'unknown-no-request-reason',
      input: { url: 'synth://host/x', title: '', body: '' },
      expected: { noRequest: { reason: 'unknown' } },
    } as unknown as FixtureCase
    expect(() => validateFixture({ plugin: 'legacy', cases: [c] })).toThrow(
      /noRequest\.reason/,
    )
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow(
      /expected\.noRequest\.reason/,
    )
  })

  test('rejects a stateful invalid request accessor before execution', async () => {
    let requestReads = 0
    const c = {
      name: 'stateful-invalid-request',
      input: { url: 'synthshapeprobe://host/x', body: 'hello' },
      expected: {
        get request() {
          requestReads += 1
          return requestReads === 1 ? [] : baseRequest
        },
      },
    } as unknown as FixtureCase

    expect(() => validateFixture({ plugin: 'legacy', cases: [c] })).toThrow(
      /expected\.request/,
    )
    expect(requestReads).toBe(1)

    requestReads = 0
    shapeProbeParses = 0
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow(
      /expected\.request/,
    )
    expect(requestReads).toBe(1)
    expect(shapeProbeParses).toBe(0)
  })

  test('reuses the validated request accessor snapshot after execution', async () => {
    let requestReads = 0
    const c = {
      name: 'stateful-valid-request',
      input: { url: 'synthshapeprobe://host/x', title: 'hi', body: 'hello' },
      expected: {
        get request() {
          requestReads += 1
          return requestReads === 1
            ? baseRequest
            : { ...baseRequest, url: 'http://wrong.local/' }
        },
      },
    } as FixtureCase

    await expect(matchCase(c, { bodyMode: 'json' })).resolves.toBeUndefined()
    expect(requestReads).toBe(1)
  })

  test('rejects a stateful requests length before execution', async () => {
    let lengthReads = 0
    const requests = new Proxy([baseRequest, baseRequest], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads += 1
          return lengthReads === 1 ? 2 : 0
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const c = {
      name: 'stateful-requests-length',
      input: { url: 'synthshapeprobe://host/x', body: 'hello' },
      expected: { requests, expectedCount: 0 },
    } as FixtureCase

    expect(() => validateFixture({ plugin: 'legacy', cases: [c] })).toThrow(
      /expectedCount/,
    )
    expect(lengthReads).toBe(1)

    lengthReads = 0
    shapeProbeParses = 0
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow(
      /expectedCount/,
    )
    expect(lengthReads).toBe(1)
    expect(shapeProbeParses).toBe(0)
  })

  test.each([
    ['undefined expected container', undefined],
    ['null expected container', null],
    ['array expected container', []],
    ['primitive expected container', 'expected'],
    ['no delivery shape', {}],
    [
      'request plus requests',
      {
        request: baseRequest,
        requests: [baseRequest, baseRequest],
        expectedCount: 2,
      },
    ],
    [
      'request plus noRequest',
      { request: baseRequest, noRequest: { reason: 'no-request' } },
    ],
    [
      'requests plus noRequest',
      {
        requests: [baseRequest, baseRequest],
        expectedCount: 2,
        noRequest: { reason: 'no-request' },
      },
    ],
    [
      'all delivery shapes',
      {
        request: baseRequest,
        requests: [baseRequest, baseRequest],
        expectedCount: 2,
        noRequest: { reason: 'no-request' },
      },
    ],
    ['request is null', { request: null }],
    ['request is an array', { request: [] }],
    ['request is a primitive', { request: 'request' }],
    ['request with expectedCount', { request: baseRequest, expectedCount: 1 }],
    [
      'request with undefined expectedCount',
      { request: baseRequest, expectedCount: undefined },
    ],
    [
      'request with inherited expectedCount',
      Object.assign(Object.create({ expectedCount: 1 }), {
        request: baseRequest,
      }),
    ],
    [
      'noRequest with expectedCount',
      { noRequest: { reason: 'no-request' }, expectedCount: 0 },
    ],
    [
      'noRequest with undefined expectedCount',
      { noRequest: { reason: 'no-request' }, expectedCount: undefined },
    ],
    [
      'noRequest with inherited expectedCount',
      Object.assign(Object.create({ expectedCount: 0 }), {
        noRequest: { reason: 'no-request' },
      }),
    ],
    [
      'requests without expectedCount',
      { requests: [baseRequest, baseRequest] },
    ],
    ['requests is null', { requests: null }],
    ['requests is an object', { requests: {} }],
    ['requests is a primitive', { requests: 'requests' }],
    [
      'requests with mismatched expectedCount',
      { requests: [baseRequest, baseRequest], expectedCount: 3 },
    ],
    [
      'requests with non-number expectedCount',
      { requests: [baseRequest, baseRequest], expectedCount: '2' },
    ],
    [
      'requests with a non-object member',
      {
        requests: [baseRequest, null] as unknown as FixtureRequest[],
        expectedCount: 2,
      },
    ],
    [
      'requests with an array member',
      {
        requests: [baseRequest, []] as unknown as FixtureRequest[],
        expectedCount: 2,
      },
    ],
    [
      'requests with a primitive member',
      {
        requests: [baseRequest, 'request'] as unknown as FixtureRequest[],
        expectedCount: 2,
      },
    ],
    [
      'sparse requests',
      {
        requests: Array(2) as FixtureRequest[],
        expectedCount: 2,
      },
    ],
    [
      'requests with inherited members',
      {
        requests: Object.setPrototypeOf(
          Array(2),
          Object.assign(Object.create(Array.prototype), {
            0: baseRequest,
            1: baseRequest,
          }),
        ) as FixtureRequest[],
        expectedCount: 2,
      },
    ],
    ['single-item requests', { requests: [baseRequest], expectedCount: 1 }],
  ] as Array<
    [string, unknown]
  >)('rejects malformed expected structure: %s', async (_label, expected) => {
    const c = {
      name: 'malformed-shape',
      input: { url: 'synthshapeprobe://host/x', body: 'hello' },
      expected,
    } as FixtureCase
    expect(() => validateFixture({ plugin: 'legacy', cases: [c] })).toThrow(
      /case "malformed-shape".*expected/,
    )

    shapeProbeParses = 0
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow(
      /case "malformed-shape".*expected/,
    )
    expect(shapeProbeParses).toBe(0)
  })

  test('rejects a noRequest expectation that actually produced a request', async () => {
    const c: FixtureCase = {
      name: 'wrong-no-request',
      input: { url: 'synth://host/x', body: 'hi' },
      expected: { noRequest: { reason: 'instantiation-failed' } },
    }
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow()
  })

  test('asserts notify result independently from an identical request', async () => {
    const success = requestCase('result-success', baseRequest)
    success.input.assertResult = true
    success.expected.result = true
    await expect(
      matchCase(success, { bodyMode: 'json' }),
    ).resolves.toBeUndefined()

    const mismatch = requestCase('result-mismatch', baseRequest)
    mismatch.input.assertResult = true
    mismatch.expected.result = false
    await expect(matchCase(mismatch, { bodyMode: 'json' })).rejects.toThrow(
      /notify result/,
    )
  })

  test('snapshots assertResult once during fixture validation', () => {
    let assertResultReads = 0
    const c = requestCase('stateful-assert-result-schema', baseRequest)
    Object.defineProperty(c.input, 'assertResult', {
      get() {
        assertResultReads += 1
        return assertResultReads <= 2
      },
    })

    expect(() => validateFixture({ plugin: 'serverchan', cases: [c] })).toThrow(
      /expected\.result/,
    )
    expect(assertResultReads).toBe(1)
  })

  test('keeps the pre-execution assertResult gate across await', async () => {
    let assertResult = true
    const c = requestCase('stateful-assert-result-match', baseRequest)
    Object.defineProperty(c.input, 'assertResult', {
      get: () => assertResult,
    })
    c.expected.result = false

    const pending = matchCase(c, { bodyMode: 'json' })
    assertResult = false
    await expect(pending).rejects.toThrow(/notify result/)
  })

  test('no-request checks zero requests before asserting false result', async () => {
    const c: FixtureCase = {
      name: 'no-request-result',
      input: {
        url: 'synth://host/x',
        title: '',
        body: '',
        assertResult: true,
      },
      expected: {
        noRequest: { reason: 'no-request' },
        result: false,
      },
    }
    await expect(matchCase(c, { bodyMode: 'json' })).resolves.toBeUndefined()

    c.input.body = 'unexpected request'
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow()
  })

  test('no-request rejects a deliberately true TS result', async () => {
    const c: FixtureCase = {
      name: 'no-request-wrong-true-result',
      input: {
        url: 'synthnoreqtrue://host/x',
        body: 'content',
        assertResult: true,
      },
      expected: {
        noRequest: { reason: 'no-request' },
        result: false,
      },
    }
    await expect(matchCase(c, { bodyMode: 'json' })).rejects.toThrow(
      /notify result/,
    )
  })

  test('rejects every unconsumed explicit response preset', async () => {
    const oneRequest = requestCase('unused-response', baseRequest)
    oneRequest.input.responses = [{ status: 200 }, { status: 500 }]
    await expect(matchCase(oneRequest, { bodyMode: 'json' })).rejects.toThrow(
      /response preset index 1 unconsumed/,
    )

    const zeroRequest: FixtureCase = {
      name: 'zero-request-unused-response',
      input: {
        url: 'synth://host/x',
        body: '',
        responses: [{ status: 200 }],
      },
      expected: { noRequest: { reason: 'no-request' } },
    }
    await expect(matchCase(zeroRequest, { bodyMode: 'json' })).rejects.toThrow(
      /response preset index 0 unconsumed/,
    )
  })

  test('validates plugins-cn result and timestamp schema without consuming time', () => {
    const fixture = (timestampMs: number): Fixture => ({
      plugin: 'serverchan',
      cases: [
        {
          name: 'schema',
          input: {
            url: 'synth://host/x',
            assertResult: true,
          },
          seeds: { timestampMs },
          expected: { request: baseRequest, result: true },
        },
      ],
    })
    const now = vi.spyOn(Date, 'now').mockReturnValue(123456)
    expect(validateFixture(fixture(0))).toBeDefined()
    expect(Date.now()).toBe(123456)
    expect(validateFixture(fixture(2 ** 51 - 1))).toBeDefined()
    expect(Date.now()).toBe(123456)
    expect(() => validateFixture(fixture(-1))).toThrow(/timestampMs/)
    expect(() => validateFixture(fixture(1.5))).toThrow(/timestampMs/)
    expect(() => validateFixture(fixture(2 ** 51))).toThrow(/timestampMs/)
    now.mockRestore()
  })

  test('rejects malformed new result contracts at fixture validation', () => {
    const base: Fixture = {
      plugin: 'serverchan',
      cases: [
        {
          name: 'missing-result-contract',
          input: { url: 'synth://host/x' },
          expected: { request: baseRequest },
        },
      ],
    }
    expect(() => validateFixture(base)).toThrow(/declare assertResult/)

    const schemaCase = base.cases[0]
    expect(schemaCase).toBeDefined()
    if (!schemaCase) return

    schemaCase.input.assertResult = false
    expect(() => validateFixture(base)).toThrow(/must set assertResult=true/)

    schemaCase.input.assertResult = true
    expect(() => validateFixture(base)).toThrow(/expected\.result/)
  })
})

// A plugin that emits a RAW non-UTF-8 binary body, to prove the base64 body
// comparison encodes the ORIGINAL bytes and not a lossy UTF-8 round-trip.
const BINARY_BODY = new Uint8Array([0xff, 0xfe, 0x00, 0x80])

class SynthBinaryPlugin extends NotifyBase {
  override async send(): Promise<boolean> {
    const res = await request({
      method: 'POST',
      url: 'http://synth.local/bin',
      headers: { 'User-Agent': 'Apprise' },
      body: BINARY_BODY,
    })
    return res.status >= 200 && res.status < 300
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    return URLBase.parseUrl(url)
  }
}

registerPlugin('synthbin', SynthBinaryPlugin as unknown as PluginConstructor)

describe('golden base64 body compares raw bytes, not a UTF-8 round-trip', () => {
  const correctBase64 = Buffer.from(BINARY_BODY).toString('base64')

  test('a non-UTF-8 binary body matches its exact base64', async () => {
    const c: FixtureCase = {
      name: 'binary',
      input: { url: 'synthbin://host/x', body: 'hi' },
      expected: {
        request: {
          method: 'POST',
          url: 'http://synth.local/bin',
          headers: { 'User-Agent': 'Apprise' },
          body: { base64: correctBase64 },
        },
      },
    }
    await expect(matchCase(c, { bodyMode: 'raw' })).resolves.toBeUndefined()
  })

  test('the old UTF-8 round-trip would have corrupted these bytes', () => {
    // Decoding invalid UTF-8 maps 0xFF/0xFE/0x80 to U+FFFD, so re-encoding the
    // string diverges from the truth — the exact false-green the fix removes.
    const roundTripped = Buffer.from(
      Buffer.from(BINARY_BODY).toString('utf8'),
      'utf8',
    ).toString('base64')
    expect(roundTripped).not.toBe(correctBase64)
  })
})
