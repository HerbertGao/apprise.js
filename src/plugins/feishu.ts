// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/feishu.py).

import { type PluginConstructor, registerPlugin } from '../registry.js'
import { type ParsedUrlResults, PrivacyMode, URLBase, unquote } from '../url.js'
import {
  FeishuLarkWebhookBase,
  type WebhookBotArgs,
} from './feishu-lark-base.js'

export type NotifyFeishuArgs = WebhookBotArgs

export class NotifyFeishu extends FeishuLarkWebhookBase {
  static override titleMaxlen = 0
  static override bodyMaxlen = 19_985

  constructor(args: NotifyFeishuArgs = {}) {
    super(args, {
      scheme: 'feishu',
      endpoint: 'https://open.feishu.cn/open-apis/bot/v2/hook/',
      endpointSuffix: '/',
      tokenPattern: /^[a-z0-9_-]+$/i,
      privacyMode: PrivacyMode.Outer,
      byteExactPythonJson: true,
    })
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
}

registerPlugin('feishu', NotifyFeishu as unknown as PluginConstructor)
