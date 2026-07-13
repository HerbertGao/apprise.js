// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/discord.py).
//
// NotifyDiscord — the `discord://` webhook plugin. A `discord://{webhook_id}/
// {webhook_token}` URL (optionally `discord://{botname}@…` to override the
// username) POSTs a JSON payload to
// `https://discord.com/api/webhooks/{webhook_id}/{webhook_token}`, and delivers
// attachments as a Discord `files[i]` multipart request. This batch implements
// the plain TEXT/HTML content path + attachments; the MARKDOWN embeds path
// (fields/footer/image thumbnail/href), ping mentions, and user-template
// rendering are DEFERRED — a URL that reaches those paths throws at send. All
// query parameters (tts/avatar/avatar_url/footer/footer_logo/fields/flags/href/
// thread/ping/image/batch/botname) are still parsed and round-tripped via
// url(). The wire request is verified field-by-field against the Python golden.

import type { AttachBase } from '../attachment/base.js'
import { NotifyFormat, NotifyImageSize, NotifyType } from '../common.js'
import { chooseBoundary, escapeMultipartFilename } from '../core/multipart.js'
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
  parseBool,
  quote,
  URLBase,
  unquote,
  urlencode,
  urlencodePlus,
} from '../url.js'

const NOTIFY_URL = 'https://discord.com/api/webhooks'
// Attachment batching limits (discord.py:121-126).
const MAX_ATTACHMENTS = 10
const MAX_ATTACH_BYTES = 25 * 1024 * 1024

// Path element delimiter set (upstream PATHSPLIT_LIST_DELIM, url.py).
const PATHSPLIT_RE = /[ \t\r\n,\\/]+/
// parse_list delimiters (STRING_DELIMITERS, parse.py:48).
const LIST_DELIM_RE = /[[\];,\s]+/

/** split_path: drop a leading `/`, split on the delimiter set, unquote. */
function splitPath(path: string): string[] {
  return path
    .replace(/^\/+/, '')
    .split(PATHSPLIT_RE)
    .filter(Boolean)
    .map((x) => unquote(x))
}

/** parse_list (parse.py, `sort=True`): split, flatten, dedupe, sort. */
function parseList(input: string | string[] | null | undefined): string[] {
  const out: string[] = []
  const args = Array.isArray(input) ? input : input == null ? [] : [input]
  for (const arg of args) {
    if (typeof arg === 'string') {
      out.push(...arg.split(LIST_DELIM_RE).filter(Boolean))
    }
  }
  return [...new Set(out)].sort()
}

/** validate_regex default (`[^\s]+`): first non-whitespace run, or null. */
function validateRegex(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const m = /[^\s]+/.exec(value.trim())
  return m ? m[0] : null
}

// --- Python-compatible JSON (byte-exact for the multipart `payload_json`) ----

/** Escape a string exactly as Python `json.dumps` (ensure_ascii=True) does. */
function pyJsonString(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string
    const code = s.charCodeAt(i)
    if (ch === '"') {
      out += '\\"'
    } else if (ch === '\\') {
      out += '\\\\'
    } else if (code === 0x08) {
      out += '\\b'
    } else if (code === 0x09) {
      out += '\\t'
    } else if (code === 0x0a) {
      out += '\\n'
    } else if (code === 0x0c) {
      out += '\\f'
    } else if (code === 0x0d) {
      out += '\\r'
    } else if (code < 0x20 || code >= 0x80) {
      // Control chars and (ensure_ascii) all non-ASCII escape as \uXXXX; Python
      // escapes each UTF-16 code unit, matching charCodeAt iteration.
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else {
      out += ch
    }
  }
  return `${out}"`
}

/**
 * Serialise a value the way Python `json.dumps` does with its DEFAULT
 * separators (`", "` and `": "`), preserving key insertion order. Needed so the
 * `payload_json` field embedded in the multipart attachment body is byte-exact
 * against the upstream capture (the compact `JSON.stringify` output differs).
 */
function pyJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null'
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'string') {
    return pyJsonString(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(pyJson).join(', ')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
  return `{${entries.map(([k, v]) => `${pyJsonString(k)}: ${pyJson(v)}`).join(', ')}}`
}

// --- multipart (mirrors requests/urllib3 files= encoding) --------------------

const CRLF = '\r\n'

interface MultipartFile {
  field: string
  /** Attachment filename, or null when absent (upstream omits `filename=`). */
  filename: string | null
  mimetype: string
  content: Buffer
}

/**
 * Build a `multipart/form-data` body byte-identical to what Python `requests`
 * emits for `data={"payload_json": ...}` + `files=[...]`: the data field first,
 * then each file field (Content-Disposition + Content-Type), then the closing
 * boundary. Matches the urllib3 field-render layout used by upstream discord.
 */
function buildMultipart(
  payloadJson: string,
  files: MultipartFile[],
  boundary: string,
): Buffer {
  const chunks: Buffer[] = []
  chunks.push(
    Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="payload_json"${CRLF}${CRLF}${payloadJson}${CRLF}`,
      'utf8',
    ),
  )
  for (const f of files) {
    // ponytail: upstream passes `attachment.name` (None -> requests/urllib3 omits
    // the `filename=` param). This nameless path is uncoverable by fixture (the
    // capture harness's memory attachments require a name; file attachments always
    // have one), so only the named case is byte-asserted.
    const disposition =
      f.filename === null || f.filename === ''
        ? `Content-Disposition: form-data; name="${f.field}"`
        : `Content-Disposition: form-data; name="${f.field}"; filename="${escapeMultipartFilename(f.filename)}"`
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}${disposition}${CRLF}Content-Type: ${f.mimetype}${CRLF}${CRLF}`,
        'utf8',
      ),
    )
    chunks.push(f.content)
    chunks.push(Buffer.from(CRLF, 'utf8'))
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'))
  return Buffer.concat(chunks)
}

/** Constructor arguments for {@link NotifyDiscord} (from its `parseUrl`). */
export interface NotifyDiscordArgs extends NotifyBaseArgs {
  webhook_id?: string
  webhook_token?: string
  tts?: boolean
  avatar?: boolean
  footer?: boolean
  footer_logo?: boolean
  include_image?: boolean
  fields?: boolean
  avatar_url?: string
  href?: string
  thread?: string
  flags?: string | number
  ping?: string
  template?: string
  batch?: boolean
}

/** A wrapper for Discord webhook notifications (upstream `NotifyDiscord`). */
export class NotifyDiscord extends NotifyBase {
  static override attachmentSupport = true
  static override bodyMaxlen = 2000
  // The body budget includes the title; amalgamate it so overflow behaves.
  static override overflowAmalgamateTitle = true

  webhookId: string
  webhookToken: string
  tts: boolean
  avatar: boolean
  footer: boolean
  footerLogo: boolean
  includeImage: boolean
  fields: boolean
  avatarUrl: string | null
  href: string | null
  threadId: string | null
  flags: number | null
  ping: string[]
  template: string | null
  batch: boolean

  constructor(args: NotifyDiscordArgs = {}) {
    super(args)

    const webhookId = validateRegex(args.webhook_id)
    if (!webhookId) {
      throw new TypeError(
        `An invalid Discord Webhook ID (${args.webhook_id}) was specified.`,
      )
    }
    this.webhookId = webhookId

    const webhookToken = validateRegex(args.webhook_token)
    if (!webhookToken) {
      throw new TypeError(
        `An invalid Discord Webhook Token (${args.webhook_token}) was specified.`,
      )
    }
    this.webhookToken = webhookToken

    this.tts = args.tts ?? false
    this.avatar = args.avatar ?? true
    this.footer = args.footer ?? false
    this.footerLogo = args.footer_logo ?? true
    this.includeImage = args.include_image ?? false
    this.fields = args.fields ?? true
    this.avatarUrl =
      typeof args.avatar_url === 'string' ? args.avatar_url : null
    this.href = typeof args.href === 'string' ? args.href : null
    this.threadId = typeof args.thread === 'string' ? args.thread : null

    if (args.flags) {
      const flags = Number.parseInt(String(args.flags), 10)
      if (Number.isNaN(flags) || flags < 0) {
        throw new TypeError(
          `An invalid Discord flags setting (${args.flags}) was specified.`,
        )
      }
      this.flags = flags
    } else {
      this.flags = null
    }

    this.ping = parseList(args.ping)
    this.template = typeof args.template === 'string' ? args.template : null
    this.batch = args.batch ?? true
  }

