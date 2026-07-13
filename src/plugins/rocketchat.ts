// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/rocketchat.py).
//
// NotifyRocketChat — the `rocket://` / `rockets://` plugin. Rocket.Chat has THREE
// authentication modes (upstream `RocketChatAuthMode`), auto-detected from the
// URL shape unless `?mode=` forces one:
//   * webhook — a two-segment `{tokenA/tokenB}@host` incoming webhook token
//     (only a `/` or `%2F` webhook triggers this; a single-segment
//     `WEBHOOK@host` does NOT). POSTs to `/hooks/{webhook}`, no login.
//   * token   — `{user}:{token}@host` where the token is >32 chars. POSTs to
//     `/api/v1/chat.postMessage` with `X-User-Id`/`X-Auth-Token`, no login/logout.
//   * basic   — `{user}:{password}@host` (password ≤32). A STATEFUL ordered
//     sequence: `POST /api/v1/login` (form body) → the login response's
//     authToken/userId seed the `X-Auth-Token`/`X-User-Id` headers → one or more
//     `POST /api/v1/chat.postMessage` (JSON body) → `POST /api/v1/logout`.
// Targets resolve to channels (`#`), users (`@`) or room ids; the SEND order is
// users → channels → rooms (upstream builds `[@user…]` first, then extends with
// `[#channel…]`, then a separate rooms pass) — NOT the URL's written order.

import { NotifyFormat, NotifyImageSize, NotifyType } from '../common.js'
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
  urlencodePlus,
} from '../url.js'

// Target class regexes (rocketchat.py:40-42).
const IS_CHANNEL = /^#(?<name>[A-Za-z0-9_-]+)$/
const IS_USER = /^@(?<name>[A-Za-z0-9._-]+)$/
const IS_ROOM_ID = /^(?<name>[A-Za-z0-9]+)$/

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

// Detect the webhook (if present in the URL): a two-segment `tokenA/tokenB`
// (or `%2F`-escaped) token in the userinfo, optionally preceded by `user:`
// (rocketchat.py:750-756). A single-segment token does NOT match.
const WEBHOOK_RE =
  /^\s*(?<schema>[^:]+:\/\/)((?<user>[^:]+):)?(?<webhook>[a-z0-9]+(?:\/|%2F)[a-z0-9]+)@(?<rest>.+)$/i

/** The three Rocket.Chat authentication modes (upstream `RocketChatAuthMode`). */
export const RocketChatAuthMode = {
  WEBHOOK: 'webhook',
  TOKEN: 'token',
  BASIC: 'basic',
} as const

const ROCKETCHAT_AUTH_MODES: readonly string[] = [
  RocketChatAuthMode.WEBHOOK,
  RocketChatAuthMode.TOKEN,
  RocketChatAuthMode.BASIC,
]

/** Constructor arguments for {@link NotifyRocketChat} (from its `parseUrl`). */
export interface NotifyRocketChatArgs extends NotifyBaseArgs {
  /** Incoming-webhook token (webhook mode). */
  webhook?: string | null
  /** Parsed `#channel` / `@user` / roomId targets. */
  targets?: string[]
  /** Forced auth mode (`?mode=`); validated against the three modes. */
  mode?: string
  /** Avatar toggle (`?avatar=`); defaults per mode (off for basic, on else). */
  avatar?: boolean
}

/** A wrapper for Rocket.Chat notifications (upstream `NotifyRocketChat`). */
export class NotifyRocketChat extends NotifyBase {
  // The title is folded into the body; markdown; 1000-char bodies (rocketchat.py:95-101).
  static override titleMaxlen = 0
  static override bodyMaxlen = 1000
  static override notifyFormat: NotifyFormat = NotifyFormat.MARKDOWN

  webhook: string | null
  mode: string
  avatar: boolean
  /** `#channel` names (without the `#`). */
  channels: string[] = []
  /** room ids. */
  rooms: string[] = []
  /** `@user` names (without the `@`). */
  users: string[] = []
  /** Auth headers carried between requests (token mode, or basic after login). */
  headers: Record<string, string> = {}
  /** `{schema}://{host}[:port]` request base. */
  apiUrl: string

