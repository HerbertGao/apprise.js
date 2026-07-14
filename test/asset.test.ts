// SPDX-License-Identifier: BSD-2-Clause
// AppriseAsset tests (core-foundation, group B — task 4.1/4.4).
// Oracle image URLs are derived from upstream asset.py image_url_mask +
// image_url() substitution @ v1.12.0.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { NotifyImageSize, NotifyType } from '../src/common.js'
import { type Diagnostic, safeSink } from '../src/diagnostics.js'

describe('AppriseAsset defaults mirror upstream', () => {
  test('display metadata defaults', () => {
    const asset = new AppriseAsset()
    expect(asset.appId).toBe('Apprise')
    expect(asset.appDesc).toBe('Apprise Notifications')
    expect(asset.appUrl).toBe('https://github.com/caronc/apprise')
    expect(asset.theme).toBe('default')
    expect(asset.defaultExtension).toBe('.png')
    expect(asset.defaultImageSize).toBe(NotifyImageSize.XY_256)
    expect(asset.bodyFormat).toBeNull()
  })

  test('default asset has a uuid uid and recursion 0', () => {
    const asset = new AppriseAsset()
    expect(asset.uid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(asset.recursion).toBe(0)
  })

  test('uid / recursion are pinnable for golden determinism', () => {
    const asset = new AppriseAsset({ uid: 'pinned-uid', recursion: 2 })
    expect(asset.uid).toBe('pinned-uid')
    expect(asset.recursion).toBe(2)
  })
})

describe('AppriseAsset.imageUrl resolves by type + size', () => {
  const base =
    'https://github.com/caronc/apprise/raw/master/apprise/assets/themes'

  test('warning at default size', () => {
    const asset = new AppriseAsset()
    expect(asset.imageUrl(NotifyType.WARNING)).toBe(
      `${base}/default/apprise-warning-256x256.png`,
    )
  })

  test('info at an explicit size', () => {
    const asset = new AppriseAsset()
    expect(asset.imageUrl(NotifyType.INFO, NotifyImageSize.XY_32)).toBe(
      `${base}/default/apprise-info-32x32.png`,
    )
  })

  test('logo ignores type/size', () => {
    const asset = new AppriseAsset()
    expect(asset.imageUrl(NotifyType.FAILURE, undefined, { logo: true })).toBe(
      `${base}/default/apprise-logo.png`,
    )
  })

  test('explicit extension override', () => {
    const asset = new AppriseAsset()
    expect(
      asset.imageUrl(NotifyType.SUCCESS, NotifyImageSize.XY_128, {
        extension: '.jpg',
      }),
    ).toBe(`${base}/default/apprise-success-128x128.jpg`)
  })

  test('empty mask yields null', () => {
    const asset = new AppriseAsset({ imageUrlMask: '' })
    expect(asset.imageUrl(NotifyType.INFO)).toBeNull()
  })
})

describe('AppriseAsset diagnostics + secureLogging (plugin-diagnostics)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // D6: default MUST be nullish-guarded so present-but-undefined does not
  // fail-open CWE-312.
  test('secureLogging default is fail-closed and undefined-proof', () => {
    expect(new AppriseAsset().secureLogging).toBe(true)
    expect(new AppriseAsset({ secureLogging: undefined }).secureLogging).toBe(
      true,
    )
    expect(new AppriseAsset({ secureLogging: false }).secureLogging).toBe(false)
  })

  test('diagnostic defaults to a sink, injection replaces it', () => {
    expect(typeof new AppriseAsset().diagnostic).toBe('function')
    // The stored sink is wrapped (safeSink) so it is not the same reference,
    // but the injected sink still receives every event.
    const seen: string[] = []
    const sink: Diagnostic = (e) => seen.push(e.kind)
    new AppriseAsset({ diagnostic: sink }).diagnostic({
      level: 'error',
      kind: 'plugin-error',
      message: 'x',
    })
    expect(seen).toEqual(['plugin-error'])
    // Present-but-undefined falls back to the default sink, not undefined.
    expect(typeof new AppriseAsset({ diagnostic: undefined }).diagnostic).toBe(
      'function',
    )
  })

  test('default sink neutralises line/terminal-forging controls (CWE-117/150)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Not just CR/LF: ESC (terminal escape injection), VT, FF, NEL, DEL and the
    // Unicode line separators U+2028/U+2029 are all line-forging vectors.
    const message =
      'line1\r\nESC\u001b]0;title\u0007VT\u000bFF\u000cNEL\u0085LS\u2028PS\u2029DEL\u007f'
    new AppriseAsset().diagnostic({
      level: 'error',
      kind: 'unparseable-url',
      message,
    })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const written = errorSpy.mock.calls[0]?.[0] as string
    expect(written).not.toMatch(/[\p{Cc}\u2028\u2029]/u)
  })

  test('default sink drops info/debug, writes error/warning', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sink = new AppriseAsset().diagnostic
    sink({ level: 'debug', kind: 'loaded', message: 'x' })
    sink({ level: 'info', kind: 'loaded', message: 'x' })
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    sink({ level: 'error', kind: 'plugin-error', message: 'boom' })
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  // Task 2.3: no shared global — two assets' sinks are independent.
  test('two consumers with different sinks do not interfere', () => {
    const a: string[] = []
    const b: string[] = []
    const assetA = new AppriseAsset({ diagnostic: (e) => a.push(e.kind) })
    const assetB = new AppriseAsset({ diagnostic: (e) => b.push(e.kind) })
    assetA.diagnostic({ level: 'error', kind: 'no-targets', message: '' })
    assetB.diagnostic({ level: 'error', kind: 'invalid-type', message: '' })
    expect(a).toEqual(['no-targets'])
    expect(b).toEqual(['invalid-type'])
  })
})

// A diagnostic sink must never change control flow — not synchronously (a throw)
// and not asynchronously (a rejected promise from a structurally-allowed async
// sink, or a bare thenable). Both escape routes were caught by review; these
// pin the swallow so neither can re-open.
describe('safeSink swallows every sink failure mode', () => {
  const evt = { level: 'error', kind: 'plugin-error', message: 'x' } as const

  test('a synchronous throw is swallowed and forwarding still happens', () => {
    const seen: string[] = []
    const wrapped = safeSink((e) => {
      seen.push(e.kind)
      throw new Error('sync boom')
    })
    expect(() => wrapped(evt)).not.toThrow()
    expect(seen).toEqual(['plugin-error'])
  })

  test('an async sink rejection does not surface as an unhandledRejection', async () => {
    const unhandled: unknown[] = []
    const on = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', on)
    safeSink((async () => {
      throw new Error('async boom')
    }) as Diagnostic)(evt)
    // A bare thenable with `.then` but no `.catch` that rejects, too.
    safeSink((() => ({
      // biome-ignore lint/suspicious/noThenProperty: intentional bare thenable
      then(_res: unknown, rej: (e: unknown) => void) {
        rej(new Error('bare boom'))
      },
    })) as unknown as Diagnostic)(evt)
    await new Promise((r) => setTimeout(r, 20))
    process.off('unhandledRejection', on)
    expect(unhandled).toHaveLength(0)
  })
})
