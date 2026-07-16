// SPDX-License-Identifier: BSD-2-Clause
// Internal shared Feishu/Lark webhook transport. This module has no registration
// side effects; public entry modules own their schemes independently.

import { NotifyType } from '../common.js'
import {
  NotifyBase,
  type NotifyBaseArgs,
  type SendOptions,
} from '../core/notify-base.js'
import { type PrivacyMode, URLBase, urlencode } from '../url.js'
import { pythonJsonDumps } from './python-json.js'

export interface WebhookBotArgs extends NotifyBaseArgs {
  token?: string
}

export interface WebhookBotConfig {
  scheme: string
  endpoint: string
  endpointSuffix?: string
  tokenPattern: RegExp
  privacyMode: PrivacyMode
  byteExactPythonJson: boolean
}

export abstract class FeishuLarkWebhookBase extends NotifyBase {
  token: string
  protected readonly webhookConfig: WebhookBotConfig

  protected constructor(args: WebhookBotArgs, config: WebhookBotConfig) {
    super(args)
    this.webhookConfig = config
    const token =
      typeof args.token === 'string'
        ? args.token.match(config.tokenPattern)?.[0]
        : ''
    if (!token) {
      throw new TypeError(
        `The ${config.scheme} token (${args.token}) is invalid.`,
      )
    }
    this.token = token
  }

  protected composeText(body: string, _title: string): string {
    return body
  }

  override async send(
    body: string,
    title = '',
    _notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    const payload = {
      msg_type: 'text',
      content: { text: this.composeText(body, title) },
    }
    const json = pythonJsonDumps(payload)
    const result = await this.request({
      method: 'POST',
      url: `${this.webhookConfig.endpoint}${this.token}${
        this.webhookConfig.endpointSuffix ?? ''
      }`,
      headers: {
        'User-Agent': this.asset.appId,
        'Content-Type': 'application/json',
      },
      body: this.webhookConfig.byteExactPythonJson
        ? new TextEncoder().encode(json)
        : JSON.stringify(payload),
    })
    return result.status === 200
  }

  override url(privacy = false): string {
    const token = URLBase.pprint(
      this.token,
      privacy,
      this.webhookConfig.privacyMode,
      { safe: '/' },
    )
    return `${this.webhookConfig.scheme}://${token}/?${urlencode(
      this.urlParameters(),
    )}`
  }
}
