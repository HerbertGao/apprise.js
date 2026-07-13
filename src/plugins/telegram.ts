// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/telegram.py).
//
// NotifyTelegram — the `tgram://` Telegram Bot API plugin. URL is
// `tgram://{bot_token}[/{targets}]`; text is delivered via
// `POST https://api.telegram.org/bot{token}/sendMessage`, and each attachment
// via a mimetype-selected endpoint (sendAnimation/sendPhoto/sendVideo/
// sendVoice/sendAudio/sendDocument) as an ORDERED multipart request. Targets
// are `parse_list`-sorted+deduped, then matched against IS_CHAT_ID_RE (numeric
// chat id, or `@channel`, with an optional `:topic`). The wire request is
// verified field-by-field against the Python golden fixture.
//
// DEFERRED (out of scope this batch, matching the spec):
//   * no-target `getUpdates` bot-owner auto-detection + cross-call store
//     (telegram.py:385,673-798,1287-1295) — in-scope requires explicit targets;
//   * the CommonMark→Telegram-Markdown `_build_send_calls` override + its
//     _commonmark_to_telegram / _repair_split_chunk helpers, which only trigger
//     when notify_format==MARKDOWN AND body_format==HTML (telegram.py:1238-1274);
//   * `?image=` icon delivery via `image_path()` (needs bundled asset images).

import type { AppriseAttachment, AttachBase } from '../attachment/base.js'
import { NotifyFormat, NotifyType } from '../common.js'
import { chooseBoundary, escapeMultipartFilename } from '../core/multipart.js'
import {
  NotifyBase,
  type NotifyBaseArgs,
  type SendOptions,
} from '../core/notify-base.js'
import { type PluginConstructor, registerPlugin } from '../registry.js'
import {
  type ParsedUrlResults,
  PrivacyMode,
  parseBool,
  quote,
  URLBase,
  unquote,
  urlencode,
} from '../url.js'

// Telegram Bot API base; the bot token and endpoint are appended (telegram.py:152).
const NOTIFY_URL = 'https://api.telegram.org/bot'

// The maximum caption length; a body within it rides as the first attachment's
// caption instead of a separate sendMessage (telegram.py:166).
const CAPTION_MAXLEN = 1024

// Telegram Markdown versions (telegram.py:90-114).
const MDV_ONE = 'MARKDOWN' // classic
const MDV_TWO = 'MarkdownV2'
// Ordered map for the `next(startswith)` resolution (telegram.py:447-462);
// insertion order matters, so an array (not an object) is used.
const MDV_MAP: ReadonlyArray<readonly [string, string]> = [
  ['v1', MDV_ONE],
  ['1', MDV_ONE],
  ['v2', MDV_TWO],
  ['2', MDV_TWO],
  ['default', MDV_TWO],
]
// Reverse lookup for url() (telegram.py:110-114).
const MDV_REVERSE: Record<string, string> = {
  [MDV_ONE]: 'v1',
  [MDV_TWO]: 'v2',
}

// Content placement (telegram.py:117-130).
const CONTENT_BEFORE = 'before'
const CONTENT_AFTER = 'after'
const CONTENT_PLACEMENTS: ReadonlySet<string> = new Set([
  CONTENT_BEFORE,
  CONTENT_AFTER,
])

// Chat-id / @channel / :topic matcher (telegram.py:83-87).
const IS_CHAT_ID_RE =
  /^((?<idno>-?[0-9]{1,32})|(@|%40)?(?<name>[a-z_-][a-z0-9_-]+))((:|%3A)(?<topic>[0-9]+))?$/i

// Bot-token validator; strips an optional leading `bot` (telegram.py:356).
const BOT_TOKEN_RE = /^(bot)?(?<key>[0-9]+:[a-z0-9_-]+)$/i

// parse_url's dirty-hack matcher for the colon-bearing bot token (telegram.py:1605).
const PARSE_URL_RE =
  /^(?<protocol>tgram:\/\/)(bot)?(?<prefix>([a-z0-9_-]+)(:[a-z0-9_-]+)?@)?(?<btoken_a>[0-9]+)(:|%3A)+(?<remaining>.*)$/i

// split_path delimiter set (url.py PATHSPLIT_LIST_DELIM).
const PATHSPLIT_RE = /[ \t\r\n,\\/]+/
// parse_list string delimiters (parse.py:48, STRING_DELIMITERS).
const STRING_DELIMITERS = /[[\];,\s]+/

