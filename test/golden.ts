// SPDX-License-Identifier: BSD-2-Clause
// Golden-differential diff tool (core-foundation, group E — task 5.3).
//
// Given a golden fixture (upstream apprise v1.12.0's real wire requests) it
// drives the equivalent TS plugin through the injectable transport seam,
// records the request the plugin would put on the wire, and asserts it matches
// the fixture FIELD-BY-FIELD per the golden-differential-testing spec:
//
//   * method : exact.
//   * url    : EXACT string equality. The plugin builds the wire URL itself (the
//              recording transport never calls `fetch`, so no platform
//              normalisation is applied) and it must match the captured Python
//              `requests` URL byte-for-byte — including quote_plus query encoding
//              (`*`->`%2A`, `~` kept, space->`+`), which a `new URL()` round-trip
//              would silently paper over.
//   * headers: every header present on either side EXCEPT the transport-default
//              ignore list is compared. Semantic headers a plugin sets
//              (User-Agent, Content-Type, Authorization, `+`custom headers, and
//              apprise-api's Accept / X-Apprise-*) are therefore all compared —
//              a missing one fails. `Content-Type` is charset-normalised.
//   * body   : raw bytes by default; JSON key-order-independent (`json` mode);
//              form order/duplicate-preserving pair list (`form` mode).
//
// A `noRequest` fixture asserts the TS side likewise refuses to construct
// (`instantiation-failed`) or emits nothing (`no-request`).
//
// The tool drives via the registry (Apprise.add + notify), so the plugin under
// test must already be imported (which self-registers its scheme) before
// runGolden is called. It is transport-agnostic and reused by group F.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { AppriseAttachment } from '../src/attachment/base.js'
import { AttachMemory } from '../src/attachment/memory.js'
import type { NotifyType } from '../src/common.js'
import { Apprise } from '../src/core/apprise.js'
import { setMultipartBoundarySeed } from '../src/core/multipart.js'
import { clearStoreSeeds, setStoreSeeds } from '../src/core/store.js'
import {
  setTransport,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../src/core/transport.js'

// --- fixture shape -----------------------------------------------------------

/** Self-describing body encoding (see fixtures/SCHEMA.md). */
export interface FixtureBody {
  text?: string
  base64?: string
}

export interface FixtureRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: FixtureBody | null
}

/**
 * A canned response the recording transport returns for the i-th request of a
 * multi-step case, so a stateful plugin (login → send …) can build later
 * requests from earlier responses. Shape MUST match the upstream parse path
 * (e.g. rocketchat login → `{status,data:{authToken,userId}}`); a missing field
 * makes upstream short-circuit. Defaults to a 200 `{}` when absent.
 */
export interface CannedResponse {
  status?: number
  headers?: Record<string, string>
  body?: FixtureBody | null
}

export type AttachmentDescriptor =
  | { file: string }
  | {
      memory: { text?: string; base64?: string }
      mimetype?: string
      name?: string
    }

export interface FixtureCase {
  name: string
  input: {
    url: string
    title?: string
    body?: string
    type?: string
    attachments?: AttachmentDescriptor[]
    /** Per-request canned responses replayed in order (multi-step plugins). */
    responses?: CannedResponse[]
    /** New wire fixtures opt in to upstream notify() result parity. */
    assertResult?: boolean
  }
  seeds?: {
    uid?: string
    recursion?: number
    boundary?: string | null
    /** matrix login-mode txnId counter start (see store.ts). */
    txn?: number
    /** matrix raw-token fixed uuid (see store.ts). */
    uuid?: string
    /** DingTalk epoch-millisecond signing seed; schema validation is generic. */
    timestampMs?: number
  }
  expected: {
    /** Single-request delivery (unchanged, backward-compatible). */
    request?: FixtureRequest
    /** Ordered multi-request sequence (login/whoami/join/send/logout, split). */
    requests?: FixtureRequest[]
    /** Independent request-count oracle for `requests` (defends vs truncation). */
    expectedCount?: number
    noRequest?: { reason: 'instantiation-failed' | 'no-request' }
    /** Upstream notify() result, present iff input.assertResult is true. */
    result?: boolean
  }
}

export interface Fixture {
  plugin: string
  cases: FixtureCase[]
}

