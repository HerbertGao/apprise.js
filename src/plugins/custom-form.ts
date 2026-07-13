// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/custom_form.py).
//
// NotifyForm — the `form://` / `forms://` meta-plugin. It POSTs (by default) an
// `application/x-www-form-urlencoded` body of four fields (version/title/
// message/type). `?method=GET` is a distinct code path: the payload becomes URL
// query params and the body is omitted (upstream custom_form.py:404). The
// `+`/`-`/`:` prefixes add headers / GET params / payload keys, and `:key` may
// remap one of the built-in field NAMES. Multipart attachment delivery is
// deferred this batch (see the send() guard).

import type { AppriseAttachment } from '../attachment/base.js'
import { NotifyType } from '../common.js'
import {
  NotifyBase,
  type NotifyBaseArgs,
  type SendOptions,
} from '../core/notify-base.js'
import { request } from '../core/transport.js'
import { type PluginConstructor, registerPlugin } from '../registry.js'
import {
  mapUnquoteMap,
  type ParsedUrlResults,
  quote,
  URLBase,
  unquote,
  urlencode,
  urlencodePlus,
} from '../url.js'
import { basicAuth, mapUnquote } from './util.js'

// Same 8-tuple as custom-json (upstream custom_form.py:48-57); POST is default.
const METHODS = [
  'POST',
  'GET',
  'DELETE',
  'PUT',
  'HEAD',
  'PATCH',
  'UPDATE',
  'OPTIONS',
] as const

// The built-in form field names (upstream FORMPayloadField).
const FIELD_VERSION = 'version'
const FIELD_TITLE = 'title'
const FIELD_MESSAGE = 'message'
const FIELD_TYPE = 'type'

/** Constructor arguments for {@link NotifyForm} (produced by its `parseUrl`). */
export interface NotifyFormArgs extends NotifyBaseArgs {
  /** Extra HTTP headers (`+key`). */
  headers?: Record<string, string>
  /** HTTP method override (`?method=`); upper-cased and validated. */
  method?: string
  /** Payload key extras/overrides (`:key`); order-preserving for the wire body. */
  payload?: Map<string, string>
  /** Extra GET params (`-key`); order-preserving for the wire query. */
  params?: Map<string, string>
}

/** A wrapper for form-encoded notifications (upstream `NotifyForm`). */
export class NotifyForm extends NotifyBase {
  static override attachmentSupport = true

  /** Form schema version emitted in every payload (upstream `form_version`). */
  formVersion = '1.0'

  method: string
  headers: Record<string, string>
  /** `-` GET params; a Map so integer-style keys keep insertion order on the wire. */
  params: Map<string, string>
  /** `:` payload extras; a Map so integer-style keys keep order in the form body. */
  payloadExtras: Map<string, string>
  /** Field-name mapping; `:field=alias` renames a built-in field's key. */
  payloadMap: Record<string, string>
  /** `:field=alias` overrides of a built-in field (echoed by url()). */
  payloadOverrides: Record<string, string>

  constructor(args: NotifyFormArgs = {}) {
    super(args)

    this.fullpath = typeof args.fullpath === 'string' ? args.fullpath : ''

    this.method =
      typeof args.method === 'string' ? args.method.toUpperCase() : METHODS[0]
    if (!(METHODS as readonly string[]).includes(this.method)) {
      throw new TypeError(`The method specified (${args.method}) is invalid.`)
    }

    // ponytail: attach-as / multi-attachment naming is only meaningful for the
    // multipart path, which is deferred this batch (send() refuses attachments).
    // Wire it in when multipart delivery lands (task 6.7).

    this.payloadMap = {
      [FIELD_VERSION]: FIELD_VERSION,
      [FIELD_TITLE]: FIELD_TITLE,
      [FIELD_MESSAGE]: FIELD_MESSAGE,
      [FIELD_TYPE]: FIELD_TYPE,
    }

    this.params = new Map(args.params ?? [])
    this.headers = { ...(args.headers ?? {}) }
    this.payloadExtras = new Map(args.payload ?? [])
    this.payloadOverrides = {}

    // A `:field=alias` whose key is a built-in field remaps that field's name
    // instead of adding a new key (upstream custom_form.py:274-282). The
    // override is retained separately so url() can echo it (custom_form.py:495).
    for (const key of [...this.payloadExtras.keys()]) {
      if (key in this.payloadMap) {
        const value = this.payloadExtras.get(key) as string
        this.payloadMap[key] = value
        this.payloadOverrides[key] = value
        this.payloadExtras.delete(key)
      }
    }
  }

