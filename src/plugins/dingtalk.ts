// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/dingtalk.py).

import { createHmac } from 'node:crypto'
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
  urlencodePlus,
} from '../url.js'

const TOKEN_RE = /^[a-z0-9]+$/i
const PHONE_RE = /^\+?([0-9\s)(+-]+)\s*$/
const PATH_SPLIT_RE = /[ \t\r\n,\\/]+/
const LIST_SPLIT_RE = /[[\];,\s]+/

function splitPath(path: string): string[] {
  return path
    .replace(/^\/+/, '')
    .split(PATH_SPLIT_RE)
    .filter(Boolean)
    .map((part) => unquote(part))
}

function parseList(...values: unknown[]): string[] {
  const parsed: string[] = []
  for (const value of values) {
    if (typeof value === 'string') {
      parsed.push(...value.split(LIST_SPLIT_RE))
    } else if (Array.isArray(value)) {
      parsed.push(...parseList(...value))
    }
  }
  return [...new Set(parsed)]
    .filter(Boolean)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export interface NotifyDingTalkArgs extends NotifyBaseArgs {
  token?: string
  secret?: string | null
  targets?: string | string[]
}

/** DingTalk custom-robot notification service (`dingtalk://`). */
export class NotifyDingTalk extends NotifyBase {
  token: string
  secret: string | null
  targets: string[]

  constructor(args: NotifyDingTalkArgs = {}) {
    super(args)
    const token =
      typeof args.token === 'string' ? args.token.match(TOKEN_RE)?.[0] : ''
    if (!token) {
      throw new TypeError(
        `An invalid DingTalk API Token (${args.token}) was specified.`,
      )
    }
    this.token = token

    this.secret = null
    if (args.secret) {
      const secret = args.secret.match(TOKEN_RE)?.[0]
      if (!secret) {
        throw new TypeError(
          `An invalid DingTalk Secret (${args.token}) was specified.`,
        )
      }
      this.secret = secret
    }

    this.targets = []
    for (const target of parseList(args.targets ?? [])) {
      const phone = PHONE_RE.exec(target)?.[1]
      if (!phone) continue
      const digits = [...phone.matchAll(/\d+/g)].map((m) => m[0]).join('')
      if (digits.length >= 11 && digits.length <= 14) {
        this.targets.push(digits)
      }
    }
  }

  override get titleMaxlen(): number {
    return this.notifyFormat === NotifyFormat.MARKDOWN
      ? NotifyBase.titleMaxlen
      : 0
  }

  getSignature(): [string, string] {
    const timestamp = String(Math.round(Date.now()))
    const secret = this.secret ?? ''
    const signature = createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(`${timestamp}\n${secret}`, 'utf8')
      .digest('base64')
    return [timestamp, quote(signature, '')]
  }

  override async send(
    body: string,
    title = '',
    _notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    const payload: Record<string, unknown> = {
      msgtype: 'text',
      at: { atMobiles: this.targets, isAtAll: false },
    }
    if (this.notifyFormat === NotifyFormat.MARKDOWN) {
      payload.markdown = { title, text: body }
    } else {
      payload.text = { content: body }
    }

    let url = `https://oapi.dingtalk.com/robot/send?access_token=${this.token}`
    if (this.secret) {
      const [timestamp, sign] = this.getSignature()
      url += `&${urlencodePlus({ timestamp, sign })}`
    }

    const response = await this.request({
      method: 'POST',
      url,
      headers: {
        'User-Agent': this.asset.appId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    return response.status === 200
  }

  override url(privacy = false): string {
    const params = {
      format: `NotifyFormat.${this.notifyFormat.toUpperCase()}`,
      overflow: `OverflowMode.${this.overflowMode.toUpperCase()}`,
      verify: this.verifyCertificate ? 'yes' : 'no',
    }
    const secret = this.secret
      ? `${URLBase.pprint(this.secret, privacy, PrivacyMode.Secret, {
          safe: '',
        })}@`
      : ''
    const token = URLBase.pprint(this.token, privacy, PrivacyMode.Outer, {
      safe: '',
    })
    const targets = this.targets.map((target) => quote(target, '')).join('/')
    return `dingtalk://${secret}${token}/${targets}/?${urlencode(params)}`
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url, { verifyHost: false })
    if (!results) return null

    const extra = results as unknown as Record<string, unknown>
    extra.token = unquote(results.host)
    if (results.user) {
      extra.secret = unquote(results.user)
    }

    const targets = splitPath(results.fullpath ?? '')
    if (results.qsd.token?.length) {
      extra.token = unquote(results.qsd.token)
    }
    if (results.qsd.secret?.length) {
      extra.secret = unquote(results.qsd.secret)
    }
    if (results.qsd.to?.length) {
      targets.push(...parseList(results.qsd.to))
    }
    extra.targets = targets
    return results
  }
}

registerPlugin('dingtalk', NotifyDingTalk as unknown as PluginConstructor)