/** How to normalise the body before comparing (per plugin). */
export type BodyMode = 'json' | 'form' | 'raw'

export interface GoldenOptions {
  bodyMode: BodyMode
  /** Compare Content-Type verbatim, including parameters such as charset. */
  exactContentType?: boolean
  /**
   * Header keys (lower-cased) treated as transport defaults and NOT compared.
   * Defaults to the requests/fetch transport-default set. Note `accept` is a
   * transport default for json/form/xml (the wildcard value) but SEMANTIC for
   * apprise-api (`application/json`): apprise-api (group F) must pass a set
   * WITHOUT `accept` so its Accept header is compared.
   */
  ignoreHeaders?: ReadonlySet<string>
}

const DEFAULT_IGNORE: ReadonlySet<string> = new Set([
  'content-length',
  'accept-encoding',
  'accept',
  'connection',
  'host',
])

// --- helpers -----------------------------------------------------------------

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_TIMESTAMP_MS = 2 ** 51 - 1
const PLUGINS_CN = new Set([
  'serverchan',
  'dingtalk',
  'wecombot',
  'feishu',
  'lark',
  'wxpusher',
  'pushdeer',
])

function validateCannedResponse(
  response: CannedResponse,
  caseName: string,
  index: number,
): void {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error(`case "${caseName}" responses[${index}] must be an object`)
  }
  const allowed = new Set(['status', 'headers', 'body'])
  if (Object.keys(response).some((key) => !allowed.has(key))) {
    throw new Error(`case "${caseName}" responses[${index}] has unknown fields`)
  }
  if (
    response.status !== undefined &&
    (!Number.isInteger(response.status) || !Number.isFinite(response.status))
  ) {
    throw new Error(
      `case "${caseName}" responses[${index}].status must be integer`,
    )
  }
  if (
    response.headers !== undefined &&
    (!response.headers ||
      typeof response.headers !== 'object' ||
      Array.isArray(response.headers) ||
      Object.values(response.headers).some(
        (value) => typeof value !== 'string',
      ))
  ) {
    throw new Error(
      `case "${caseName}" responses[${index}].headers must map strings to strings`,
    )
  }
  if (response.body !== undefined && response.body !== null) {
    const bodyKeys = Object.keys(response.body)
    const bodyKey = bodyKeys[0] as 'text' | 'base64' | undefined
    if (
      bodyKeys.length !== 1 ||
      bodyKey === undefined ||
      !['text', 'base64'].includes(bodyKey) ||
      typeof response.body[bodyKey] !== 'string'
    ) {
      throw new Error(
        `case "${caseName}" responses[${index}].body must contain exactly one text/base64 string`,
      )
    }
  }
}

type ValidatedExpected = (
  | {
      shape: 'request'
      request: FixtureRequest
    }
  | {
      shape: 'requests'
      requests: FixtureRequest[]
      expectedCount: number
    }
  | {
      shape: 'noRequest'
      reason: 'instantiation-failed' | 'no-request'
    }
) & {
  assertResult: boolean | undefined
  result: boolean | undefined
}

