// SPDX-License-Identifier: BSD-2-Clause
// url() serialization fidelity: sidecar-oracle differential (D1) + idempotency
// (D4), over the SAME (plugin, caseName) universe as fixtures/url-oracle.json —
// the union of cases/<plugin>.json (wire seeds) and cases/url-oracle/<plugin>.json
// (url()-only seeds). The oracle was captured from upstream apprise v1.12.0.
//
//   * differential (task 2): for every case, `new P(P.parseUrl(norm(seed))).url()`
//     and `.url(true)` are diffed against the captured upstream url()/urlPrivacy
//     per design.md D1 — base byte-equal, every TS-emitted query key value
//     byte-equal to upstream (rule 1), upstream-only keys ⊆ D (rule 2), TS keys ∩
//     D = ∅ (rule 3), plus the structural (no unencoded `#` in the query segment,
//     no duplicate keys) and presence (format/overflow always, custom `method`)
//     assertions. url(privacy=true) uses the same rules against urlPrivacy.
//   * idempotency (task 3 / D4): u1 === u2 for lossless plugins; for faithfully
//     lossy plugins, each TS stage matches the sidecar's upstream
//     re-serialization stage (order-preserving, D-stripped, byte-for-byte).
//
// norm() reproduces Apprise.instantiate's `/#`->`/%23` preprocessing so
// rocketchat's `#channel` base target survives the static P.parseUrl (a bare
// `#` would otherwise be dropped as a fragment). MUST use the plugin STATIC
// parseUrl (carries method/headers/params/payload + normalised
// format/verify/rto/cto) — the module-level parseUrl would make u1===u2 vacuous.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { NotifyAppriseAPI } from '../src/plugins/apprise-api.js'
import { NotifyForm } from '../src/plugins/custom-form.js'
import { NotifyJSON } from '../src/plugins/custom-json.js'
import { NotifyXML } from '../src/plugins/custom-xml.js'
import { NotifyDingTalk } from '../src/plugins/dingtalk.js'
import { NotifyDiscord } from '../src/plugins/discord.js'
import { NotifyFeishu } from '../src/plugins/feishu.js'
import { NotifyLark } from '../src/plugins/lark.js'
import { NotifyMatrix } from '../src/plugins/matrix.js'
import { NotifyMattermost } from '../src/plugins/mattermost.js'
import { NotifyPushDeer } from '../src/plugins/pushdeer.js'
import { NotifyRocketChat } from '../src/plugins/rocketchat.js'
import { NotifyServerChan } from '../src/plugins/serverchan.js'
import { NotifySlack } from '../src/plugins/slack.js'
import { NotifyTelegram } from '../src/plugins/telegram.js'
import { NotifyWeComBot } from '../src/plugins/wecombot.js'
import { NotifyWxPusher } from '../src/plugins/wxpusher.js'
import type { ParsedUrlResults } from '../src/url.js'

// --- plugin registry (name -> class) -----------------------------------------

interface UrlPlugin {
  url(privacy?: boolean): string
}
interface UrlPluginClass {
  new (args: ParsedUrlResults): UrlPlugin
  parseUrl(url: string): ParsedUrlResults | null
  parseNativeUrl?(url: string): Record<string, unknown> | null
}

const PLUGINS: Record<string, UrlPluginClass> = {
  'custom-json': NotifyJSON as unknown as UrlPluginClass,
  'custom-form': NotifyForm as unknown as UrlPluginClass,
  'custom-xml': NotifyXML as unknown as UrlPluginClass,
  'apprise-api': NotifyAppriseAPI as unknown as UrlPluginClass,
  mattermost: NotifyMattermost as unknown as UrlPluginClass,
  discord: NotifyDiscord as unknown as UrlPluginClass,
  slack: NotifySlack as unknown as UrlPluginClass,
  telegram: NotifyTelegram as unknown as UrlPluginClass,
  rocketchat: NotifyRocketChat as unknown as UrlPluginClass,
  matrix: NotifyMatrix as unknown as UrlPluginClass,
  serverchan: NotifyServerChan as unknown as UrlPluginClass,
  dingtalk: NotifyDingTalk as unknown as UrlPluginClass,
  wecombot: NotifyWeComBot as unknown as UrlPluginClass,
  feishu: NotifyFeishu as unknown as UrlPluginClass,
  lark: NotifyLark as unknown as UrlPluginClass,
  wxpusher: NotifyWxPusher as unknown as UrlPluginClass,
  pushdeer: NotifyPushDeer as unknown as UrlPluginClass,
}

