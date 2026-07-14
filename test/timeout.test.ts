// SPDX-License-Identifier: BSD-2-Clause
// Request-timeout (?cto=/?rto=) + per-instance transport tests.
//
// Native `fetch` has NO default timeout, so before this a stalled server hung
// `notify()` forever. Upstream gives every request a connect + read timeout
// (url.py:109/113, both 4.0s) exposed as the `cto`/`rto` URL parameters.
//
// The expectations below are taken from upstream apprise 1.12.0, verified
// against the real Python (scripts/.venv):
//
//   $ python -c "import apprise; a=apprise.Apprise()
//                a.add('json://localhost/path?rto=5&cto=2'); print(a[0].url())"
//   json://localhost/path?method=POST&format=text&overflow=upstream
//       &retry=0&wait=0.5&optional=no&rto=5.0&cto=2.0
//   # request_timeout == (2.0, 5.0)   <- (connect, read)
//
//   $ ... a.add('json://localhost/path?rto=bogus&cto=1.5') ...
//   json://localhost/path?...&cto=1.5        <- rto rejected, NO exception, and
//   # socket_read_timeout == 4.0                the 4.0 default is kept
//
// (retry/wait/optional are upstream parameters out of scope for batch-1; the
// rto/cto VALUES and their emission order — rto, cto — are the contract here.)

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { Apprise } from '../src/core/apprise.js'
import {
  request,
  setTransport,
  type TransportRequest,
} from '../src/core/transport.js'
import '../src/plugins/custom-json.js'

afterEach(() => {
  setTransport(null)
  vi.restoreAllMocks()
})

/** A recording transport plus the requests it saw. */
function recorder(name: string) {
  const seen: TransportRequest[] = []
  return {
    seen,
    transport: async (req: TransportRequest) => {
      seen.push(req)
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: async () => name,
      }
    },
  }
}

/**
 * Drive the DEFAULT (native-fetch) transport with a raw deadline and return the
 * `RequestInit` it handed to `fetch`. `AbortSignal.timeout()` is called inside
 * that transport, so a deadline it rejects throws right here.
 */
async function fetchInit(timeout: number): Promise<RequestInit> {
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('ok'))
  spy.mockClear()
  await request({ method: 'POST', url: 'http://localhost/x', timeout })
  return spy.mock.calls.at(-1)?.[1] as RequestInit
}

describe('the deadline is normalised before AbortSignal.timeout()', () => {
  // AbortSignal.timeout() throws ERR_OUT_OF_RANGE on a non-integer, on a
  // negative, and past 2**31-1 — all three reachable from a URL upstream ACCEPTS.
  test('a non-integer deadline (?cto=1.1&rto=2.2 -> 3300.0000000000005)', async () => {
    const kinds: string[] = []
    const apprise = new Apprise({
      asset: new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) }),
    })
    expect(apprise.add('json://127.0.0.1:1/path?cto=1.1&rto=2.2')).toBe(true)
    const plugin = apprise.servers[0]

    // Python: request_timeout == (1.1, 2.2); the sum is not an integer number
    // of milliseconds, which used to blow up EVERY request on this plugin.
    expect(plugin?.requestTimeout).toEqual([1.1, 2.2])
    expect(plugin?.requestTimeoutMs).toBe(3300.0000000000005)

    const init = await fetchInit(plugin?.requestTimeoutMs ?? 0)
    expect(init.signal).toBeInstanceOf(AbortSignal)

    // End to end: a dead port is a connection failure folded into `false`, not
    // an ERR_OUT_OF_RANGE thrown before the socket is even opened.
    vi.restoreAllMocks()
    expect(await apprise.notify({ body: 'hello' })).toBe(false)
    // The false is a real connection failure (a surfaced rejection), not a
    // throw that escaped before the socket opened.
    expect(kinds).toContain('unhandled-exception')
  })

  test('a negative deadline (?cto=-5 -> -1000; upstream takes float("-5"))', async () => {
    const apprise = new Apprise()
    expect(apprise.add('json://localhost/path?cto=-5')).toBe(true)
    const plugin = apprise.servers[0]

    expect(plugin?.requestTimeout).toEqual([-5.0, 4.0])
    // Python: str(float("-5")) == "-5.0"
    expect(plugin?.url()).toContain('cto=-5.0')

    // Clamped to 0 -> an immediate abort, but never a throw.
    const init = await fetchInit(plugin?.requestTimeoutMs ?? 0)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  test('a huge deadline is clamped, not degraded to 1ms', async () => {
    // 2147483648 does not throw: it emits a TimeoutOverflowWarning and silently
    // becomes a 1ms deadline. Anything larger (?cto=1e30) throws outright.
    const warnings: string[] = []
    const onWarning = (w: Error) => warnings.push(w.name)
    process.on('warning', onWarning)
    try {
      expect((await fetchInit(2_147_483_648)).signal).toBeInstanceOf(
        AbortSignal,
      )
      expect((await fetchInit(1e33)).signal).toBeInstanceOf(AbortSignal)
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('warning', onWarning)
    }
    expect(warnings).not.toContain('TimeoutOverflowWarning')
  })

  test('a non-finite deadline attaches NO signal (?cto=inf waits forever)', async () => {
    // Upstream hands `timeout=inf` straight to requests; NaN must not throw.
    expect((await fetchInit(Number.POSITIVE_INFINITY)).signal).toBeUndefined()
    expect((await fetchInit(Number.NaN)).signal).toBeUndefined()
  })
})

