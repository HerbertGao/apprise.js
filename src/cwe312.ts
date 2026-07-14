// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/utils/cwe312.py).
//
// CWE-312 credential masking for diagnostic logs. `cwe312Word` part-masks a
// single word (keep first+last char, mask the middle); `cwe312Url` splits a URL
// into scheme/user/host/port/fullpath/query and masks each component before
// re-assembling for display. See https://cwe.mitre.org/data/definitions/312.html
//
// SECURITY NOTE — the parseable path is a byte-faithful port of upstream, anchored
// by the venv sidecar oracle (fixtures/cwe312.json). The unparseable path
// DELIBERATELY deviates from upstream's fail-open (see cwe312Url below).

import { isHostname, parseUrl } from './url.js'

// Upstream masks any word longer than one char that fails is_hostname, any word
// >=16 chars, or (advanced) any word whose character-class "obscurity" crosses a
// threshold. All of these collapse to the same first-char...last-char shape.
function outer(word: string): string {
  // Slice by code POINT, not UTF-16 code unit: a non-BMP credential char (e.g. an
  // emoji, 2 units) would otherwise split into a broken surrogate half `�`,
  // diverging from Python's code-point-indexed `word[0:1]` / `word[-1:]`.
  const chars = Array.from(word)
  return `${chars[0] ?? ''}...${chars.at(-1) ?? ''}`
}

// ponytail: ASCII char classification. Python's str.isdigit/isalpha/isupper/
// islower are Unicode-aware ('²'.isdigit() is true), but the advanced heuristic
// below only ever runs on words that PASSED is_hostname (pure ASCII [a-z0-9-.])
// or on single chars (where the class never changes the 1-transition outcome) —
// non-ASCII multi-char words are masked by the is_hostname branch before we get
// here. So ASCII predicates match the venv oracle byte-for-byte; upgrade only if
// the oracle ever disagrees (it can't, given the branch order above).
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}
function isUpper(c: string): boolean {
  return c >= 'A' && c <= 'Z'
}
function isLower(c: string): boolean {
  return c >= 'a' && c <= 'z'
}

// Character variance markers (upstream cwe312.py Variance class). Only the
// distinctness of adjacent markers matters, not the literal glyphs.
const NUMERIC = 'n'
const ALPHA_UPPER = '+'
const ALPHA_LOWER = '-'
const SPECIAL = 's'

/**
 * Part-mask a single word (upstream `cwe312_word`, cwe312.py:32-114).
 *
 * `force` unconditionally masks to `first...last` (used for passwords and
 * allowlisted query keys). Otherwise the word is masked when it is not a bare
 * hostname (len > 1), when it is >= 16 chars, or — under `advanced` — when its
 * mix of digit/upper/lower/special characters is obscure enough (threshold
 * transitions). A non-string / blank input is returned unchanged.
 */
export function cwe312Word(
  word: string,
  force?: boolean,
  advanced?: boolean,
  threshold?: number,
): string
export function cwe312Word(
  word: string | null | undefined,
  force?: boolean,
  advanced?: boolean,
  threshold?: number,
): string | null | undefined
export function cwe312Word(
  word: string | null | undefined,
  force = false,
  advanced = true,
  threshold = 5,
): string | null | undefined {
  // not a password if it's not something we even support
  if (typeof word !== 'string' || !word.trim()) {
    return word
  }

  const w = word.trim()

  if (force) {
    // We're forcing the representation to be a secret (for consistency).
    return outer(w)
  }

  // Length in CODE POINTS, not UTF-16 units, to match Python's `len()`: a
  // single non-BMP char (e.g. an emoji) is len 1 in Python but `.length` 2 in
  // JS, which would otherwise mask `?x=😀` here while upstream leaves it.
  const cpLen = [...w].length

  if (cpLen > 1 && !isHostname(w, true, true, false)) {
    // Not a hostname -> treat as secret.
    return outer(w)
  }

  if (cpLen >= 16) {
    // An IP is at most 15 chars; longer words are assumed secret.
    return outer(w)
  }

  if (advanced) {
    // Mark the word secret based on its obscurity (character-class variance).
    let lastVariance: string | null = null
    let obscurity = 0

    for (const c of w) {
      let variance: string
      if (isDigit(c)) {
        variance = NUMERIC
      } else if (isUpper(c)) {
        variance = ALPHA_UPPER
      } else if (isLower(c)) {
        variance = ALPHA_LOWER
      } else {
        variance = SPECIAL
      }

      if (lastVariance !== variance || variance === SPECIAL) {
        obscurity += 1
        if (obscurity >= threshold) {
          return outer(w)
        }
      }

      lastVariance = variance
    }
  }

  return w
}

