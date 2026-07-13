// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/slack.py).
//
// NotifySlack — the `slack://` plugin. THIS BATCH implements the two primary
// delivery modes; gov-hook / workflow / trigger are deferred (see the mode
// guard in the constructor):
//   * hook (WEBHOOK): `slack://[{botname}@]{A}/{B}/{C}[/{targets}]` ->
//     POST https://hooks.slack.com/services/{A}/{B}/{C}. Webhooks do NOT support
//     attachments — upstream only WARNS and still sends the main message
//     (slack.py:1136); this is faithfully reproduced.
//   * bot: OAuth token `^(?:xoxe\.)?xox[abp]-...` -> POST
//     https://slack.com/api/chat.postMessage (Authorization: Bearer). Attachments
//     use the 4-step external-upload flow (chat.postMessage collects the channel
//     id -> GET files.getUploadURLExternal -> POST the returned upload_url
//     (multipart) -> POST files.completeUploadExternal), slack.py:1219-1314.
//
// Targets are channels (`#chan`) / users (`@user`) / `+`-encoded ids / emails
// (resolved via users.lookupByEmail); a single target may carry `:thread_ts`.
// Every wire request is diffed field-by-field against the Python golden fixture.

import type { AppriseAttachment } from '../attachment/base.js'
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

// The Slack modes (their string VALUES are the public `?mode=` contract,
// slack.py:116-134). Only hook + bot are wired this batch.
const MODE_WEBHOOK = 'hook'
const MODE_BOT = 'bot'
// Prefix-matched by `?mode=` (upstream `a.startswith(mode)`); the last three are
// recognised only to reject them with a clear "deferred" error.
const SLACK_MODES = ['hook', 'gov-hook', 'bot', 'workflow', 'trigger'] as const

// Slack endpoints.
const WEBHOOK_URL = 'https://hooks.slack.com/services'
const API_URL = 'https://slack.com/api/'