/** Validate the fixture's exclusive delivery oracle before executing it. */
function validateExpectedShape(c: FixtureCase): ValidatedExpected {
  const expected = c.expected
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new Error(`case "${c.name}" expected must be an object`)
  }

  const request = expected.request
  const requests = expected.requests
  const noRequest = expected.noRequest
  const assertResult = c.input.assertResult
  const result = expected.result
  const shapes: ValidatedExpected['shape'][] = []
  if (request !== undefined) shapes.push('request')
  if (requests !== undefined) shapes.push('requests')
  if (noRequest !== undefined) shapes.push('noRequest')
  if (shapes.length !== 1) {
    throw new Error(
      `case "${c.name}" expected must contain exactly one of request, requests, or noRequest`,
    )
  }

  const shape = shapes[0] as ValidatedExpected['shape']
  if (shape !== 'requests' && 'expectedCount' in expected) {
    throw new Error(
      `case "${c.name}" expected.expectedCount is only valid with requests`,
    )
  }
  if (shape === 'request') {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new Error(`case "${c.name}" expected.request must be an object`)
    }
    return { shape, request, assertResult, result }
  } else if (shape === 'requests') {
    if (!Array.isArray(requests)) {
      throw new Error(
        `case "${c.name}" expected.requests must contain at least two requests`,
      )
    }
    const requestCount = requests.length
    if (requestCount < 2) {
      throw new Error(
        `case "${c.name}" expected.requests must contain at least two requests`,
      )
    }
    const validatedRequests: FixtureRequest[] = []
    for (let index = 0; index < requestCount; index += 1) {
      const member = Object.hasOwn(requests, index)
        ? requests[index]
        : undefined
      if (!member || typeof member !== 'object' || Array.isArray(member)) {
        throw new Error(
          `case "${c.name}" expected.requests entries must be objects`,
        )
      }
      validatedRequests.push(member)
    }
    const expectedCount = expected.expectedCount
    if (expectedCount !== requestCount) {
      throw new Error(
        `case "${c.name}" expected.expectedCount must equal expected.requests.length`,
      )
    }
    return {
      shape,
      requests: validatedRequests,
      expectedCount,
      assertResult,
      result,
    }
  } else {
    const reason = noRequest?.reason
    if (reason !== 'instantiation-failed' && reason !== 'no-request') {
      throw new Error(
        `case "${c.name}" expected.noRequest.reason must be "instantiation-failed" or "no-request"`,
      )
    }
    return { shape, reason, assertResult, result }
  }
}

export function validateFixture(fixture: Fixture): Fixture {
  for (const c of fixture.cases) {
    const expected = validateExpectedShape(c)
    const timestampMs = c.seeds?.timestampMs
    if (
      timestampMs !== undefined &&
      (!Number.isSafeInteger(timestampMs) ||
        timestampMs < 0 ||
        timestampMs > MAX_TIMESTAMP_MS)
    ) {
      throw new Error(
        `case "${c.name}" seeds.timestampMs must be an integer between 0 and ${MAX_TIMESTAMP_MS}`,
      )
    }
    if (c.input.responses !== undefined && !Array.isArray(c.input.responses)) {
      throw new Error(`case "${c.name}" input.responses must be an array`)
    }
    for (const [index, response] of (c.input.responses ?? []).entries()) {
      validateCannedResponse(response, c.name, index)
    }
    const isInstantiationFailure =
      expected.shape === 'noRequest' &&
      expected.reason === 'instantiation-failed'
    if (PLUGINS_CN.has(fixture.plugin)) {
      if (typeof expected.assertResult !== 'boolean') {
        throw new Error(`plugins-cn case "${c.name}" must declare assertResult`)
      }
      if (isInstantiationFailure && expected.assertResult !== false) {
        throw new Error(
          `instantiation-failed case "${c.name}" must set assertResult=false`,
        )
      }
      if (!isInstantiationFailure && expected.assertResult !== true) {
        throw new Error(
          `constructed case "${c.name}" must set assertResult=true`,
        )
      }
    }
    if (
      expected.assertResult === true &&
      typeof expected.result !== 'boolean'
    ) {
      throw new Error(`case "${c.name}" must provide boolean expected.result`)
    }
    if (expected.assertResult !== true && expected.result !== undefined) {
      throw new Error(
        `case "${c.name}" must omit expected.result unless assertResult=true`,
      )
    }
  }
  return fixture
}

/** Load a fixture by a path relative to the subproject root. */
export function loadFixture(relPath: string): Fixture {
  return validateFixture(
    JSON.parse(readFileSync(join(PROJECT_ROOT, relPath), 'utf8')) as Fixture,
  )
}

function buildAttach(
  descriptors: AttachmentDescriptor[] | undefined,
): AppriseAttachment | null {
  if (!descriptors || descriptors.length === 0) {
    return null
  }
  const container = new AppriseAttachment()
  for (const d of descriptors) {
    if ('file' in d) {
      if (!container.add(join(PROJECT_ROOT, d.file))) {
        throw new Error(`could not add file attachment: ${d.file}`)
      }
    } else {
      const content =
        d.memory.text !== undefined
          ? d.memory.text
          : Buffer.from(d.memory.base64 ?? '', 'base64')
      container.add(
        new AttachMemory({
          content,
          name: d.name ?? null,
          mimetype: d.mimetype ?? null,
        }),
      )
    }
  }
  return container
}

interface DriveResult {
  added: boolean
  requests: TransportRequest[]
  result: boolean
}

