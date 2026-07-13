// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/mattermost.py).
//
// NotifyMattermost — the `mmost://` / `mmosts://` incoming-webhook plugin. This
// batch implements the WEBHOOK mode only: an `mmost(s)://{host}[:port]
// [/{fullpath}]/{token}` URL POSTs a JSON `{text,icon_url?,username,channel?}`
// payload to `{scheme}://{host}[:port][/{fullpath}]/hooks/{token}` (mattermost
// .py:502). Because webhook mode carries no attachments upstream
// (`attachment_support = (mode == BOT)`, mattermost.py:267) this plugin sets
// `attachmentSupport = false`. BOT mode (`/api/v4/posts` + `/api/v4/files`
// attachment upload, channel-id lookup) is DEFERRED — a `?mode=bot` / `?team=`
// URL throws at construction. The wire request is verified field-by-field
// against the Python golden fixture.

import { NotifyImageSize, NotifyType } from '../common.js'
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

// Upstream Mattermost modes (mattermost.py:78-91). WEBHOOK is the default; BOT
// is deferred this batch.
const MODE_WEBHOOK = 'webhook'
const MODE_BOT = 'bot'
const MATTERMOST_MODES = [MODE_WEBHOOK, MODE_BOT] as const

// Channel / channel-id detection (mattermost.py:74-75).
const IS_CHANNEL = /^(#|%23)([A-Za-z0-9_-]+)$/
const IS_CHANNEL_ID = /^(\+|%2B)?([A-Za-z0-9_-]+)$/

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

/**
 * parse_list (parse.py, `sort=True` default): split each string on the
 * delimiter set, flatten arrays, drop empties, then return a de-duplicated,
 * lexicographically-sorted list (upstream `sorted(filter(bool, set(...)))`).
 */
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

/** validate_regex default (`[^\s]+`): first non-whitespace run of a trimmed
 *  string, or `null` (upstream parse.py). */
function validateRegex(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const m = /[^\s]+/.exec(value.trim())
  return m ? m[0] : null
}

/** Strip trailing `/` from a path (upstream `fullpath.rstrip("/")`). */
function rstripSlash(path: string): string {
  return path.replace(/\/+$/, '')
}

/** Constructor arguments for {@link NotifyMattermost} (from its `parseUrl`). */
export interface NotifyMattermostArgs extends NotifyBaseArgs {
  /** Webhook token (last path segment). */
  token?: string
  /** Optional sub-path preceding `/hooks/` (leading `/`, no trailing `/`). */
  fullpath?: string | null
  /** Target channels (raw strings; validated in the constructor). */
  targets?: string[] | string
  /** Include the notify-type image as `icon_url` (default true). */
  include_image?: boolean
  /** Explicit icon URL override. */
  icon_url?: string
  /** Integration mode (`webhook` — the only supported mode this batch). */
  mode?: string
}

/** A wrapper for Mattermost incoming-webhook notifications (webhook mode). */
export class NotifyMattermost extends NotifyBase {
  // Upstream overridable defaults (mattermost.py:114-120). Webhook mode has no
  // attachments, so attachmentSupport stays false this batch.
  static override bodyMaxlen = 4000
  static override titleMaxlen = 0
  static override attachmentSupport = false

  token: string
  /** "" or `/sub/path` (no trailing slash), matching upstream `self.fullpath`. */
  override fullpath: string
  targets: Array<[string, string]>
  invalidTargets: string[]
  includeImage: boolean
  iconUrl: string | null
  mode: string

  constructor(args: NotifyMattermostArgs = {}) {
    super(args)

    // Upstream keeps fullpath as a (possibly empty) trimmed string; URLBase
    // coerces it to `/`, so restore the upstream default here.
    this.fullpath =
      typeof args.fullpath === 'string' ? args.fullpath.trim() : ''

    // Mode resolution (mattermost.py:253-264): prefix-match against the mode
    // list. BOT mode is deferred this batch.
    let mode = MODE_WEBHOOK
    if (typeof args.mode === 'string' && args.mode.trim()) {
      const wanted = args.mode.trim().toLowerCase()
      const resolved = MATTERMOST_MODES.find((m) => m.startsWith(wanted))
      if (!resolved) {
        throw new TypeError(
          `The Mattermost mode specified (${args.mode}) is invalid.`,
        )
      }
      mode = resolved
    }
    if (mode === MODE_BOT) {
      // ponytail: BOT mode (/api/v4/posts + /api/v4/files attachment upload,
      // channel-id lookup, persistent cache) is deferred; wire it in with the
      // bot-mode milestone. Webhook mode is the batch-1 scope.
      throw new TypeError('Mattermost bot mode is not supported in this batch.')
    }
    this.mode = mode

    const token = validateRegex(args.token)
    if (!token) {
      throw new TypeError(
        `An invalid Mattermost Token (${args.token}) was specified.`,
      )
    }
    this.token = token

    // Channel parsing (mattermost.py:280-313). Webhook mode maps both `#name`
    // and bare `name` (channel-id form) to a `#` channel.
    this.targets = []
    this.invalidTargets = []
    for (const target of parseList(args.targets)) {
      const chan = IS_CHANNEL.exec(target)
      if (chan) {
        this.targets.push(['#', chan[2] as string])
        continue
      }
      const chanId = IS_CHANNEL_ID.exec(target)
      if (chanId) {
        this.targets.push(['#', chanId[2] as string])
        continue
      }
      this.invalidTargets.push(target)
    }

    // ponytail: upstream's constructor signature defaults include_image=False
    // (mattermost.py:240) but its URL/template default is True (mattermost.py:214);
    // parseUrl always supplies an explicit value, so align direct construction
    // with the URL path (True) rather than the bare Python signature.
    this.includeImage = args.include_image ?? true
    this.iconUrl = typeof args.icon_url === 'string' ? args.icon_url : null
  }

  override async send(
    body: string,
    _title = '',
    notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    const schema = this.secure ? 'https' : 'http'
    const port = this.port == null ? '' : `:${this.port}`
    const url = `${schema}://${this.host}${port}${rstripSlash(
      this.fullpath,
    )}/hooks/${this.token}`

    const headers: Record<string, string> = {
      'User-Agent': this.asset.appId,
      'Content-Type': 'application/json',
    }

    // No targets -> a single post to the webhook's default channel.
    const targets: Array<[string | null, string | null]> =
      this.targets.length > 0 ? this.targets : [[null, null]]

    let hasError = false
    for (const [, value] of targets) {
      const payload: Record<string, unknown> = { text: body }

      let imageUrl = this.iconUrl
      if (!imageUrl && this.includeImage) {
        imageUrl = this.asset.imageUrl(notifyType, NotifyImageSize.XY_72)
      }
      if (imageUrl) {
        payload.icon_url = imageUrl
      }
      payload.username = this.user ? this.user : this.asset.appId
      if (value) {
        payload.channel = value
      }

      const res = await this.request({
        method: 'POST',
        url,
        headers,
        body: JSON.stringify(payload),
      })
      if (res.status !== 200) {
        hasError = true
      }
    }
    return !hasError
  }

  /** Serialise back to an `mmost(s)://` URL (mattermost.py:721-790). */
  override url(privacy = false): string {
    const params: Record<string, string> = {
      image: this.includeImage ? 'yes' : 'no',
    }
    if (this.iconUrl) {
      params.icon_url = this.iconUrl
    }
    Object.assign(params, this.urlParameters())
    if (this.targets.length > 0) {
      params.to = this.targets
        .map(([kind, value]) => quote(`${kind}${value}`, '#+'))
        .concat(this.invalidTargets.map((x) => quote(x, '')))
        .join(',')
    }

    const scheme = this.secure ? 'mmosts' : 'mmost'
    const source = this.user ? `${quote(this.user, '')}@` : ''
    const defaultPort = this.secure ? 443 : 80
    const port =
      this.port == null || this.port === defaultPort ? '' : `:${this.port}`
    const fullpath = this.fullpath ? `${quote(this.fullpath, '/')}/` : '/'
    const token = URLBase.pprint(this.token, privacy, PrivacyMode.Outer, {
      safe: '',
    })
    return `${scheme}://${source}${this.host}${port}${fullpath}${token}/?${urlencode(
      params,
    )}`
  }

  /** Parse an `mmost(s)://` URL into constructor args (upstream `parse_url`). */
  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url)
    if (!results) {
      return null
    }
    const extra = results as unknown as Record<string, unknown>

    // The last path segment is the token; everything before it is the fullpath.
    const tokens = splitPath(results.fullpath ?? '')
    extra.token = tokens.length > 0 ? tokens.pop() : null
    extra.fullpath = tokens.length > 0 ? `/${tokens.join('/')}` : ''

    // Targets: `to` / `channel` / `channels` (all aliases of targets).
    const targets: string[] = []
    for (const key of ['to', 'channel', 'channels']) {
      const value = results.qsd[key]
      if (value?.length) {
        targets.push(value)
      }
    }
    extra.targets = targets

    extra.include_image = parseBool(
      'image' in results.qsd ? results.qsd.image : true,
      true,
    )

    if (results.qsd.mode) {
      extra.mode = unquote(results.qsd.mode)
    }
    // team/botname map to `user`; team additionally implies BOT mode (deferred).
    if (results.qsd.team) {
      extra.user = unquote(results.qsd.team)
      if (!('mode' in extra)) {
        extra.mode = MODE_BOT
      }
    } else if (results.qsd.botname) {
      extra.user = unquote(results.qsd.botname)
    }
    if ('icon_url' in results.qsd) {
      extra.icon_url = unquote(results.qsd.icon_url)
    }

    return results
  }
}

registerPlugin(
  ['mmost', 'mmosts'],
  NotifyMattermost as unknown as PluginConstructor,
)
