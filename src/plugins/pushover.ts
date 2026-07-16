// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/pushover.py).

import type { AppriseAttachment, AttachBase } from '../attachment/base.js'
import { NotifyFormat, NotifyType } from '../common.js'
import { convertBetween } from '../conversion.js'
import { chooseBoundary, escapeMultipartFilename } from '../core/multipart.js'
import {
  NotifyBase,
  type NotifyBaseArgs,
  type SendOptions,
} from '../core/notify-base.js'
import { encryptPushoverField } from '../internal/pushover-codec.js'
import { type PluginConstructor, registerPlugin } from '../registry.js'
import {
  type ParsedUrlResults,
  PrivacyMode,
  parseBool,
  quote,
  URLBase,
  unquote,
  urlencode,
  urlencodePlus,
} from '../url.js'

export enum PushoverPriority {
  LOW = -2,
  MODERATE = -1,
  NORMAL = 0,
  HIGH = 1,
  EMERGENCY = 2,
}

export const PushoverSound = {
  PUSHOVER: 'pushover',
  BIKE: 'bike',
  BUGLE: 'bugle',
  CASHREGISTER: 'cashregister',
  CLASSICAL: 'classical',
  COSMIC: 'cosmic',
  FALLING: 'falling',
  GAMELAN: 'gamelan',
  INCOMING: 'incoming',
  INTERMISSION: 'intermission',
  MAGIC: 'magic',
  MECHANICAL: 'mechanical',
  PIANOBAR: 'pianobar',
  SIREN: 'siren',
  SPACEALARM: 'spacealarm',
  TUGBOAT: 'tugboat',
  ALIEN: 'alien',
  CLIMB: 'climb',
  PERSISTENT: 'persistent',
  ECHO: 'echo',
  UPDOWN: 'updown',
  NONE: 'none',
} as const

const PRIORITY_NAMES = new Map<number, string>([
  [PushoverPriority.LOW, 'low'],
  [PushoverPriority.MODERATE, 'moderate'],
  [PushoverPriority.NORMAL, 'normal'],
  [PushoverPriority.HIGH, 'high'],
  [PushoverPriority.EMERGENCY, 'emergency'],
])
const PRIORITY_PREFIXES: ReadonlyArray<[string, PushoverPriority]> = [
  ['l', PushoverPriority.LOW],
  ['m', PushoverPriority.MODERATE],
  ['n', PushoverPriority.NORMAL],
  ['h', PushoverPriority.HIGH],
  ['e', PushoverPriority.EMERGENCY],
  ['-2', PushoverPriority.LOW],
  ['-1', PushoverPriority.MODERATE],
  ['0', PushoverPriority.NORMAL],
  ['1', PushoverPriority.HIGH],
  ['2', PushoverPriority.EMERGENCY],
]
const DEVICE_RE = /^\s*([a-z0-9_-]{1,25})\s*$/i
const GROUP_RE = /^\s*(?:%23|#)([a-z0-9]+)\s*$/i
const ENCRYPTION_KEY_RE = /^[0-9a-f]{64}$/i
const LIST_SPLIT_RE = /[[\];,\s]+/
const PATH_SPLIT_RE = /[ \t\r\n,\\/]+/
const ALL_DEVICES = 'ALL_DEVICES'
const NOTIFY_URL = 'https://api.pushover.net/1/messages.json'

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

function pyInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return fallback
}

function resolvePriority(value: unknown): PushoverPriority {
  if (value === null || value === undefined) return PushoverPriority.NORMAL
  const text = String(value).toLowerCase()
  return (
    PRIORITY_PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ??
    PushoverPriority.NORMAL
  )
}

function buildMultipart(
  boundary: string,
  fields: ReadonlyMap<string, string>,
  attachment: AttachBase,
): Buffer {
  const parts: Buffer[] = []
  for (const [name, value] of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    )
  }
  const name = attachment.name ?? ''
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${escapeMultipartFilename(name)}"\r\n\r\n`,
    ),
    Buffer.from(attachment.base64(), 'base64'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  )
  return Buffer.concat(parts)
}

export interface NotifyPushoverArgs extends NotifyBaseArgs {
  userKey?: string | null
  token?: string | null
  targets?: string[] | string | null
  priority?: string | number | null
  sound?: string | null
  interval?: string | number | null
  expire?: string | number | null
  supplementalUrl?: string | null
  supplementalUrlTitle?: string | null
  encryptionKey?: string | null
  e2ee?: boolean | string | null
}

/** Pushover secure notification service. */
export class NotifyPushover extends NotifyBase {
  static override attachmentSupport = true
  static override bodyMaxlen = 1024

