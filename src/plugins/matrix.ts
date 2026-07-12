// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/matrix/base.py — the
// e2ee.py module is intentionally EXCLUDED, see the deferral notes below).
//
// NotifyMatrix — the `matrix://` / `matrixs://` plugin. This batch implements the
// minimal "post a message to a room" closed loop over TWO of upstream's five
// modes (MatrixWebhookMode, base.py:145-168):
//   * t2bot   (`matrix://{token}`, or `?mode=t2bot`): a single POST to the
//     t2bot.io webhook relay.
//   * off / direct (`matrix(s)://{token}@{host}` raw access token, or
//     `matrix(s)://{user}:{password}@{host}[:port]/{targets}` login): the
//     Client-Server API login/whoami → join → send sequence.
//
// DEFERRED this batch (explicitly out of scope — spec/tasks 7.1/7.2):
//   * E2EE (olm/megolm, the `cryptography` dependency) — plaintext only.
//   * the `matrix` / `slack` / `hookshot` WEBHOOK modes (distinct payloads).
//   * server discovery (`matrixs://` `.well-known` + `/versions`); in-scope
//     fixtures pin `?discovery=no`, and baseUrl() below skips the well-known
//     flow (a discovery=yes+secure setup would need it — deferred).
//   * no-target auto-probe (`/joined_rooms`), `#alias` room-alias resolution,
//     `@user` DM rooms, login-failure `/register` fallback, media upload
//     (attachments), and cross-call persistent storage (the in-memory store
//     stub lives for a single notify only).

import { NotifyFormat, NotifyType } from '../common.js'
import { markdownToHtml } from '../conversion.js'
import {
  NotifyBase,
  type NotifyBaseArgs,
  type SendOptions,
} from '../core/notify-base.js'
import { PersistentStoreStub } from '../core/store.js'
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
} from '../url.js'

// Client-Server API path prefixes (base.py:74-75). `?version=` selects between
// them: V3 ("3") -> /v3, V2 ("2") -> /r0.
const MATRIX_V2_API_PATH = '/_matrix/client/r0'
const MATRIX_V3_API_PATH = '/_matrix/client/v3'
// t2bot.io webhook relay endpoint (base.py:587).
const T2BOT_URL = 'https://webhooks.t2bot.io/api/v1/matrix/hook'

// Path element delimiter (upstream PATHSPLIT_LIST_DELIM, url.py:49).
const PATHSPLIT_RE = /[ \t\r\n,\\/]+/

// Message types (base.py:116-127) and API versions (base.py:130-142).
const MATRIX_MESSAGE_TYPES = ['text', 'notice'] as const
const MATRIX_VERSIONS = ['2', '3'] as const
// Webhook modes (base.py:145-169). `off` = direct/disabled.
const MATRIX_WEBHOOK_MODES = [
  'off',
  'matrix',
  'slack',
  't2bot',
  'hookshot',
] as const

// Room-ID / user syntax (base.py:97-109). `#alias` (IS_ROOM_ALIAS) is deferred.
const IS_ROOM_ID =
  /^\s*(?:!|&#33;|%21)(?<room>[A-Za-z0-9._=-]+)(?:(?::|%3A)(?<home_server>[A-Za-z0-9.-]+))?\s*$/i
const IS_USER =
  /^\s*(?:@|%40)(?<user>[A-Za-z0-9._=+/-]+)(?:(?::|%3A)(?<home_server>[A-Za-z0-9.-]+))?\s*$/i
// t2bot webhook id (base.py:489); validated case-insensitively.
const T2BOT_TOKEN_RE = /^[a-z0-9]{64}$/i

/** split_path (url.py:729): drop a leading `/`, split on the delimiter set, unquote. */
function splitPath(path: string): string[] {
  return path
    .replace(/^\/+/, '')
    .split(PATHSPLIT_RE)
    .filter(Boolean)
    .map((x) => unquote(x))
}

/** Minimal parse_list for `?to=` (comma/whitespace separated), then unquote. */
function parseList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((x) => unquote(x))
}

/** Split on the FIRST `:` only (Python `str.split(":", 1)`). */
function splitFirst(value: string, sep: string): [string, string] | null {
  const idx = value.indexOf(sep)
  return idx === -1 ? null : [value.slice(0, idx), value.slice(idx + 1)]
}

