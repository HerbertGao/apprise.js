// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/utils/parse.py + apprise/url.py).
//
// URLBase is the root of the plugin class hierarchy (URLBase -> NotifyBase ->
// concrete plugin), mirroring the upstream module boundaries so each file can
// be diffed line-for-line against its Python counterpart. The PUBLIC contract
// (scheme parsing rules, query parameter names, round-trip semantics) is 1:1
// with Python; the implementation itself is idiomatic TypeScript.

import {
  NOTIFY_FORMATS,
  type NotifyFormat,
  OVERFLOW_MODES,
  type OverflowMode,
} from './common.js'

// ponytail: batch-1 has no structured logger yet; warnings mirror upstream
// `logger.warning` behaviour (the observable effect — falling back to the
// default — is what round-trip/parse tests assert). Swap for a real logger
// when the logging subsystem lands.
function warn(message: string): void {
  console.warn(`apprise.js: ${message}`)
}

// --- Percent-encoding helpers (mirror URLBase.quote/unquote/urlencode) -------

const ALWAYS_SAFE =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~'

const PERCENT_RUN_RE = /(?:%[0-9A-Fa-f]{2})+/g

/**
 * Replace `%xx` escapes with their single-character equivalent, decoding byte
 * runs as UTF-8. Invalid sequences are replaced (errors="replace"), matching
 * upstream `URLBase.unquote` (url.py:596-621).
 */
export function unquote(content: string | null | undefined): string {
  if (!content) {
    return ''
  }
  const decoder = new TextDecoder('utf-8', { fatal: false })
  return content.replace(PERCENT_RUN_RE, (run) => {
    const bytes = new Uint8Array(run.length / 3)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16)
    }
    return decoder.decode(bytes)
  })
}

/**
 * Percent-encode `content`, leaving unreserved characters and any character in
 * `safe` untouched. Byte-wise UTF-8 with upper-case hex, matching Python's
 * `quote()` (url.py:623-648) — note this differs from `encodeURIComponent`,
 * which leaves `!'()*` unescaped.
 */