  userKey: string
  token: string
  devices: string[] = []
  groups: string[] = []
  invalidTargets: string[] = []
  priority: PushoverPriority
  sound: string
  interval?: number
  expire?: number
  supplementalUrl: string | null
  supplementalUrlTitle: string | null
  encryptionKey: string | null
  e2ee: boolean

  constructor(args: NotifyPushoverArgs = {}) {
    super(args)
    const token = typeof args.token === 'string' ? args.token.trim() : ''
    const userKey = typeof args.userKey === 'string' ? args.userKey.trim() : ''
    if (!token || /\s/.test(token)) {
      throw new TypeError(
        `An invalid Pushover Access Token (${args.token}) was specified.`,
      )
    }
    if (!userKey || /\s/.test(userKey)) {
      throw new TypeError(
        `An invalid Pushover User Key (${args.userKey}) was specified.`,
      )
    }
    this.token = token
    this.userKey = userKey

    const targets = parseList(args.targets)
    if (targets.length === 0) this.devices = [ALL_DEVICES]
    else {
      for (const target of targets) {
        const group = GROUP_RE.exec(target)
        if (group?.[1]) this.groups.push(group[1])
        else {
          const device = DEVICE_RE.exec(target)
          if (device?.[1]) this.devices.push(device[1])
          else this.invalidTargets.push(target)
        }
      }
    }

    this.supplementalUrl =
      typeof args.supplementalUrl === 'string' ? args.supplementalUrl : null
    this.supplementalUrlTitle =
      typeof args.supplementalUrlTitle === 'string'
        ? args.supplementalUrlTitle
        : null
    this.sound =
      typeof args.sound === 'string'
        ? args.sound.toLowerCase()
        : PushoverSound.PUSHOVER
    this.priority = resolvePriority(args.priority)
    if (this.priority === PushoverPriority.EMERGENCY) {
      this.interval = pyInt(args.interval, 900)
      this.expire = pyInt(args.expire, 3600)
      if (this.interval < 30) {
        throw new TypeError(
          'Pushover emergency interval must be at least 30 seconds.',
        )
      }
      if (this.expire < 0 || this.expire > 10800) {
        throw new TypeError(
          'Pushover expire must reside in the range of 0 to 10800 seconds.',
        )
      }
    }

    if (args.encryptionKey) {
      const key = String(args.encryptionKey).trim().toLowerCase()
      if (!ENCRYPTION_KEY_RE.test(key)) {
        throw new TypeError(
          `Pushover encryption_key must be exactly 64 hex characters (256-bit AES key); got ${key.length} chars`,
        )
      }
      this.encryptionKey = key
    } else this.encryptionKey = null
    this.e2ee =
      args.e2ee === null || args.e2ee === undefined
        ? true
        : parseBool(args.e2ee)
  }

  override async send(
    body: string,
    title = '',
    _notifyType: NotifyType = NotifyType.INFO,
    options: SendOptions = {},
  ): Promise<boolean> {
    if (this.devices.length === 0 && this.groups.length === 0) return false

    const base = new Map<string, string>([
      ['token', this.token],
      ['priority', String(this.priority)],
      ['title', title || this.asset.appDesc],
      ['message', body],
      ['sound', this.sound],
    ])
    if (this.supplementalUrl) base.set('url', this.supplementalUrl)
    if (this.supplementalUrlTitle)
      base.set('url_title', this.supplementalUrlTitle)
    if (this.notifyFormat === NotifyFormat.HTML) base.set('html', '1')
    else if (this.notifyFormat === NotifyFormat.MARKDOWN) {
      // Python-Markdown does not append markdown-it's final document newline.
      base.set(
        'message',
        convertBetween(
          NotifyFormat.MARKDOWN,
          NotifyFormat.HTML,
          body,
        ).trimEnd(),
      )
      base.set('html', '1')
    }
    if (this.priority === PushoverPriority.EMERGENCY) {
      base.set('retry', String(this.interval))
      base.set('expire', String(this.expire))
    }

    if (this.encryptionKey && this.e2ee) {
      const key = Buffer.from(this.encryptionKey, 'hex')
      try {
        for (const field of ['message', 'title', 'url', 'url_title']) {
          const value = base.get(field)
          if (value !== undefined)
            base.set(field, encryptPushoverField(value, key))
        }
        base.set('encrypted', '1')
      } catch {
        return false
      }
    }

    const payloads: Array<Map<string, string>> = []
    if (this.devices.length > 0) {
      payloads.push(
        new Map([
          ...base,
          ['user', this.userKey],
          ['device', this.devices.join(',')],
        ]),
      )
    }
    for (const group of this.groups) {
      payloads.push(new Map([...base, ['user', group]]))
    }

    const attach = options.attach as AppriseAttachment | null | undefined
    let hasError = false
    for (const payload of payloads) {
      if (attach && attach.length > 0) {
        const current = new Map(payload)
        let index = 0
        for (const attachment of attach) {
          if (index > 0 || !body) current.set('message', attachment.name ?? '')
          if (!(await this.sendOne(current, attachment))) hasError = true
          current.set('title', '')
          current.set('sound', PushoverSound.NONE)
          index += 1
        }
      } else if (!(await this.sendOne(payload))) hasError = true
    }
    return !hasError
  }

