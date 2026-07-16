// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/pushdeer.py).

import { NotifyType } from '../common.js'
import {
  NotifyBase,
  type NotifyBaseArgs,
  type SendOptions,
} from '../core/notify-base.js'
import { type PluginConstructor, registerPlugin } from '../registry.js'
import {
  type ParsedUrlResults,
  PrivacyMode,
  URLBase,
  unquote,
  urlencodePlus,
} from '../url.js'

const PUSH_KEY_RE = /^[a-z0-9]+$/i
const PATH_SPLIT_RE = /[ \t\r\n,\\/]+/

function splitPath(path: string): string[] {
  return path
    .replace(/^\/+/, '')
    .split(PATH_SPLIT_RE)
    .filter(Boolean)
    .map((part) => unquote(part))
}

export interface NotifyPushDeerArgs extends NotifyBaseArgs {
  pushkey?: string
}

export class NotifyPushDeer extends NotifyBase {
  pushKey: string

  constructor(args: NotifyPushDeerArgs = {}) {
    super(args)
    const pushKey =
      typeof args.pushkey === 'string'
        ? args.pushkey.match(PUSH_KEY_RE)?.[0]
        : ''
    if (!pushKey) {
      throw new TypeError(
        `An invalid PushDeer API Pushkey (${args.pushkey}) was specified.`,
      )
    }
    this.pushKey = pushKey
  }

  override async send(
    body: string,
    title = '',
    _notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    const schema = this.secure ? 'https' : 'http'
    const host = this.host || 'api2.pushdeer.com'
    const port = this.port || (this.secure ? 443 : 80)
    const result = await this.request({
      method: 'POST',
      url: `${schema}://${host}:${port}/message/push?pushkey=${this.pushKey}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: urlencodePlus({
        text: title || body,
        type: 'text',
        desp: title ? body : '',
      }),
    })
    return result.status === 200
  }

  override url(privacy = false): string {
    const scheme = this.secure ? 'pushdeers' : 'pushdeer'
    const pushKey = URLBase.pprint(this.pushKey, privacy, PrivacyMode.Outer, {
      safe: '',
    })
    if (!this.host) return `${scheme}://${pushKey}`
    return `${scheme}://${this.host}${this.port ? `:${this.port}` : ''}/${pushKey}`
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url, { verifyHost: false })
    if (!results) return null
    const paths = splitPath(results.fullpath ?? '')
    const extra = results as unknown as Record<string, unknown>
    if (paths.length === 0) {
      extra.pushkey = results.host
      extra.host = null
    } else {
      extra.pushkey = paths.pop()
    }
    return results
  }
}

registerPlugin(
  ['pushdeer', 'pushdeers'],
  NotifyPushDeer as unknown as PluginConstructor,
)