  constructor(args: NotifyRocketChatArgs = {}) {
    super(args)

    const schema = this.secure ? 'https' : 'http'
    this.apiUrl = `${schema}://${this.host}${this.port != null ? `:${this.port}` : ''}`

    this.webhook = typeof args.webhook === 'string' ? args.webhook : null

    // Explicit mode (validated), else auto-detect (rocketchat.py:228-247).
    const forced =
      typeof args.mode === 'string' ? args.mode.toLowerCase() : null
    if (forced && !ROCKETCHAT_AUTH_MODES.includes(forced)) {
      throw new TypeError(
        `The authentication mode specified (${args.mode}) is invalid.`,
      )
    }
    let mode = forced
    if (!mode) {
      if (this.webhook != null) {
        mode = RocketChatAuthMode.WEBHOOK
      } else if (this.password && this.password.length > 32) {
        mode = RocketChatAuthMode.TOKEN
      } else {
        mode = RocketChatAuthMode.BASIC
      }
    }
    this.mode = mode

    // Credential / webhook requirements (rocketchat.py:249-265).
    if (
      (mode === RocketChatAuthMode.BASIC ||
        mode === RocketChatAuthMode.TOKEN) &&
      !(this.user && this.password)
    ) {
      throw new TypeError(
        `No Rocket.Chat ${
          mode === RocketChatAuthMode.BASIC ? 'user/pass combo' : 'user/apikey'
        } was specified.`,
      )
    }
    if (mode === RocketChatAuthMode.WEBHOOK && !this.webhook) {
      throw new TypeError('No Rocket.Chat Incoming Webhook was specified.')
    }

    // Token mode carries its auth headers from the start (rocketchat.py:267-274).
    if (mode === RocketChatAuthMode.TOKEN) {
      this.headers['X-User-Id'] = this.user as string
      this.headers['X-Auth-Token'] = this.password as string
    }

    // Validate recipients, dropping bad ones (rocketchat.py:276-298).
    for (const recipient of args.targets ?? []) {
      const channel = IS_CHANNEL.exec(recipient)
      if (channel?.groups) {
        this.channels.push(channel.groups.name as string)
        continue
      }
      const room = IS_ROOM_ID.exec(recipient)
      if (room?.groups) {
        this.rooms.push(room.groups.name as string)
        continue
      }
      const user = IS_USER.exec(recipient)
      if (user?.groups) {
        this.users.push(user.groups.name as string)
        continue
      }
      console.warn(
        `apprise.js: Dropped invalid channel/room/user (${recipient}) specified.`,
      )
    }

    if (
      mode === RocketChatAuthMode.BASIC &&
      this.rooms.length === 0 &&
      this.channels.length === 0
    ) {
      throw new TypeError(
        'No Rocket.Chat room and/or channels specified to notify.',
      )
    }

    // Avatar default: off for basic (needs the bot flag), on otherwise
    // (rocketchat.py:319-323).
    const avatarDefault = mode !== RocketChatAuthMode.BASIC
    this.avatar = typeof args.avatar === 'boolean' ? args.avatar : avatarDefault
  }

  override async send(
    body: string,
    _title = '',
    notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    // Dispatch on mode (rocketchat.py:412-425): webhook → its own path; basic
    // AND token both flow through the "basic" sender (token just skips login).
    return this.mode === RocketChatAuthMode.WEBHOOK
      ? this.sendWebhook(body, notifyType)
      : this.sendBasic(body, notifyType)
  }

  /** Shared JSON payload (rocketchat.py:518-530). */
  private payload(
    body: string,
    notifyType: NotifyType,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = { text: body }
    const imageUrl = this.avatar
      ? this.asset.imageUrl(notifyType, NotifyImageSize.XY_128)
      : null
    if (imageUrl) {
      payload.avatar = imageUrl
    }
    return payload
  }

  /** Webhook mode: POST to `/hooks/{webhook}`, one request per target (or one
   *  request with no channel when there are no targets) (rocketchat.py:427-467). */
  private async sendWebhook(
    body: string,
    notifyType: NotifyType,
  ): Promise<boolean> {
    const payload = this.payload(body, notifyType)
    const path = `hooks/${this.webhook}`

    const targets = [
      ...this.users.map((u) => `@${u}`),
      ...this.channels.map((c) => `#${c}`),
      ...this.rooms.map((r) => r),
    ]
    if (targets.length === 0) {
      return this.post(payload, path)
    }

    let hasError = false
    for (const target of targets) {
      payload.channel = target
      if (!(await this.post(payload, path))) {
        hasError = true
      }
    }
    return !hasError
  }

  /** Basic/token mode: (login →)? postMessage per target (→ logout)?
   *  (rocketchat.py:469-516). Send order is users → channels, then rooms. */
  private async sendBasic(
    body: string,
    notifyType: NotifyType,
  ): Promise<boolean> {
    if (this.mode === RocketChatAuthMode.BASIC && !(await this.login())) {
      return false
    }

    const base = this.payload(body, notifyType)
    let hasError = false

    const channelTargets = [
      ...this.users.map((u) => `@${u}`),
      ...this.channels.map((c) => `#${c}`),
    ]
    for (const channel of channelTargets) {
      if (!(await this.post({ ...base, channel }))) {
        hasError = true
      }
    }

    for (const room of this.rooms) {
      if (!(await this.post({ ...base, roomId: room }))) {
        hasError = true
      }
    }

    if (this.mode === RocketChatAuthMode.BASIC) {
      await this.logout()
    }
    return !hasError
  }

