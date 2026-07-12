// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/apprise_api.py).
//
// NotifyAppriseAPI — the `apprise://` / `apprises://` meta-plugin targeting an
// Apprise API server. It differs from the other custom plugins:
//   * the endpoint ALWAYS ends `/notify/{token}` and the HTTP method is ALWAYS
//     POST — `?method=` selects the PAYLOAD ENCODING (form|json), not a verb;
//   * it always emits the semantic headers Accept/X-Apprise-ID/
//     X-Apprise-Recursion-Count (plus Content-Type for json, Authorization when
//     credentialed); the golden diff compares Accept (its ignore set omits it);
//   * only the `+` (headers) prefix is honoured — `-` and `:` are ignored;
//   * attachments embed as base64 when method=json (multipart when method=form
//     is deferred this batch — see the send() guard).

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
  type ParsedUrlResults,
  PrivacyMode,
  quote,
  URLBase,
  unquote,
  urlencode,
  urlencodePlus,
} from '../url.js'
import { basicAuth, mapUnquote } from './util.js'

// `?method=` selects the payload ENCODING (not an HTTP verb); form is default.
const APPRISE_API_METHODS = ['form', 'json'] as const
// Token character class (apprise_api.py:126); validated case-insensitively.
const TOKEN_RE = /^[A-Z0-9_-]{1,128}$/i
// Path element delimiter (upstream PATHSPLIT_LIST_DELIM, url.py:49).
const PATHSPLIT_RE = /[ \t\r\n,\\/]+/

/** split_path: drop a leading `/`, split on the delimiter set, unquote. */
function splitPath(path: string): string[] {
  return path
    .replace(/^\/+/, '')
    .split(PATHSPLIT_RE)
    .filter(Boolean)
    .map((x) => unquote(x))
}

/** Constructor arguments for {@link NotifyAppriseAPI} (from its `parseUrl`). */
export interface NotifyAppriseAPIArgs extends NotifyBaseArgs {
  /** Notification token (from the path, or `?token=` / `?to=`). */
  token?: string
  /** Payload encoding (`?method=`); lower-cased and validated. */
  method?: string
  /** Extra HTTP headers (`+key`). */
  headers?: Record<string, string>
}

/** A wrapper for Apprise API notifications (upstream `NotifyAppriseAPI`). */
export class NotifyAppriseAPI extends NotifyBase {
  static override attachmentSupport = true

  token: string
  method: string
  headers: Record<string, string>

