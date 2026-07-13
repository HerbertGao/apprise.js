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
import { Apprise } from '../src/core/apprise.js'
import { setTransport, type TransportRequest } from '../src/core/transport.js'
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