// Attachment mimetype → endpoint, scanned TOP-TO-BOTTOM (ORDER-SENSITIVE,
// telegram.py:185-231). gif/H264 animation precedes generic image; video is
// mp4-only; ogg voice precedes audio; document is the catch-all. Regexes carry
// only `i` (no `g`) so `.test()` stays stateless.
const MIME_LOOKUP: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^(image\/gif|video\/H264)/i, 'sendAnimation', 'animation'],
  [/^image\/.*/i, 'sendPhoto', 'photo'],
  [/^video\/mp4/i, 'sendVideo', 'video'],
  [/^(application|audio)\/ogg/i, 'sendVoice', 'voice'],
  [/^audio\/(mpeg|mp4a-latm)/i, 'sendAudio', 'audio'],
  [/.*/i, 'sendDocument', 'document'],
]

// Telegram's HTML mode rejects HTML-escaped entities and many tags; these
// ordered substitutions convert an HTML body to what Telegram expects
// (telegram.py:238-343). Each entry is [pattern, replacement, htmlFill]: when
// htmlFill is non-null the replacement's `{}` is filled with htmlFill (only for
// HTML/MARKDOWN source bodies) else "". All patterns carry `g` (Python re.sub
// replaces every match).
type EscapeEntry = readonly [RegExp, string, string | null]
const HTML_ESCAPE_ENTRIES: ReadonlyArray<EscapeEntry> = [
  [/\s*<!.+?-->\s*/gims, '', null],
  [
    /\s*<\s*(!?DOCTYPE|p|div|span|body|script|link|meta|html|font|head|label|form|input|textarea|select|iframe|source|script)([^a-z0-9>][^>]*)?>\s*/gims,
    '',
    null,
  ],
  [
    /\s*<\s*\/(span|body|script|meta|html|font|head|label|form|input|textarea|select|ol|ul|link|iframe|source|script)([^a-z0-9>][^>]*)?>\s*/gims,
    '',
    null,
  ],
  [/<\s*(strong)([^a-z0-9>][^>]*)?>/gims, '<b>', null],
  [/<\s*\/\s*(strong)([^a-z0-9>][^>]*)?>/gims, '</b>', null],
  [/\s*<\s*(h[1-6]|title)([^a-z0-9>][^>]*)?>\s*/gims, '{}<b>', '\r\n'],
  [/\s*<\s*\/\s*(h[1-6]|title)([^a-z0-9>][^>]*)?>\s*/gims, '</b>{}', '<br/>'],
  [/<\s*(caption|em)([^a-z0-9>][^>]*)?>/gims, '<i>', null],
  [/<\s*\/\s*(caption|em)([^a-z0-9>][^>]*)?>/gims, '</i>', null],
  [/<\s*li([^a-z0-9>][^>]*)?>\s*/gims, ' -', null],
  [/\s*<\s*\/?\s*(ol|ul|br|hr)\s*\/?>\s*/gims, '\r\n', null],
  [/\s*<\s*\/\s*(br|p|hr|li|div)([^a-z0-9>][^>]*)?>\s*/gims, '\r\n', null],
  [/&nbsp;?/gi, ' ', null],
  [/&emsp;?/gi, '   ', null],
  [/&apos;?/gi, "'", null],
  [/&quot;?/gi, '"', null],
  [/\r*\n[\r\n]+/gi, '\r\n', null],
]

/** split_path: drop a leading `/`, split on the delimiter set, unquote. */
function splitPath(path: string): string[] {
  return path
    .replace(/^\/+/, '')
    .split(PATHSPLIT_RE)
    .filter(Boolean)
    .map((x) => unquote(x))
}

/**
 * parse_list (parse.py:1164) with the upstream default `sort=True`: recursively
 * split each string on STRING_DELIMITERS, then return a UNIQUE, code-point
 * SORTED list. Telegram relies on the sort — target delivery order is the sorted
 * order, NOT the URL order.
 */
function parseList(...args: unknown[]): string[] {
  const result: string[] = []
  for (const arg of args) {
    if (typeof arg === 'string') {
      result.push(...arg.split(STRING_DELIMITERS))
    } else if (Array.isArray(arg)) {
      result.push(...parseList(...arg))
    }
  }
  return [...new Set(result)]
    .filter(Boolean)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Render a multipart data value the way requests does (True/False, str(int)). */
function renderFieldValue(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False'
  }
  return String(value)
}