/**
 * URLBase.escape_html (url.py:569-594). Escapes `&<>'"`; `whitespace` also maps
 * tab/space to `&emsp;`/`&nbsp;`; `convertNewLines` maps `\n` to `<br/>`. The
 * replacement ORDER is load-bearing so entities are never double-escaped.
 */
function escapeHtml(
  html: string,
  { convertNewLines = false, whitespace = true } = {},
): string {
  if (!html) {
    return ''
  }
  let out = html
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;')
    .replaceAll('"', '&quot;')
  if (whitespace) {
    out = out.replaceAll('\t', '&emsp;').replaceAll(' ', '&nbsp;')
  }
  if (convertNewLines) {
    out = out.replaceAll('\n', '<br/>')
  }
  return out
}

/** What upstream `_fetch` returns, minus retry/throttle and the (deferred,
 *  alias-create-only) status_code slot. ok == HTTP 200. */
interface FetchResult {
  ok: boolean
  response: Record<string, unknown>
}

/** Constructor arguments for {@link NotifyMatrix} (from its `parseUrl`). */
export interface NotifyMatrixArgs extends NotifyBaseArgs {
  /** Room-id / user targets (already split + unquoted). */
  targets?: string[]
  /** Webhook mode (`?mode=`); `off` = direct. */
  mode?: string | null
  /** Message type (`?msgtype=`): text|notice. */
  msgtype?: string
  /** API version (`?version=`/`?v=`): "2"|"3". */
  version?: string
  /** Inline an image (`?image=`); media path deferred, kept for round-trip. */
  includeImage?: boolean
  /** Server discovery (`?discovery=`); the well-known flow itself is deferred. */
  discovery?: boolean
  /** Force `:homeserver` on room IDs when missing (`?hsreq=`). */
  hsreq?: boolean
  /** Hookshot webhook path (`?path=`); hookshot mode deferred. */
  webhookPath?: string
  /** E2EE flag (`?e2ee=`); E2EE deferred, kept for round-trip. */
  e2ee?: boolean
}

/** A wrapper for Matrix Notifications (upstream `NotifyMatrix`). */
export class NotifyMatrix extends NotifyBase {
  // Media upload (attachments) is DEFERRED this batch — declaring no attachment
  // support keeps the engine from routing attachments into send(). Upstream is
  // True; this is a deliberate scoped degradation (spec non-goal).
  static override attachmentSupport = false
  // 65000 leaves headroom under the 65536-byte Matrix event limit (base.py:204).
  static override bodyMaxlen = 65000

  rooms: string[] = []
  users: string[] = []
  mode: string
  msgtype: string
  version: string
  includeImage: boolean
  discovery: boolean
  hsreq: boolean
  webhookPath: string
  e2ee: boolean

  // Per-notify auth/session state (upstream reads these from self.store; the
  // in-memory stub is empty per notify, so they start unset).
  homeServer: string | null
  userId: string | null
  accessToken: string | null
  deviceId: string | null
  // login mode: a store-driven incrementing counter; raw-token mode: a reused
  // uuid (set in _sendServer). number|string per that split (base.py:544/839).
  transactionId: number | string
  readonly store: PersistentStoreStub

