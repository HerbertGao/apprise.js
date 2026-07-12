// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/custom_xml.py).
//
// NotifyXML — the `xml://` / `xmls://` meta-plugin. It POSTs (by default) a SOAP
// envelope whose XML declaration, namespaces and element names mirror upstream
// byte-for-byte; payload values are escaped with the upstream `escape_html`
// (`'`->`&apos;`, `"`->`&quot;`, plus `&`/`<`/`>`). The `+` prefix adds headers
// and `:` adds/renames payload elements. The `-` (GET params) prefix is a
// faithful upstream QUIRK: it is parsed and echoed by url() but NOT sent on the
// wire (upstream send() passes no `params=`), so it is verified by a url() unit
// test rather than a golden fixture. Multipart is N/A (XML embeds base64).

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
} from '../url.js'
import { basicAuth, mapUnquote } from './util.js'

// Same 8-tuple as the other custom plugins (custom_xml.py:51-60); POST default.
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

// XML element names for the built-in payload fields (upstream XMLPayloadField).
const FIELD_VERSION = 'Version'
const FIELD_TITLE = 'Subject'
const FIELD_MESSAGE = 'Message'
const FIELD_MESSAGETYPE = 'MessageType'

const XSD_VER = '1.1'
const XSD_DEFAULT_URL =
  'https://raw.githubusercontent.com/caronc/apprise/master' +
  '/apprise/assets/NotifyXML-{version}.xsd'

// The SOAP envelope template, copied byte-for-byte from custom_xml.py:173-184
// (indentation and newlines are load-bearing — the golden diff compares raw
// bytes). Placeholders are filled in send().
const PAYLOAD_TEMPLATE = `<?xml version='1.0' encoding='utf-8'?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <soapenv:Body>
        <Notification{{XSD_URL}}>
            {{CORE}}
            {{ATTACHMENTS}}
       </Notification>
    </soapenv:Body>
</soapenv:Envelope>`

/**
 * Escape a string for XML/HTML embedding — the upstream `URLBase.escape_html`
 * with `whitespace=False, convert_new_lines=False` (the flags every send() call
 * site uses, custom_xml.py:284-341). `&` is escaped first so the following
 * named entities are not double-escaped (upstream sax_escape order).
 */
function escapeHtml(value: string | null | undefined): string {
  if (!value) {
    return ''
  }
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;')
    .replaceAll('"', '&quot;')
}

/** Constructor arguments for {@link NotifyXML} (produced by its `parseUrl`). */
export interface NotifyXMLArgs extends NotifyBaseArgs {
  /** Extra HTTP headers (`+key`). */
  headers?: Record<string, string>
  /** HTTP method override (`?method=`); upper-cased and validated. */
  method?: string
  /** Payload element extras/overrides (`:key`); order-preserving for the XML body. */
  payload?: Map<string, string>
  /** Extra GET params (`-key`) — parsed & echoed by url() but never sent; order-preserving. */
  params?: Map<string, string>
}

/** A wrapper for XML notifications (upstream `NotifyXML`). */
export class NotifyXML extends NotifyBase {
  static override attachmentSupport = true

  method: string
  headers: Record<string, string>
  /** `-` GET params: stored & echoed by url(), NOT sent (upstream quirk); a Map
   * so integer-style keys keep insertion order when echoed. */
  params: Map<string, string>
  /** Element-name map for the built-in fields; `:Field=alias` renames one. */
  payloadMap: Record<string, string>
  /** `:key` overrides that hit a built-in field (echoed by url()). */
  payloadOverrides: Record<string, string>
  /** `:key` extras that add a brand-new element; a Map so integer-style names
   * keep insertion order in the XML body (a plain object would hoist `"1"`). */
  payloadExtras: Map<string, string>

  constructor(args: NotifyXMLArgs = {}) {
    super(args)

    // Upstream keeps fullpath as the (possibly empty) raw string.
    this.fullpath = typeof args.fullpath === 'string' ? args.fullpath : ''

    this.method =
      typeof args.method === 'string' ? args.method.toUpperCase() : METHODS[0]
    if (!(METHODS as readonly string[]).includes(this.method)) {
      throw new TypeError(`The method specified (${args.method}) is invalid.`)
    }

    this.payloadMap = {
      [FIELD_VERSION]: FIELD_VERSION,
      [FIELD_TITLE]: FIELD_TITLE,
      [FIELD_MESSAGE]: FIELD_MESSAGE,
      [FIELD_MESSAGETYPE]: FIELD_MESSAGETYPE,
    }

    this.params = new Map(args.params ?? [])
    this.headers = { ...(args.headers ?? {}) }
    this.payloadOverrides = {}
    this.payloadExtras = new Map()

    // Sort each `:key` into an override of a built-in element or a new extra,
    // sanitising the key to XML-safe characters (custom_xml.py:225-245). The
    // extras Map keeps upstream dict insertion order — integer-style element
    // names (`:2`, `:1`) are NOT hoisted the way a plain object would reorder them.
    for (const [rawKey, value] of args.payload ?? []) {
      const key = rawKey.replace(/[^A-Za-z0-9_-]/g, '')
      if (!key) {
        continue
      }
      if (key in this.payloadMap) {
        this.payloadMap[key] = value
        this.payloadOverrides[key] = value
      } else {
        this.payloadExtras.set(key, value)
      }
    }
  }