// Channel token: optional +/#/@ prefix, then id, with an optional `:thread_ts`.
const CHANNEL_RE = /^([+#@]?[A-Z0-9_-]{1,32})(?::([0-9.]+))?$/i
// Delimiters for the `?to=` / `?token=` query values (slack.py:103).
const CHANNEL_LIST_DELIM = /[ \t\r\n,#\\/]+/
// parse_list delimiter set (parse.py:48): brackets, semicolon, comma, whitespace.
const STRING_DELIMITERS = /[[\];,\s]+/
// Path element delimiter (URLBase.split_path).
const PATHSPLIT_RE = /[ \t\r\n,\\/]+/

// Token validators (slack.py:223-255).
const ACCESS_TOKEN_RE = /^(?:xoxe\.)?xox[abp]-[A-Z0-9-]+$/i
const TOKEN_A_RE = /^[A-Z0-9]+$/i
const TOKEN_B_RE = /^[A-Z0-9]+$/i
const TOKEN_C_RE = /^[A-Za-z0-9]+$/i

// is_email (parse.py GET_EMAIL_RE), anchored and without the leading name-prefix
// group — a target is always a bare token, never `Name: user@domain`.
const EMAIL_RE = new RegExp(
  '^(?<fullEmail>(?:[^+]+\\+)?' +
    "[a-z0-9_!#$%&*/=?%`{|}~^-]+(?:\\.[a-z0-9_!#$%&'*/=?%`{|}~^-]+)*" +
    '@(?:(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9_-]*[a-z0-9])' +
    '|[a-z0-9][a-z0-9_-]{5,}))',
  'i',
)

// HTML colour per notify type (asset.py:67-75); used for the attachment `color`.
const COLOR_MAP: Record<string, string> = {
  info: '#3AA3E3',
  success: '#3AA337',
  failure: '#A32037',
  warning: '#CACF29',
}
const DEFAULT_HTML_COLOR = '#888888'

// Legacy mrkdwn entity escaping (slack.py:355-362). A SINGLE-pass replace so an
// introduced `&amp;` is not itself re-escaped.
const RE_FORMATTING = /\r\*\n|&|<|>/g
function applyFormatting(text: string): string {
  return text.replace(RE_FORMATTING, (m) =>
    m === '&' ? '&amp;' : m === '<' ? '&lt;' : m === '>' ? '&gt;' : '\\n',
  )
}

/** split_path: drop a leading `/`, split on the delimiter set, unquote. */
function splitPath(path: string | null | undefined): string[] {
  return (path ?? '')
    .replace(/^\/+/, '')
    .split(PATHSPLIT_RE)
    .filter(Boolean)
    .map((x) => unquote(x))
}

/**
 * parse_list (parse.py:1164): split each arg on the delimiter set, then return a
 * UNIQUE, SORTED list. The sort makes the multi-target delivery order
 * deterministic — the golden fixture captures that exact order.
 */
function parseList(
  ...args: (string | string[] | null | undefined)[]
): string[] {
  const result: string[] = []
  for (const arg of args) {
    if (typeof arg === 'string') {
      result.push(...arg.split(STRING_DELIMITERS))
    } else if (Array.isArray(arg)) {
      result.push(...parseList(...arg))
    }
  }
  return [...new Set(result.filter(Boolean))].sort()
}

/** validate_regex: return the trimmed value when it matches, else null. */
function validateRegex(value: unknown, re: RegExp): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const v = value.trim()
  return re.test(v) ? v : null
}

/** Build the requests/urllib3 multipart body for a single `file` field. */
function buildMultipart(
  boundary: string,
  filename: string,
  content: Buffer,
): Buffer {
  // A 2-tuple file field carries NO per-part Content-Type (slack.py passes
  // `(name, fp)`), so the part header is Content-Disposition only.
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escapeMultipartFilename(filename)}"\r\n\r\n`
  const tail = `\r\n--${boundary}--\r\n`
  return Buffer.concat([
    Buffer.from(head, 'utf8'),
    content,
    Buffer.from(tail, 'utf8'),
  ])
}

/** A parsed Slack JSON response, or `false` on a failed request. */
type SlackResponse = Record<string, unknown> | false

/** Constructor arguments for {@link NotifySlack} (from its `parseUrl`). */
export interface NotifySlackArgs extends NotifyBaseArgs {
  accessToken?: string | null
  tokenA?: string | null
  tokenB?: string | null
  tokenC?: string | null
  targets?: string[]
  includeImage?: boolean
  includeFooter?: boolean
  includeTimestamp?: boolean
  useBlocks?: boolean
  mode?: string
  template?: string
}

/** A wrapper for Slack Notifications (upstream `NotifySlack`). */
export class NotifySlack extends NotifyBase {
  static override notifyFormat: NotifyFormat = NotifyFormat.MARKDOWN
  static override attachmentSupport = true
  static override bodyMaxlen = 35000

  // Bots default to #general when no channel is given (slack.py:197).
  static defaultNotificationChannel = '#general'

  mode: string
  accessToken: string | null = null
  tokenA: string | null = null
  tokenB: string | null = null
  tokenC: string | null = null
  channels: (string | null)[]
  includeImage: boolean
  includeFooter: boolean
  includeTimestamp: boolean
  useBlocks: boolean

  // Cache of resolved email -> Slack user id (slack.py:673).
  #lookupUsers = new Map<string, string>()

  constructor(args: NotifySlackArgs = {}) {
    super(args)

    // ponytail: Block-Kit templating (`?template=`, slack.py) is deferred this
    // batch. Fail loud rather than silently send a normal, divergent message.
    if (args.template) {
      throw new TypeError('Slack Block-Kit templating is not supported yet.')
    }

    // Mode: explicit `?mode=` (prefix-matched) wins, else detect from the token.
    if (typeof args.mode === 'string' && args.mode) {
      const resolved = SLACK_MODES.find((a) =>
        a.startsWith(args.mode as string),
      )
      if (!resolved) {
        throw new TypeError(
          `The Slack mode specified (${args.mode}) is invalid.`,
        )
      }
      if (resolved !== MODE_WEBHOOK && resolved !== MODE_BOT) {
        // gov-hook / workflow / trigger are deferred this batch.
        throw new TypeError(
          `The Slack mode specified (${resolved}) is not supported yet.`,
        )
      }
      this.mode = resolved
    } else {
      this.mode = args.accessToken ? MODE_BOT : MODE_WEBHOOK
    }

    if (this.mode === MODE_WEBHOOK) {
      this.tokenA = validateRegex(args.tokenA, TOKEN_A_RE)
      if (!this.tokenA) {
        throw new TypeError(
          `An invalid Slack (first) Token (${args.tokenA}) was specified.`,
        )
      }
      this.tokenB = validateRegex(args.tokenB, TOKEN_B_RE)
      if (!this.tokenB) {
        throw new TypeError(
          `An invalid Slack (second) Token (${args.tokenB}) was specified.`,
        )
      }
      this.tokenC = validateRegex(args.tokenC, TOKEN_C_RE)
      if (!this.tokenC) {
        throw new TypeError(
          `An invalid Slack (third) Token (${args.tokenC}) was specified.`,
        )
      }
    } else {
      this.accessToken = validateRegex(args.accessToken, ACCESS_TOKEN_RE)
      if (!this.accessToken) {
        throw new TypeError(
          `An invalid Slack OAuth Access Token (${args.accessToken}) was specified.`,
        )
      }
    }

    this.channels = parseList(args.targets ?? [])
    if (this.channels.length === 0) {
      // A webhook already knows its channel; a bot falls back to #general.
      this.channels.push(
        this.mode === MODE_WEBHOOK
          ? null
          : NotifySlack.defaultNotificationChannel,
      )
    }

    this.includeImage = args.includeImage ?? true
    this.includeFooter = args.includeFooter ?? true
    this.includeTimestamp = args.includeTimestamp ?? true
    this.useBlocks = args.useBlocks ?? false
  }

  private get appId(): string {
    return this.asset.appId || ''
  }

  private color(notifyType: NotifyType): string {
    return COLOR_MAP[notifyType] ?? DEFAULT_HTML_COLOR
  }

  private imageUrl(notifyType: NotifyType): string | null {
    return this.asset.imageUrl(notifyType, NotifyImageSize.XY_72)
  }

  override async send(
    body: string,
    title = '',
    notifyType: NotifyType = NotifyType.INFO,
    options: SendOptions = {},
  ): Promise<boolean> {
    const attach: AppriseAttachment | null = options.attach ?? null
    const bodyFormat = options.bodyFormat ?? null
    let hasError = false

    // ponytail: the CommonMark->mrkdwn conversion (HTML body_format) and the
    // <!channel>/<@user>/<url|desc> restoration are deferred — no in-scope
    // fixture exercises them; plain and entity-escaped text is faithful.

    const payload = this.buildPayload(body, title, notifyType, bodyFormat)

    if (attach && this.attachmentSupport && this.mode === MODE_WEBHOOK) {
      // Webhooks cannot carry attachments; warn but still send the message.
      console.warn('apprise.js: Slack Webhooks do not support attachments.')
    }

    if (this.user) {
      payload.username = this.user
    }

    const url =
      this.mode === MODE_WEBHOOK
        ? `${WEBHOOK_URL}/${this.tokenA}/${this.tokenB}/${this.tokenC}`
        : `${API_URL}chat.postMessage`

    const attachChannelList: string[] = []
    for (const original of this.channels) {
      let channel = original
      if (channel !== null) {
        const email = EMAIL_RE.exec(channel)
        if (email) {
          const userId = await this.lookupUserId(
            email.groups?.fullEmail as string,
          )
          payload.channel = userId ?? undefined
          if (!userId) {
            hasError = true
            continue
          }
        } else {
          const m = CHANNEL_RE.exec(channel)
          if (!m) {
            console.warn(
              `apprise.js: The specified Slack target ${channel} is invalid;skipping.`,
            )
            hasError = true
            continue
          }
          const ch = m[1] as string
          const threadTs = m[2]
          channel = ch
          if (threadTs) {
            payload.thread_ts = threadTs
          } else if ('thread_ts' in payload) {
            // Do not carry a previous target's thread forward.
            delete payload.thread_ts
          }
          if (ch[0] === '+') {
            payload.channel = ch.slice(1)
          } else if (ch[0] === '@') {
            payload.channel = ch
          } else {
            payload.channel = ch[0] === '#' ? ch : `#${ch}`
          }
        }
      }

      const response = await this.doSend(url, payload)
      if (!response) {
        hasError = true
        continue
      }
      // Collect the channel/chat id Slack accepts for the later upload step.
      if (typeof response.channel === 'string') {
        attachChannelList.push(response.channel)
      }
    }

    if (
      attach &&
      this.attachmentSupport &&
      this.mode === MODE_BOT &&
      attachChannelList.length > 0
    ) {
      let no = 0
      for (const attachment of attach) {
        no++
        if (!attachment.exists()) {
          return false
        }
        const filename = attachment.name
          ? attachment.name
          : `file${String(no).padStart(3, '0')}.dat`

        // 1) Ask Slack for an upload URL.
        const params = { filename, length: String(attachment.size) }
        const meta = await this.doSend(
          `${API_URL}files.getUploadURLExternal`,
          {},
          {
            httpMethod: 'GET',
            params,
          },
        )
        if (
          !(
            meta &&
            typeof meta.file_id === 'string' &&
            typeof meta.upload_url === 'string'
          )
        ) {
          return false
        }
        const fileId = meta.file_id as string
        const uploadUrl = meta.upload_url as string

        // 2) Upload the file bytes (multipart) to the returned URL.
        await this.doSend(uploadUrl, {}, { attach: attachment })

        // 3) Attach the uploaded file to each collected channel.
        for (const channelId of attachChannelList) {
          const complete = await this.doSend(
            `${API_URL}files.completeUploadExternal`,
            {
              files: [{ id: fileId, title: attachment.name }],
              channel_id: channelId,
            },
          )
          if (!(complete && Array.isArray(complete.files))) {
            return false
          }
        }
      }
    }

    return !hasError
  }

  /** Build the chat/webhook payload (blocks or legacy) sans channel/username. */
  private buildPayload(
    body: string,
    title: string,
    notifyType: NotifyType,
    bodyFormat: NotifyFormat | null,
  ): Record<string, unknown> {
    const slackFormat =
      this.notifyFormat === NotifyFormat.MARKDOWN ? 'mrkdwn' : 'plain_text'

    if (this.useBlocks) {
      const blocks: Array<Record<string, unknown>> = [
        { type: 'section', text: { type: slackFormat, text: body } },
      ]
      if (title) {
        blocks.unshift({
          type: 'header',
          text: { type: 'plain_text', text: title, emoji: true },
        })
      }
      const attachment: Record<string, unknown> = {
        blocks,
        color: this.color(notifyType),
      }
      const payload: Record<string, unknown> = { attachments: [attachment] }

      if (this.includeFooter) {
        const imageUrl = this.includeImage ? this.imageUrl(notifyType) : null
        const elements: Array<Record<string, unknown>> = [
          { type: slackFormat, text: this.appId },
        ]
        if (imageUrl) {
          payload.icon_url = imageUrl
          elements.unshift({
            type: 'image',
            image_url: imageUrl,
            alt_text: notifyType,
          })
        }
        blocks.push({ type: 'context', elements })
      }
      return payload
    }

    // Legacy formatting: markdown (non-HTML) bodies are entity-escaped; the
    // title is always escaped.
    let text = body
    if (
      this.notifyFormat === NotifyFormat.MARKDOWN &&
      bodyFormat !== NotifyFormat.HTML
    ) {
      text = applyFormatting(text)
    }
    const attachment: Record<string, unknown> = {
      title: applyFormatting(title),
      text,
      color: this.color(notifyType),
    }
    const payload: Record<string, unknown> = {
      mrkdwn: this.notifyFormat === NotifyFormat.MARKDOWN,
      attachments: [attachment],
    }

    const imageUrl = this.includeImage ? this.imageUrl(notifyType) : null
    if (imageUrl) {
      payload.icon_url = imageUrl
    }
    if (this.includeFooter) {
      if (imageUrl) {
        attachment.footer_icon = imageUrl
      }
      attachment.footer = this.appId
      if (this.includeTimestamp) {
        // ponytail: real epoch-seconds timestamp — non-deterministic, so no
        // golden case pins it (every footer/image case uses ?timestamp=no).
        attachment.ts = Date.now() / 1000
      }
    }
    return payload
  }

  /** Wrapper around the transport, mirroring upstream `_send`. */
  private async doSend(
    url: string,
    payload: Record<string, unknown>,
    options: {
      attach?: AppriseAttachment['attachments'][number]
      httpMethod?: string
      params?: Record<string, string>
    } = {},
  ): Promise<SlackResponse> {
    const { attach, httpMethod = 'POST', params } = options

    const headers: Record<string, string> = {
      'User-Agent': this.appId,
      Accept: 'application/json',
    }
    if (!attach) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
    }
    if (this.mode === MODE_BOT) {
      headers.Authorization = `Bearer ${this.accessToken}`
    }

    let body: string | Buffer
    if (attach) {
      // The boundary comes from the shared multipart seam: random in production,
      // pinned to seeds.boundary for the golden capture/replay.
      const boundary = chooseBoundary()
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`
      body = buildMultipart(
        boundary,
        attach.name ?? '',
        Buffer.from(attach.base64(), 'base64'),
      )
    } else {
      body = JSON.stringify(payload)
    }

    let finalUrl = url
    if (params) {
      finalUrl += `?${urlencodePlus(params)}`
    }

    // ponytail: upstream sends a JSON body even on the GET (files.getUploadURL);
    // faithful to the fixture. Native fetch rejects a GET body — a transport
    // concern out of scope here (the golden suite records, never fetches).
    const res = await request({
      method: httpMethod.toUpperCase(),
      url: finalUrl,
      headers,
      body,
    })

    const text = await res.text()
    let response: Record<string, unknown> = { ok: false }
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        response = parsed as Record<string, unknown>
      }
    } catch {
      // Non-JSON body (e.g. the webhook "ok" text or the upload "OK - <len>").
    }

    let statusOkay: boolean
    if (this.mode === MODE_BOT) {
      statusOkay = response.ok === true || text.includes('OK')
    } else {
      statusOkay = text === 'ok'
    }

    if (res.status !== 200 || !statusOkay) {
      return false
    }
    return response
  }

  /** Resolve an email to a Slack user id via users.lookupByEmail. */
  private async lookupUserId(email: string): Promise<string | null> {
    const cached = this.#lookupUsers.get(email)
    if (cached !== undefined) {
      return cached
    }
    if (this.mode !== MODE_BOT) {
      console.warn(
        'apprise.js: Emails can not be resolved to Slack User IDs unless you have a bot configured.',
      )
      return null
    }

    const headers: Record<string, string> = {
      'User-Agent': this.appId,
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${this.accessToken}`,
    }
    const url = `${API_URL}users.lookupByEmail?${urlencodePlus({ email })}`
    const res = await request({ method: 'GET', url, headers })

    const text = await res.text()
    let response: Record<string, unknown> = { ok: false }
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        response = parsed as Record<string, unknown>
      }
    } catch {
      // leave response as {ok:false}
    }

    if (res.status !== 200 || response.ok !== true) {
      console.warn('apprise.js: Failed to send Slack User Lookup.')
      return null
    }
    const user = response.user as { id?: string } | undefined
    const userId = user?.id
    if (!userId) {
      return null
    }
    this.#lookupUsers.set(email, userId)
    return userId
  }

  /** Serialise back to a `slack://` URL (slack.py:1672-1736). */
  override url(privacy = false): string {
    const params: Record<string, string> = {
      image: this.includeImage ? 'yes' : 'no',
      footer: this.includeFooter ? 'yes' : 'no',
      timestamp: this.includeTimestamp ? 'yes' : 'no',
      blocks: this.useBlocks ? 'yes' : 'no',
      mode: this.mode,
    }
    Object.assign(params, this.urlParameters())

    const botname = this.user ? `${quote(this.user, '')}@` : ''
    const targets = this.channels.map((x) => quote(x, '')).join('/')

    if (this.mode === MODE_WEBHOOK) {
      const a = URLBase.pprint(this.tokenA, privacy, PrivacyMode.Outer, {
        safe: '',
      })
      const b = URLBase.pprint(this.tokenB, privacy, PrivacyMode.Outer, {
        safe: '',
      })
      const c = URLBase.pprint(this.tokenC, privacy, PrivacyMode.Outer, {
        safe: '',
      })
      return `slack://${botname}${a}/${b}/${c}/${targets}/?${urlencode(params)}`
    }
    const token = URLBase.pprint(this.accessToken, privacy, PrivacyMode.Outer, {
      safe: '',
    })
    return `slack://${botname}${token}/${targets}/?${urlencode(params)}`
  }

  /** Parse a `slack://` URL into constructor args (upstream `parse_url`). */
  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url, { verifyHost: false })
    if (!results) {
      return null
    }
    const extra = results as unknown as Record<string, unknown>

    const token = unquote(results.host)
    const entries = splitPath(results.fullpath)

    let targets: string[]
    if (token.startsWith('xo')) {
      extra.accessToken = token
      targets = entries
    } else {
      extra.tokenA = token
      extra.tokenB = entries.shift() ?? null
      extra.tokenC = entries.shift() ?? null
      targets = entries
    }

    // `?token=` overrides the path token(s) (bot xo* or slash-delimited webhook).
    const qToken = results.qsd.token
    if (qToken?.length) {
      const parts = unquote(qToken).split(CHANNEL_LIST_DELIM).filter(Boolean)
      if (parts.length > 0 && (parts[0] as string).startsWith('xo')) {
        extra.accessToken = parts[0]
        extra.tokenA = null
        extra.tokenB = null
        extra.tokenC = null
      } else {
        extra.accessToken = null
        extra.tokenA = parts.shift() ?? null
        extra.tokenB = parts.shift() ?? null
        extra.tokenC = parts.shift() ?? null
      }
    }

    // `?to=` appends extra targets.
    const qTo = results.qsd.to
    if (qTo?.length) {
      targets = targets.concat(
        unquote(qTo).split(CHANNEL_LIST_DELIM).filter(Boolean),
      )
    }
    extra.targets = targets

    extra.includeImage = parseBool(results.qsd.image ?? true)
    extra.includeTimestamp = parseBool(results.qsd.timestamp ?? true)
    extra.includeFooter = parseBool(results.qsd.footer ?? true)
    if (results.qsd.blocks?.length) {
      extra.useBlocks = parseBool(results.qsd.blocks)
    }
    if (results.qsd.mode?.length) {
      extra.mode = unquote(results.qsd.mode)
    }

    // `?template=` Block-Kit templating is parsed so the constructor can reject
    // it (deferred this batch); `:token` templating is still unhandled.
    if (results.qsd.template?.length) {
      extra.template = unquote(results.qsd.template)
    }
    return results
  }

  /**
   * Recognise a NATIVE Slack incoming-webhook URL and translate it to a
   * `slack://` URL (upstream `parse_native_url`; workflow/gov variants deferred).
   */
  static override parseNativeUrl(url: string): Record<string, unknown> | null {
    const m =
      /^https?:\/\/hooks\.slack\.com\/services\/(?<a>[A-Z0-9]+)\/(?<b>[A-Z0-9]+)\/(?<c>[A-Z0-9]+)\/?(?<params>\?.+)?$/i.exec(
        url,
      )
    if (!m) {
      return null
    }
    const g = m.groups as Record<string, string | undefined>
    const params = g.params ?? ''
    return NotifySlack.parseUrl(
      `slack://${g.a}/${g.b}/${g.c}/${params}`,
    ) as unknown as Record<string, unknown> | null
  }
}

registerPlugin('slack', NotifySlack as unknown as PluginConstructor)
