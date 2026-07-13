// SPDX-License-Identifier: BSD-2-Clause
// URL-contract + core-enum tests (core-foundation, group A).
// Oracle values are cross-checked against upstream apprise v1.12.0 semantics
// (utils/parse.py + url.py + plugins/base.py).

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NotifyFormat, NotifyType, OverflowMode } from '../src/common.js'
import {
  type ParsedUrlResults,
  parseBool,
  parseUrl,
  quote,
  URLBase,
  unquote,
  urlencode,
} from '../src/url.js'

// --- core enums (task 2.1) ---------------------------------------------------

describe('core enums mirror upstream string values', () => {
  test('values are byte-for-byte upstream', () => {
    expect(NotifyType.INFO).toBe('info')
    expect(NotifyType.SUCCESS).toBe('success')
    expect(NotifyType.WARNING).toBe('warning')
    expect(NotifyType.FAILURE).toBe('failure')

    expect(NotifyFormat.TEXT).toBe('text')
    expect(NotifyFormat.HTML).toBe('html')
    expect(NotifyFormat.MARKDOWN).toBe('markdown')

    expect(OverflowMode.UPSTREAM).toBe('upstream')
    expect(OverflowMode.TRUNCATE).toBe('truncate')
    expect(OverflowMode.SPLIT).toBe('split')
  })
})

// --- low-level helpers -------------------------------------------------------

describe('percent-encoding helpers', () => {
  test('quote encodes like Python quote (not encodeURIComponent)', () => {
    // Python quote leaves !'()* ESCAPED; only unreserved + safe survive.
    expect(quote("a!b'c(d)")).toBe('a%21b%27c%28d%29')
    expect(quote('a/b')).toBe('a/b') // default safe='/'
    expect(quote('a/b', '')).toBe('a%2Fb') // safe='' escapes slash
    expect(quote('a b')).toBe('a%20b') // space -> %20, never +
    expect(quote('~_.-')).toBe('~_.-') // unreserved untouched
  })

  test('unquote decodes %xx runs as UTF-8', () => {
    expect(unquote('a%20b%2Fc')).toBe('a b/c')
    expect(unquote('%E2%9C%93')).toBe('✓') // check mark
    expect(unquote('')).toBe('')
  })

  test('urlencode preserves order and drops null values', () => {
    expect(urlencode({ format: 'html', overflow: 'split' })).toBe(
      'format=html&overflow=split',
    )
    expect(urlencode({ a: '1', b: null, c: '2' })).toBe('a=1&c=2')
    expect(urlencode({ k: 'a b' })).toBe('k=a%20b')
  })

  test('parseBool mirrors upstream truth table', () => {
    for (const yes of [
      'yes',
      'y',
      'true',
      't',
      'on',
      '1',
      'enable',
      'always',
    ]) {
      expect(parseBool(yes)).toBe(true)
    }
    for (const no of ['no', 'n', 'false', 'f', 'off', '0', 'deny', 'never']) {
      expect(parseBool(no)).toBe(false)
    }
    // Unrecognised -> default (false), or the provided default.
    expect(parseBool('bogus')).toBe(false)
    expect(parseBool('bogus', true)).toBe(true)
    expect(parseBool(1)).toBe(true)
  })
})

// --- parse_url semantics (task 2.2) -----------------------------------------

describe('parseUrl: credentials, port, case, query', () => {
  test('credentials + port + case preservation + lowercased query key', () => {
    const r = parseUrl('schema://user:pass@Host:8080/path/Seg?Format=markdown')
    expect(r).not.toBeNull()
    const p = r as NonNullable<typeof r>
    expect(p.schema).toBe('schema')
    expect(p.user).toBe('user')
    expect(p.password).toBe('pass')
    expect(p.host).toBe('Host') // host case preserved
    expect(p.port).toBe(8080)
    expect(p.fullpath).toBe('/path/Seg') // path case preserved
    // query key lower-cased, value case preserved
    expect(p.qsd).toEqual({ format: 'markdown' })
  })

  test('query URL-decoded but + is NOT converted to space', () => {
    const p = parseUrl(
      'schema://host?token=a%20b%2Fc&x=1+2',
    ) as ParsedUrlResults
    expect(p.qsd.token).toBe('a b/c')
    expect(p.qsd.x).toBe('1+2') // + preserved
  })

  test('query value is stripped after unquote', () => {
    const p = parseUrl('schema://host?tok=%20abc%20') as ParsedUrlResults
    expect(p.qsd.tok).toBe('abc')
  })

  test('missing port + empty query', () => {
    const p = parseUrl('schema://host') as ParsedUrlResults
    expect(p.port).toBeNull()
    expect(p.qsd).toEqual({})
    expect(p.host).toBe('host')
  })

  test('duplicate query keys: last wins', () => {
    const p = parseUrl('schema://host?a=1&a=2') as ParsedUrlResults
    expect(p.qsd.a).toBe('2')
  })

  test('+/-/: prefixed keys map into extension dicts, case preserved', () => {
    const p = parseUrl(
      'schema://host?+X-Custom=val&-remove=1&:payload=2',
    ) as ParsedUrlResults
    expect(p.qsdPlus).toEqual({ 'X-Custom': 'val' })
    // qsdMinus/qsdColon are order-preserving Maps (integer-style keys keep
    // insertion order on the wire); qsd/qsdPlus stay plain objects.
    expect(p.qsdMinus).toEqual(new Map([['remove', '1']]))
    expect(p.qsdColon).toEqual(new Map([['payload', '2']]))
  })
})