  override async send(
    body: string,
    title = '',
    notifyType: NotifyType = NotifyType.INFO,
    options: SendOptions = {},
  ): Promise<boolean> {
    const attach = options.attach ?? null

    // ponytail: the MARKDOWN embeds path (fields/footer/thumbnail/href), ping
    // mentions, and user templates are deferred this batch (not in the coverage
    // matrix). Reject rather than emit a divergent payload.
    if (this.template) {
      throw new TypeError(
        'Discord template mode is not supported in this batch.',
      )
    }
    if (this.notifyFormat === NotifyFormat.MARKDOWN) {
      throw new TypeError(
        'Discord markdown/embeds mode is not supported in this batch.',
      )
    }
    if (this.ping.length > 0) {
      throw new TypeError(
        'Discord ping mentions are not supported in this batch.',
      )
    }

    const payload: Record<string, unknown> = {
      tts: this.tts,
      // If TTS is set we do not wait for the whole message; otherwise we wait.
      wait: this.tts === false,
    }
    if (this.flags) {
      payload.flags = this.flags
    }

    const imageUrl = this.asset.imageUrl(notifyType, NotifyImageSize.XY_256)
    if (this.avatar && (imageUrl || this.avatarUrl)) {
      payload.avatar_url = this.avatarUrl ? this.avatarUrl : imageUrl
    }
    if (this.user) {
      payload.username = this.user
    }

    const params: Map<string, string> | null = this.threadId
      ? new Map([['thread_id', this.threadId]])
      : null

    // TEXT / HTML content branch (discord.py:630-638).
    if (body) {
      payload.content = title ? `${title}\r\n${body}` : body
      if (!(await this.dispatch(payload, params, null))) {
        return false
      }
    }

    if (attach && this.attachmentSupport && attach.length > 0) {
      // Attachments re-use the payload but never speak; content is dropped.
      payload.tts = false
      payload.wait = true
      delete payload.content

      const attachments = [...attach]
      const maxPer = this.batch ? MAX_ATTACHMENTS : 1
      const batches: AttachBase[][] = []
      let current: AttachBase[] = []
      let currentSize = 0
      for (const a of attachments) {
        const size = this.batch && a.exists() ? a.size : 0
        if (
          current.length > 0 &&
          (current.length >= maxPer ||
            (this.batch && currentSize + size > MAX_ATTACH_BYTES))
        ) {
          batches.push(current)
          current = []
          currentSize = 0
        }
        current.push(a)
        currentSize += size
      }
      batches.push(current)

      for (const b of batches) {
        if (!(await this.dispatch(payload, params, b))) {
          return false
        }
      }
    }

    return true
  }