// Matches a leading `<scheme>://` (or `:\` / mixed separators, per upstream's
// `[/\\]+`). `s` flag so a remainder containing CR/LF is still fully captured.
const SCHEME_RE = /^([^\s:/\\]+):[/\\]+([\s\S]*)$/

const FORCE_KEYS = new Set([
  'password',
  'secret',
  'pass',
  'token',
  'key',
  'id',
  'apikey',
  'to',
])

/**
 * Mask credentials in a URL for display (upstream `cwe312_url`, cwe312.py:117-221).
 *
 * Five masking dimensions: password (always) · non-`http(s)` user/host · fullpath
 * (per segment) · query (each value; forced when the key is in {@link FORCE_KEYS}).
 *
 * Query masking is allowlist-gated best-effort: `access_token` / `api_key` / etc.
 * are NOT in the force list and go through the (weaker) heuristic — so a masked
 * URL does not guarantee every query secret is hidden. This is upstream's
 * boundary, kept faithfully.
 *
 * Parseable URLs are byte-for-byte equal to upstream (anchored by the venv
 * sidecar oracle). Unparseable URLs use the fail-closed branch below.
 */
/**
 * Fail-CLOSED masking: keep only a `<scheme>://` prefix (if present) and
 * force-mask the ENTIRE remainder as ONE word — e.g.
 * `tgram://123456789:ABCdef_ghi-jkl/12345` -> `tgram://1...5`. Unlike
 * {@link cwe312Url} this NEVER falls through to the per-component heuristic, so
 * it cannot leak a secret carried in a non-allowlisted query key. It is the
 * mandated masker for two inputs: a URL `parse_url` rejects, and any
 * `scheme://…` substring pulled from exception text (which may parse yet still
 * carry a secret the heuristic would pass through — see notification-engine spec).
 *
 * MUST NOT split on '/' (short segments like `/12345` would leak un-forced) and
 * MUST NOT return the raw string.
 */
export function cwe312UrlFailClosed(url: string): string {
  const m = SCHEME_RE.exec(url)
  if (m?.[2] !== undefined) {
    return `${m[1]}://${cwe312Word(m[2], true)}`
  }
  return cwe312Word(url, true)
}

export function cwe312Url(url: string): string {
  const results = parseUrl(url)

  if (!results) {
    // ponytail: DELIBERATE deviation from upstream cwe312_url (cwe312.py:139-143).
    // Upstream returns the URL UNCHANGED when parse_url rejects it — a fail-OPEN
    // path that leaks full tgram/matrix bot tokens carried in the authority
    // (the token fails hostname verification, so parse_url rejects, so upstream
    // dumps it verbatim). We fail CLOSED via the whole-remainder force-mask.
    return cwe312UrlFailClosed(url)
  }

  const password = cwe312Word(results.password, true)
  let user: string | null | undefined
  let host: string
  if (!results.schema.startsWith('http')) {
    user = cwe312Word(results.user)
    host = cwe312Word(results.host)
  } else {
    host = cwe312Word(results.host, false, false)
    user = cwe312Word(results.user, false, false)
  }

  // Apply the full-path scan in all cases (mask each `/`-separated segment).
  let fullpath = ''
  if (results.fullpath) {
    const segments = results.fullpath
      .replace(/^\/+/, '')
      .split(/[\\/]+/)
      .map((x) => cwe312Word(x))
    fullpath = `/${segments.join('/')}`
  }

  // Re-assemble authentication.
  let auth = ''
  if (user && password) {
    auth = `${user}:${password}@`
  } else if (user) {
    auth = `${user}@`
  }

  // Re-assemble query string (mask each value; force allowlisted keys).
  // ponytail: `qsd` is a plain object (parseUrl treats it as an unordered set,
  // like headers — see url.ts), so purely-numeric keys hoist to the front and
  // the emitted order can diverge from upstream on a URL like `?2=a&1=b`. Byte
  // parity with the venv oracle holds for every real apprise URL (query names
  // are never purely numeric) and every value is still masked, so this is a
  // known, credential-safe boundary; fixing order would mean reworking parseUrl's
  // qsd into an ordered map (project-wide, out of this change's scope).
  let params = ''
  const qsdEntries = Object.entries(results.qsd)
  if (qsdEntries.length) {
    params = `?${qsdEntries
      .map(([k, v]) => `${k}=${cwe312Word(v, FORCE_KEYS.has(k))}`)
      .join('&')}`
  }

  const port = results.port ? `:${results.port}` : ''

  return `${results.schema}://${auth}${host}${port}${fullpath}${params}`
}