/** Build a form-correct TransportResponse from a canned spec (default 200 `{}`). */
function makeResponse(spec: CannedResponse | undefined): TransportResponse {
  const status = spec?.status ?? 200
  let bodyBytes: Buffer
  if (spec === undefined) {
    bodyBytes = Buffer.from('{}')
  } else if (spec.body == null) {
    bodyBytes = Buffer.alloc(0)
  } else if (spec.body.base64 !== undefined) {
    bodyBytes = Buffer.from(spec.body.base64, 'base64')
  } else {
    bodyBytes = Buffer.from(spec.body.text ?? '')
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: new Headers(spec?.headers ?? {}),
    text: async () => bodyBytes.toString(),
    arrayBuffer: async () => Uint8Array.from(bodyBytes).buffer,
  }
}

/** Drive one case through Apprise, recording the wire request(s). */
async function driveCase(c: FixtureCase): Promise<DriveResult> {
  const seeds = c.seeds ?? {}
  const asset = new AppriseAsset({
    uid: seeds.uid ?? 'itest-uid-0',
    recursion: seeds.recursion ?? 0,
  })

  // Pin the store determinism BEFORE the plugin is constructed (the store reads
  // seeds at construction). Cleared in the finally below (like setTransport).
  setStoreSeeds({ txn: seeds.txn, uuid: seeds.uuid })
  // Pin the shared multipart boundary so hand-assembled multipart bodies replay
  // byte-for-byte against the capture. Cleared in the finally (like setTransport).
  setMultipartBoundarySeed(seeds.boundary ?? null)
  try {
    const app = new Apprise({ asset })
    const added = app.add(c.input.url)

    const canned = c.input.responses ?? []
    const requests: TransportRequest[] = []
    // This recorder captures the request the PLUGIN emits (Python parity),
    // including any GET/HEAD body upstream sends; the real native-fetch runtime
    // drops a GET/HEAD body (transport.ts) — see transport.test.ts.
    const transport: Transport = async (req) => {
      const idx = requests.length
      requests.push(req)
      return makeResponse(canned[idx])
    }

    let result = false
    if (added) {
      setTransport(transport)
      try {
        result = await app.notify({
          title: c.input.title ?? '',
          body: c.input.body ?? '',
          type: (c.input.type ?? 'info') as NotifyType,
          attach: buildAttach(c.input.attachments),
        })
      } finally {
        setTransport(null)
      }
    }
    if (requests.length < canned.length) {
      throw new Error(
        `case "${c.name}" left response preset index ${requests.length} unconsumed`,
      )
    }
    return { added, requests, result }
  } finally {
    clearStoreSeeds()
    setMultipartBoundarySeed(null)
  }
}

function headerMap(h: Record<string, string> | undefined): Map<string, string> {
  const m = new Map<string, string>()
  for (const [k, v] of Object.entries(h ?? {})) {
    m.set(k.toLowerCase(), v)
  }
  return m
}

/** Strip a `; charset=...` suffix from a Content-Type value. */
function stripCharset(v: string | undefined): string | undefined {
  return v?.split(';')[0]?.trim()
}

function bodyToString(body: TransportRequest['body']): string | null {
  if (body == null) {
    return null
  }
  return typeof body === 'string' ? body : Buffer.from(body).toString()
}

/** Recursively sort object keys (arrays keep order) for order-agnostic JSON. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson)
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalJson((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

/** Decode one `application/x-www-form-urlencoded` token (`+` -> space). */
function decodeForm(s: string): string {
  return decodeURIComponent(s.replace(/\+/g, ' '))
}

/** Parse a form body into an ORDERED, duplicate-preserving pair list. */
function parseForm(body: string): Array<[string, string]> {
  if (body === '') {
    return []
  }
  return body.split('&').map((pair) => {
    const eq = pair.indexOf('=')
    const k = eq === -1 ? pair : pair.slice(0, eq)
    const v = eq === -1 ? '' : pair.slice(eq + 1)
    return [decodeForm(k), decodeForm(v)] as [string, string]
  })
}

