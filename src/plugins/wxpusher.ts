// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/wxpusher.py).

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
import { pythonJsonDumps } from './python-json.js'

const TOKEN_RE = /^AT_[^\s]+$/i
const USER_RE = /^\s*(UID_[^\s]+)\s*$/i
const TOPIC_RE = /^\s*([1-9][0-9]{0,20})\s*$/
const PATH_SPLIT_RE = /[ \t\r\n,\\/]+/
const LIST_SPLIT_RE = /[[\];,\s]+/

/** Python orders strings lexicographically by Unicode code point. */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (char) => char.codePointAt(0) ?? 0)
  const right = Array.from(b, (char) => char.codePointAt(0) ?? 0)
  const length = Math.min(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const difference = (left[i] as number) - (right[i] as number)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

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
    if (typeof value === 'string') parsed.push(...value.split(LIST_SPLIT_RE))
    else if (Array.isArray(value)) parsed.push(...parseList(...value))
  }
  return [...new Set(parsed)].filter(Boolean).sort(compareCodePoints)
}

function topicValue(value: string): number | bigint {
  const bigint = BigInt(value)
  return bigint <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bigint) : bigint
}

const CONTENT_TYPE: Record<NotifyFormat, number> = {
  [NotifyFormat.TEXT]: 1,
  [NotifyFormat.HTML]: 2,
  [NotifyFormat.MARKDOWN]: 3,
}

function decodeJsonBytes(bytes: Uint8Array): string {
  let encoding = 'utf-8'
  let offset = 0
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0xfe &&
    bytes[3] === 0xff
  ) {
    encoding = 'utf-32be'
    offset = 4
  } else if (
    bytes[0] === 0xff &&
    bytes[1] === 0xfe &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    encoding = 'utf-32le'
    offset = 4
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be'
    offset = 2
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le'
    offset = 2
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset = 3
  } else if (bytes.length >= 4 && bytes[0] === 0x00) {
    encoding = bytes[1] === 0x00 ? 'utf-32be' : 'utf-16be'
  } else if (bytes.length >= 4 && bytes[1] === 0x00) {
    encoding = bytes[2] === 0x00 && bytes[3] === 0x00 ? 'utf-32le' : 'utf-16le'
  } else if (bytes.length >= 2 && bytes[0] === 0x00) {
    encoding = 'utf-16be'
  } else if (bytes.length >= 2 && bytes[1] === 0x00) {
    encoding = 'utf-16le'
  }

  if (encoding === 'utf-32le' || encoding === 'utf-32be') {
    const content = bytes.subarray(offset)
    if (content.length % 4 !== 0) throw new TypeError('invalid UTF-32')
    const view = new DataView(
      content.buffer,
      content.byteOffset,
      content.byteLength,
    )
    let decoded = ''
    for (let index = 0; index < content.length; index += 4) {
      const codePoint = view.getUint32(index, encoding === 'utf-32le')
      if (
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        throw new TypeError('invalid UTF-32')
      }
      decoded += String.fromCodePoint(codePoint)
    }
    return decoded
  }
  return new TextDecoder(encoding, { fatal: true }).decode(
    bytes.subarray(offset),
  )
}

export interface NotifyWxPusherArgs extends NotifyBaseArgs {
  token?: string
  targets?: string | string[]
}

export class NotifyWxPusher extends NotifyBase {
  token: string
  users: string[]
  topics: Array<number | bigint>
  invalidTargets: string[]

  constructor(args: NotifyWxPusherArgs = {}) {
    super(args)
    const token =
      typeof args.token === 'string' ? args.token.match(TOKEN_RE)?.[0] : ''
    if (!token) {
      throw new TypeError(
        `An invalid WxPusher App Token (${args.token}) was specified.`,
      )
    }
    this.token = token
    this.users = []
    this.topics = []
    this.invalidTargets = []

    for (const target of parseList(args.targets ?? [])) {
      const user = USER_RE.exec(target)?.[1]
      if (user) {
        this.users.push(user)
        continue
      }
      const topic = TOPIC_RE.exec(target)?.[1]
      if (topic) {
        this.topics.push(topicValue(topic))
        continue
      }
      this.invalidTargets.push(target)
    }
  }

  override async send(
    body: string,
    title = '',
    _notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    if (this.users.length === 0 && this.topics.length === 0) return false

    const payload = {
      appToken: this.token,
      content: body,
      summary: title,
      contentType: CONTENT_TYPE[this.notifyFormat],
      topicIds: this.topics,
      uids: this.users,
      url: null,
    }
    const result = await this.request({
      method: 'POST',
      url: 'https://wxpusher.zjiecode.com/api/send/message',
      headers: {
        'User-Agent': this.asset.appId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: new TextEncoder().encode(pythonJsonDumps(payload)),
    })

    let response: unknown = null
    try {
      if (!result.arrayBuffer) return false
      response = JSON.parse(
        decodeJsonBytes(new Uint8Array(await result.arrayBuffer())),
      )
    } catch {
      return false
    }
    return (
      result.status === 200 &&
      Boolean(response) &&
      typeof response === 'object' &&
      (response as Record<string, unknown>).code === 1000
    )
  }

  override url(privacy = false): string {
    const token = URLBase.pprint(this.token, privacy, PrivacyMode.Secret, {
      safe: '',
    })
    const targets = [
      ...this.topics.map(String),
      ...this.users,
      ...this.invalidTargets.map((target) => quote(target, '')),
    ].join('/')
    return `wxpusher://${token}/${targets}/?${urlencode(this.urlParameters())}`
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url, { verifyHost: false })
    if (!results) return null
    const extra = results as unknown as Record<string, unknown>
    const targets = splitPath(results.fullpath ?? '')
    if (results.qsd.token?.length) {
      extra.token = unquote(results.qsd.token)
      if (results.host) targets.push(...splitPath(results.host))
    } else {
      extra.token = unquote(results.host)
    }
    if (results.qsd.to?.length) {
      targets.push(...parseList(results.qsd.to))
    }
    extra.targets = targets
    return results
  }
}

registerPlugin('wxpusher', NotifyWxPusher as unknown as PluginConstructor)
