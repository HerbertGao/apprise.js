// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/pushbullet.py).

import type { AppriseAttachment, AttachBase } from '../attachment/base.js'
import { NotifyType } from '../common.js'
import { chooseBoundary, escapeMultipartFilename } from '../core/multipart.js'
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

const SEND_TO_ALL = 'ALL_DEVICES'
const API_URL = 'https://api.pushbullet.com/v2/'
const LIST_SPLIT_RE = /[[\];,\s]+/
const PATH_SPLIT_RE = /[ \t\r\n,\\/]+/

// is_email (parse.py GET_EMAIL_RE), matching the target form used upstream.
const EMAIL_RE = new RegExp(
  '^(?<fullEmail>(?:[^+]+\\+)?' +
    "[a-z0-9_!#$%&*/=?%`{|}~^-]+(?:\\.[a-z0-9_!#$%&'*/=?%`{|}~^-]+)*" +
    '@(?:(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9_-]*[a-z0-9])' +
    '|[a-z0-9][a-z0-9_-]{5,}))',
  'i',
)

function parseList(
  ...values: Array<string | string[] | null | undefined>
): string[] {
  const entries: string[] = []
  for (const value of values) {
    if (typeof value === 'string') entries.push(...value.split(LIST_SPLIT_RE))
    else if (Array.isArray(value)) entries.push(...parseList(...value))
  }
  return [...new Set(entries.filter(Boolean))].sort()
}

function splitPath(path: string | null | undefined): string[] {
  return (path ?? '')
    .replace(/^\/+/, '')
    .split(PATH_SPLIT_RE)
    .filter(Boolean)
    .map((value) => unquote(value))
}

function buildMultipart(boundary: string, attachment: AttachBase): Buffer {
  const name = attachment.name ?? ''
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escapeMultipartFilename(name)}"\r\n\r\n`,
    ),
    Buffer.from(attachment.base64(), 'base64'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
}

interface SendResult {
  okay: boolean
  response: unknown
}

interface PreparedFilePayload {
  type: 'file'
  file_name: string
  file_type: string
  file_url: string
  image_url?: string
}

export interface NotifyPushBulletArgs extends NotifyBaseArgs {
  accessToken?: string | null
  targets?: string[] | string | null
}

/** Pushbullet note and response-driven attachment notification plugin. */
export class NotifyPushBullet extends NotifyBase {
  static override attachmentSupport = true

  accessToken: string
  targets: readonly string[]

  constructor(args: NotifyPushBulletArgs = {}) {
    super(args)
    const token =
      typeof args.accessToken === 'string' ? args.accessToken.trim() : ''
    if (!token || /\s/.test(token)) {
      throw new TypeError(
        `An invalid PushBullet Access Token (${args.accessToken}) was specified.`,
      )
    }
    this.accessToken = token
    const targets = parseList(args.targets)
    this.targets = targets.length === 0 ? [SEND_TO_ALL] : targets
  }

  override async send(
    body: string,
    title = '',
    _notifyType: NotifyType = NotifyType.INFO,
    options: SendOptions = {},
  ): Promise<boolean> {
    const attachments: PreparedFilePayload[] = []
    const attach = options.attach as AppriseAttachment | null | undefined

    if (attach && attach.length > 0) {
      let number = 1
      for (const attachment of attach) {
        if (!attachment.exists()) return false
        const metadata = {
          file_name:
            attachment.name || `file${String(number).padStart(3, '0')}.dat`,
          file_type: attachment.mimetype,
        }
        const prepared = await this.sendJson(
          `${API_URL}upload-request`,
          metadata,
        )
        if (!prepared.okay) return false
        const value = prepared.response
        if (!value || typeof value !== 'object' || Array.isArray(value))
          return false
        const response = value as Record<string, unknown>
        const fileName = response.file_name
        const fileType = response.file_type
        const fileUrl = response.file_url
        const uploadUrl = response.upload_url
        if (
          typeof fileName !== 'string' ||
          typeof fileType !== 'string' ||
          typeof fileUrl !== 'string' ||
          typeof uploadUrl !== 'string'
        ) {
          return false
        }

        const payload: PreparedFilePayload = {
          type: 'file',
          file_name: fileName,
          file_type: fileType,
          file_url: fileUrl,
        }
        if (fileType.startsWith('image/')) payload.image_url = fileUrl
        const uploaded = await this.sendAttachment(uploadUrl, attachment)
        if (!uploaded.okay) return false
        attachments.push(payload)
        number += 1
      }
    }

    let hasError = false
    for (const recipient of this.targets) {
      const note: Record<string, string> = { type: 'note', title, body }
      const email = EMAIL_RE.exec(recipient)?.groups?.fullEmail
      if (email) note.email = email
      else if (recipient === SEND_TO_ALL) {
        // The all-devices sentinel intentionally adds no target selector.
      } else if (recipient.startsWith('#'))
        note.channel_tag = recipient.slice(1)
      else note.device_iden = recipient

      if (body) {
        const sent = await this.sendJson(`${API_URL}pushes`, note)
        if (!sent.okay) {
          hasError = true
          continue
        }
      }
      for (const payload of attachments) {
        const sent = await this.sendJson(`${API_URL}pushes`, payload)
        if (!sent.okay) hasError = true
      }
    }
    return !hasError
  }

  private headers(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.asset.appId,
      Authorization: `Basic ${Buffer.from(`${this.accessToken}:`).toString('base64')}`,
    }
    if (contentType) headers['Content-Type'] = contentType
    return headers
  }

  private async sendJson(url: string, payload: unknown): Promise<SendResult> {
    return this.sendWire(url, {
      headers: this.headers('application/json'),
      body: payload ? JSON.stringify(payload) : undefined,
    })
  }

  private async sendAttachment(
    url: string,
    attachment: AttachBase,
  ): Promise<SendResult> {
    const boundary = chooseBoundary()
    return this.sendWire(url, {
      headers: this.headers(`multipart/form-data; boundary=${boundary}`),
      body: buildMultipart(boundary, attachment),
    })
  }

  private async sendWire(
    url: string,
    wire: { headers: Record<string, string>; body?: string | Buffer },
  ): Promise<SendResult> {
    try {
      const result = await this.request({ method: 'POST', url, ...wire })
      const text = await result.text()
      let response: unknown = text
      try {
        response = JSON.parse(text)
      } catch {
        // Only upload-request consumes JSON; other successful phases accept
        // empty or non-JSON responses exactly like upstream.
      }
      return {
        okay: result.status === 200 || result.status === 204,
        response,
      }
    } catch {
      return { okay: false, response: null }
    }
  }

  override url(privacy = false): string {
    const targets =
      this.targets.length === 1 && this.targets[0] === SEND_TO_ALL
        ? ''
        : this.targets.map((target) => quote(target)).join('/')
    const token = URLBase.pprint(this.accessToken, privacy, PrivacyMode.Outer, {
      safe: '',
    })
    return `pbul://${token}/${targets}/?${urlencode(this.urlParameters())}`
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url, { verifyHost: false })
    if (!results) return null
    const extra = results as unknown as Record<string, unknown>
    const targets = splitPath(results.fullpath)
    if (results.qsd.to?.length) targets.push(...parseList(results.qsd.to))
    extra.targets = targets
    extra.accessToken = unquote(results.host)
    return results
  }
}

registerPlugin('pbul', NotifyPushBullet as unknown as PluginConstructor)