function compareHeaders(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
  ignore: ReadonlySet<string>,
  exactContentType: boolean,
): void {
  const ah = headerMap(actual)
  const eh = headerMap(expected)
  const keys = new Set(
    [...ah.keys(), ...eh.keys()].filter((k) => !ignore.has(k)),
  )
  for (const key of keys) {
    let a = ah.get(key)
    let e = eh.get(key)
    if (key === 'content-type' && !exactContentType) {
      a = stripCharset(a)
      e = stripCharset(e)
    }
    expect(a, `header "${key}"`).toBe(e)
  }
}

function compareBody(
  actual: TransportRequest['body'],
  expected: FixtureBody | null,
  mode: BodyMode,
): void {
  if (expected == null) {
    const s = bodyToString(actual)
    expect(s == null || s === '', 'body should be empty').toBe(true)
    return
  }
  if (expected.base64 !== undefined) {
    // Byte-faithful: base64-encode the ORIGINAL body bytes, never a UTF-8
    // round-trip (which maps invalid UTF-8 to U+FFFD and corrupts arbitrary
    // binary). A string body is its UTF-8 bytes; a Uint8Array is used verbatim.
    const bytes =
      actual == null
        ? Buffer.alloc(0)
        : typeof actual === 'string'
          ? Buffer.from(actual, 'utf8')
          : Buffer.from(actual)
    expect(bytes.toString('base64'), 'body (base64)').toBe(expected.base64)
    return
  }
  const actualStr = bodyToString(actual)
  const expText = expected.text ?? ''
  if (mode === 'json') {
    expect(canonicalJson(JSON.parse(actualStr ?? 'null'))).toEqual(
      canonicalJson(JSON.parse(expText)),
    )
  } else if (mode === 'form') {
    expect(parseForm(actualStr ?? '')).toEqual(parseForm(expText))
  } else {
    expect(actualStr ?? '').toBe(expText)
  }
}

function compareRequest(
  actual: TransportRequest,
  expected: FixtureRequest,
  opts: GoldenOptions,
): void {
  expect(actual.method, 'method').toBe(expected.method)
  expect(actual.url, 'url').toBe(expected.url)
  compareHeaders(
    actual.headers,
    expected.headers,
    opts.ignoreHeaders ?? DEFAULT_IGNORE,
    opts.exactContentType ?? false,
  )
  compareBody(actual.body, expected.body, opts.bodyMode)
}

/** Run the golden assertions for ONE case (exported for the tool's self-test). */
export async function matchCase(
  c: FixtureCase,
  opts: GoldenOptions,
): Promise<void> {
  const expected = validateExpectedShape(c)
  const { added, requests, result } = await driveCase(c)

  const assertNotifyResult = (): void => {
    if (expected.assertResult === true) {
      expect(result, 'notify result').toBe(expected.result)
    }
  }

  if (expected.shape === 'noRequest') {
    if (expected.reason === 'instantiation-failed') {
      expect(added, 'instantiation should have failed').toBe(false)
    } else {
      expect(added, 'instantiation should have succeeded').toBe(true)
    }
    expect(requests, 'no wire request expected').toHaveLength(0)
    assertNotifyResult()
    return
  }

  // Multi-request form: an ordered sequence with an independent count oracle.
  if (expected.shape === 'requests') {
    const expectedReqs = expected.requests
    const count = expected.expectedCount
    expect(added, 'instantiation should succeed').toBe(true)
    // Independent count oracle: guards against a truncated sequence (a short
    // upstream response short-circuiting) passing by mutual agreement.
    expect(requests, `expected ${count} wire requests`).toHaveLength(count)
    for (let i = 0; i < expectedReqs.length; i++) {
      compareRequest(
        requests[i] as TransportRequest,
        expectedReqs[i] as FixtureRequest,
        opts,
      )
    }
    assertNotifyResult()
    return
  }

  expect(added, 'instantiation should succeed').toBe(true)
  expect(requests, 'exactly one wire request expected').toHaveLength(1)
  compareRequest(requests[0] as TransportRequest, expected.request, opts)
  assertNotifyResult()
}

/**
 * Register a vitest `test()` per fixture case. Call at the top level of a
 * plugin's golden test file (after importing the plugin so its scheme is
 * registered).
 */
export function runGolden(relFixturePath: string, opts: GoldenOptions): void {
  const fixture = loadFixture(relFixturePath)
  for (const c of fixture.cases) {
    test(c.name, async () => {
      await matchCase(c, opts)
    })
  }
}
