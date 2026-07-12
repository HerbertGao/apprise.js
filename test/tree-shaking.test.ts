// SPDX-License-Identifier: BSD-2-Clause
// Tree-shaking / convenience-bucket tests (core-foundation, group F — task 6.6).
// A single-plugin import must register ONLY that plugin's schemes (its protocol
// + secure_protocol) and drag in none of the siblings, so a bundler can drop
// unused plugins. The `plugins/all.ts` bucket registers every in-scope plugin.
//
// Both facts are observed through the shared registry. The two tests run in
// definition order within this isolated file: the single-plugin assertion (which
// proves the siblings are absent) runs BEFORE the bucket import registers them.

import { describe, expect, test } from 'vitest'
import { resolvePlugin } from '../src/registry.js'

const ALL_SCHEMES = [
  'json',
  'jsons',
  'form',
  'forms',
  'xml',
  'xmls',
  'apprise',
  'apprises',
]

describe('tree-shaking / convenience bucket', () => {
  test('importing ONE plugin registers only its schemes, not siblings', async () => {
    await import('../src/plugins/custom-xml.js')

    // custom-xml registers its protocol AND its independent secure_protocol.
    expect(resolvePlugin('xml')).toBeDefined()
    expect(resolvePlugin('xmls')).toBeDefined()

    // ...and pulls in none of the other plugins' schemes.
    expect(resolvePlugin('json')).toBeUndefined()
    expect(resolvePlugin('jsons')).toBeUndefined()
    expect(resolvePlugin('form')).toBeUndefined()
    expect(resolvePlugin('forms')).toBeUndefined()
    expect(resolvePlugin('apprise')).toBeUndefined()
    expect(resolvePlugin('apprises')).toBeUndefined()
  })

  test('the all.ts bucket registers every in-scope plugin scheme', async () => {
    await import('../src/plugins/all.js')
    for (const scheme of ALL_SCHEMES) {
      expect(resolvePlugin(scheme), scheme).toBeDefined()
    }
  })
})