describe('a stalled server no longer hangs notify()', () => {
  test('a connection that is accepted but never answered fails fast', {
    timeout: 5000,
  }, async () => {
    // Accept the socket, then never write a response — exactly the case that
    // used to leave the notify() promise (and the socket) pending forever.
    const server: Server = createServer(() => {
      /* deliberately no response, ever */
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    try {
      const apprise = new Apprise()
      // 0.1 + 0.1 -> a 200ms deadline (the plugin's request_timeout pair).
      expect(apprise.add(`json://127.0.0.1:${port}/path?cto=0.1&rto=0.1`)).toBe(
        true,
      )

      const started = Date.now()
      const result = await apprise.notify({ body: 'hello' })
      const elapsed = Date.now() - started

      // The abort surfaces as a rejected send(), which the allSettled
      // aggregation folds into an overall `false` (never a hang, never a throw).
      expect(result).toBe(false)
      expect(elapsed).toBeLessThan(1000)
      // ...and the abort FIRED at the deadline rather than the transport
      // throwing on the spot: a `false` alone would also be satisfied by an
      // AbortSignal.timeout() that rejected its delay before opening a socket.
      expect(elapsed).toBeGreaterThanOrEqual(150)
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    }
  })

  test('every request carries a deadline, even without ?cto=/?rto=', async () => {
    const rec = recorder('default')
    const apprise = new Apprise({ transport: rec.transport })
    apprise.add('json://localhost/path')
    await apprise.notify({ body: 'hello' })

    // The 4.0 + 4.0 upstream defaults, summed into fetch's single AbortSignal.
    expect(rec.seen[0]?.timeout).toBe(8000)
  })

  test('?cto=/?rto= drive the deadline handed to the transport', async () => {
    const rec = recorder('custom')
    const apprise = new Apprise({ transport: rec.transport })
    apprise.add('json://localhost/path?cto=2&rto=5')
    await apprise.notify({ body: 'hello' })

    expect(rec.seen[0]?.timeout).toBe(7000)
  })
})

describe('cto / rto parsing', () => {
  test('valid floats are applied (connect, read) — upstream request_timeout', () => {
    const apprise = new Apprise()
    apprise.add('json://localhost/path?rto=5&cto=2')
    const plugin = apprise.servers[0]

    expect(plugin?.socketConnectTimeout).toBe(2.0)
    expect(plugin?.socketReadTimeout).toBe(5.0)
    // Python: a[0].request_timeout == (2.0, 5.0)
    expect(plugin?.requestTimeout).toEqual([2.0, 5.0])
  })

  test('the 4.0 defaults apply when neither is specified', () => {
    const apprise = new Apprise()
    apprise.add('json://localhost/path')
    const plugin = apprise.servers[0]

    expect(plugin?.requestTimeout).toEqual([4.0, 4.0])
    expect(plugin?.requestTimeoutMs).toBe(8000)
  })

  test('an invalid value warns and KEEPS the default (upstream never throws)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const apprise = new Apprise()
    // Python: socket_read_timeout stays 4.0, socket_connect_timeout becomes 1.5.
    expect(apprise.add('json://localhost/path?rto=bogus&cto=1.5')).toBe(true)
    const plugin = apprise.servers[0]

    expect(plugin?.socketReadTimeout).toBe(4.0)
    expect(plugin?.socketConnectTimeout).toBe(1.5)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid socket read timeout (rto)'),
    )
  })

  // Python's float() grammar, measured against the real 1.12.0 venv. JS
  // `Number()` is wrong in BOTH directions — it takes 0x10/0o17/0b101/"" (all
  // ValueErrors in Python) and rejects inf/nan/1_000.5 (all fine in Python).
  test.each([
    ['inf', Number.POSITIVE_INFINITY],
    ['INF', Number.POSITIVE_INFINITY],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-inf', Number.NEGATIVE_INFINITY],
    ['1_000.5', 1000.5],
    ['1_0', 10],
    ['1.', 1],
    ['.5', 0.5],
    ['1e3', 1000],
    ['1_0e2', 1000],
    ['%2B5', 5],
    ['-5', -5],
    ['%20%201.5%20%20', 1.5],
  ])('float(%s) is accepted', (raw, expected) => {
    const apprise = new Apprise()
    expect(apprise.add(`json://localhost/path?cto=${raw}`)).toBe(true)
    expect(apprise.servers[0]?.socketConnectTimeout).toBe(expected)
  })

  test.each(['nan', 'NaN'])('float(%s) is accepted', (raw) => {
    const apprise = new Apprise()
    expect(apprise.add(`json://localhost/path?cto=${raw}`)).toBe(true)
    expect(apprise.servers[0]?.socketConnectTimeout).toBeNaN()
  })

  test.each([
    '_1',
    '1_',
    '1__0',
    '1e_3',
    '.',
    '1e',
    '0x10',
    '0o17',
    '0b101',
    '5abc',
    '',
  ])('float(%s) is a ValueError -> warn + keep the 4.0 default', (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const apprise = new Apprise()
    expect(apprise.add(`json://localhost/path?cto=${raw}`)).toBe(true)

    expect(apprise.servers[0]?.socketConnectTimeout).toBe(4.0)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid socket connect timeout (cto)'),
    )
  })

  test('an empty / non-numeric cto likewise falls back to the default', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const apprise = new Apprise()
    apprise.add('json://localhost/path?cto=&rto=3abc')
    const plugin = apprise.servers[0]

    // Python float("") and float("3abc") both raise ValueError -> defaults kept.
    expect(plugin?.requestTimeout).toEqual([4.0, 4.0])
  })
})