  constructor(args: NotifyMatrixArgs = {}) {
    super(args)

    // Separate @user DM targets (deferred) from room identifiers.
    for (const target of args.targets ?? []) {
      if (IS_USER.test(target)) {
        this.users.push(target)
      } else {
        this.rooms.push(target)
      }
    }

    this.includeImage = args.includeImage ?? false
    this.discovery = args.discovery ?? true
    this.hsreq = args.hsreq ?? true

    let webhookPath =
      typeof args.webhookPath === 'string' && args.webhookPath.trim()
        ? args.webhookPath.trim()
        : '/webhook'
    if (!webhookPath.startsWith('/')) {
      webhookPath = `/${webhookPath}`
    }
    this.webhookPath = webhookPath.replace(/\/+$/, '') || '/'

    this.e2ee = args.e2ee ?? true

    this.mode = typeof args.mode === 'string' ? args.mode.toLowerCase() : 'off'
    if (!(MATRIX_WEBHOOK_MODES as readonly string[]).includes(this.mode)) {
      throw new TypeError(`The mode specified (${args.mode}) is invalid.`)
    }
    // ponytail: the matrix/slack/hookshot webhook payloads are deferred this
    // batch (see file header). Fail loud at construction — matching slack.ts /
    // mattermost.ts — instead of add()ing OK then silently no-op in sendWebhook.
    if (
      this.mode === 'matrix' ||
      this.mode === 'slack' ||
      this.mode === 'hookshot'
    ) {
      throw new TypeError(
        `The Matrix ${this.mode} webhook mode is not supported yet.`,
      )
    }

    // NOT lower-cased: `?version=v2` is illegal (only "2"/"3", base.py:464-473).
    this.version = typeof args.version === 'string' ? args.version : '3'
    if (!(MATRIX_VERSIONS as readonly string[]).includes(this.version)) {
      throw new TypeError(`The version specified (${args.version}) is invalid.`)
    }

    this.msgtype =
      typeof args.msgtype === 'string' ? args.msgtype.toLowerCase() : 'text'
    if (!(MATRIX_MESSAGE_TYPES as readonly string[]).includes(this.msgtype)) {
      throw new TypeError(`The msgtype specified (${args.msgtype}) is invalid.`)
    }

    this.store = new PersistentStoreStub()

    this.accessToken = null
    this.homeServer = null
    this.userId = null
    this.deviceId = null

    if (this.mode === 't2bot') {
      // t2bot requires a 64-char webhook id in place of a token (base.py:486-497).
      const token = validateT2BotToken(this.password)
      if (!token) {
        throw new TypeError(
          `An invalid T2Bot/Matrix Webhook ID (${this.password}) was specified.`,
        )
      }
      this.accessToken = token
    } else if (!this.host) {
      throw new TypeError(
        `An invalid Matrix Hostname (${this.host}) was specified`,
      )
    } else if (this.port != null && !(this.port >= 1 && this.port <= 65535)) {
      throw new TypeError(`An invalid Matrix Port (${this.port}) was specified`)
    }

    // Discovery only applies to direct (non-webhook) mode (base.py:515-517).
    if (this.mode !== 'off') {
      this.discovery = false
    }

    // Restore session state from the store (empty per notify -> all null).
    if (this.mode !== 't2bot') {
      this.homeServer = this.store.get<string | null>('home_server', null)
      this.userId = this.store.get<string | null>('user_id', null)
      this.accessToken = this.store.get<string | null>('access_token', null)
      this.deviceId = this.store.get<string | null>('device_id', null)
      if (!this.homeServer && this.userId) {
        const parts = splitFirst(this.userId, ':')
        if (parts) {
          this.homeServer = parts[1]
        }
      }
    }

    // login-mode counter start (base.py:544-546): 0 unless a cached access_token
    // pre-exists (cross-call persistence is deferred, so this is 0 here).
    this.transactionId = !this.accessToken
      ? 0
      : this.store.get<number>('transaction_id', 0)
  }

  override async send(
    body: string,
    title = '',
    notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    return this.mode !== 'off'
      ? this.sendWebhook(body, title, notifyType)
      : this.sendServer(body, title, notifyType)
  }

  // --- t2bot webhook (the only in-scope webhook mode) ------------------------

  private async sendWebhook(
    body: string,
    title: string,
    notifyType: NotifyType,
  ): Promise<boolean> {
    if (this.mode !== 't2bot') {
      // matrix / slack / hookshot webhook payloads are deferred this batch.
      return false
    }

    const headers: Record<string, string> = {
      'User-Agent': this.asset.appId,
      'Content-Type': 'application/json',
    }
    const url = `${T2BOT_URL}/${this.accessToken}`
    const payload = this.t2botPayload(body, title, notifyType)

    const res = await request({
      method: 'POST',
      url,
      headers,
      body: JSON.stringify(payload),
    })
    return res.status === 200
  }

  /** _t2bot_webhook_payload = _matrix_webhook_payload (+ avatarUrl, deferred). */
  private t2botPayload(
    body: string,
    title: string,
    _notifyType: NotifyType,
  ): Record<string, unknown> {
    const displayName = this.user || this.asset.appId
    const format = this.notifyFormat === NotifyFormat.TEXT ? 'plain' : 'html'
    let text: string
    if (this.notifyFormat === NotifyFormat.HTML) {
      text = (title ? `<h1>${escapeHtml(title)}</h1>` : '') + body
    } else if (this.notifyFormat === NotifyFormat.MARKDOWN) {
      text =
        (title ? `<h1>${escapeHtml(title)}</h1>` : '') + markdownToHtml(body)
    } else {
      text = title ? `${title}\r\n${body}` : body
    }
    // include_image -> avatarUrl is the media path, deferred (default off).
    return { displayName, format, text }
  }