  private async sendOne(
    payload: ReadonlyMap<string, string>,
    attachment?: AttachBase,
  ): Promise<boolean> {
    let usableAttachment = attachment
    if (usableAttachment) {
      if (!usableAttachment.exists()) return false
      if (!/^image\/.*/i.test(usableAttachment.mimetype ?? ''))
        usableAttachment = undefined
      else if (usableAttachment.size <= 0 || usableAttachment.size > 5_242_880)
        return false
    }

    const headers: Record<string, string> = {
      'User-Agent': this.asset.appId,
      Authorization: `Basic ${Buffer.from(`${this.token}:`).toString('base64')}`,
    }
    let body: string | Buffer
    if (usableAttachment) {
      const boundary = chooseBoundary()
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`
      body = buildMultipart(boundary, payload, usableAttachment)
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = urlencodePlus(new Map(payload))
    }
    try {
      const result = await this.request({
        method: 'POST',
        url: NOTIFY_URL,
        headers,
        body,
      })
      return result.status === 200
    } catch {
      return false
    }
  }

  override url(privacy = false): string {
    const params: Record<string, string> = {
      priority: PRIORITY_NAMES.get(this.priority) ?? 'normal',
      sound: this.sound,
    }
    if (this.supplementalUrl) params.url = this.supplementalUrl
    if (this.supplementalUrlTitle) params.url_title = this.supplementalUrlTitle
    if (this.priority === PushoverPriority.EMERGENCY) {
      params.expire = String(this.expire)
      params.interval = String(this.interval)
    }
    if (this.encryptionKey) {
      params.key = privacy
        ? URLBase.pprint(this.encryptionKey, true, PrivacyMode.Outer, {
            safe: '',
          })
        : this.encryptionKey
      if (!this.e2ee) params.e2ee = 'no'
    }
    Object.assign(params, this.urlParameters())

    const targets = [
      ...this.devices
        .filter((device) => device !== ALL_DEVICES)
        .map((device) => quote(device, '')),
      ...this.groups.map((group) => quote(`#${group}`, '')),
      ...this.invalidTargets.map((target) => quote(target, '')),
    ].join('/')
    const userKey = URLBase.pprint(this.userKey, privacy, PrivacyMode.Outer, {
      safe: '',
    })
    const token = URLBase.pprint(this.token, privacy, PrivacyMode.Outer, {
      safe: '',
    })
    return `pover://${userKey}@${token}/${targets}/?${urlencode(params)}`
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    const q = url.indexOf('?')
    const path = q < 0 ? url : url.slice(0, q)
    const rest = q < 0 ? '' : url.slice(q)
    const results = URLBase.parseUrl(path.replaceAll('#', '%23') + rest, {
      verifyHost: false,
    })
    if (!results) return null
    const extra = results as unknown as Record<string, unknown>
    const targets = splitPath(results.fullpath)
    if (results.qsd.to?.length) targets.push(...parseList(results.qsd.to))
    extra.targets = targets
    extra.userKey = unquote(results.user)
    extra.token = unquote(results.host)
    if (results.qsd.priority?.length)
      extra.priority = unquote(results.qsd.priority)
    if (results.qsd.sound?.length) extra.sound = unquote(results.qsd.sound)
    if (results.qsd.url?.length)
      extra.supplementalUrl = unquote(results.qsd.url)
    if (results.qsd.url_title?.length) {
      extra.supplementalUrlTitle = unquote(results.qsd.url_title)
    }
    if (results.qsd.expire?.length) extra.expire = results.qsd.expire
    if (results.qsd.interval?.length) extra.interval = results.qsd.interval
    if (results.qsd.key?.length) extra.encryptionKey = unquote(results.qsd.key)
    if (results.qsd.e2ee?.length) extra.e2ee = results.qsd.e2ee
    return results
  }
}

registerPlugin('pover', NotifyPushover as unknown as PluginConstructor)
