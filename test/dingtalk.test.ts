// SPDX-License-Identifier: BSD-2-Clause

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, test, vi } from 'vitest'
import { NotifyFormat } from '../src/common.js'
import { Apprise } from '../src/core/apprise.js'
import { NotifyBase } from '../src/core/notify-base.js'
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '../src/core/transport.js'
import {
  NotifyDingTalk,
  type NotifyDingTalkArgs,
} from '../src/plugins/dingtalk.js'
import { type PluginConstructor, registerPlugin } from '../src/registry.js'
import { type ParsedUrlResults, URLBase } from '../src/url.js'
import {
  type Fixture,
  type FixtureCase,
  loadFixture,
  matchCase,
  validateFixture,
} from './golden.js'

const MAX_TIMESTAMP_MS = 2 ** 51 - 1
const DINGTALK_TEST_PATH = fileURLToPath(import.meta.url)
const DINGTALK_IGNORED_HEADERS = new Set([
  'content-length',
  'accept-encoding',
  'accept',
  'connection',
  'host',
])

async function withFixedNow<T>(
  timestampMs: number | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (timestampMs === undefined) {
    return await run()
  }
  if (
    !Number.isSafeInteger(timestampMs) ||
    timestampMs < 0 ||
    timestampMs > MAX_TIMESTAMP_MS
  ) {
    throw new TypeError('timestampMs is outside the deterministic clock domain')
  }

  const clock = vi.spyOn(Date, 'now').mockReturnValue(timestampMs)
  try {
    return await run()
  } finally {
    clock.mockRestore()
  }
}

function response(status = 200, body = '{}'): TransportResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers(),
    text: async () => body,
  }
}