export function quote(content: string | null | undefined, safe = '/'): string {
  if (!content) {
    return ''
  }
  const safeSet = new Set((ALWAYS_SAFE + safe).split(''))
  const bytes = new TextEncoder().encode(content)
  let out = ''
  for (const b of bytes) {
    const ch = String.fromCharCode(b)
    if (b < 0x80 && safeSet.has(ch)) {
      out += ch
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/**
 * Ordered key/value input accepted by {@link urlencode}. A `Map` is used where
 * insertion order MUST survive even for integer-style keys (`"1"`, `"2"`) — a
 * plain object silently reorders those to the front, diverging from Python's
 * dict insertion order on the wire (custom-form/-json wire query & form body).
 */
export type EncodeInput =
  | Map<string, string | null | undefined>
  | Record<string, string | null | undefined>

/**
 * Encode a mapping into a `key=value&...` query string. Entries whose value is
 * `null`/`undefined` are dropped; keys and values are quoted with `safe=''`
 * (spaces become `%20`, never `+`) — matching upstream `urlencode`
 * (parse.py:1089-1131). Iteration order is preserved (pass a `Map` for
 * integer-style keys, which a plain object would reorder to the front).
 */
export function urlencode(query: EncodeInput): string {
  const pairs = query instanceof Map ? [...query] : Object.entries(query)
  return pairs
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${quote(k, '')}=${quote(v as string, '')}`)
    .join('&')
}

/**
 * Apply {@link unquote} to a Map's keys and values, preserving iteration order
 * (mirrors the per-plugin re-unquote of the `qsd±`/`qsd:` extension maps). Used
 * for the order-sensitive `-`params / `:`payload collections that reach the wire.
 */
export function mapUnquoteMap(src: Map<string, string>): Map<string, string> {
  return new Map([...src].map(([k, v]) => [unquote(k), unquote(v)]))
}

/**
 * Query encoding matching Python `requests` `params=` (`urlencode(...,
 * quote_via=quote_plus)`): identical to {@link urlencode} except a space becomes
 * `+` instead of `%20`. This is the ONLY difference between Python `quote_plus`
 * and `quote(safe='')`; `*`->`%2A` and a literal `~` are preserved by both (and
 * are exactly where `URLSearchParams` diverges — it leaves `*` bare and encodes
 * `~`). Use this for wire query strings a plugin builds (GET params, `-`params).
 * `%20` can only originate from an encoded space, so the replace is precise.
 */
export function urlencodePlus(query: EncodeInput): string {
  return urlencode(query).replaceAll('%20', '+')
}

/** `inf` / `infinity` / `nan`, optionally signed — Python `float()` takes all. */
const PY_FLOAT_SPECIAL = /^([+-]?)(inf(?:inity)?|nan)$/i

/**
 * Python's decimal `float()` grammar: optional sign, then digits (single `_`
 * separators BETWEEN digits only) with an optional `.` and fraction, or a
 * leading `.` and fraction, then an optional exponent under the same digit
 * rules. Accepts `1.`, `.5`, `1_000.5`, `1_0e2`; rejects `_1`, `1_`, `1__0`,
 * `1e_3`, `.`, `1e`.
 */
const PY_FLOAT_DECIMAL =
  /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/

/**
 * Python `float(str)` semantics: leading/trailing whitespace is tolerated, an
 * empty or non-numeric string is a ValueError (here: `null`, letting the caller
 * warn and keep its default, per upstream url.py:292-309).
 *
 * Deliberately NOT `Number()`, which is wrong in BOTH directions: it accepts
 * `0x10` / `0o17` / `0b101` / `""` (Python raises on all four) and rejects
 * `inf` / `nan` / `1_000.5` (Python takes all three). Also not `parseFloat`,
 * which would accept the `"5abc"` Python rejects.
 */
function pyFloat(value: string): number | null {
  const trimmed = value.trim()

  const special = PY_FLOAT_SPECIAL.exec(trimmed)
  if (special) {
    if (special[2]?.toLowerCase() === 'nan') {
      return Number.NaN
    }
    return special[1] === '-'
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY
  }

  if (!PY_FLOAT_DECIMAL.test(trimmed)) {
    return null
  }
  return Number(trimmed.replaceAll('_', ''))
}

/**
 * Python `str(float)` formatting: an integral value keeps a `.0` suffix
 * (`str(float("5")) == "5.0"`, where JS `String(5)` gives `"5"`), and the
 * non-finite values {@link pyFloat} can now yield print as `inf` / `-inf` /
 * `nan` (JS `String()` gives `Infinity` / `NaN`). Required so `?rto=5` and
 * `?cto=inf` round-trip through {@link URLBase.url} byte-identically to
 * upstream.
 */
function pyFloatStr(value: number): string {
  if (Number.isNaN(value)) {
    return 'nan'
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 'inf' : '-inf'
  }
  const text = String(value)
  return /^-?\d+$/.test(text) ? `${text}.0` : text
}

/**
 * String-based boolean parsing. Mirrors upstream `parse_bool` (parse.py:868-909)
 * exactly, including the first-two-character prefix table; unrecognised strings
 * fall back to `defaultValue`.
 */
export function parseBool(arg: unknown, defaultValue = false): boolean {
  if (typeof arg === 'string') {
    const prefix = arg.toLowerCase().slice(0, 2)
    if (['de', 'di', 'ne', 'f', 'n', 'no', 'of', '0', 'fa'].includes(prefix)) {
      return false
    }
    if (['en', 'al', 't', 'y', 'ye', 'on', '1', 'tr'].includes(prefix)) {
      return true
    }
    return defaultValue
  }
  return Boolean(arg)
}

// --- Host / IP validation (mirror is_ipaddr / is_hostname) -------------------

const IPV4_RE =
  /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/

// Ported verbatim from parse.py:204-217 (RFC 2732 IPv6, optionally bracketed).
const IPV6_RE =
  /^\[?(([0-9a-f]{1,4}:){7,7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,7}:|([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,2}|([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,3}|([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,4}|([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:((:[0-9a-f]{1,4}){1,6})|:((:[0-9a-f]{1,4}){1,7}|:)|fe80:(:[0-9a-f]{0,4}){0,4}%[0-9a-z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-f]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\]?/i

/**
 * Validate an IPv4/IPv6 address. Returns the canonical form (IPv6 wrapped in
 * `[...]` per RFC 2732) or `false`. Mirrors `is_ipaddr` (parse.py:182-228).
 */
export function isIpAddr(
  addr: string,
  ipv4 = true,
  ipv6 = true,
): string | false {
  if (ipv4) {
    const m = IPV4_RE.exec(addr)
    if (m) {
      return m[0]
    }
  }
  if (ipv6) {
    const m = IPV6_RE.exec(addr)
    if (m) {
      // Return the address wrapped in square brackets (RFC 2732), stripping
      // any brackets the input already carried.
      const inner = m[0].replace(/^\[/, '').replace(/\]$/, '')
      return `[${inner}]`
    }
  }
  return false
}

const HOSTNAME_LABEL_RE = /^([a-z0-9][a-z0-9_-]{1,62}|[a-z_-])$/i
const HOSTNAME_LABEL_NO_EDGE_RE = /[_-]$/

/**
 * Validate a hostname, returning the (possibly IP-normalised) host or `false`.
 * Mirrors `is_hostname` (parse.py:231-272) with `underscore=true`.
 */
export function isHostname(
  hostname: string,
  ipv4 = true,
  ipv6 = true,
): string | false {
  if (hostname.length > 253 || hostname.length === 0) {
    return false
  }

  // Strip a single trailing period.
  let host = hostname
  if (host.endsWith('.')) {
    host = host.slice(0, -1)
  }

  const labels = host.split('.')

  // IPv4 fast-path: exactly four dot-separated numeric labels.
  if (labels.length === 4 && /^[0-9.]+$/.test(host)) {
    return isIpAddr(host, ipv4, false)
  }

  const labelsValid = labels.every(
    (label) =>
      HOSTNAME_LABEL_RE.test(label) && !HOSTNAME_LABEL_NO_EDGE_RE.test(label),
  )

  if (!labelsValid) {
    return isIpAddr(host, ipv4, ipv6)
  }

  return host
}

// --- Path tidy (mirror utils/disk.py:tidy_path for URL paths) ----------------

// ponytail: URL path portions never carry `~` or Windows drive letters, so
// tidy_path collapses to two rules — collapse separator runs, trim trailing
// separators/whitespace (expanduser is a no-op here). Upgrade if a plugin ever
// needs real filesystem path tidying.
const TIDY_COLLAPSE_RE = /([/\\])[/\\]+/g
const TIDY_TRIM_RE = /^(.+[^:][^/\\])[\s/\\]*$/

function tidyPath(path: string): string {
  let out = path.trim().replace(TIDY_COLLAPSE_RE, '$1')
  const m = TIDY_TRIM_RE.exec(out)
  if (m?.[1] !== undefined) {
    out = m[1]
  }
  return out
}

// --- Query string parsing (mirror parse_qsd) ---------------------------------

/**
 * Result of {@link parseQsd}: the base `qsd` plus the `+`/`-`/`:` maps. The
 * order-sensitive `-`params / `:`payload maps are `Map`s so their insertion
 * order survives to the wire even for integer-style keys (`-1`, `:2`); `qsd`
 * and `qsdPlus` (headers, compared as an unordered set) stay plain objects.
 */
export interface QsdResult {
  qsd: Record<string, string>
  /** Keys prefixed with `+` in the URL (headers); prefix stripped, case kept. */
  qsdPlus: Record<string, string>
  /** Keys prefixed with `-` in the URL (params); prefix stripped, order kept. */
  qsdMinus: Map<string, string>
  /** Keys prefixed with `:` in the URL (payload); prefix stripped, order kept. */
  qsdColon: Map<string, string>
}

const ADD_TOKEN_RE = /^[ +](.*)/
const DEL_TOKEN_RE = /^-(.*)/
const COLON_TOKEN_RE = /^:(.*)/

/**
 * Query String Dictionary builder. Mirrors upstream `parse_qsd` (parse.py:508-592):
 * keys are lower-cased (when `sanitize`); values are `unquote`d then trimmed;
 * `+` is NOT converted to space unless `plusToSpace`; keys starting with
 * `+`/`-`/`:` are additionally captured (case-preserved) into the extension maps.
 */
export function parseQsd(
  qs: string,
  {
    plusToSpace = false,
    sanitize = true,
  }: { plusToSpace?: boolean; sanitize?: boolean } = {},
): QsdResult {
  const result: QsdResult = {
    qsd: {},
    qsdPlus: {},
    qsdMinus: new Map(),
    qsdColon: new Map(),
  }

  const pairs = qs.split('&').flatMap((s) => s.split(';'))

  for (const nameValue of pairs) {
    const eq = nameValue.indexOf('=')
    const rawKey = eq === -1 ? nameValue : nameValue.slice(0, eq)
    const rawVal = eq === -1 ? '' : nameValue.slice(eq + 1)

    // The first character is preserved as-is (so a leading +/-/: survives);
    // any `+` in the remainder becomes a space (parse.py:554-557).
    let key =
      (rawKey.length === 0 ? '' : rawKey[0]) +
      (rawKey.length <= 1 ? '' : rawKey.slice(1).replaceAll('+', ' '))
    key = unquote(key)

    let val = plusToSpace ? rawVal.replaceAll('+', ' ') : rawVal
    val = unquote(val)
    val = val ? val.trim() : ''

    result.qsd[sanitize ? key.toLowerCase().trim() : key] = val

    const add = ADD_TOKEN_RE.exec(key)
    if (add?.[1] !== undefined) {
      result.qsdPlus[add[1]] = val
    }
    const del = DEL_TOKEN_RE.exec(key)
    if (del?.[1] !== undefined) {
      result.qsdMinus.set(del[1], val)
    }
    const colon = COLON_TOKEN_RE.exec(key)
    if (colon?.[1] !== undefined) {
      result.qsdColon.set(colon[1], val)
    }
  }

  return result
}

// --- parse_url ---------------------------------------------------------------

const VALID_URL_RE = /^\s*(?:([^:\s]+):[/\\]+)?(?:([^?]+)(?:\?(.+))?)?\s*$/
const VALID_QUERY_RE = /^(.*[/\\])([^/\\]+)?$/
const PORT_RE = /^(\[[0-9a-f:]+\]|[^:]+):([^:]*)$/

/** Structured result of {@link parseUrl}. Fields mirror upstream `parse_url`. */
export interface ParsedUrl {
  schema: string
  /** Re-assembled, cleaned URL. */
  url: string
  host: string
  user: string | null
  password: string | null
  port: number | null
  fullpath: string | null
  path: string | null
  query: string | null
  qsd: Record<string, string>
  qsdPlus: Record<string, string>
  qsdMinus: Map<string, string>
  qsdColon: Map<string, string>
}

interface ParseUrlOptions {
  defaultSchema?: string
  verifyHost?: boolean
  strictPort?: boolean
  plusToSpace?: boolean
  sanitize?: boolean
}

/** Strict integer parse (matches Python `int(str)`: optional sign, digits only). */
function strictInt(value: string): number | null {
  const trimmed = value.trim()
  return /^[+-]?[0-9]+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null
}

/**
 * Parse an apprise URL into structured components. Faithful port of
 * `parse_url` (parse.py:595-865). Returns `null` when the URL cannot be parsed
 * (including invalid host / non-numeric port when `verifyHost`).
 */
export function parseUrl(
  url: string,
  options: ParseUrlOptions = {},
): ParsedUrl | null {
  const {
    defaultSchema = 'http',
    verifyHost = true,
    strictPort = false,
    plusToSpace = false,
    sanitize = true,
  } = options

  const result: ParsedUrl = {
    schema: '',
    url: '',
    host: '',
    user: null,
    password: null,
    port: null,
    fullpath: null,
    path: null,
    query: null,
    qsd: {},
    qsdPlus: {},
    qsdMinus: new Map(),
    qsdColon: new Map(),
  }

  const match = VALID_URL_RE.exec(url)
  if (!match) {
    return null
  }

  result.schema = match[1] ? match[1].toLowerCase().trim() : defaultSchema
  const hostPortion = match[2] ? match[2].trim() : ''
  const qsdata = match[3] ? match[3].trim() : ''

  if (qsdata) {
    const parsed = parseQsd(qsdata, { plusToSpace, sanitize })
    result.qsd = parsed.qsd
    result.qsdPlus = parsed.qsdPlus
    result.qsdMinus = parsed.qsdMinus
    result.qsdColon = parsed.qsdColon
  }

  // urlparse(`http://${hostPortion}`): split netloc from path. urlparse only
  // treats '/', '?', '#' as delimiters (not backslash).
  let netloc = hostPortion
  let rawPath = ''
  const delim = hostPortion.search(/[/?#]/)
  if (delim !== -1) {
    netloc = hostPortion.slice(0, delim)
    rawPath = hostPortion.slice(delim)
    const qf = rawPath.search(/[?#]/)
    if (qf !== -1) {
      rawPath = rawPath.slice(0, qf)
    }
  }

  result.host = netloc.trim()
  result.fullpath = quote(unquote(tidyPath(rawPath.trim())))

  // Re-attach a trailing slash that tidy_path removed but the caller supplied.
  const lastFp = result.fullpath.at(-1)
  const lastUrl = url.at(-1)
  if (
    result.fullpath &&
    lastFp !== '/' &&
    lastFp !== '\\' &&
    (lastUrl === '/' || lastUrl === '\\')
  ) {
    const trimmedLast = url.trim().at(-1)
    if (trimmedLast) {
      result.fullpath += trimmedLast
    }
  }

  if (!result.fullpath) {
    result.fullpath = null
  } else {
    const qm = VALID_QUERY_RE.exec(result.fullpath)
    result.path = qm?.[1] ?? null
    result.query = qm?.[2] ?? null
  }

  // Split user (and password) out of the netloc.
  const atParts = result.host.split(/@+/)
  if (atParts.length >= 2) {
    result.user = atParts[0] ?? null
    result.host = atParts[1] ?? ''
  }
  if (result.user != null) {
    const colonParts = result.user.split(/:+/)
    if (colonParts.length >= 2) {
      result.user = colonParts[0] ?? null
      result.password = colonParts[1] ?? null
    }
  }

  // Port parsing (bracketed IPv6 host kept intact).
  const pmatch = PORT_RE.exec(result.host)
  if (pmatch) {
    result.host = pmatch[1] ?? ''
    const portStr = pmatch[2] ?? ''
    const hasDigit = /[0-9]/.test(portStr)
    const intVal = hasDigit ? strictInt(portStr) : null
    if (intVal === null) {
      // Python: int(...) raised ValueError.
      if (verifyHost) {
        return null
      }
    } else {
      result.port = intVal
    }
  }

  const port = result.port

  if (verifyHost) {
    const validated = isHostname(result.host)
    if (!validated) {
      return null
    }
    result.host = validated
    if (
      typeof port === 'number' &&
      !(!strictPort || (strictPort && port > 0 && port <= 65535))
    ) {
      return null
    }
  } else if (pmatch && typeof port !== 'number') {
    if (strictPort) {
      result.port = null // string ports unsupported in batch-1
    } else {
      result.port = null
      result.host = `${pmatch[1] ?? ''}:${pmatch[2] ?? ''}`
    }
  }

  // Re-assemble a cleaned-up URL.
  let assembled = `${result.schema}://`
  if (typeof result.user === 'string') {
    assembled += result.user
    assembled +=
      typeof result.password === 'string' ? `:${result.password}@` : '@'
  }
  assembled += result.host
  if (result.port != null) {
    assembled += `:${result.port}`
  }
  if (result.fullpath) {
    assembled += result.fullpath
  }
  result.url = assembled

  return result
}

// --- URLBase -----------------------------------------------------------------

/** Constructor arguments for {@link URLBase}, produced by {@link URLBase.parseUrl}. */
export interface UrlBaseArgs {
  schema?: string
  secure?: boolean
  host?: string | null
  port?: number | null
  user?: string | null
  password?: string | null
  fullpath?: string | null
  /** SSL certificate verification flag (already `parseBool`-normalised). */
  verify?: boolean
  /** Socket connect timeout in seconds (`?cto=`, already float-normalised). */
  cto?: number
  /** Socket read timeout in seconds (`?rto=`, already float-normalised). */
  rto?: number
}

/**
 * Results of {@link URLBase.parseUrl}: a {@link ParsedUrl} enriched with the
 * normalised standard query parameters consumed by the class hierarchy.
 */
export interface ParsedUrlResults extends ParsedUrl {
  secure: boolean
  /** SSL verification flag (parse_bool of `?verify=`, default true). */
  verify: boolean
  /** Effective `?cto=` — present only when a valid float was supplied. */
  cto?: number
  /** Effective `?rto=` — present only when a valid float was supplied. */
  rto?: number
  /** Effective `?format=` — present only when a valid value was supplied. */
  format?: NotifyFormat
  /** Effective `?overflow=` — present only when a valid value was supplied. */
  overflow?: OverflowMode
}

/**
 * Privacy masking modes for {@link URLBase.pprint} (upstream `PrivacyMode`,
 * url.py:61-72): `Secret` -> `****`; `Outer` -> first char + `...` + last char;
 * `Tail` -> `...` + the trailing 4 characters.
 */
export enum PrivacyMode {
  Secret = '*',
  Outer = 'o',
  Tail = 't',
}

/**
 * Root of the plugin class hierarchy — URL parsing and round-trip
 * serialisation. Mirrors upstream `URLBase` (apprise/url.py).
 */
export class URLBase {
  /** Secure sites are verified against a Certificate Authority by default. */
  static verifyCertificate = true

  /** Seconds to wait for the connection to be established (url.py:109). */
  static socketConnectTimeout = 4.0

  /** Seconds to wait for the server to send a response (url.py:113). */
  static socketReadTimeout = 4.0

  schema: string
  secure: boolean
  host: string
  port: number | null
  user: string | null
  password: string | null
  fullpath: string | null
  verifyCertificate: boolean
  socketConnectTimeout: number
  socketReadTimeout: number

  constructor(args: UrlBaseArgs = {}) {
    this.schema = (args.schema ?? 'unknown').toLowerCase()

    this.secure =
      typeof args.secure === 'boolean' ? args.secure : this.schema.endsWith('s')

    this.host = unquote(args.host ?? '')
    this.port = args.port ?? null
    this.user = args.user != null ? unquote(args.user) : null
    this.password = args.password != null ? unquote(args.password) : null

    const fullpath = unquote(args.fullpath ?? '')
    this.fullpath = fullpath || '/'

    this.verifyCertificate = parseBool(
      args.verify ?? URLBase.verifyCertificate,
      URLBase.verifyCertificate,
    )

    // The class defaults are read off the CONCRETE class so a plugin can
    // override them (upstream class attributes); `?cto=`/`?rto=` then override
    // per instance (url.py:290-309).
    const cls = this.constructor as typeof URLBase
    this.socketConnectTimeout = args.cto ?? cls.socketConnectTimeout
    this.socketReadTimeout = args.rto ?? cls.socketReadTimeout
  }

  /**
   * The (connect, read) timeout pair, mirroring upstream's `request_timeout`
   * property (url.py:821-825) which feeds `requests`' `timeout=` keyword.
   */
  get requestTimeout(): [number, number] {
    return [this.socketConnectTimeout, this.socketReadTimeout]
  }

  /**
   * The single request deadline handed to the transport, in milliseconds.
   *
   * ponytail: `requests` takes a SEPARATE connect and read timeout; native
   * `fetch` exposes only one `AbortSignal`, i.e. a total-request deadline, so a
   * 1:1 port is impossible. Both values are still parsed and round-tripped
   * faithfully; on the wire they are summed into one deadline (default
   * 4.0 + 4.0 = 8s). A consumer needing true split connect/read semantics
   * injects an undici-Agent-backed transport (`new Apprise({ transport })`).
   */
  get requestTimeoutMs(): number {
    return (this.socketConnectTimeout + this.socketReadTimeout) * 1000
  }

  /**
   * Parse an apprise URL and normalise the standard query parameters. Faithful
   * to `URLBase.parse_url` + `post_process_parse_url_results` (url.py:882-1031),
   * with the `format`/`overflow` extraction from `NotifyBase.parse_url`
   * (base.py:1214-1232) folded in so the whole standard-parameter contract
   * lives in one place. Returns `null` on parse failure.
   */
  static parseUrl(
    url: string,
    options: ParseUrlOptions = {},
  ): ParsedUrlResults | null {
    const parsed = parseUrl(url, { defaultSchema: 'unknown', ...options })
    if (!parsed) {
      return null
    }

    const results = parsed as ParsedUrlResults
    results.secure = results.schema.endsWith('s')

    // verify: parse_bool coercion, silent (no reject, no warn). When `?verify=`
    // is present the raw string goes through parse_bool with its own default
    // (false) — an unrecognised value like `?verify=bogus` therefore yields
    // false, matching upstream (post_process_parse_url_results, url.py:897-908).
    // When absent, verify defaults to true.
    results.verify =
      'verify' in results.qsd ? parseBool(results.qsd.verify) : true

    // format / overflow: value is lower-cased then validated against the enum;
    // an invalid value warns and falls back to the plugin default (omitted).
    if ('format' in results.qsd) {
      const value = (results.qsd.format ?? '').toLowerCase()
      if (NOTIFY_FORMATS.has(value)) {
        results.format = value as NotifyFormat
      } else {
        warn(`Unsupported format specified '${results.qsd.format}'`)
      }
    }

    if ('overflow' in results.qsd) {
      const value = (results.qsd.overflow ?? '').toLowerCase()
      if (OVERFLOW_MODES.has(value)) {
        results.overflow = value as OverflowMode
      } else {
        warn(`Unsupported overflow mode specified '${results.qsd.overflow}'`)
      }
    }

    // rto / cto: `float()` coercion. An invalid value WARNS and keeps the class
    // default — upstream catches the (TypeError, ValueError) rather than
    // rejecting the URL (url.py:291-309).
    if ('rto' in results.qsd) {
      const value = pyFloat(results.qsd.rto ?? '')
      if (value === null) {
        warn(
          `Invalid socket read timeout (rto) was specified ${results.qsd.rto}`,
        )
      } else {
        results.rto = value
      }
    }

    if ('cto' in results.qsd) {
      const value = pyFloat(results.qsd.cto ?? '')
      if (value === null) {
        warn(
          `Invalid socket connect timeout (cto) was specified ${results.qsd.cto}`,
        )
      } else {
        results.cto = value
      }
    }

    return results
  }

  /**
   * Provides the default set of query parameters for {@link url}. At the
   * URLBase level only `rto`/`cto`/`verify` are emitted (each ONLY when it
   * differs from the URLBase default — compared against the base class, not the
   * concrete plugin, exactly as upstream does); NotifyBase layers
   * `format`/`overflow` on top. Mirrors `URLBase.url_parameters`
   * (url.py:850-880) including the emission order, minus the `redirect`
   * parameter that is out of scope for batch-1.
   */
  urlParameters(): Record<string, string> {
    const params: Record<string, string> = {}
    if (this.socketReadTimeout !== URLBase.socketReadTimeout) {
      params.rto = pyFloatStr(this.socketReadTimeout)
    }
    if (this.socketConnectTimeout !== URLBase.socketConnectTimeout) {
      params.cto = pyFloatStr(this.socketConnectTimeout)
    }
    if (this.verifyCertificate !== URLBase.verifyCertificate) {
      params.verify = this.verifyCertificate ? 'yes' : 'no'
    }
    return params
  }

  /**
   * Privacy-print a secret before embedding it in a URL (upstream
   * `URLBase.pprint`, url.py:650-693). With `privacy=false` it simply quotes the
   * value (or returns it as-is when `quote=false`); with `privacy=true` it masks
   * per `mode` — `Secret` -> `****`, `Tail` -> `...` + last 4 chars, `Outer`
   * (default) -> first char + `...` + last char. Quoting is intentionally
   * skipped under privacy so the mask is not itself percent-encoded.
   */
  static pprint(
    content: string | null | undefined,
    privacy = true,
    mode: PrivacyMode = PrivacyMode.Outer,
    {
      quote: doQuote = true,
      safe = '/',
    }: { quote?: boolean; safe?: string } = {},
  ): string {
    if (!privacy) {
      return doQuote ? quote(content, safe) : (content ?? '')
    }
    if (mode === PrivacyMode.Secret) {
      return '****'
    }
    if (typeof content !== 'string' || !content) {
      return ''
    }
    if (mode === PrivacyMode.Tail) {
      return `...${content.slice(-4)}`
    }
    return `${content.slice(0, 1)}...${content.slice(-1)}`
  }

  /**
   * Render the `scheme://[user[:password]@]host[:port]` prefix shared by every
   * `url()` serialiser. The auth block masks the password to `****` under
   * `privacy`; the default port for the effective scheme (443 when `secure`,
   * else 80) is elided. Concrete plugins pass their OWN scheme and append their
   * own path/query tail (mirrors the head of `URLBase.url`, url.py:371-409).
   */
  protected renderUrlPrefix(scheme: string, privacy: boolean): string {
    let auth = ''
    if (this.user && this.password) {
      auth = `${quote(this.user, '')}:${
        privacy ? '****' : quote(this.password, '')
      }@`
    } else if (this.user) {
      auth = `${quote(this.user, '')}@`
    }

    const defaultPort = this.secure ? 443 : 80
    const port =
      this.port === null || this.port === defaultPort ? '' : `:${this.port}`
    return `${scheme}://${auth}${this.host}${port}`
  }

  /**
   * Assemble the URL back into a string that {@link parseUrl} can re-parse to
   * an equivalent instance. Mirrors `URLBase.url` (url.py:371-409): the scheme
   * is rendered as http/https from the `secure` flag (concrete plugins override
   * this to render their own scheme), the default port is elided, and
   * parameters are appended in insertion order.
   */
  url(privacy = false): string {
    const params = this.urlParameters()
    const scheme = this.secure ? 'https' : 'http'
    const fullpath = this.fullpath ? quote(this.fullpath, '/') : '/'
    const paramStr = Object.keys(params).length ? `?${urlencode(params)}` : ''

    return `${this.renderUrlPrefix(scheme, privacy)}${fullpath}${paramStr}`
  }
}