  /** Post `payload` (JSON, or multipart when `attach` is given). */
  private async dispatch(
    payload: Record<string, unknown>,
    params: Map<string, string> | null,
    attach: AttachBase[] | null,
  ): Promise<boolean> {
    const headers: Record<string, string> = { 'User-Agent': this.asset.appId }

    let url = `${NOTIFY_URL}/${this.webhookId}/${this.webhookToken}`
    if (params) {
      const query = urlencodePlus(params)
      if (query) {
        url += `?${query}`
      }
    }

    let wireBody: string | Buffer
    if (attach && attach.length > 0) {
      const files: MultipartFile[] = []
      for (let i = 0; i < attach.length; i++) {
        const a = attach[i] as AttachBase
        if (!a.exists()) {
          return false
        }
        files.push({
          field: `files[${i}]`,
          // Upstream passes attachment.name verbatim (None -> no filename= param).
          filename: a.name ?? null,
          mimetype: a.mimetype ?? 'application/octet-stream',
          content: Buffer.from(a.base64(), 'base64'),
        })
      }
      const boundary = chooseBoundary()
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`
      wireBody = buildMultipart(pyJson(payload), files, boundary)
    } else {
      headers['Content-Type'] = 'application/json; charset=utf-8'
      wireBody = pyJson(payload)
    }

    const res = await request({ method: 'POST', url, headers, body: wireBody })
    // Discord accepts 200 (wait=true) or 204 (no content) (discord.py:855-858).
    return res.status === 200 || res.status === 204
  }

  /** Serialise back to a `discord://` URL (discord.py:932-986). */
  override url(privacy = false): string {
    const params: Record<string, string> = {
      tts: this.tts ? 'yes' : 'no',
      avatar: this.avatar ? 'yes' : 'no',
      footer: this.footer ? 'yes' : 'no',
      footer_logo: this.footerLogo ? 'yes' : 'no',
      image: this.includeImage ? 'yes' : 'no',
      fields: this.fields ? 'yes' : 'no',
      batch: this.batch ? 'yes' : 'no',
    }
    if (this.avatarUrl) {
      params.avatar_url = this.avatarUrl
    }
    if (this.flags) {
      params.flags = String(this.flags)
    }
    if (this.href) {
      params.href = this.href
    }
    if (this.threadId) {
      params.thread = this.threadId
    }
    if (this.ping.length > 0) {
      params.ping = this.ping.join(',')
    }
    Object.assign(params, this.urlParameters())

    const botname = this.user ? `${quote(this.user, '')}@` : ''
    const webhookId = URLBase.pprint(
      this.webhookId,
      privacy,
      PrivacyMode.Outer,
      {
        safe: '',
      },
    )
    const webhookToken = URLBase.pprint(
      this.webhookToken,
      privacy,
      PrivacyMode.Outer,
      { safe: '' },
    )
    return `discord://${botname}${webhookId}/${webhookToken}/?${urlencode(params)}`
  }

  /** Parse a `discord://` URL into constructor args (upstream `parse_url`). */
  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url, { verifyHost: false })
    if (!results) {
      return null
    }
    const extra = results as unknown as Record<string, unknown>

    extra.webhook_id = unquote(results.host)
    const tokens = splitPath(results.fullpath ?? '')
    extra.webhook_token = tokens.length > 0 ? tokens[0] : null

    extra.tts = parseBool(results.qsd.tts ?? false)
    extra.fields = parseBool(results.qsd.fields ?? true)
    extra.footer = parseBool(results.qsd.footer ?? false)
    extra.footer_logo = parseBool(results.qsd.footer_logo ?? true)
    extra.avatar = parseBool(results.qsd.avatar ?? true)
    extra.include_image = parseBool(
      'image' in results.qsd ? results.qsd.image : false,
      false,
    )

    if ('botname' in results.qsd) {
      extra.user = unquote(results.qsd.botname)
    }
    if ('flags' in results.qsd) {
      extra.flags = unquote(results.qsd.flags)
    }
    if ('avatar_url' in results.qsd) {
      extra.avatar_url = unquote(results.qsd.avatar_url)
    }
    if ('href' in results.qsd) {
      extra.href = unquote(results.qsd.href)
    } else if ('url' in results.qsd) {
      extra.href = unquote(results.qsd.url)
      extra.format = NotifyFormat.MARKDOWN
    }
    if ('thread' in results.qsd) {
      extra.thread = unquote(results.qsd.thread)
      extra.format = NotifyFormat.MARKDOWN
    }
    if ('ping' in results.qsd) {
      extra.ping = unquote(results.qsd.ping)
    }
    if (results.qsd.template) {
      extra.template = unquote(results.qsd.template)
    }
    extra.batch = parseBool(
      'batch' in results.qsd ? results.qsd.batch : true,
      true,
    )

    return results
  }
}

registerPlugin('discord', NotifyDiscord as unknown as PluginConstructor)