/**
 * Assemble a `multipart/form-data` body byte-for-byte as Python
 * `requests`/urllib3 does: each data field then the single file field, each part
 * carrying ONLY a Content-Disposition (no per-part Content-Type, since telegram
 * passes a 2-tuple `(name, fp)` with no content type), CRLF-terminated.
 */
function buildMultipart(
  boundary: string,
  dataFields: Map<string, unknown>,
  fileKey: string,
  fileName: string,
  fileBytes: Buffer,
): Buffer {
  const parts: Buffer[] = []
  for (const [name, value] of dataFields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${renderFieldValue(
          value,
        )}\r\n`,
        'utf8',
      ),
    )
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileKey}"; filename="${escapeMultipartFilename(fileName)}"\r\n\r\n`,
      'utf8',
    ),
    fileBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  )
  return Buffer.concat(parts)
}

/** A single target: [chat id (number) or @channel (string), topic or null]. */
type TelegramTarget = readonly [number | string, number | null]

/** Constructor arguments for {@link NotifyTelegram} (from its `parseUrl`). */
export interface NotifyTelegramArgs extends NotifyBaseArgs {
  botToken?: string
  targets?: string[]
  detectOwner?: boolean
  includeImage?: boolean
  silent?: boolean
  preview?: boolean
  topic?: number | string | null
  content?: string
  mdv?: string
}

/** A wrapper for Telegram Notifications (upstream `NotifyTelegram`). */
export class NotifyTelegram extends NotifyBase {
  static override notifyFormat: NotifyFormat = NotifyFormat.HTML
  static override attachmentSupport = true
  static override bodyMaxlen = 4096
  static override titleMaxlen = 0

  botToken: string
  markdownVer: string
  silent: boolean
  preview: boolean
  content: string
  topic: number | null
  detectOwner: boolean
  includeImage: boolean
  targets: TelegramTarget[] = []

  constructor(args: NotifyTelegramArgs = {}) {
    super(args)

    const token = BOT_TOKEN_RE.exec(String(args.botToken ?? '').trim())
    if (!token?.groups?.key) {
      throw new TypeError(
        `The Telegram Bot Token specified (${args.botToken}) is invalid.`,
      )
    }
    this.botToken = token.groups.key

    // Markdown version (telegram.py:446-462).
    const mdv = args.mdv
    if (mdv == null) {
      this.markdownVer = MDV_ONE // MAP["v1"]
    } else {
      const s = String(mdv).toLowerCase()
      this.markdownVer = MDV_MAP.find(([k]) => s.startsWith(k))?.[1] ?? MDV_ONE
    }

    this.silent = args.silent == null ? false : Boolean(args.silent)
    this.preview = args.preview == null ? false : Boolean(args.preview)

    this.content =
      typeof args.content === 'string'
        ? args.content.toLowerCase()
        : CONTENT_BEFORE
    if (this.content && !CONTENT_PLACEMENTS.has(this.content)) {
      throw new TypeError(
        `The content placement specified (${args.content}) is invalid.`,
      )
    }

    if (args.topic) {
      const t = Number.parseInt(String(args.topic), 10)
      if (Number.isNaN(t)) {
        throw new TypeError(
          `The Telegram Topic ID specified (${args.topic}) is invalid.`,
        )
      }
      this.topic = t
    } else {
      this.topic = null
    }

    this.detectOwner = args.detectOwner ?? true

    for (const target of parseList(args.targets ?? [])) {
      const m = IS_CHAT_ID_RE.exec(target)
      if (!m?.groups) {
        // Drop invalid target; also stop us falling back to owner detection.
        this.detectOwner = false
        continue
      }
      const topic = m.groups.topic
        ? Number.parseInt(m.groups.topic, 10)
        : this.topic
      if (m.groups.name != null) {
        this.targets.push([`@${m.groups.name}`, topic])
      } else {
        this.targets.push([Number.parseInt(m.groups.idno as string, 10), topic])
      }
    }

    this.includeImage = args.includeImage ?? false
  }