  // --- direct (off) Client-Server API sequence -------------------------------

  private async sendServer(
    body: string,
    title: string,
    _notifyType: NotifyType,
  ): Promise<boolean> {
    // Raw access-token auth: password is the token, reuse a single uuid txnId.
    if (this.accessToken === null && this.password && !this.user) {
      this.accessToken = this.password
      this.transactionId = this.store.transactionUuid()
    }

    // Login when we still have no token (register fallback deferred).
    if (this.accessToken === null && !(await this.login())) {
      return false
    }

    // Resolve user_id (+ home_server) via /whoami when login/token gave none.
    if (!this.userId) {
      await this.whoami()
    }

    // Last-resort: assume the home server matches the connect host.
    if (!this.homeServer) {
      this.homeServer = this.host
    }

    const rooms = [...this.rooms]
    let hasError = false

    // @user DM resolution is deferred; no-target /joined_rooms probe is deferred.
    if (this.users.length > 0) {
      // Cannot resolve DM targets this batch.
      hasError = true
    }
    if (rooms.length === 0) {
      // Nothing to notify (auto-probe deferred).
      return false
    }

    const payload = this.messagePayload(body, title)

    for (const room of rooms) {
      const roomId = await this.roomJoin(room)
      if (!roomId) {
        hasError = true
        continue
      }

      const path = `/rooms/${quote(roomId)}/send/m.room.message/${this.transactionId}`
      const { ok } = await this.fetch(path, payload, 'PUT')

      // Increment the txn counter so subsequent sends aren't seen as retries —
      // ONLY in login mode (access_token != password); raw-token reuses its uuid.
      if (this.accessToken !== this.password) {
        this.transactionId = (this.transactionId as number) + 1
        this.store.set('transaction_id', this.transactionId)
      }

      if (!ok) {
        hasError = true
      }
    }

    return !hasError
  }