  constructor(args: NotifyAppriseAPIArgs = {}) {
    super(args)

    const token = typeof args.token === 'string' ? args.token : ''
    if (!TOKEN_RE.test(token)) {
      throw new TypeError(
        `The Apprise API token specified (${token}) is invalid.`,
      )
    }
    this.token = token

    this.method =
      typeof args.method === 'string'
        ? args.method.toLowerCase()
        : APPRISE_API_METHODS[0]
    if (!(APPRISE_API_METHODS as readonly string[]).includes(this.method)) {
      throw new TypeError(`The method specified (${args.method}) is invalid.`)
    }

    this.headers = { ...(args.headers ?? {}) }
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

    // Attachments: base64-embed for json; multipart (files) for form is a real
    // upstream code path that is DEFERRED this batch (a smoke test in
    // apprise-api.test.ts pins the refusal). Refuse rather than diverge.
    const attach: AppriseAttachment | null = options.attach ?? null
    const attachments: Array<{
      filename: string
      base64: string
      mimetype: string
    }> = []
    if (attach && this.attachmentSupport && attach.length > 0) {
      if (this.method !== 'json') {
        // ponytail: multipart form delivery deferred (see file header + task 6.7).
        return false
      }
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

    // Payload in upstream key order (title/body/type/format).
    const payloadObj: Record<string, unknown> = {
      title,
      body,
      type: notifyType,
      format: this.notifyFormat,
    }

    let wireBody: string
    if (this.method === 'json') {
      headers['Content-Type'] = 'application/json'
      if (attachments.length > 0) {
        payloadObj.attachments = attachments
      }
      wireBody = JSON.stringify(payloadObj)
    } else {
      // form: requests sets application/x-www-form-urlencoded for a dict body.
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      wireBody = urlencodePlus(payloadObj as Record<string, string>)
    }

    if (this.user) {
      headers.Authorization = basicAuth(this.user, this.password)
    }

    const schema = this.secure ? 'https' : 'http'
    let url = `${schema}://${this.host}`
    if (this.port != null) {
      url += `:${this.port}`
    }
    const fullpath = (this.fullpath ?? '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
    if (fullpath) {
      url += `/${fullpath}`
    }
    url += `/notify/${this.token}`

    // Headers that cannot be over-ridden (apprise_api.py:368-377).
    headers.Accept = 'application/json'
    headers['X-Apprise-ID'] = this.asset.uid
    headers['X-Apprise-Recursion-Count'] = String(this.asset.recursion + 1)

    // HTTP method is ALWAYS POST (method= only chose the encoding above).
    // Success is EXACTLY 200 (apprise_api.py:406, `!= requests.codes.ok` fails);
    // a 201/202 is a failure here, unlike the custom-json/form/xml plugins which
    // accept any 2xx.
    const res = await request({ method: 'POST', url, headers, body: wireBody })
    return res.status === 200
  }

  /**
   * Serialise back to an `apprise(s)://` URL (apprise_api.py:198-253). Emits the
   * plugin's own scheme, ALWAYS `method` (the payload ENCODING), the standard
   * params, and only the `+`(headers) prefix (`-`/`:` are ignored by this
   * plugin). The token is re-appended after the path as `.../{token}/?params`.
   */
  override url(privacy = false): string {
    const params: Record<string, string> = { method: this.method }
    Object.assign(params, this.urlParameters())
    for (const [k, v] of Object.entries(this.headers)) {
      params[`+${k}`] = v
    }
    // ponytail: `?tags=` echo is deferred with tag routing (a batch-1 non-goal).

    const scheme = this.secure ? 'apprises' : 'apprise'
    const rawPath = (this.fullpath ?? '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
    const fullpath = rawPath ? `/${quote(rawPath, '/')}/` : '/'
    // Token is privacy-masked (Outer mode) like the password (apprise_api.py:250,
    // `pprint(self.token, privacy, safe="")`) — never emit it verbatim under
    // privacy, or the URL leaks the secret.
    const token = URLBase.pprint(this.token, privacy, PrivacyMode.Outer, {
      safe: '',
    })
    return `${this.renderUrlPrefix(scheme, privacy)}${fullpath}${token}/?${urlencode(
      params,
    )}`
  }

  /**
   * Recognise a NATIVE Apprise API URL (`http(s)://host[/path]/notify/{token}`)
   * and translate it to an `apprise(s)://` URL (upstream `parse_native_url`).
   */
  static override parseNativeUrl(url: string): Record<string, unknown> | null {
    const m =
      /^http(?<secure>s?):\/\/(?<hostname>[A-Z0-9._-]+)(:(?<port>[0-9]+))?(?<path>\/[^?]+?)?\/notify\/(?<token>[A-Z0-9_-]{1,32})\/?(?<params>\?.+)?$/i.exec(
        url,
      )
    if (!m) {
      return null
    }
    const g = m.groups as Record<string, string | undefined>
    const schema = g.secure ? 'apprises' : 'apprise'
    const port = g.port ? `:${g.port}` : ''
    const path = g.path ?? ''
    // DELIBERATE deviation from upstream (apprise_api.py:492): the `params` group
    // already includes its leading `?`, and upstream re-prepends another `?`
    // (`"?{}".format(...)`), producing a latent-buggy `??x=y` that keys the first
    // param as `?x`. We strip the captured `?` and add exactly one — the correct
    // behaviour. Guarded by an intentional single-`?` round-trip expectation.
    const params = g.params ? `?${g.params.slice(1)}` : ''
    return NotifyAppriseAPI.parseUrl(
      `${schema}://${g.hostname}${port}${path}/${g.token}/${params}`,
    ) as unknown as Record<string, unknown> | null
  }

  /** Parse an `apprise(s)://` URL into constructor args (upstream `parse_url`). */
  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url)
    if (!results) {
      return null
    }
    const extra = results as unknown as Record<string, unknown>
    extra.headers = mapUnquote(results.qsdPlus)

    // Token precedence: ?token= , then ?to= , then the last path segment.
    const qToken = results.qsd.token
    const qTo = results.qsd.to
    if (qToken?.length) {
      extra.token = unquote(qToken)
    } else if (qTo?.length) {
      extra.token = unquote(qTo)
    } else {
      const entries = splitPath(results.fullpath ?? '')
      if (entries.length > 0) {
        extra.token = entries[entries.length - 1]
        extra.fullpath = entries.slice(0, -1).join('/')
      }
    }

    const method = results.qsd.method
    if (method?.length) {
      extra.method = unquote(method)
    }
    // ponytail: `?tags=` is a batch-1 non-goal (tag routing deferred); parsed
    // by upstream but intentionally not wired into the request here.
    return results
  }
}

registerPlugin(
  ['apprise', 'apprises'],
  NotifyAppriseAPI as unknown as PluginConstructor,
)
