// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/custom_json.py).
//
// NotifyJSON — the `json://` / `jsons://` meta-plugin. It POSTs (by default) a
// JSON body whose five keys (version/title/message/attachments/type) mirror
// upstream exactly, supports `?method=` HTTP-verb override, and the `+`/`-`/`:`
// URL prefixes for extra headers / GET params / payload keys. The wire request
// is verified field-by-field against the Python golden fixture.

import type { AppriseAttachment } from '../attachment/base.js'
import { NotifyType } from '../common.js'
import {
  NotifyBase,
  type NotifyBaseArgs,
  type SendOptions,
} from '../core/notify-base.js'
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

// The HTTP methods `?method=` may select (upstream custom_json.py:52-61). Note
// the non-standard `UPDATE`. `METHODS[0]` (POST) is the default.
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

/** Constructor arguments for {@link NotifyJSON} (produced by its `parseUrl`). */
export interface NotifyJSONArgs extends NotifyBaseArgs {
  /** Extra HTTP headers (`+key`). */
  headers?: Record<string, string>
  /** HTTP method override (`?method=`); upper-cased and validated. */
  method?: string
  /** Payload key extras/overrides (`:key`); order-preserving Map. */
  payload?: Map<string, string>
  /** Extra GET params (`-key`), joined into the request URL; order-preserving Map. */
  params?: Map<string, string>
}

/** A wrapper for JSON notifications (upstream `NotifyJSON`). */
export class NotifyJSON extends NotifyBase {
  static override attachmentSupport = true

  /** JSON schema version emitted in every payload (upstream `json_version`). */
  jsonVersion = '1.0'

  method: string
  headers: Record<string, string>
  /** `-` GET params; a Map so integer-style keys keep insertion order on the wire query. */
  params: Map<string, string>
  /** `:` payload extras applied to the JSON body (order-agnostic there, but Map-typed for uniformity). */
  payloadExtras: Map<string, string>

  constructor(args: NotifyJSONArgs = {}) {
    super(args)

    // Upstream keeps fullpath as the (possibly empty) raw string; URLBase
    // coerces an absent path to '/', so restore the upstream default here so
    // the wire URL has no spurious trailing slash.
    this.fullpath = typeof args.fullpath === 'string' ? args.fullpath : ''

    this.method =
      typeof args.method === 'string' ? args.method.toUpperCase() : METHODS[0]
    if (!(METHODS as readonly string[]).includes(this.method)) {
      throw new TypeError(`The method specified (${args.method}) is invalid.`)
    }

    this.params = new Map(args.params ?? [])
    this.headers = { ...(args.headers ?? {}) }
    this.payloadExtras = new Map(args.payload ?? [])
  }

  override async send(
    body: string,
    title = '',
    notifyType: NotifyType = NotifyType.INFO,
    options: SendOptions = {},
  ): Promise<boolean> {
    // ponytail: native fetch forbids a GET/HEAD body (transport.ts drops it),
    // but upstream custom_json.py:315 sends the JSON payload as the body on ANY
    // method (incl. GET/HEAD). Fail loud rather than silently ship an empty
    // GET/HEAD and report success on the 2xx.
    if (this.method === 'GET' || this.method === 'HEAD') {
      throw new TypeError(
        `json:// cannot send a ${this.method} request: native fetch cannot ` +
          'carry the JSON payload as a GET/HEAD body (upstream does).',
      )
    }

    const headers: Record<string, string> = {
      'User-Agent': this.asset.appId,
      'Content-Type': 'application/json',
      ...this.headers,
    }

    const attachments: Array<{
      filename: string
      base64: string
      mimetype: string
    }> = []
    const attach: AppriseAttachment | null = options.attach ?? null
    if (attach && this.attachmentSupport) {
      let no = 0
      for (const attachment of attach) {
        no++
        if (!attachment.exists()) {
          return false
        }
        try {
          attachments.push({
            filename: attachment.name
              ? attachment.name
              : `file${String(no).padStart(3, '0')}.dat`,
            base64: attachment.base64(),
            mimetype: attachment.mimetype ?? '',
          })
        } catch {
          return false
        }
      }
    }

    const payload: Record<string, unknown> = {
      version: this.jsonVersion,
      title,
      message: body,
      attachments,
      type: notifyType,
    }

    // Payload extras (`:key`): rename an existing key to `value`, delete it when
    // `value` is empty, or append a brand-new key (upstream custom_json.py:272-285).
    for (const [key, value] of this.payloadExtras) {
      if (key in payload) {
        if (!value) {
          delete payload[key]
        } else {
          payload[value] = payload[key]
          delete payload[key]
        }
      } else {
        payload[key] = value
      }
    }

    if (this.user) {
      headers.Authorization = basicAuth(this.user, this.password)
    }

    const schema = this.secure ? 'https' : 'http'
    let url = `${schema}://${this.host}`
    if (this.port != null) {
      url += `:${this.port}`
    }
    // Empty path -> `/` on the wire: both Python `requests` and `fetch`
    // normalise an absent path to `/`, so the plugin must build the same url
    // the golden capture recorded (`http://host/`), not `http://host`.
    url += this.fullpath || '/'

    // `-` params ride in the wire query, quote_plus-encoded (requests params=).
    const query = urlencodePlus(this.params)
    if (query) {
      url += `?${query}`
    }

    const res = await this.request({
      method: this.method,
      url,
      headers,
      body: JSON.stringify(payload),
    })
    return res.status >= 200 && res.status < 300
  }

  /**
   * Serialise back to a `json(s)://` URL (custom_json.py:378-429). Emits the
   * plugin's own scheme, ALWAYS `method`, the standard params, and the
   * `+`(headers)/`-`(params)/`:`(payloadExtras) prefix maps so the URL
   * round-trips to an equivalent instance.
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

    const scheme = this.secure ? 'jsons' : 'json'
    const fullpath = this.fullpath ? quote(this.fullpath, '/') : '/'
    return `${this.renderUrlPrefix(scheme, privacy)}${fullpath}?${urlencode(params)}`
  }

  /** Parse a `json(s)://` URL into constructor args (upstream `parse_url`). The
   * base fields ride on {@link ParsedUrlResults}; the `+`/`-`/`:` maps and the
   * method are attached as extra runtime props consumed by the constructor. */
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

registerPlugin(['json', 'jsons'], NotifyJSON as unknown as PluginConstructor)
