// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/serverchan.py).

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
  urlencodePlus,
} from '../url.js'

const TOKEN_RE = /^[a-z0-9-]+$/i

export interface NotifyServerChanArgs extends NotifyBaseArgs {
  token?: string
}

/** ServerChan notification service (`schan://`). */
export class NotifyServerChan extends NotifyBase {
  token: string

  constructor(args: NotifyServerChanArgs = {}) {
    super(args)
    const token =
      typeof args.token === 'string' ? args.token.match(TOKEN_RE)?.[0] : ''
    if (!token) {
      throw new TypeError(
        `An invalid ServerChan API Token (${args.token}) was specified.`,
      )
    }
    this.token = token
  }

  override async send(
    body: string,
    title = '',
    _notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    const response = await this.request({
      method: 'POST',
      url: `https://sctapi.ftqq.com/${this.token}.send`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: urlencodePlus({ title, desp: body }),
    })
    return response.status === 200
  }

  override url(privacy = false): string {
    const token = URLBase.pprint(this.token, privacy, PrivacyMode.Outer, {
      safe: '',
    })
    return `schan://${token}`
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url, { verifyHost: false })
    if (!results) {
      return null
    }

    // Preserve upstream's deliberately unanchored prefix extraction: without
    // a trailing slash, `schan://abc-def` constructs with token `abc`.
    const pattern = url.endsWith('/')
      ? /^schan:\/\/([a-zA-Z0-9]+)\//
      : /^schan:\/\/([a-zA-Z0-9]+)\/?/
    const extra = results as unknown as Record<string, unknown>
    extra.token = pattern.exec(url)?.[1] ?? ''
    return results
  }
}

registerPlugin('schan', NotifyServerChan as unknown as PluginConstructor)