  override async send(
    body: string,
    // Title is amalgamated into the body upstream (titleMaxlen=0), so send()
    // itself never uses it — mirrors the base skeleton's `_title`.
    _title = '',
    notifyType: NotifyType = NotifyType.INFO,
    options: SendOptions = {},
  ): Promise<boolean> {
    if (this.targets.length === 0) {
      // no-target bot-owner auto-detection is deferred (see file header).
      return false
    }

    const attach: AppriseAttachment | null = options.attach ?? null
    const bodyFormat = options.bodyFormat ?? null

    // ponytail: `?image=yes` icon delivery needs the deferred asset-image
    // subsystem (image_path); fail loud rather than silently drop the icon.
    if (this.includeImage) {
      throw new TypeError(
        'Telegram ?image= icon delivery is not supported yet.',
      )
    }

    const headers = {
      'User-Agent': this.asset.appId,
      'Content-Type': 'application/json',
    }
    const url = `${NOTIFY_URL}${this.botToken}/sendMessage`

    const payloadBase: Record<string, unknown> = {
      disable_notification: this.silent,
      disable_web_page_preview: !this.preview,
    }

    if (this.notifyFormat === NotifyFormat.MARKDOWN) {
      // ponytail: upstream converts a CommonMark (HTML-source) body to
      // Telegram-Markdown in a private `_build_send_calls` override, which is not
      // portable (NotifyBase.buildSendCalls is private here). Throwing is the
      // honest deferral — sending the raw unconverted text would silently diverge.
      if (bodyFormat === NotifyFormat.HTML) {
        throw new TypeError(
          'Telegram CommonMark->Markdown conversion (markdown message from an ' +
            'HTML-format body) is not supported yet.',
        )
      }
      if (bodyFormat === NotifyFormat.TEXT && this.markdownVer === MDV_TWO) {
        // Escape MarkdownV2-reserved characters in plain text (telegram.py:1328).
        body = body.replace(/(?<!\\)([_*[\]()~`>#+=|{}.!-])/g, '\\$1')
      }
      payloadBase.parse_mode = this.markdownVer
      payloadBase.text = body
    } else {
      payloadBase.parse_mode = 'HTML'
      for (const [re, template, htmlFill] of HTML_ESCAPE_ENTRIES) {
        let replacement = template
        if (htmlFill !== null) {
          const fill =
            bodyFormat === NotifyFormat.HTML ||
            bodyFormat === NotifyFormat.MARKDOWN
              ? htmlFill
              : ''
          replacement = template.replace('{}', fill)
        }
        body = body.replace(re, replacement)
      }
      payloadBase.text = body
    }

    // A body within the caption limit rides as the first attachment's caption
    // (order matters for the multipart body: caption/show/parse_mode first).
    const captionPayload: Map<string, unknown> | null =
      attach && body && String(payloadBase.text ?? '').length < CAPTION_MAXLEN
        ? new Map<string, unknown>([
            ['caption', payloadBase.text],
            ['show_caption_above_media', this.content === CONTENT_BEFORE],
            ['parse_mode', payloadBase.parse_mode],
          ])
        : null

    const attachContent = !body || captionPayload ? CONTENT_AFTER : this.content

    let hasError = false
    for (const target of this.targets) {
      const [chatId, topic] = target
      const payload: Record<string, unknown> = {
        ...payloadBase,
        chat_id: chatId,
      }
      if (topic) {
        payload.message_thread_id = topic
      }

      // include_image icon delivery is deferred (see file header); default false.

      if (attach && this.attachmentSupport && attachContent === CONTENT_AFTER) {
        if (
          !(await this.sendAttachments(
            target,
            notifyType,
            attach,
            captionPayload,
          ))
        ) {
          hasError = true
          continue
        }
        if (!body) {
          continue
        }
      }

      if (captionPayload) {
        // The body went out as the attachment caption; no sendMessage needed.
        continue
      }

      const res = await this.request({
        method: 'POST',
        url,
        headers,
        body: JSON.stringify(payload),
      })
      if (res.status !== 200) {
        hasError = true
        continue
      }

      if (
        attach &&
        this.attachmentSupport &&
        attachContent === CONTENT_BEFORE &&
        !(await this.sendAttachments(target, notifyType, attach, null))
      ) {
        hasError = true
      }
    }
    return !hasError
  }

  /** Deliver each attachment in order; the caption payload rides the first one. */
  private async sendAttachments(
    target: TelegramTarget,
    notifyType: NotifyType,
    attach: AppriseAttachment,
    caption: Map<string, unknown> | null,
  ): Promise<boolean> {
    let no = 0
    for (const attachment of attach) {
      no++
      const payload: Map<string, unknown> =
        caption && no === 1 ? new Map(caption) : new Map()
      payload.set(
        'title',
        attachment.name
          ? attachment.name
          : `file${String(no).padStart(3, '0')}.dat`,
      )
      if (!(await this.sendMedia(target, notifyType, payload, attachment))) {
        return false
      }
    }
    return true
  }

  /** Upload one attachment via its mimetype-selected endpoint (multipart). */
  private async sendMedia(
    target: TelegramTarget,
    _notifyType: NotifyType,
    payload: Map<string, unknown>,
    attachment: AttachBase,
  ): Promise<boolean> {
    if (!attachment.exists()) {
      return false
    }

    const mimetype = attachment.mimetype ?? ''
    const entry = MIME_LOOKUP.find(([re]) => re.test(mimetype))
    // The catch-all guarantees a match; fall back to document defensively.
    const [, functionName, key] = entry ?? [/.*/, 'sendDocument', 'document']

    const url = `${NOTIFY_URL}${this.botToken}/${functionName}`
    const [chatId, topic] = target
    payload.set('chat_id', chatId)
    if (topic) {
      payload.set('message_thread_id', topic)
    }

    const fileName = attachment.name ?? 'file.dat'
    let fileBytes: Buffer
    try {
      fileBytes = Buffer.from(attachment.base64(), 'base64')
    } catch {
      return false
    }

    const boundary = chooseBoundary()
    const body = buildMultipart(boundary, payload, key, fileName, fileBytes)
    const headers = {
      'User-Agent': this.asset.appId,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    }

    const res = await this.request({ method: 'POST', url, headers, body })
    return res.status === 200
  }

  /**
   * Serialise back to a `tgram://` URL (telegram.py:1542-1585). The bot token is
   * Outer-masked under privacy; targets (chat ids / @channels, with `:topic`)
   * are appended verbatim.
   */
  override url(privacy = false): string {
    const params: Record<string, string> = {
      image: this.includeImage ? 'True' : 'False',
      detect: this.detectOwner ? 'yes' : 'no',
      silent: this.silent ? 'yes' : 'no',
      preview: this.preview ? 'yes' : 'no',
      content: this.content,
      mdv: MDV_REVERSE[this.markdownVer] ?? 'v1',
    }
    if (this.topic) {
      params.topic = String(this.topic)
    }
    Object.assign(params, this.urlParameters())

    const targets = this.targets.map(([chatId, topic_]) => {
      const topic = topic_ ? topic_ : this.topic
      const head =
        typeof chatId === 'string' ? quote(`${chatId}`, '@') : `${chatId}`
      return topic ? `${head}:${topic}` : head
    })

    const botToken = URLBase.pprint(this.botToken, privacy, PrivacyMode.Outer, {
      safe: '',
    })
    return `tgram://${botToken}/${targets.join('/')}/?${urlencode(params)}`
  }

  /** Parse a `tgram://` URL (telegram.py:1591-1701, the colon dirty-hack). */
  static override parseUrl(url: string): ParsedUrlResults | null {
    const m = PARSE_URL_RE.exec(url)
    if (!m?.groups) {
      return null
    }
    const g = m.groups
    const reconstructed = g.prefix
      ? `${g.protocol}${g.prefix}${g.btoken_a}/${g.remaining}`
      : `${g.protocol}${g.btoken_a}/${g.remaining}`

    const results = URLBase.parseUrl(reconstructed, { verifyHost: false })
    if (!results) {
      return null
    }
    const extra = results as unknown as Record<string, unknown>

    const botTokenA = unquote(results.host)
    const entries = splitPath(results.fullpath ?? '')
    const botTokenB = entries.shift() ?? ''
    extra.botToken = `${botTokenA}:${botTokenB}`

    const targets = entries
    const qsd = results.qsd

    if (qsd.content?.length) {
      extra.content = qsd.content
    }
    if (qsd.to?.length) {
      targets.push(...parseList(qsd.to))
    }
    extra.targets = targets

    if (qsd.mdv?.length) {
      extra.mdv = qsd.mdv
    }
    if (qsd.topic?.length) {
      extra.topic = qsd.topic
    } else if (qsd.thread?.length) {
      extra.topic = qsd.thread
    }

    extra.silent = parseBool(qsd.silent ?? false)
    extra.preview = parseBool(qsd.preview ?? false)
    extra.includeImage = parseBool(qsd.image ?? false)
    // detect defaults to `not targets`: on when no explicit target was given.
    extra.detectOwner = parseBool(qsd.detect ?? targets.length === 0)

    return results
  }
}

registerPlugin('tgram', NotifyTelegram as unknown as PluginConstructor)
