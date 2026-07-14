// SPDX-License-Identifier: BSD-2-Clause
// CWE-312 credential-masking golden diff (plugin-diagnostics, group A — tasks 1.5/1.6).
//
// Two disjoint oracles (Codex round-3 blocker — MUST NOT be merged):
//  - PARSEABLE group: expected values come from the venv `cwe312_url` sidecar
//    (fixtures/cwe312.json), asserted BYTE-FOR-BYTE. Upstream is authoritative.
//  - UNPARSEABLE group: expected values are NOT from venv — upstream FAIL-OPENS
//    on these and would encode the leak into the oracle. We pin the fail-closed
//    output and additionally assert the full credential substring is ABSENT.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { cwe312Url, cwe312Word } from '../src/cwe312.js'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

interface Sidecar {
  parseable: { url: string; expected: string }[]
}

const oracle: Sidecar = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'fixtures/cwe312.json'), 'utf8'),
)

describe('cwe312Url — parseable group (byte-exact vs venv oracle)', () => {
  test.each(oracle.parseable)('cwe312Url(%o) matches upstream byte-for-byte', ({
    url,
    expected,
  }) => {
    expect(cwe312Url(url)).toBe(expected)
  })
})

// Unparseable group: { tgram token-in-authority / matrix token / URL with space /
// no-scheme malformed }. `leaks` are substrings that MUST NOT survive masking.
const UNPARSEABLE: {
  name: string
  url: string
  expected: string
  leaks: string[]
}[] = [
  {
    name: 'tgram token-in-authority',
    url: 'tgram://123456789:ABCdef_ghi-jkl/12345',
    expected: 'tgram://1...5',
    leaks: ['ABCdef_ghi-jkl', '123456789:ABCdef_ghi-jkl'],
  },
  {
    name: 'matrix token-in-authority',
    url: 'matrix://accesstoken:secret/room',
    expected: 'matrix://a...m',
    leaks: ['accesstoken', 'secret'],
  },
  {
    name: 'URL with space',
    url: 'tgram://bot 123/chat',
    expected: 'tgram://b...t',
    leaks: ['bot 123'],
  },
  {
    name: 'no-scheme malformed',
    url: 'foo bar baz',
    expected: 'f...z',
    leaks: ['foo bar baz', 'bar'],
  },
]

describe('cwe312Url — unparseable group (fail-closed, no venv oracle)', () => {
  test.each(UNPARSEABLE)('fail-closed masks $name to the pinned shape', ({
    url,
    expected,
  }) => {
    expect(cwe312Url(url)).toBe(expected)
  })

  test.each(UNPARSEABLE)('fail-closed never leaks the credential for $name', ({
    url,
    leaks,
  }) => {
    const masked = cwe312Url(url)
    for (const leak of leaks) {
      expect(masked).not.toContain(leak)
    }
    // The whole raw URL must never be returned verbatim (upstream's bug).
    expect(masked).not.toBe(url)
  })

  test('empty string is rejected by parseUrl and masks to empty (no credential)', () => {
    // parse_url('') returns None (rejected), so this rides the fail-closed
    // branch; there is no credential, so '' is the correct, leak-free output.
    expect(cwe312Url('')).toBe('')
  })
})

describe('cwe312Word — force shape matches the fail-closed remainder', () => {
  test('force masks to first...last after trim', () => {
    expect(cwe312Word('123456789:ABCdef_ghi-jkl/12345', true)).toBe('1...5')
    expect(cwe312Word('  spaced  ', true)).toBe('s...d')
  })

  test('non-string / blank input returned unchanged', () => {
    expect(cwe312Word(null)).toBeNull()
    expect(cwe312Word(undefined)).toBeUndefined()
    expect(cwe312Word('   ')).toBe('   ')
  })
})