  /** Build the plaintext `m.room.message` payload (base.py:1027-1069). */
  private messagePayload(body: string, title: string): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      msgtype: `m.${this.msgtype}`,
      body: title ? `# ${title}\r\n${body}` : body,
    }
    if (this.notifyFormat === NotifyFormat.HTML) {
      payload.format = 'org.matrix.custom.html'
      // NOTE: upstream does NOT escape the title in the HTML branch (base.py:1043).
      payload.formatted_body = (title ? `<h1>${title}</h1>` : '') + body
    } else if (this.notifyFormat === NotifyFormat.MARKDOWN) {
      const titleHtml = title
        ? `<h1>${escapeHtml(title, { whitespace: false })}</h1>`
        : ''
      payload.format = 'org.matrix.custom.html'
      // md->html is best-effort (markdown-it != Python markdown), see conversion.ts.
      payload.formatted_body = titleHtml + markdownToHtml(body)
    }
    return payload
  }

  /** _login (base.py:1240-1334): POST /login, capture access_token/user_id. */
  private async login(): Promise<boolean> {
    if (this.accessToken) {
      return true
    }
    if (!(this.user && this.password)) {
      return false
    }

    const payload: Record<string, unknown> =
      this.version === '3'
        ? {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: this.user },
            password: this.password,
          }
        : {
            type: 'm.login.password',
            user: this.user,
            password: this.password,
          }
    if (this.deviceId) {
      payload.device_id = this.deviceId
    } else {
      payload.initial_device_display_name = this.asset.appId
    }

    const { ok, response } = await this.fetch('/login', payload)
    if (!ok) {
      return false
    }

    this.accessToken = (response.access_token as string) ?? null
    this.userId = (response.user_id as string) ?? null
    this.deviceId = (response.device_id as string) ?? null

    const hs = response.home_server as string | undefined
    if (hs) {
      this.homeServer = hs
    } else if (this.userId && !this.homeServer) {
      const parts = splitFirst(this.userId, ':')
      if (parts) {
        this.homeServer = parts[1]
      }
    }

    if (!this.accessToken) {
      return false
    }

    this.store.set('access_token', this.accessToken)
    if (this.homeServer) {
      this.store.set('home_server', this.homeServer)
    }
    this.store.set('user_id', this.userId)
    if (this.deviceId) {
      this.store.set('device_id', this.deviceId)
    }
    return true
  }

  /** _whoami (base.py:1336-1379): GET /account/whoami to resolve user_id. */
  private async whoami(): Promise<boolean> {
    const { ok, response } = await this.fetch('/account/whoami', null, 'GET')
    if (!ok) {
      return false
    }

    this.userId = (response.user_id as string) ?? this.userId
    this.deviceId = (response.device_id as string) ?? this.deviceId

    if (this.userId && !this.homeServer) {
      const parts = splitFirst(this.userId, ':')
      if (parts) {
        this.homeServer = parts[1]
      }
    }

    if (this.userId) {
      this.store.set('user_id', this.userId)
    }
    if (this.deviceId) {
      this.store.set('device_id', this.deviceId)
    }
    if (this.homeServer) {
      this.store.set('home_server', this.homeServer)
    }
    return true
  }

  /**
   * _room_join (base.py:1430-1504, IS_ROOM_ID branch only). Joins an explicit
   * `!roomId[:homeserver]` and returns the resolved room id. `#alias` resolution
   * and auto-create are deferred (non-room-id targets return null -> skipped).
   */
  private async roomJoin(room: string): Promise<string | null> {
    if (!this.accessToken) {
      return null
    }
    const m = IS_ROOM_ID.exec(room)
    if (!m) {
      // Alias / other forms deferred this batch.
      return null
    }

    const roomToken = m.groups?.room ?? ''
    const explicitHs = m.groups?.home_server
    const homeServer = explicitHs || this.homeServer
    const cacheKey = `!${roomToken}:${homeServer}`
    const roomId = explicitHs || this.hsreq ? cacheKey : `!${roomToken}`

    const cached = this.store.get<{ id: string } | null>(cacheKey, null)
    if (cached) {
      return cached.id
    }

    const path = `/join/${quote(roomId)}`
    const { ok, response } = await this.fetch(path, {}, 'POST')
    if (!ok) {
      return null
    }

    const joinedId = (response.room_id as string) || roomId
    this.store.set(cacheKey, { id: joinedId, home_server: homeServer })
    return joinedId
  }

  /**
   * _fetch (base.py:1743-...) minus throttle/retry/media. Builds base_url +
   * api-path + path, issues one request through the transport seam, and returns
   * (ok, parsed-json-response, status). ok == HTTP 200 (upstream requires it).
   */
  private async fetch(
    path: string,
    payload: unknown,
    method: 'POST' | 'PUT' | 'GET' = 'POST',
  ): Promise<FetchResult> {
    const headers: Record<string, string> = {
      'User-Agent': this.asset.appId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (this.accessToken != null) {
      headers.Authorization = `Bearer ${this.accessToken}`
    }

    const apiPath =
      this.version === '3' ? MATRIX_V3_API_PATH : MATRIX_V2_API_PATH
    const url = `${this.baseUrl()}${apiPath}${path}`
    // dumps(payload): null -> "null" (whoami GET body), {} -> "{}", obj -> JSON.
    const body = JSON.stringify(payload ?? null)

    const res = await request({ method, url, headers, body })
    let response: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(await res.text())
      if (parsed && typeof parsed === 'object') {
        response = parsed as Record<string, unknown>
      }
    } catch {
      response = {}
    }
    return { ok: res.status === 200, response }
  }

  /** base_url (base.py:3486-3506) minus server discovery (deferred). */
  private baseUrl(): string {
    // ponytail: discovery (`.well-known` + `/versions`) is deferred; in-scope
    // fixtures pin `?discovery=no`, so the simple host URL is always correct here.
    const schema = this.secure ? 'https' : 'http'
    const port = this.port != null ? `:${this.port}` : ''
    return `${schema}://${this.host}${port}`
  }

  /** Serialise back to a `matrix(s)://` URL (base.py:3084-3139). */
  override url(privacy = false): string {
    const params: Record<string, string> = {
      image: this.includeImage ? 'yes' : 'no',
      mode: this.mode,
      version: this.version,
      msgtype: this.msgtype,
      discovery: this.discovery ? 'yes' : 'no',
      hsreq: this.hsreq ? 'yes' : 'no',
    }
    if (this.mode === 'hookshot') {
      params.path = this.webhookPath
    }
    if (!this.e2ee) {
      params.e2ee = 'no'
    }
    Object.assign(params, this.urlParameters())

    let auth = ''
    if (this.mode !== 't2bot') {
      if (this.user && this.password) {
        auth = `${quote(this.user, '')}:${URLBase.pprint(
          this.password,
          privacy,
          PrivacyMode.Secret,
          { safe: '' },
        )}@`
      } else if (this.user || this.password) {
        auth = `${quote((this.user || this.password) as string, '')}@`
      }
    }

    const scheme = this.secure ? 'matrixs' : 'matrix'
    const hostname =
      this.mode !== 't2bot'
        ? quote(this.host, '')
        : URLBase.pprint(this.accessToken, privacy, PrivacyMode.Outer, {
            safe: '',
          })
    const port = this.port != null ? `:${this.port}` : ''
    const rooms = quote([...this.rooms, ...this.users].join('/'))
    return `${scheme}://${auth}${hostname}${port}/${rooms}?${urlencode(params)}`
  }

  /** Parse a `matrix(s)://` URL into constructor args (upstream `parse_url`). */
  static override parseUrl(url: string): ParsedUrlResults | null {
    // verifyHost=false: t2bot carries a 64-char token where the host would be.
    const results = URLBase.parseUrl(url, { verifyHost: false })
    if (!results?.host) {
      return null
    }
    const extra = results as unknown as Record<string, unknown>

    // Targets from the path, plus `?to=`.
    const targets = splitPath(results.fullpath ?? '')
    const to = results.qsd.to
    if (to?.length) {
      targets.push(...parseList(to))
    }
    extra.targets = targets

    extra.includeImage = parseBool(results.qsd.image ?? false)
    extra.discovery = parseBool(results.qsd.discovery ?? true)
    extra.hsreq = parseBool(results.qsd.hsreq ?? true)
    if ('path' in results.qsd) {
      extra.webhookPath = unquote(results.qsd.path)
    }
    if ('e2ee' in results.qsd) {
      extra.e2ee = parseBool(results.qsd.e2ee)
    }

    let mode: string | null = results.qsd.mode ?? null
    // t2bot auto-detection: bare token (no password, no targets).
    if (mode === null && !results.password && targets.length === 0) {
      mode = 't2bot'
    }
    if (mode && mode.toLowerCase() === 't2bot') {
      results.password = unquote(results.host)
    }
    extra.mode = mode

    if (results.qsd.msgtype?.length) {
      extra.msgtype = unquote(results.qsd.msgtype)
    }

    // `?token=` overrides the password; otherwise swap a lone user into it.
    if (results.qsd.token?.length) {
      results.password = unquote(results.qsd.token)
    } else if (!results.password && results.user) {
      results.password = results.user
      results.user = null
    }

    if (results.qsd.version?.length) {
      extra.version = unquote(results.qsd.version)
    } else if (results.qsd.v?.length) {
      extra.version = unquote(results.qsd.v)
    }

    return results
  }

  /** Recognise a native t2bot.io webhook URL (base.py:3247-3276). */
  static override parseNativeUrl(url: string): Record<string, unknown> | null {
    const m =
      /^https?:\/\/webhooks\.t2bot\.io\/api\/v[0-9]+\/matrix\/hook\/(?<token>[A-Z0-9_-]+)\/?(?<params>\?.+)?$/i.exec(
        url,
      )
    if (!m) {
      return null
    }
    const token = m.groups?.token ?? ''
    const params = m.groups?.params
    const query = params ? `${params}&mode=t2bot` : '?mode=t2bot'
    return NotifyMatrix.parseUrl(
      `matrixs://${token}/${query}`,
    ) as unknown as Record<string, unknown> | null
  }
}

/** validate_regex(password, /^[a-z0-9]{64}$/i): the token when it matches, else null. */
function validateT2BotToken(password: string | null): string | null {
  return password && T2BOT_TOKEN_RE.test(password) ? password : null
}

registerPlugin(
  ['matrix', 'matrixs'],
  NotifyMatrix as unknown as PluginConstructor,
)