function hasConcurrentCall(source: string, filename = 'fixture.ts'): boolean {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  let found = false
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let callee: ts.Expression = node.expression
      while (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === 'concurrent') {
          found = true
          return
        }
        callee = callee.expression
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const fixture = loadFixture('fixtures/dingtalk.json')

describe.sequential('dingtalk golden differential', () => {
  for (const fixtureCase of fixture.cases) {
    test(fixtureCase.name, async () => {
      await withFixedNow(fixtureCase.seeds?.timestampMs, async () => {
        await matchCase(fixtureCase, {
          bodyMode: 'json',
          exactContentType: true,
          ignoreHeaders: DINGTALK_IGNORED_HEADERS,
        })
      })
    })
  }
})

const clockObservations: number[] = []

class ClockProbePlugin extends NotifyBase {
  override async send(): Promise<boolean> {
    clockObservations.push(Date.now())
    const result = await this.request({
      method: 'POST',
      url: 'https://clock-probe.invalid/fixed',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    return result.status === 200
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    return URLBase.parseUrl(url)
  }
}

registerPlugin('clockprobe', ClockProbePlugin as unknown as PluginConstructor)

const probeCase = (timestampMs: number): FixtureCase => ({
  name: `clock-probe-${timestampMs}`,
  input: { url: 'clockprobe://host', body: 'run' },
  seeds: { timestampMs },
  expected: {
    request: {
      method: 'POST',
      url: 'https://clock-probe.invalid/fixed',
      headers: { 'Content-Type': 'application/json' },
      body: { text: '{}' },
    },
  },
})

describe.sequential('dingtalk deterministic clock and URL contract', () => {
  const build = (url: string, transport?: Transport) =>
    new NotifyDingTalk({
      ...(NotifyDingTalk.parseUrl(url) as unknown as NotifyDingTalkArgs),
      transport,
    })

  test('pins the Python-compatible timestamp/HMAC formula', async () => {
    const plugin = build('dingtalk://secret123@abcdefgh/')
    await withFixedNow(1_700_000_000_123, async () => {
      const [timestamp, signature] = plugin.getSignature()
      expect(timestamp).toBe('1700000000123')
      expect(signature).toBe('fE9IZV%2FSz5d9kQkZwtMBZ5qfB0cEON9rJ90RpBftOa4%3D')
    })
  })

  test('accepts the timestamp upper bound and rejects upper bound plus one', async () => {
    await expect(
      withFixedNow(MAX_TIMESTAMP_MS, async () => Date.now()),
    ).resolves.toBe(MAX_TIMESTAMP_MS)
    await expect(
      withFixedNow(MAX_TIMESTAMP_MS + 1, async () => Date.now()),
    ).rejects.toThrow(/timestampMs/)
  })

  test('keeps the fixed clock through an asynchronous yield', async () => {
    const seen: number[] = []
    let release!: () => void
    const deferred = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = withFixedNow(123_456, async () => {
      seen.push(Date.now())
      await Promise.resolve()
      seen.push(Date.now())
      await deferred
      seen.push(Date.now())
      return 'done'
    })
    await Promise.resolve()
    expect(Date.now()).toBe(123_456)
    release()
    await expect(running).resolves.toBe('done')
    expect(seen).toEqual([123_456, 123_456, 123_456])
    expect(Date.now()).not.toBe(123_456)
  })

  test('restores time after matcher assertion failure', async () => {
    const bad = probeCase(111)
    const request = bad.expected.request
    if (!request) throw new Error('probe fixture lost its request')
    request.url = 'https://clock-probe.invalid/wrong'
    await expect(
      withFixedNow(111, async () => matchCase(bad, { bodyMode: 'json' })),
    ).rejects.toThrow()
    expect(Date.now()).not.toBe(111)
  })

  test('restores time after the notification transport throws', async () => {
    const plugin = build('dingtalk://abcdefgh', async () => {
      throw new Error('transport boom')
    })
    await expect(
      withFixedNow(222, async () => plugin.send('body')),
    ).rejects.toThrow(/transport boom/)
    expect(Date.now()).not.toBe(222)
  })

  test('an immediately following seedless run awaits and uses real time', async () => {
    const before = Date.now()
    const observed = await withFixedNow(undefined, async () => {
      await Promise.resolve()
      return Date.now()
    })
    expect(observed).toBeGreaterThanOrEqual(before)
    expect(observed).toBeLessThanOrEqual(Date.now())
  })

  test('generic matchCase validates but does not consume timestamp seeds', async () => {
    clockObservations.length = 0
    const stableClock = vi.spyOn(Date, 'now').mockReturnValue(424_242)
    try {
      await matchCase(probeCase(0), { bodyMode: 'json' })
      await matchCase(probeCase(MAX_TIMESTAMP_MS), { bodyMode: 'json' })
    } finally {
      stableClock.mockRestore()
    }
    expect(clockObservations).toEqual([424_242, 424_242])

    const invalid: Fixture = {
      plugin: 'clockprobe',
      cases: [probeCase(MAX_TIMESTAMP_MS + 1)],
    }
    expect(() => validateFixture(invalid)).toThrow(/timestampMs/)
  })

  test('the shared runner has no clock hooks or DingTalk registration import', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./golden.ts', import.meta.url)),
      'utf8',
    )
    expect(source).not.toMatch(/from\s+['"][^'"]*dingtalk[^'"]*['"]/i)
    expect(source).not.toMatch(/plugin\s*===?\s*['"]dingtalk['"]/i)
    expect(source).not.toMatch(/spyOn\s*\(\s*Date\s*,\s*['"]now['"]\s*\)/)
    const optionsBlock = source.slice(
      source.indexOf('export interface GoldenOptions'),
      source.indexOf('const DEFAULT_IGNORE'),
    )
    expect(optionsBlock).not.toMatch(/clock|lifecycle/i)
  })

  test('AST guard scans only this file and detects renamed concurrent calls', () => {
    const source = readFileSync(DINGTALK_TEST_PATH, 'utf8')
    expect(hasConcurrentCall(source, DINGTALK_TEST_PATH)).toBe(false)
    expect(
      hasConcurrentCall(
        "import { test as check } from 'vitest'; check.concurrent('bad', () => {})",
      ),
    ).toBe(true)
  })

  test('normalizes targets, serializes privacy, and drops timeout parameters', () => {
    const plugin = build(
      'dingtalk://secret123@abcdefgh/+86%20138-0013-8000/?to=13900139000&rto=9&cto=7',
    )
    expect(plugin.targets).toEqual(['13800138000', '13900139000'])
    expect(plugin.url(true)).toContain('dingtalk://****@a...h/')
    expect(plugin.url()).not.toMatch(/[?&](?:rto|cto)=/)
    expect(new Apprise().add(plugin.url())).toBe(true)
  })

  test('keeps the documented HTML-to-Markdown passthrough degradation', async () => {
    const requests: TransportRequest[] = []
    const app = new Apprise({
      transport: async (request) => {
        requests.push(request)
        return response()
      },
    })
    expect(app.add('dingtalk://abcdefgh?format=markdown')).toBe(true)
    await expect(
      app.notify({
        body: '<b>hello</b>',
        bodyFormat: NotifyFormat.HTML,
      }),
    ).resolves.toBe(true)
    expect(JSON.parse(String(requests[0]?.body)).markdown.text).toBe(
      '<b>hello</b>',
    )
  })
})
