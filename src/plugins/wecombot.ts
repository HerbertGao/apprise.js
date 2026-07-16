// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/wecombot.py).

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
  urlencode,
} from '../url.js'
import { pythonJsonDumps } from './python-json.js'

const KEY_RE = /^[a-z0-9_-]+$/i

export interface NotifyWeComBotArgs extends NotifyBaseArgs {
  key?: string
}

/** WeCom group-bot webhook service (`wecombot://`). */
export class NotifyWeComBot extends NotifyBase {
  static override titleMaxlen = 0

  key: string
  apiUrl: string

  constructor(args: NotifyWeComBotArgs = {}) {
    super(args)
    const key = typeof args.key === 'string' ? args.key.match(KEY_RE)?.[0] : ''
    if (!key) {
      throw new TypeError(
        `An invalid WeCom Bot Webhook Key (${args.key}) was specified.`,
      )
    }
    this.key = key
    this.apiUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`
  }

  override async send(
    body: string,
    _title = '',
    _notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    const result = await this.request({
      method: 'POST',
      url: this.apiUrl,
      headers: {
        'User-Agent': this.asset.appId,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: new TextEncoder().encode(
        pythonJsonDumps({ msgtype: 'text', text: { content: body } }),
      ),
    })
    return result.status === 200
  }

  override url(privacy = false): string {
    const key = URLBase.pprint(this.key, privacy, PrivacyMode.Outer, {
      safe: '',
    })
    return `wecombot://${key}/?${urlencode(this.urlParameters())}`
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url, { verifyHost: false })
    if (!results) return null
    const extra = results as unknown as Record<string, unknown>
    extra.key = unquote(results.host)
    if (results.qsd.key?.length) {
      extra.key = unquote(results.qsd.key)
    }
    return results
  }

  static override parseNativeUrl(url: string): Record<string, unknown> | null {
    const match =
      /^https?:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\/?\?key=(?<key>[A-Z0-9_-]+)\/?&?(?<params>.+)?$/i.exec(
        url,
      )
    if (!match?.groups) return null
    const params = match.groups.params ? `?${match.groups.params}` : ''
    return NotifyWeComBot.parseUrl(
      `wecombot://${match.groups.key}${params}`,
    ) as unknown as Record<string, unknown> | null
  }
}

registerPlugin('wecombot', NotifyWeComBot as unknown as PluginConstructor)
