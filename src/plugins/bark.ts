// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/bark.py).

import { NotifyFormat, NotifyImageSize, NotifyType } from '../common.js'
import {
  NotifyBase,
  type NotifyBaseArgs,
  type SendOptions,
} from '../core/notify-base.js'
import { type PluginConstructor, registerPlugin } from '../registry.js'
import {
  type ParsedUrlResults,
  PrivacyMode,
  parseBool,
  quote,
  URLBase,
  unquote,
  urlencode,
} from '../url.js'

export const BARK_SOUNDS = [
  'alarm.caf',
  'anticipate.caf',
  'bell.caf',
  'birdsong.caf',
  'bloom.caf',
  'calypso.caf',
  'chime.caf',
  'choo.caf',
  'descent.caf',
  'electronic.caf',
  'fanfare.caf',
  'glass.caf',
  'gotosleep.caf',
  'healthnotification.caf',
  'horn.caf',
  'ladder.caf',
  'mailsent.caf',
  'minuet.caf',
  'multiwayinvitation.caf',
  'newmail.caf',
  'newsflash.caf',
  'noir.caf',
  'paymentsuccess.caf',
  'shake.caf',
  'sherwoodforest.caf',
  'silence.caf',
  'spell.caf',
  'suspense.caf',
  'telegraph.caf',
  'tiptoes.caf',
  'typewriters.caf',
  'update.caf',
] as const

export enum NotifyBarkLevel {
  ACTIVE = 'active',
  TIME_SENSITIVE = 'timeSensitive',
  PASSIVE = 'passive',
  CRITICAL = 'critical',
}

const BARK_LEVELS = Object.values(NotifyBarkLevel)
const LIST_SPLIT_RE = /[[\];,\s]+/
const PATH_SPLIT_RE = /[ \t\r\n,\\/]+/

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

function pyInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null
  if (typeof value !== 'string' || !/^[+-]?\d+$/.test(value.trim())) return null
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : null
}

export interface NotifyBarkArgs extends NotifyBaseArgs {
  targets?: string[] | string | null
  includeImage?: boolean
  sound?: string | null
  category?: string | null
  group?: string | null
  level?: string | null
  click?: string | null
  badge?: string | number | null
  volume?: string | number | null
  icon?: string | null
  call?: boolean | string | null
}

/** Bark server notification plugin. */
export class NotifyBark extends NotifyBase {
  targets: string[]
  includeImage: boolean
  sound: string | null
  category: string | null
  group: string | null
  level: NotifyBarkLevel | null
  click: string | null
  badge: number | null
  volume: number | null
  icon: string | null
  call: boolean
  notifyUrl: string

  constructor(args: NotifyBarkArgs = {}) {
    super(args)
    const port = this.port !== null ? `:${this.port}` : ''
    this.notifyUrl = `${this.secure ? 'https' : 'http'}://${this.host}${port}/push`
    this.targets = parseList(args.targets)
    this.includeImage = args.includeImage ?? true
    this.category = typeof args.category === 'string' ? args.category : null
    this.group = typeof args.group === 'string' ? args.group : null
    this.click = typeof args.click === 'string' ? args.click : null
    this.icon = typeof args.icon === 'string' ? args.icon : null
    this.call = parseBool(args.call)

    const badge = pyInt(args.badge)
    this.badge = badge !== null && badge >= 0 ? badge : null

    const sound = typeof args.sound === 'string' ? args.sound.toLowerCase() : ''
    this.sound = sound
      ? (BARK_SOUNDS.find((candidate) => candidate.startsWith(sound)) ?? null)
      : null

    const volume = pyInt(args.volume)
    // Upstream retains parsed out-of-range integers after warning; only values
    // that fail int() entirely become None.
    this.volume = volume

    const level = typeof args.level === 'string' ? args.level : ''
    this.level = level
      ? (BARK_LEVELS.find((candidate) => candidate[0] === level[0]) ?? null)
      : null
  }

  override async send(
    body: string,
    title = '',
    notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    if (this.targets.length === 0) return false

    const basePayload: Record<string, unknown> = {
      title: title || this.asset.appDesc,
    }
    if (this.notifyFormat === NotifyFormat.MARKDOWN) basePayload.markdown = body
    else basePayload.body = body

    const imageUrl = this.includeImage
      ? this.asset.imageUrl(notifyType, NotifyImageSize.XY_128)
      : null
    if (this.icon) basePayload.icon = this.icon
    else if (imageUrl) basePayload.icon = imageUrl
    if (this.sound) basePayload.sound = this.sound
    if (this.click) basePayload.url = this.click
    if (this.badge) basePayload.badge = this.badge
    if (this.level) basePayload.level = this.level
    if (this.category) basePayload.category = this.category
    if (this.group) basePayload.group = this.group
    if (this.volume) basePayload.volume = this.volume
    if (this.call) basePayload.call = 1

    const headers: Record<string, string> = {
      'User-Agent': this.asset.appId,
      'Content-Type': 'application/json; charset=utf-8',
    }
    if (this.user) {
      const password = this.password === null ? 'None' : this.password
      headers.Authorization = `Basic ${Buffer.from(`${this.user}:${password}`).toString('base64')}`
    }

    let hasError = false
    for (const target of [...this.targets].reverse()) {
      try {
        const result = await this.request({
          method: 'POST',
          url: this.notifyUrl,
          headers,
          body: JSON.stringify({ ...basePayload, device_key: target }),
        })
        if (result.status !== 200) hasError = true
      } catch {
        hasError = true
      }
    }
    return !hasError
  }

  override url(privacy = false): string {
    const params: Record<string, string> = {
      image: this.includeImage ? 'yes' : 'no',
    }
    if (this.sound) params.sound = this.sound
    if (this.click) params.click = this.click
    if (this.badge) params.badge = String(this.badge)
    if (this.level) params.level = this.level
    if (this.volume) params.volume = String(this.volume)
    if (this.category) params.category = this.category
    if (this.group) params.group = this.group
    if (this.icon) params.icon = this.icon
    if (this.call) params.call = 'yes'
    Object.assign(params, this.urlParameters())

    let auth = ''
    if (this.user && this.password) {
      auth = `${quote(this.user, '')}:${URLBase.pprint(
        this.password,
        privacy,
        PrivacyMode.Secret,
        { safe: '' },
      )}@`
    } else if (this.user) {
      auth = `${quote(this.user, '')}@`
    }
    const defaultPort = this.secure ? 443 : 80
    const port =
      this.port === null || this.port === defaultPort ? '' : `:${this.port}`
    const targets = this.targets.map((target) => quote(target)).join('/')
    return `${this.secure ? 'barks' : 'bark'}://${auth}${this.host}${port}/${targets}?${urlencode(params)}`
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url)
    if (!results) return null
    const extra = results as unknown as Record<string, unknown>
    const targets = splitPath(results.fullpath)
    if (results.qsd.to?.length) targets.push(...parseList(results.qsd.to))
    extra.targets = targets
    for (const key of [
      'category',
      'group',
      'badge',
      'volume',
      'level',
      'click',
      'sound',
      'icon',
    ]) {
      if (results.qsd[key]?.length)
        extra[key] = unquote(results.qsd[key]?.trim())
    }
    extra.includeImage = parseBool(results.qsd.image ?? true)
    extra.call = parseBool(results.qsd.call ?? false)
    return results
  }
}

registerPlugin(['bark', 'barks'], NotifyBark as unknown as PluginConstructor)