// Plugins whose url() unconditionally emits `method` (the custom webhook family).
const CUSTOM_METHOD_PLUGINS = new Set([
  'custom-json',
  'custom-form',
  'custom-xml',
  'apprise-api',
])

const LOSSY_PLUGINS = new Set(['serverchan', 'pushdeer', 'dingtalk'])

// Deferred keys (design.md D1): upstream url() emits them, this batch does not
// serialize them yet — each is plugin-specific and an exact literal key that NO
// TS plugin emits, so global-set membership is rule-3-safe:
//   `tags`      — apprise-api (upstream forwards routing tags to the server).
//   `template`  — discord (webhook template URL; discord.ts constructs but drops
//                 it — rejection is in send(), not the ctor, so it IS constructible
//                 and gets an active url-oracle seed).
//   `attach-as` — custom-form only (multipart attachment filename; upstream emits
//                 it when non-default, form.ts constructs but drops it — deferred
//                 multipart). json/xml never emit it.
// `emojis` is deliberately NOT here — upstream never emits it.
//
// NOT deferrable via this set — the discord/slack `:{k}` overflow-substitution
// tokens: upstream serialises them as `%3A<name>` (arbitrary <name>) and TS drops
// them. They can't be exact members (arbitrary suffix), and can't be a `%3A`-prefix
// family either — the custom plugins IMPLEMENT `:payload` and TS emits those same
// `%3A<name>` keys (e.g. `%3Amessage`), so a prefix-family defer would trip rule 3
// against them. Hence a documented model boundary (URL_KEY_INVENTORY discord/slack
// notes): no seed activates them; if one did, rule 2 fails loud until TS round-trips
// the tokens. (Construct-rejected keys — slack `template`, matrix `path`, mattermost
// `mode=bot` — need no D entry: no constructible seed can activate them.)
const DEFERRED = new Set([
  'retry',
  'wait',
  'optional',
  'store',
  'tz',
  'redirect',
  'tags',
  'template',
  'attach-as',
])

// --- fixture + seed loading --------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

interface OracleCase {
  url: string
  urlPrivacy: string
  reserialize: [string, string]
}
interface OracleFile {
  apprise_version: string
  inventory: Record<string, { static: string[]; conditional: string[] }>
  oracle: Record<string, Record<string, OracleCase>>
}

const ORACLE = JSON.parse(
  readFileSync(join(ROOT, 'fixtures/url-oracle.json'), 'utf8'),
) as OracleFile

interface SeedFile {
  cases: Array<{ name: string; url: string }>
}

/** A seed URL plus its provenance: curated = the hand-authored url-oracle source
 * (cases/url-oracle/), which MUST always construct + be captured. */
interface Seed {
  url: string
  curated: boolean
}

/** Union of the wire seed source and the url()-only source, keyed by caseName. */
function loadSeeds(plugin: string): Map<string, Seed> {
  const seeds = new Map<string, Seed>()
  for (const [rel, curated] of [
    [`cases/${plugin}.json`, false],
    [`cases/url-oracle/${plugin}.json`, true],
  ] as const) {
    let raw: string
    try {
      raw = readFileSync(join(ROOT, rel), 'utf8')
    } catch {
      continue
    }
    const data = JSON.parse(raw) as SeedFile
    for (const c of data.cases) {
      // (plugin, caseName) MUST be globally unique across both sources; a silent
      // last-wins overwrite would mis-pair the sidecar's oracle (design.md D2).
      if (seeds.has(c.name)) {
        throw new Error(
          `duplicate seed caseName "${c.name}" for plugin "${plugin}" across sources`,
        )
      }
      seeds.set(c.name, { url: c.url, curated })
    }
  }
  return seeds
}

