// SPDX-License-Identifier: BSD-2-Clause
// Tree-shaking / convenience-bucket tests (core-foundation group F — task 6.6;
// extended for plugins-im group G — task 8.1).
// A single-plugin import must register ONLY that plugin's schemes (its protocol
// + secure_protocol) and drag in none of the siblings, so a bundler can drop
// unused plugins. The `plugins/all.ts` bucket registers every in-scope plugin.
//
// All facts are observed through the shared registry. Tests run in definition
// order within this isolated file: the custom-xml isolation test (which proves
// every sibling is absent) runs first, then each IM plugin is imported one at a
// time and asserted to flip only its own scheme(s), then the bucket import.

import { describe, expect, test } from 'vitest'
import { registerPlugin, resolvePlugin } from '../src/registry.js'

const ALL_SCHEMES = [
  'json',
  'jsons',
  'form',
  'forms',
  'xml',
  'xmls',
  'apprise',
  'apprises',
  'mmost',
  'mmosts',
  'discord',
  'slack',
  'tgram',
  'rocket',
  'rockets',
  'matrix',
  'matrixs',
  'schan',
  'dingtalk',
  'wecombot',
  'feishu',
  'lark',
  'wxpusher',
  'pushdeer',
  'pushdeers',
]

// Every scheme EXCEPT custom-xml's own pair — none of these may exist after a
// lone custom-xml import.
const NON_XML_SCHEMES = ALL_SCHEMES.filter((s) => s !== 'xml' && s !== 'xmls')

// The six IM plugins, imported one at a time to prove each self-registers only
// its own scheme(s) (in definition order, so a later entry is still absent when
// an earlier one is imported).
const IM_PLUGINS: Array<[string, () => Promise<unknown>, string[]]> = [
  [
    'mattermost',
    () => import('../src/plugins/mattermost.js'),
    ['mmost', 'mmosts'],
  ],
  ['discord', () => import('../src/plugins/discord.js'), ['discord']],
  ['slack', () => import('../src/plugins/slack.js'), ['slack']],
  ['telegram', () => import('../src/plugins/telegram.js'), ['tgram']],
  [
    'rocketchat',
    () => import('../src/plugins/rocketchat.js'),
    ['rocket', 'rockets'],
  ],
  ['matrix', () => import('../src/plugins/matrix.js'), ['matrix', 'matrixs']],
  ['serverchan', () => import('../src/plugins/serverchan.js'), ['schan']],
  ['dingtalk', () => import('../src/plugins/dingtalk.js'), ['dingtalk']],
  ['wecombot', () => import('../src/plugins/wecombot.js'), ['wecombot']],
  ['feishu', () => import('../src/plugins/feishu.js'), ['feishu']],
  ['lark', () => import('../src/plugins/lark.js'), ['lark']],
  ['wxpusher', () => import('../src/plugins/wxpusher.js'), ['wxpusher']],
  [
    'pushdeer',
    () => import('../src/plugins/pushdeer.js'),
    ['pushdeer', 'pushdeers'],
  ],
]

describe('tree-shaking / convenience bucket', () => {
  test('importing ONE plugin registers only its schemes, not siblings', async () => {
    await import('../src/plugins/custom-xml.js')

    // custom-xml registers its protocol AND its independent secure_protocol.
    expect(resolvePlugin('xml')).toBeDefined()
    expect(resolvePlugin('xmls')).toBeDefined()

    // ...and pulls in none of the other plugins' schemes.
    for (const scheme of NON_XML_SCHEMES) {
      expect(resolvePlugin(scheme), scheme).toBeUndefined()
    }
  })

  test('a throwing registration observer cannot block registration', () => {
    const observerKey = Symbol.for('apprise.js/test-registration-observer@0')
    const globals = globalThis as unknown as Record<symbol, unknown>
    globals[observerKey] = () => {
      throw new Error('observer collision')
    }
    try {
      const plugin = resolvePlugin('xml')
      if (!plugin) throw new Error('custom-xml was not registered')
      registerPlugin('observer-probe', plugin)
      expect(resolvePlugin('observer-probe')).toBe(plugin)
    } finally {
      delete globals[observerKey]
    }
  })

  for (let i = 0; i < IM_PLUGINS.length; i++) {
    const [name, load, schemes] = IM_PLUGINS[i] as [
      string,
      () => Promise<unknown>,
      string[],
    ]
    const nextSchemes = IM_PLUGINS[i + 1]?.[2] ?? []
    test(`importing ${name} registers only ${schemes.join('/')}`, async () => {
      // Absent before its own import; a not-yet-imported sibling stays absent.
      for (const s of schemes) {
        expect(resolvePlugin(s), s).toBeUndefined()
      }
      for (const s of nextSchemes) {
        expect(resolvePlugin(s), s).toBeUndefined()
      }

      await load()

      // Its own scheme(s) are now registered...
      for (const s of schemes) {
        expect(resolvePlugin(s), s).toBeDefined()
      }
      // ...but the next plugin was NOT dragged in.
      for (const s of nextSchemes) {
        expect(resolvePlugin(s), s).toBeUndefined()
      }
    })
  }

  test('the all.ts bucket registers every in-scope plugin scheme', async () => {
    await import('../src/plugins/all.js')
    for (const scheme of ALL_SCHEMES) {
      expect(resolvePlugin(scheme), scheme).toBeDefined()
    }
  })
})
