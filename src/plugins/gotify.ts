// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/gotify.py).

import { NotifyFormat, NotifyType } from '../common.js'
import {
  NotifyBase,
  type NotifyBaseArgs,
  type SendOptions,
} from '../core/notify-base.js'
import { type PluginConstructor, registerPlugin } from '../registry.js'
import {
  type ParsedUrlResults,
  PrivacyMode,
  quote,
  URLBase,
  unquote,
  urlencode,
} from '../url.js'

export enum GotifyPriority {
  LOW = 0,
  MODERATE = 3,
  NORMAL = 5,
  HIGH = 8,
  EMERGENCY = 10,
}

const PRIORITY_NAMES = new Map<number, string>([
  [GotifyPriority.LOW, 'low'],
  [GotifyPriority.MODERATE, 'moderate'],
  [GotifyPriority.NORMAL, 'normal'],
  [GotifyPriority.HIGH, 'high'],
  [GotifyPriority.EMERGENCY, 'emergency'],
])

// Ordered: "10" must precede "1", matching upstream's dict insertion order.
const PRIORITY_PREFIXES: ReadonlyArray<[string, GotifyPriority]> = [
  ['l', GotifyPriority.LOW],
  ['m', GotifyPriority.MODERATE],
  ['n', GotifyPriority.NORMAL],
  ['h', GotifyPriority.HIGH],
  ['e', GotifyPriority.EMERGENCY],
  ['10', GotifyPriority.EMERGENCY],
  ['0', GotifyPriority.LOW],
  ['1', GotifyPriority.LOW],
  ['2', GotifyPriority.LOW],
  ['3', GotifyPriority.MODERATE],
  ['4', GotifyPriority.MODERATE],
  ['5', GotifyPriority.NORMAL],
  ['6', GotifyPriority.NORMAL],
  ['7', GotifyPriority.NORMAL],
  ['8', GotifyPriority.HIGH],
  ['9', GotifyPriority.HIGH],
]

const PATH_SPLIT_RE = /[ \t\r\n,\\/]+/

function splitPath(path: string | null | undefined): string[] {
  return (path ?? '')
    .replace(/^\/+/, '')
    .split(PATH_SPLIT_RE)
    .filter(Boolean)
    .map((part) => unquote(part))
}

function resolvePriority(value: unknown): GotifyPriority {
  if (value === null || value === undefined) return GotifyPriority.NORMAL
  const text = String(value).toLowerCase()
  return (
    PRIORITY_PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ??
    GotifyPriority.NORMAL
  )
}

export interface NotifyGotifyArgs extends NotifyBaseArgs {
  token?: string | null
  priority?: string | number | null
}

/** Gotify self-hosted JSON notification service. */
export class NotifyGotify extends NotifyBase {
  token: string
  priority: GotifyPriority

  constructor(args: NotifyGotifyArgs = {}) {
    super(args)
    const token = typeof args.token === 'string' ? args.token.trim() : ''
    if (!token || /\s/.test(token)) {
      throw new TypeError(
        `An invalid Gotify Token (${args.token}) was specified.`,
      )
    }
    this.token = token
    this.priority = resolvePriority(args.priority)
  }

  override async send(
    body: string,
    title = '',
    _notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    const schema = this.secure ? 'https' : 'http'
    const port = this.port === null ? '' : `:${this.port}`
    const payload: Record<string, unknown> = {
      priority: this.priority,
      title,
      message: body,
    }
    if (this.notifyFormat === NotifyFormat.MARKDOWN) {
      payload.extras = {
        'client::display': { contentType: 'text/markdown' },
      }
    }

    try {
      const result = await this.request({
        method: 'POST',
        url: `${schema}://${this.host}${port}${this.fullpath ?? '/'}message`,
        headers: {
          'User-Agent': this.asset.appId,
          'Content-Type': 'application/json',
          'X-Gotify-Key': this.token,
        },
        body: JSON.stringify(payload),
      })
      return result.status === 200
    } catch {
      return false
    }
  }

  override url(privacy = false): string {
    const scheme = this.secure ? 'gotifys' : 'gotify'
    const defaultPort = this.secure ? 443 : 80
    const port =
      this.port === null || this.port === defaultPort ? '' : `:${this.port}`
    const fullpath = quote(this.fullpath ?? '/', '/')
    const token = URLBase.pprint(this.token, privacy, PrivacyMode.Outer, {
      safe: '',
    })
    const params = {
      priority: PRIORITY_NAMES.get(this.priority) ?? 'normal',
      ...this.urlParameters(),
    }
    return `${scheme}://${this.host}${port}${fullpath}${token}/?${urlencode(params)}`
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url)
    if (!results) return null
    const entries = splitPath(results.fullpath)
    const extra = results as unknown as Record<string, unknown>
    extra.token = entries.pop() ?? null
    extra.fullpath = entries.length === 0 ? '/' : `/${entries.join('/')}/`
    if (results.qsd.priority?.length) {
      extra.priority = unquote(results.qsd.priority)
    }
    return results
  }
}

registerPlugin(
  ['gotify', 'gotifys'],
  NotifyGotify as unknown as PluginConstructor,
)
