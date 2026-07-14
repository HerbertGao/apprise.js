// SPDX-License-Identifier: BSD-2-Clause
// matrix golden-differential tests (plugins-im, group F — tasks 7.1/7.2).
// Asserts fixtures/matrix.json (upstream apprise v1.12.0, e2ee.py EXCLUDED) for
// the in-scope closed loop: t2bot webhook (single POST), raw-token direct
// (whoami+join+send, uuid txnId pinned), user:pass login (login+join+send, txn
// counter from 0), multi-room (login + join/send x2 with the txn counter
// advancing 0->1), and ?format=html (formatted_body + org.matrix.custom.html).
// bodyMode json + the default header ignore set (matrix's Accept is a normal
// header, not the meta-semantic one apprise-api compares).
//
// DEFERRED paths (NOT exercised here, tracked as non-goals): E2EE, the
// matrix/slack/hookshot webhook modes, no-target /joined_rooms auto-probe,
// #alias resolution, @user DM rooms, /register fallback, media upload, server
// discovery (fixtures pin ?discovery=no), and cross-call persistence.

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { Apprise } from '../src/core/apprise.js'
// Side-effect import registers the matrix/matrixs schemes.
import { NotifyMatrix, type NotifyMatrixArgs } from '../src/plugins/matrix.js'
import { runGolden } from './golden.js'

describe('matrix golden differential', () => {
  runGolden('fixtures/matrix.json', { bodyMode: 'json' })
})

describe('matrix url() round-trip', () => {
  test('direct login URL serialises to matrixs:// and re-parses equal', () => {
    const url =
      'matrixs://user:pass@matrix.example.com/!abc:matrix.example.com?discovery=no'
    const plugin = new NotifyMatrix(
      NotifyMatrix.parseUrl(url) as unknown as NotifyMatrixArgs,
    )
    const serialised = plugin.url()
    expect(serialised.startsWith('matrixs://')).toBe(true)
    expect(serialised).toContain('mode=off')
    // rooms are quote()d (`!`->%21, `:`->%3A) — base.py:3137.
    expect(serialised).toContain('%21abc%3Amatrix.example.com')

    const reparsed = new NotifyMatrix(
      NotifyMatrix.parseUrl(serialised) as unknown as NotifyMatrixArgs,
    )
    expect(reparsed.rooms).toEqual(plugin.rooms)
    expect(reparsed.mode).toBe(plugin.mode)
    expect(reparsed.version).toBe(plugin.version)
    expect(new Apprise().add(serialised)).toBe(true)
  })
})

describe('matrix url(privacy) masks secrets', () => {
  test('direct: password is masked, never emitted verbatim under privacy', () => {
    const plugin = new NotifyMatrix(
      NotifyMatrix.parseUrl(
        'matrixs://user:SECRETPASS@matrix.example.com/!abc:matrix.example.com?discovery=no',
      ) as unknown as NotifyMatrixArgs,
    )
    expect(plugin.url(true)).not.toContain('SECRETPASS')
    expect(plugin.url(true)).toContain('****')
    expect(plugin.url(false)).toContain('SECRETPASS')
  })

  test('t2bot: the webhook token is masked under privacy', () => {
    const token =
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
    const plugin = new NotifyMatrix(
      NotifyMatrix.parseUrl(`matrix://${token}`) as unknown as NotifyMatrixArgs,
    )
    expect(plugin.mode).toBe('t2bot')
    expect(plugin.url(true)).not.toContain(token)
    expect(plugin.url(false)).toContain(token)
  })
})

describe('matrix construction guards', () => {
  test('an invalid ?version= is rejected (add returns false)', () => {
    const kinds: string[] = []
    const asset = new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) })
    expect(
      new Apprise({ asset }).add(
        'matrixs://user:pass@matrix.example.com/!a:h?version=v2',
      ),
    ).toBe(false)
    expect(kinds).toContain('plugin-error')
  })

  test('a short (non-64-char) t2bot token is rejected', () => {
    const kinds: string[] = []
    const asset = new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) })
    expect(new Apprise({ asset }).add('matrix://tooshort')).toBe(false)
    expect(kinds).toContain('plugin-error')
  })

  test('a direct secure URL without ?discovery=no is rejected (discovery deferred)', () => {
    const kinds: string[] = []
    const asset = new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) })
    expect(
      new Apprise({ asset }).add(
        'matrixs://user:pass@matrix.example.com/!abc:matrix.example.com',
      ),
    ).toBe(false)
    expect(kinds).toContain('plugin-error')
  })

  test('unwired webhook modes (matrix/slack/hookshot) are rejected at construction', () => {
    const kinds: string[] = []
    const asset = new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) })
    for (const mode of ['matrix', 'slack', 'hookshot']) {
      expect(
        new Apprise({ asset }).add(
          `matrixs://user:pass@matrix.example.com/!a:h?mode=${mode}&discovery=no`,
        ),
      ).toBe(false)
    }
    expect(kinds).toContain('plugin-error')
    expect(kinds).toHaveLength(3)
  })

  test('the native t2bot.io webhook URL is recognised', () => {
    const token =
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
    expect(
      new Apprise().add(
        `https://webhooks.t2bot.io/api/v1/matrix/hook/${token}`,
      ),
    ).toBe(true)
  })
})
