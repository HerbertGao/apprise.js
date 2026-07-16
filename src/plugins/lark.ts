// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/lark.py).

import { type PluginConstructor, registerPlugin } from '../registry.js'
import { type ParsedUrlResults, PrivacyMode, URLBase, unquote } from '../url.js'
import {
  FeishuLarkWebhookBase,
  type WebhookBotArgs,
} from './feishu-lark-base.js'

export type NotifyLarkArgs = WebhookBotArgs

export class NotifyLark extends FeishuLarkWebhookBase {
  constructor(args: NotifyLarkArgs = {}) {
    super(args, {
      scheme: 'lark',
      endpoint: 'https://open.larksuite.com/open-apis/bot/v2/hook/',
      tokenPattern: /^[a-z0-9-]+$/i,
      privacyMode: PrivacyMode.Secret,
      byteExactPythonJson: false,
    })
  }

  protected override composeText(body: string, title: string): string {
    return title ? `${title}\n${body}` : body
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url, { verifyHost: false })
    if (!results) return null
    const extra = results as unknown as Record<string, unknown>
    extra.token = results.qsd.token?.length
      ? unquote(results.qsd.token)
      : unquote(results.host)
    return results
  }

  static override parseNativeUrl(url: string): Record<string, unknown> | null {
    const match =
      /^https:\/\/open\.larksuite\.com\/open-apis\/bot\/v2\/hook\/([\w-]+)$/i.exec(
        url,
      )
    return match
      ? (NotifyLark.parseUrl(`lark://${match[1]}`) as unknown as Record<
          string,
          unknown
        >)
      : null
  }
}

registerPlugin('lark', NotifyLark as unknown as PluginConstructor)