// --- url() split / query parse (design.md D1) --------------------------------

/** Reproduce Apprise.instantiate's `/#`->`/%23` preprocessing (first match). */
function norm(url: string): string {
  return url.replace('/#', '/%23')
}

function parseSeed(
  plugin: UrlPluginClass,
  url: string,
): ParsedUrlResults | null {
  const normalized = norm(url)
  if (/^https?:\/\//i.test(normalized)) {
    return (plugin.parseNativeUrl?.(normalized) ??
      null) as ParsedUrlResults | null
  }
  return plugin.parseUrl(normalized)
}

/** Split at the FIRST `?`: base before, query after (design.md D1). */
function splitUrl(url: string): { base: string; query: string } {
  const i = url.indexOf('?')
  return i === -1
    ? { base: url, query: '' }
    : { base: url.slice(0, i), query: url.slice(i + 1) }
}

/** Query -> ordered (key, rawValue) pairs; first `=` splits, no `=` -> (key, ''). */
function parseQuery(query: string): Array<[string, string]> {
  if (query === '') {
    return []
  }
  return query.split('&').map((seg) => {
    const eq = seg.indexOf('=')
    return (eq === -1 ? [seg, ''] : [seg.slice(0, eq), seg.slice(eq + 1)]) as [
      string,
      string,
    ]
  })
}

/** Drop D-keyed query segments, preserving remaining segments' bytes and order. */
function stripDeferred(url: string): string {
  const { base, query } = splitUrl(url)
  if (query === '') {
    return url
  }
  const kept = query.split('&').filter((seg) => {
    const eq = seg.indexOf('=')
    return !DEFERRED.has(eq === -1 ? seg : seg.slice(0, eq))
  })
  return kept.length ? `${base}?${kept.join('&')}` : base
}

// --- D1 differential ---------------------------------------------------------

function assertUrlMatches(
  label: string,
  plugin: string,
  actual: string,
  expected: string,
): void {
  const inventory = ORACLE.inventory[plugin]
  if (!inventory) throw new Error(`missing inventory for ${plugin}`)
  const expectsQuery =
    inventory.static.length > 0 || inventory.conditional.length > 0
  expect(actual.includes('?'), `${label}: query presence`).toBe(expectsQuery)

  const a = splitUrl(actual)
  const e = splitUrl(expected)

  // base: byte-for-byte (a literal `#` here — rocketchat #channel — is allowed).
  expect(a.base, `${label}: base`).toBe(e.base)

  // structural: no unencoded `#` in the query; no duplicate TS keys.
  expect(a.query.includes('#'), `${label}: query has unencoded #`).toBe(false)
  const aPairs = parseQuery(a.query)
  const aKeys = aPairs.map(([k]) => k)
  expect(new Set(aKeys).size, `${label}: query has duplicate keys`).toBe(
    aKeys.length,
  )

  const eMap = new Map(parseQuery(e.query))
  const aKeySet = new Set(aKeys)

  // Rule 1: every TS key is present upstream and its value is byte-equal.
  for (const [k, v] of aPairs) {
    expect(eMap.has(k), `${label}: TS key "${k}" absent upstream`).toBe(true)
    expect(v, `${label}: value of "${k}"`).toBe(eMap.get(k))
  }
  // Rule 2: upstream-only keys must be deferred.
  for (const k of eMap.keys()) {
    if (!aKeySet.has(k)) {
      expect(
        DEFERRED.has(k),
        `${label}: upstream key "${k}" missing from TS and not in D`,
      ).toBe(true)
    }
  }
  // Rule 3: TS never emits a deferred key.
  for (const k of aKeys) {
    expect(DEFERRED.has(k), `${label}: TS emits deferred key "${k}"`).toBe(
      false,
    )
  }

  // Presence: every static inventory key is unconditional.
  for (const key of inventory.static) {
    expect(aKeySet.has(key), `${label}: missing static key ${key}`).toBe(true)
  }
  if (CUSTOM_METHOD_PLUGINS.has(plugin)) {
    expect(aKeySet.has('method'), `${label}: missing method`).toBe(true)
  }
}