  override async send(
    body: string,
    title = '',
    notifyType: NotifyType = NotifyType.INFO,
    options: SendOptions = {},
  ): Promise<boolean> {
    const headers: Record<string, string> = {
      'User-Agent': this.asset.appId,
      ...this.headers,
    }
    if (this.user) {
      headers.Authorization = basicAuth(this.user, this.password)
    }

    // ponytail: multipart form-data delivery is deferred to a later batch
    // (design Open Question / task 6.7). Rather than emit a request that
    // diverges from upstream's multipart body, refuse the attachment path.
    // A smoke test pins this batch-1 behaviour (custom-form.test.ts).
    const attach: AppriseAttachment | null = options.attach ?? null
    if (attach && this.attachmentSupport && attach.length > 0) {
      return false
    }

    // Build the payload in upstream field order (version/title/message/type),
    // honouring any field-name remap and skipping fields mapped to empty. A Map
    // keeps insertion order on the wire even when a field is renamed to an
    // integer-style name (`:title=1`) — a plain object would hoist `"1"` first.
    const payload = new Map<string, string>()
    const builtins: Array<[string, string]> = [
      [FIELD_VERSION, this.formVersion],
      [FIELD_TITLE, title],
      [FIELD_MESSAGE, body],
      [FIELD_TYPE, notifyType],
    ]
    for (const [key, value] of builtins) {
      const mapped = this.payloadMap[key]
      if (!mapped) {
        continue
      }
      payload.set(mapped, value)
    }
    for (const [key, value] of this.payloadExtras) {
      payload.set(key, value)
    }

    const schema = this.secure ? 'https' : 'http'
    let url = `${schema}://${this.host}`
    if (this.port != null) {
      url += `:${this.port}`
    }
    // Empty path -> `/` on the wire (requests/fetch both normalise it), so the
    // built url matches the golden capture (`http://host/`, not `http://host`).
    url += this.fullpath || '/'

    if (this.method === 'GET') {
      // GET: payload rides in the query string, merged with `-` params; no body.
      // The wire query is quote_plus-encoded (requests params=), NOT the form
      // body encoder — `*`/`~`/space differ between the two. Merging via a Map
      // matches Python `payload.update(self.params)`: params override on key
      // collision but existing keys keep their position (insertion order).
      const query = urlencodePlus(new Map([...payload, ...this.params]))
      if (query) {
        url += `?${query}`
      }
      const res = await request({ method: 'GET', url, headers, body: null })
      return res.status >= 200 && res.status < 300
    }

    // ponytail: native fetch forbids a HEAD body (transport.ts drops it), but
    // upstream custom_form.py sends the form payload as the body on any non-GET
    // method (incl. HEAD). Fail loud rather than silently ship an empty HEAD and
    // report success on the 2xx. (GET is query-mapped above and stays correct;
    // DELETE/PUT/PATCH/UPDATE/OPTIONS legitimately carry a body on native fetch.)
    if (this.method === 'HEAD') {
      throw new TypeError(
        'form:// cannot send a HEAD request: native fetch cannot carry the ' +
          'form payload as a HEAD body (upstream does).',
      )
    }

    // Non-GET: payload is the form-encoded body; `-` params ride in the query
    // (quote_plus-encoded like requests params=, distinct from the body encoder).
    const query = urlencodePlus(this.params)
    if (query) {
      url += `?${query}`
    }
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const res = await request({
      method: this.method,
      url,
      headers,
      body: urlencodePlus(payload),
    })
    return res.status >= 200 && res.status < 300
  }

  /**
   * Serialise back to a `form(s)://` URL (custom_form.py:485-532). Emits the
   * plugin's own scheme, ALWAYS `method`, the standard params, and the
   * `+`(headers)/`-`(params)/`:`(payloadExtras + payloadOverrides) prefix maps.
   * The `attach-as` extension is deferred this batch (multipart), so it is not
   * emitted here — wire it in with multipart delivery (task 6.7).
   */
  override url(privacy = false): string {
    const params: Record<string, string> = { method: this.method }
    Object.assign(params, this.urlParameters())
    for (const [k, v] of Object.entries(this.headers)) {
      params[`+${k}`] = v
    }
    for (const [k, v] of this.params) {
      params[`-${k}`] = v
    }
    for (const [k, v] of this.payloadExtras) {
      params[`:${k}`] = v
    }
    for (const [k, v] of Object.entries(this.payloadOverrides)) {
      params[`:${k}`] = v
    }

    const scheme = this.secure ? 'forms' : 'form'
    const fullpath = this.fullpath ? quote(this.fullpath, '/') : '/'
    return `${this.renderUrlPrefix(scheme, privacy)}${fullpath}?${urlencode(params)}`
  }

  /** Parse a `form(s)://` URL into constructor args (upstream `parse_url`). */
  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url)
    if (!results) {
      return null
    }
    const extra = results as unknown as Record<string, unknown>
    extra.payload = mapUnquoteMap(results.qsdColon)
    extra.headers = mapUnquote(results.qsdPlus)
    extra.params = mapUnquoteMap(results.qsdMinus)
    const method = results.qsd.method
    if (method?.length) {
      extra.method = unquote(method)
    }
    return results
  }
}

registerPlugin(['form', 'forms'], NotifyForm as unknown as PluginConstructor)