  /** POST a JSON payload; success is EXACTLY 200 (rocketchat.py:532-604). */
  private async post(
    payload: Record<string, unknown>,
    path = 'api/v1/chat.postMessage',
  ): Promise<boolean> {
    const headers: Record<string, string> = {
      ...this.headers,
      'User-Agent': this.asset.appId,
      'Content-Type': 'application/json',
    }
    const res = await this.request({
      method: 'POST',
      url: `${this.apiUrl}/${path}`,
      headers,
      body: JSON.stringify(payload),
    })
    return res.status === 200
  }

  /** Authenticate; on success cache the auth headers (rocketchat.py:606-685). The
   *  request body is form-urlencoded (`data=payload`), NOT JSON. */
  private async login(): Promise<boolean> {
    const payload = new Map<string, string>([
      ['username', this.user ?? ''],
      ['password', this.password ?? ''],
    ])
    const res = await this.request({
      method: 'POST',
      url: `${this.apiUrl}/api/v1/login`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: urlencodePlus(payload),
    })
    if (res.status !== 200) {
      return false
    }
    let response: { status?: string; data?: Record<string, unknown> } | null
    try {
      response = JSON.parse(await res.text())
    } catch {
      return false
    }
    if (response?.status !== 'success') {
      return false
    }
    this.headers['X-Auth-Token'] = (response.data?.authToken as string) ?? ''
    this.headers['X-User-Id'] = (response.data?.userId as string) ?? ''
    return true
  }

  /** Log the cached session off (rocketchat.py:687-734). Result is not folded
   *  into the notification outcome upstream, so it is likewise ignored here. */
  private async logout(): Promise<void> {
    await this.request({
      method: 'POST',
      url: `${this.apiUrl}/api/v1/logout`,
      headers: { ...this.headers },
    })
  }

  /**
   * Serialise back to a `rocket(s)://` URL (rocketchat.py:347-405). ALWAYS emits
   * `avatar` and `mode`; auth is `{user}:{password}@` for basic/token or
   * `{user?:}{webhook}@` for webhook (secret-masked under privacy); targets are
   * written channels → rooms → users (NOT the send order).
   */
  override url(privacy = false): string {
    const params: Record<string, string> = {
      avatar: this.avatar ? 'yes' : 'no',
      mode: this.mode,
    }
    Object.assign(params, this.urlParameters())

    let auth: string
    if (
      this.mode === RocketChatAuthMode.BASIC ||
      this.mode === RocketChatAuthMode.TOKEN
    ) {
      auth = `${quote(this.user ?? '', '')}:${URLBase.pprint(
        this.password,
        privacy,
        PrivacyMode.Secret,
        { safe: '' },
      )}@`
    } else {
      const userPart = this.user ? `${quote(this.user, '')}:` : ''
      auth = `${userPart}${URLBase.pprint(this.webhook, privacy, PrivacyMode.Secret, { safe: '' })}@`
    }

    const scheme = this.secure ? 'rockets' : 'rocket'
    const defaultPort = this.secure ? 443 : 80
    const port =
      this.port == null || this.port === defaultPort ? '' : `:${this.port}`
    const targets = [
      ...this.channels.map((c) => quote(`#${c}`, '@#')),
      ...this.rooms.map((r) => quote(r, '@#')),
      ...this.users.map((u) => quote(`@${u}`, '@#')),
    ].join('/')

    return `${scheme}://${auth}${this.host}${port}/${targets}/?${urlencode(params)}`
  }

  /** Parse a `rocket(s)://` URL into constructor args (upstream `parse_url`). */
  static override parseUrl(url: string): ParsedUrlResults | null {
    // Peel a `{tokenA/tokenB}` webhook out of the userinfo, then re-parse the
    // URL without it (it conflicts with standard `user:pass@` parsing).
    const match = WEBHOOK_RE.exec(url)
    let effective = url
    if (match?.groups) {
      const g = match.groups
      effective = `${g.schema}${g.user ? `${g.user}@` : ''}${g.rest}`
    }

    const results = URLBase.parseUrl(effective)
    if (!results) {
      return null
    }
    const extra = results as unknown as Record<string, unknown>

    if (match?.groups) {
      extra.webhook = unquote(match.groups.webhook as string)
      // Also seed the password (raw) in case a basic setup carried it here
      // (rocketchat.py:785-787); unquoting happens in URLBase's constructor.
      extra.password = match.groups.webhook
    }

    extra.targets = splitPath(results.fullpath ?? '')

    const mode = results.qsd.mode
    if (mode?.length) {
      extra.mode = unquote(mode)
    }
    const avatar = results.qsd.avatar
    if (avatar?.length) {
      extra.avatar = parseBool(avatar)
    }
    const webhook = results.qsd.webhook
    if (webhook?.length) {
      extra.webhook = unquote(webhook)
    }
    // ponytail: `?to=` target alias needs upstream parse_list (sort/dedup/flatten)
    // which isn't ported and no in-scope case uses it — deferred like apprise-api's
    // `?tags=`. Add when a `?to=` case lands.
    return results
  }
}

registerPlugin(
  ['rocket', 'rockets'],
  NotifyRocketChat as unknown as PluginConstructor,
)