// --- test registration -------------------------------------------------------

describe('url() sidecar-oracle differential (D1)', () => {
  for (const [plugin, cases] of Object.entries(ORACLE.oracle)) {
    const P = PLUGINS[plugin]
    const seeds = loadSeeds(plugin)
    describe(plugin, () => {
      for (const [name, oracle] of Object.entries(cases)) {
        test(name, () => {
          if (!P) {
            throw new Error(`no plugin class registered for "${plugin}"`)
          }
          const seed = seeds.get(name)
          if (seed === undefined) {
            throw new Error(`no seed source for ${plugin}/${name}`)
          }
          const parsed = parseSeed(P, seed.url)
          expect(
            parsed,
            `${plugin}/${name}: parseUrl returned null`,
          ).not.toBeNull()
          const inst = new P(parsed as ParsedUrlResults)
          assertUrlMatches(
            `${plugin}/${name} url()`,
            plugin,
            inst.url(),
            oracle.url,
          )
          assertUrlMatches(
            `${plugin}/${name} url(privacy)`,
            plugin,
            inst.url(true),
            oracle.urlPrivacy,
          )
        })
      }
    })
  }
})

describe('url() idempotency (D4)', () => {
  for (const [plugin, cases] of Object.entries(ORACLE.oracle)) {
    const P = PLUGINS[plugin]
    const seeds = loadSeeds(plugin)
    describe(plugin, () => {
      for (const [name, oracle] of Object.entries(cases)) {
        test(name, () => {
          if (!P) {
            throw new Error(`no plugin class registered for "${plugin}"`)
          }
          const seed = seeds.get(name)
          if (seed === undefined) {
            throw new Error(`no seed source for ${plugin}/${name}`)
          }
          const p1 = parseSeed(P, seed.url)
          expect(p1, `${plugin}/${name}: first parseUrl null`).not.toBeNull()
          const u1 = new P(p1 as ParsedUrlResults).url()
          const p2 = P.parseUrl(norm(u1))
          expect(p2, `${plugin}/${name}: second parseUrl null`).not.toBeNull()
          const u2 = new P(p2 as ParsedUrlResults).url()

          if (u1 === u2 && !LOSSY_PLUGINS.has(plugin)) {
            expect(u2).toBe(u1)
            return
          }
          // Faithful-lossiness exception (D4): each TS stage MUST match the
          // sidecar's upstream re-serialization stage — order-preserving and
          // D-stripped, byte-for-byte (NOT the differential's unordered per-key).
          expect(
            stripDeferred(u1),
            `${plugin}/${name}: stage1 vs upstream`,
          ).toBe(stripDeferred(oracle.reserialize[0]))
          expect(
            stripDeferred(u2),
            `${plugin}/${name}: stage2 vs upstream`,
          ).toBe(stripDeferred(oracle.reserialize[1]))
        })
      }
    })
  }
})