describe('parseUrl: rejection of invalid host/port', () => {
  test('missing host is rejected', () => {
    expect(parseUrl('schema://')).toBeNull()
  })

  test('non-numeric port is rejected', () => {
    expect(parseUrl('schema://host:abc')).toBeNull()
    expect(parseUrl('schema://host:80.5')).toBeNull()
  })

  test('valid numeric port on a path URL is accepted', () => {
    const p = parseUrl('schema://host:80/path') as ParsedUrlResults
    expect(p.port).toBe(80)
    expect(p.fullpath).toBe('/path')
  })
})

describe('parseUrl: IPv6 (high-risk ported path)', () => {
  test('[::1]:8080 keeps brackets on host throughout', () => {
    const p = parseUrl('schema://[::1]:8080/path') as ParsedUrlResults
    expect(p.host).toBe('[::1]') // oracle: brackets retained
    expect(p.port).toBe(8080)
    expect(p.fullpath).toBe('/path')
  })
})

// --- standard params: format / overflow / verify (task 2.3) ------------------

describe('URLBase.parseUrl: standard query parameters', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('format overrides default and is value-lowercased', () => {
    const p = URLBase.parseUrl('schema://host?format=HTML') as ParsedUrlResults
    expect(p.format).toBe(NotifyFormat.HTML)
  })

  test('overflow is value-lowercased', () => {
    const p = URLBase.parseUrl(
      'schema://host?overflow=SPLIT',
    ) as ParsedUrlResults
    expect(p.overflow).toBe(OverflowMode.SPLIT)
  })

  test('invalid format warns and falls back to default (not rejected)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = URLBase.parseUrl('schema://host?format=bogus') as ParsedUrlResults
    expect(p).not.toBeNull()
    expect(p.format).toBeUndefined() // fell back to plugin default
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  test('invalid overflow warns and falls back to default', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = URLBase.parseUrl(
      'schema://host?overflow=bogus',
    ) as ParsedUrlResults
    expect(p.overflow).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  test('verify goes through parse_bool (silent coercion, no reject)', () => {
    expect(
      (URLBase.parseUrl('schema://host?verify=no') as ParsedUrlResults).verify,
    ).toBe(false)
    expect(
      (URLBase.parseUrl('schema://host?verify=yes') as ParsedUrlResults).verify,
    ).toBe(true)
    // Unrecognised value -> parse_bool default (false), NOT a rejection.
    const bogus = URLBase.parseUrl(
      'schema://host?verify=bogus',
    ) as ParsedUrlResults
    expect(bogus).not.toBeNull()
    expect(bogus.verify).toBe(false)
    // Absent -> defaults to true.
    expect((URLBase.parseUrl('schema://host') as ParsedUrlResults).verify).toBe(
      true,
    )
  })
})

// --- URLBase round-trip (task 2.3/2.4) --------------------------------------

function fromParsed(url: string): URLBase {
  const r = URLBase.parseUrl(url)
  if (!r) {
    throw new Error(`parse failed for ${url}`)
  }
  return new URLBase({
    schema: r.schema,
    secure: r.secure,
    host: r.host,
    port: r.port,
    user: r.user,
    password: r.password,
    fullpath: r.fullpath,
    verify: r.verify,
  })
}

describe('URLBase.url() round-trips', () => {
  test('credentials + port + verify survive a round-trip', () => {
    const original = 'http://user:pass@host.example:8080/a/b?verify=no'
    const serialized = fromParsed(original).url()
    expect(serialized).toBe(original)

    const re = URLBase.parseUrl(serialized) as ParsedUrlResults
    expect(re.user).toBe('user')
    expect(re.password).toBe('pass')
    expect(re.host).toBe('host.example')
    expect(re.port).toBe(8080)
    expect(re.verify).toBe(false)
  })

  test('IPv6 host round-trips with brackets intact', () => {
    const original = 'http://[::1]:8080/path'
    const serialized = fromParsed(original).url()
    expect(serialized).toBe(original)

    const re = URLBase.parseUrl(serialized) as ParsedUrlResults
    expect(re.host).toBe('[::1]')
    expect(re.port).toBe(8080)
  })

  test('default port is elided; verify=yes (default) is not emitted', () => {
    const u = fromParsed('https://host/x').url()
    expect(u).toBe('https://host/x') // 443 elided, no verify param
  })
})