  /** True when any `:` override/extra is present (upstream `xsd_url` gate). */
  private get hasPayloadCustomisations(): boolean {
    return (
      Object.keys(this.payloadOverrides).length > 0 ||
      this.payloadExtras.size > 0
    )
  }

  override async send(
    body: string,
    title = '',
    notifyType: NotifyType = NotifyType.INFO,
    options: SendOptions = {},
  ): Promise<boolean> {
    const headers: Record<string, string> = {
      'User-Agent': this.asset.appId,
      'Content-Type': 'application/xml',
      ...this.headers,
    }

    // Build the core elements in upstream field order, honouring any rename and
    // skipping a field whose element name was mapped to empty. A Map (like the
    // upstream `dict`, custom_xml.py:278) dedups by element name: remapping a
    // built-in onto an existing name overwrites (last value, first position)
    // rather than emitting a second same-named element.
    const payloadBase = new Map<string, string>()
    const fields: Array<[string, string]> = [
      [FIELD_VERSION, XSD_VER],
      [FIELD_TITLE, escapeHtml(title)],
      [FIELD_MESSAGE, escapeHtml(body)],
      [FIELD_MESSAGETYPE, escapeHtml(notifyType)],
    ]
    for (const [key, value] of fields) {
      const mapped = this.payloadMap[key]
      if (!mapped) {
        continue
      }
      payloadBase.set(mapped, value)
    }
    for (const [key, value] of this.payloadExtras) {
      payloadBase.set(key, escapeHtml(value))
    }
    const xmlBase = [...payloadBase]
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join('')

    let xmlAttachments = ''
    const attach: AppriseAttachment | null = options.attach ?? null
    if (attach && this.attachmentSupport) {
      const entries: string[] = []
      let no = 0
      for (const attachment of attach) {
        no++
        if (!attachment.exists()) {
          return false
        }
        try {
          const filename = attachment.name
            ? attachment.name
            : `file${String(no).padStart(3, '0')}.dat`
          const entry =
            `<Attachment filename="${escapeHtml(filename)}"` +
            ` mimetype="${escapeHtml(attachment.mimetype ?? '')}">` +
            `${attachment.base64()}</Attachment>`
          entries.push(entry)
        } catch {
          return false
        }
      }
      xmlAttachments = `<Attachments format="base64">${entries.join('')}</Attachments>`
    }

    const xsdUrl = this.hasPayloadCustomisations
      ? null
      : XSD_DEFAULT_URL.replace('{version}', XSD_VER)
    const payload = PAYLOAD_TEMPLATE.replaceAll(
      '{{XSD_URL}}',
      xsdUrl ? ` xmlns:xsi="${xsdUrl}"` : '',
    )
      .replaceAll('{{CORE}}', xmlBase)
      .replaceAll('{{ATTACHMENTS}}', xmlAttachments)

    if (this.user) {
      headers.Authorization = basicAuth(this.user, this.password)
    }

    const schema = this.secure ? 'https' : 'http'
    let url = `${schema}://${this.host}`
    if (this.port != null) {
      url += `:${this.port}`
    }
    // Empty path -> `/` on the wire (requests/fetch both normalise it), so the
    // built url matches the golden capture (`http://host/`, not `http://host`).
    url += this.fullpath || '/'

    // Upstream passes no `params=`, so `-` params never reach the wire.
    const res = await request({
      method: this.method,
      url,
      headers,
      body: payload,
    })
    return res.status >= 200 && res.status < 300
  }

  /**
   * Serialise back to an `xml(s)://` URL. Mirrors custom_xml.py:467-519 — it
   * echoes `method`, the standard params, and the `+`/`-`/`:` maps. NOTE the
   * `-` params ARE echoed here even though they are never sent (the upstream
   * quirk this method exists to document/verify).
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

    // url() renders the plugin's OWN scheme (custom_xml.py:504,
    // `secure_protocol if secure else protocol`), NOT the http/https wire scheme
    // send() uses — a serialised URL must re-parse back to an xml(s):// instance.
    const scheme = this.secure ? 'xmls' : 'xml'
    const fullpath = this.fullpath ? quote(this.fullpath, '/') : '/'
    return `${this.renderUrlPrefix(scheme, privacy)}${fullpath}?${urlencode(params)}`
  }

  /** Parse an `xml(s)://` URL into constructor args (upstream `parse_url`). */
  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url)
    if (!results) {
      return null
    }
    const extra = results as unknown as Record<string, unknown>
    // Keep the `:`payload / `-`params as ordered Maps so integer-style element
    // names survive to the XML body in upstream dict insertion order (`:2`
    // before `:1`) — a plain object would hoist `"1"` ahead of `"2"`. Mirrors
    // custom-form/-json (C3-1). Headers are an unordered set, so a plain object.
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

registerPlugin(['xml', 'xmls'], NotifyXML as unknown as PluginConstructor)