// The per-case describes above iterate ONLY the sidecar, so a silently-dropped
// seed or a deleted oracle case shrinks coverage while staying green. Anchor the
// oracle to the seed universe (union of both sources) instead.
describe('url() oracle coverage', () => {
  test('apprise_version pinned to 1.12.0', () => {
    expect(ORACLE.apprise_version).toBe('1.12.0')
  })

  test('oracle plugin set == the registered in-scope plugins', () => {
    expect(new Set(Object.keys(ORACLE.oracle))).toEqual(
      new Set(Object.keys(PLUGINS)),
    )
  })

  test('inventory plugin set == oracle plugin set', () => {
    expect(new Set(Object.keys(ORACLE.inventory))).toEqual(
      new Set(Object.keys(ORACLE.oracle)),
    )
  })

  test('captured key union exactly covers each static/conditional inventory', () => {
    const gaps = inventoryGaps(ORACLE)
    expect(gaps, JSON.stringify(gaps)).toEqual({})
  })

  test('dropping an activated conditional key makes completeness RED', () => {
    const broken = structuredClone(ORACLE)
    for (const entry of Object.values(broken.oracle.wecombot ?? {})) {
      entry.url = removeQueryKey(entry.url, 'rto')
    }
    expect(inventoryGaps(broken).wecombot).toContain('rto')
  })

  test('every constructible seed has an oracle entry', () => {
    const missing: string[] = []
    for (const plugin of Object.keys(PLUGINS)) {
      const P = PLUGINS[plugin]
      if (!P) {
        throw new Error(`no plugin class registered for "${plugin}"`)
      }
      const cases = ORACLE.oracle[plugin] ?? {}
      for (const [name, seed] of loadSeeds(plugin)) {
        // Curated (cases/url-oracle/) seeds are hand-authored to construct and be
        // captured, so they MUST ALWAYS have an oracle entry — no TS-construction
        // tolerance (which would silently mask a curated seed added without
        // regenerating the sidecar). Only a WIRE seed may lack an entry, and only
        // when it is genuinely non-constructible (the invalid-method/invalid-token
        // wire cases the harness legitimately skips).
        // `Object.hasOwn`, not `in`: a seed named toString/constructor/__proto__
        // must not read as "covered" off the prototype chain.
        if (seed.curated) {
          if (!Object.hasOwn(cases, name)) {
            missing.push(`${plugin}/${name}`)
          }
          continue
        }
        let constructs = false
        const parsed = parseSeed(P, seed.url)
        if (parsed) {
          try {
            const inst = new P(parsed)
            constructs = inst != null
          } catch {
            constructs = false
          }
        }
        if (constructs && !Object.hasOwn(cases, name)) {
          missing.push(`${plugin}/${name}`)
        }
      }
    }
    expect(
      missing,
      `oracle missing entries for constructible seeds: ${missing.join(', ')}`,
    ).toEqual([])
  })
})

function removeQueryKey(url: string, key: string): string {
  const { base, query } = splitUrl(url)
  const kept = parseQuery(query).filter(([candidate]) => candidate !== key)
  return kept.length
    ? `${base}?${kept.map(([k, v]) => `${k}=${v}`).join('&')}`
    : base
}

function inventoryGaps(file: OracleFile): Record<string, string[]> {
  const gaps: Record<string, string[]> = {}
  for (const [plugin, inventory] of Object.entries(file.inventory)) {
    const found = new Set<string>()
    for (const entry of Object.values(file.oracle[plugin] ?? {})) {
      for (const [key] of parseQuery(splitUrl(entry.url).query)) {
        const decoded = decodeURIComponent(key)
        const family = ['+', '-', ':'].includes(decoded[0] ?? '')
          ? (decoded[0] as string)
          : decoded
        if (!DEFERRED.has(family)) found.add(family)
      }
    }
    const expected = new Set(
      [...inventory.static, ...inventory.conditional].filter(
        (key) => !DEFERRED.has(key),
      ),
    )
    const missing = [...expected].filter((key) => !found.has(key))
    const extra = [...found].filter((key) => !expected.has(key))
    const difference = [...missing, ...extra.map((key) => `extra:${key}`)]
    if (difference.length > 0) gaps[plugin] = difference
  }
  return gaps
}