describe('url() round-trip', () => {
  test('rto/cto round-trip with Python float formatting (5 -> 5.0)', () => {
    const apprise = new Apprise()
    apprise.add('json://localhost/path?rto=5&cto=2')

    // Oracle (real Python 1.12.0), modulo the retry/wait/optional params that
    // are out of scope for batch-1:
    //   json://localhost/path?method=POST&format=text&overflow=upstream
    //                        &...&rto=5.0&cto=2.0
    const url = apprise.servers[0]?.url() ?? ''
    expect(url).toBe(
      'json://localhost/path?method=POST&format=text&overflow=upstream&rto=5.0&cto=2.0',
    )
    // `String(5)` would emit `rto=5`; Python's `str(float("5"))` is `"5.0"`.
    expect(url).toContain('rto=5.0')
    expect(url).toContain('cto=2.0')
    // Emission order is rto, then cto (url.py:862-868).
    expect(url.indexOf('rto=')).toBeLessThan(url.indexOf('cto='))
  })

  test('a fractional value keeps its decimal form', () => {
    const apprise = new Apprise()
    apprise.add('json://localhost/path?cto=1.5')

    expect(apprise.servers[0]?.url()).toContain('cto=1.5')
  })

  test('inf / nan print as Python does, not as JS does', () => {
    // Python: str(float("inf")) == "inf"; JS String(Infinity) == "Infinity".
    const infinite = new Apprise()
    infinite.add('json://localhost/path?cto=inf')
    const infUrl = infinite.servers[0]?.url() ?? ''
    expect(infUrl).toContain('cto=inf')
    expect(infUrl).not.toContain('Infinity')

    const notANumber = new Apprise()
    notANumber.add('json://localhost/path?cto=nan')
    expect(notANumber.servers[0]?.url()).toContain('cto=nan')
  })

  test('the defaults are NOT emitted (parameters are on-demand only)', () => {
    const apprise = new Apprise()
    apprise.add('json://localhost/path?rto=4.0&cto=4')

    const url = apprise.servers[0]?.url() ?? ''
    expect(url).not.toContain('rto=')
    expect(url).not.toContain('cto=')
  })

  test('a serialised URL re-parses to the same timeouts', () => {
    const first = new Apprise()
    first.add('json://localhost/path?rto=5&cto=2')

    const second = new Apprise()
    second.add(first.servers[0]?.url() ?? '')

    expect(second.servers[0]?.requestTimeout).toEqual([2.0, 5.0])
  })
})

describe('per-instance transport', () => {
  test('two Apprise instances do not interfere with each other', async () => {
    const a = recorder('a')
    const b = recorder('b')

    const first = new Apprise({ transport: a.transport })
    const second = new Apprise({ transport: b.transport })
    first.add('json://first.test/path')
    second.add('json://second.test/path')

    await Promise.all([
      first.notify({ body: 'one' }),
      second.notify({ body: 'two' }),
    ])

    expect(a.seen).toHaveLength(1)
    expect(b.seen).toHaveLength(1)
    expect(a.seen[0]?.url).toBe('http://first.test/path')
    expect(b.seen[0]?.url).toBe('http://second.test/path')
  })

  test('the instance transport wins over the module-level one', async () => {
    const globalRec = recorder('global')
    const instanceRec = recorder('instance')
    setTransport(globalRec.transport)

    const apprise = new Apprise({ transport: instanceRec.transport })
    apprise.add('json://localhost/path')
    await apprise.notify({ body: 'hello' })

    expect(instanceRec.seen).toHaveLength(1)
    expect(globalRec.seen).toHaveLength(0)
  })

  test('without an instance transport the module-level one is used', async () => {
    const globalRec = recorder('global')
    setTransport(globalRec.transport)

    const apprise = new Apprise()
    apprise.add('json://localhost/path')
    await apprise.notify({ body: 'hello' })

    expect(globalRec.seen).toHaveLength(1)
  })
})
