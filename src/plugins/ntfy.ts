// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/ntfy.py).

import { basename } from 'node:path'
import type { AppriseAttachment, AttachBase } from '../attachment/base.js'
import { AttachMemory } from '../attachment/memory.js'
import { NotifyFormat, NotifyImageSize, NotifyType } from '../common.js'
import {
  NotifyBase,
  type NotifyBaseArgs,
  type SendOptions,
} from '../core/notify-base.js'
import { type PluginConstructor, registerPlugin } from '../registry.js'
import {
  isHostname,
  type ParsedUrlResults,
  PrivacyMode,
  parseBool,
  quote,
  URLBase,
  unquote,
  urlencode,
  urlencodePlus,
} from '../url.js'

export enum NtfyMode {
  CLOUD = 'cloud',
  PRIVATE = 'private',
}

export enum NtfyAuth {
  BASIC = 'basic',
  TOKEN = 'token',
}

export enum NtfyPriority {
  MAX = 'max',
  HIGH = 'high',
  NORMAL = 'default',
  LOW = 'low',
  MIN = 'min',
}

const MODES = new Set(Object.values(NtfyMode))
const AUTH_MODES = new Set(Object.values(NtfyAuth))
const TOPIC_RE = /^[a-z0-9_-]{1,64}$/i
const TOKEN_DETECT_RE = /^tk_[^ \t]+/i
const CLOUD_HOST_RE = /ntfy\.sh/i
const LIST_SPLIT_RE = /[[\];,\s]+/
const PATH_SPLIT_RE = /[ \t\r\n,\\/]+/
const CLOUD_URL = 'https://ntfy.sh'
const PRIORITY_PREFIXES: ReadonlyArray<[string, NtfyPriority]> = [
  ['l', NtfyPriority.LOW],
  ['mo', NtfyPriority.LOW],
  ['n', NtfyPriority.NORMAL],
  ['h', NtfyPriority.HIGH],
  ['e', NtfyPriority.MAX],
  ['mi', NtfyPriority.MIN],
  ['ma', NtfyPriority.MAX],
  ['d', NtfyPriority.NORMAL],
  ['1', NtfyPriority.MIN],
  ['2', NtfyPriority.LOW],
  ['3', NtfyPriority.NORMAL],
  ['4', NtfyPriority.HIGH],
  ['5', NtfyPriority.MAX],
]

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

function resolvePriority(value: unknown): NtfyPriority {
  if (!value) return NtfyPriority.NORMAL
  const text = String(value).toLowerCase()
  return (
    PRIORITY_PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ??
    NtfyPriority.NORMAL
  )
}

/** Length of one Python ensure_ascii=True JSON string, including quotes. */
function pythonJsonStringLength(value: string): number {
  let length = 2
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x22 || code === 0x5c) length += 2
    else if ([0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code)) length += 2
    else if (code < 0x20 || code >= 0x7f) length += 6
    else length += 1
  }
  return length
}

/** Python json.dumps(mapping) character length for an ordered string mapping. */
function pythonJsonDumpsLength(payload: ReadonlyMap<string, string>): number {
  let length = 2
  let index = 0
  for (const [key, value] of payload) {
    if (index > 0) length += 2 // ", "
    length += pythonJsonStringLength(key) + 2 + pythonJsonStringLength(value)
    index += 1
  }
  return length
}

function containsNonAscii(value: string): boolean {
  return [...value].some((character) => (character.codePointAt(0) ?? 0) > 127)
}

export interface NotifyNtfyArgs extends NotifyBaseArgs {
  targets?: string[] | string | null
  remoteAttach?: string | null
  filename?: string | null
  click?: string | null
  delay?: string | null
  email?: string | null
  priority?: string | number | null
  xtags?: string[] | string | null
  actions?: string | null
  mode?: string | null
  includeImage?: boolean | string | null
  avatarUrl?: string | null
  auth?: string | null
  token?: string | null
}

interface SendOneResult {
  okay: boolean
  response: unknown
}

/** ntfy cloud/private JSON and raw-attachment notification plugin. */
export class NotifyNtfy extends NotifyBase {
  static override attachmentSupport = true
  static override titleMaxlen = 200
  static override bodyMaxlen = 7800
  static override overflowAmalgamateTitle = true

  mode: NtfyMode
  auth: NtfyAuth
  includeImage: boolean
  remoteAttach: string | null
  filename: string | null
  click: string | null
  delay: string | null
  email: string | null
  token: string | null
  priority: NtfyPriority
  tags: readonly string[]
  actions: string | null
  avatarUrl: string | null
  topics: readonly string[]

  constructor(args: NotifyNtfyArgs = {}) {
    super(args)
    const mode =
      typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase()
        : NtfyMode.PRIVATE
    if (!MODES.has(mode as NtfyMode)) {
      throw new TypeError(`An invalid ntfy Mode (${args.mode}) was specified.`)
    }
    this.mode = mode as NtfyMode

    const auth =
      typeof args.auth === 'string'
        ? args.auth.trim().toLowerCase()
        : NtfyAuth.BASIC
    if (!AUTH_MODES.has(auth as NtfyAuth)) {
      throw new TypeError(
        `An invalid ntfy Authentication type (${args.auth}) was specified.`,
      )
    }
    this.auth = auth as NtfyAuth
    this.includeImage =
      args.includeImage === undefined || args.includeImage === null
        ? true
        : parseBool(args.includeImage)
    this.remoteAttach =
      typeof args.remoteAttach === 'string' ? args.remoteAttach : null
    this.filename = typeof args.filename === 'string' ? args.filename : null
    const click = typeof args.click === 'string' ? args.click : null
    this.click =
      click && containsNonAscii(click) ? quote(click, ':/?&=[]') : click
    this.delay = typeof args.delay === 'string' ? args.delay : null
    this.email = typeof args.email === 'string' ? args.email : null
    this.token = typeof args.token === 'string' ? args.token : null
    this.priority = resolvePriority(args.priority)
    this.tags = parseList(args.xtags)
    this.actions = typeof args.actions === 'string' ? args.actions : null
    this.avatarUrl = typeof args.avatarUrl === 'string' ? args.avatarUrl : null
    this.topics = parseList(args.targets).filter((topic) =>
      TOPIC_RE.test(topic),
    )
  }

  override async send(
    body: string,
    title = '',
    notifyType: NotifyType = NotifyType.INFO,
    options: SendOptions = {},
  ): Promise<boolean> {
    if (this.topics.length === 0) return false
    const assetImage = this.asset.imageUrl(notifyType, NotifyImageSize.XY_256)
    const imageUrl =
      this.includeImage && (assetImage || this.avatarUrl)
        ? (this.avatarUrl ?? assetImage)
        : null
    const attach = options.attach as AppriseAttachment | null | undefined
    let hasError = false

    for (const topic of [...this.topics].reverse()) {
      if (attach && attach.length > 0) {
        let index = 0
        for (const attachment of attach) {
          if (!attachment.exists()) return false
          const sent = await this.sendOne(topic, {
            body: index === 0 && body ? body : null,
            title: index === 0 && title ? title : null,
            attachment,
            imageUrl,
          })
          if (!sent.okay) return false
          index += 1
        }
      } else {
        const sent = await this.sendOne(topic, { body, title, imageUrl })
        if (!sent.okay) hasError = true
      }
    }
    return !hasError
  }

  private notificationHeaders(imageUrl: string | null): Record<string, string> {
    const headers: Record<string, string> = { 'User-Agent': this.asset.appId }
    if (imageUrl) headers['X-Icon'] = imageUrl
    if (this.notifyFormat === NotifyFormat.MARKDOWN)
      headers['X-Markdown'] = 'yes'
    if (this.priority !== NtfyPriority.NORMAL)
      headers['X-Priority'] = this.priority
    if (this.delay !== null) headers['X-Delay'] = this.delay
    if (this.click !== null) headers['X-Click'] = quote(this.click, ':/?@&=#')
    if (this.email !== null) headers['X-Email'] = this.email
    if (this.tags.length > 0) headers['X-Tags'] = this.tags.join(',')
    if (this.actions) headers['X-Actions'] = this.actions
    return headers
  }

  private endpointAndAuth(headers: Record<string, string>): string | null {
    if (this.mode === NtfyMode.CLOUD) return CLOUD_URL
    if (this.auth === NtfyAuth.BASIC && this.user) {
      const password = this.password === null ? 'None' : this.password
      headers.Authorization = `Basic ${Buffer.from(`${this.user}:${password}`).toString('base64')}`
    } else if (this.auth === NtfyAuth.TOKEN) {
      if (!this.token) return null
      headers.Authorization = `Bearer ${this.token}`
    }
    const port = this.port === null ? '' : `:${this.port}`
    return `${this.secure ? 'https' : 'http'}://${this.host}${port}`
  }

  private async sendOne(
    topic: string,
    args: {
      body?: string | null
      title?: string | null
      attachment?: AttachBase
      imageUrl: string | null
    },
  ): Promise<SendOneResult> {
    const headers = this.notificationHeaders(args.imageUrl)
    const endpoint = this.endpointAndAuth(headers)
    if (!endpoint) return { okay: false, response: null }

    // requests prepares a bare origin as `origin/`; our injected transport
    // sees the plugin URL before fetch has a chance to normalize it.
    let url = args.attachment ? endpoint : `${endpoint}/`
    let wireBody: string | Buffer
    if (args.attachment) {
      const params = new Map<string, string>([
        ['filename', args.attachment.name ?? ''],
      ])
      if (args.title) params.set('title', args.title)
      if (args.body) params.set('message', args.body)
      url += `/${topic}?${urlencodePlus(params)}`
      wireBody = Buffer.from(args.attachment.base64(), 'base64')
    } else {
      headers['Content-Type'] = 'application/json'
      const payload = new Map<string, string>([['topic', topic]])
      if (this.remoteAttach) {
        payload.set('attach', this.remoteAttach)
        if (this.filename) payload.set('filename', this.filename)
      }
      if (args.title) payload.set('title', args.title)
      if (args.body) payload.set('message', args.body)

      if (pythonJsonDumpsLength(payload) > 8000) {
        const content = `${args.title ? `${args.title}\n` : ''}${args.body ?? ''}`
        const attachment = new AttachMemory({
          content,
          mimetype:
            this.notifyFormat === NotifyFormat.MARKDOWN
              ? 'text/markdown'
              : this.notifyFormat === NotifyFormat.HTML
                ? 'text/html'
                : 'text/plain',
        })
        return this.sendOne(topic, {
          body: '',
          title: '',
          attachment,
          imageUrl: args.imageUrl,
        })
      }
      wireBody = JSON.stringify(Object.fromEntries(payload))
    }

    try {
      const result = await this.request({
        method: 'POST',
        url,
        headers,
        body: wireBody,
      })
      if (result.status === 200) return { okay: true, response: null }
      const text = await result.text()
      let response: unknown = null
      try {
        response = JSON.parse(text)
      } catch {
        // Diagnostics keep the HTTP status when the server body is not JSON.
      }
      return { okay: false, response }
    } catch {
      return { okay: false, response: null }
    }
  }

  override url(privacy = false): string {
    const params: Record<string, string> = {
      priority: this.priority,
      mode: this.mode,
      image: this.includeImage ? 'yes' : 'no',
      auth: this.auth,
    }
    if (this.avatarUrl) params.avatar_url = this.avatarUrl
    if (this.remoteAttach !== null) params.attach = this.remoteAttach
    if (this.click !== null) params.click = this.click
    if (this.delay !== null) params.delay = this.delay
    if (this.email !== null) params.email = this.email
    if (this.tags.length > 0) params.xtags = this.tags.join(',')
    if (this.actions) params.actions = this.actions
    Object.assign(params, this.urlParameters())

    const topics = this.topics.map((topic) => quote(topic, '')).join('/')
    if (this.mode === NtfyMode.CLOUD) {
      return `ntfys://${topics}?${urlencode(params)}`
    }

    let auth = ''
    if (this.auth === NtfyAuth.BASIC) {
      if (this.user && this.password) {
        auth = `${quote(this.user, '')}:${URLBase.pprint(
          this.password,
          privacy,
          PrivacyMode.Secret,
          { safe: '' },
        )}@`
      } else if (this.user) auth = `${quote(this.user, '')}@`
    } else if (this.token) {
      auth = `${URLBase.pprint(this.token, privacy, PrivacyMode.Outer, {
        safe: '',
      })}@`
    }
    const defaultPort = this.secure ? 443 : 80
    const port =
      this.port === null || this.port === defaultPort ? '' : `:${this.port}`
    return `${this.secure ? 'ntfys' : 'ntfy'}://${auth}${this.host}${port}/${topics}?${urlencode(params)}`
  }

  static override parseUrl(url: string): ParsedUrlResults | null {
    const results = URLBase.parseUrl(url, { verifyHost: false })
    if (!results) return null
    const extra = results as unknown as Record<string, unknown>
    if (results.qsd.priority?.length)
      extra.priority = unquote(results.qsd.priority)
    if (results.qsd.attach?.length) {
      extra.remoteAttach = unquote(results.qsd.attach)
      if (results.qsd.filename?.length) {
        extra.filename = basename(unquote(results.qsd.filename))
      }
    }
    if (results.qsd.click?.length) extra.click = unquote(results.qsd.click)
    if (results.qsd.delay?.length) extra.delay = unquote(results.qsd.delay)
    if (results.qsd.email?.length) extra.email = unquote(results.qsd.email)
    const rawTags = results.qsd.xtags || results.qsd.tags || ''
    if (rawTags) extra.xtags = parseList(unquote(rawTags))
    if (results.qsd.actions?.length)
      extra.actions = unquote(results.qsd.actions)
    extra.includeImage = parseBool(results.qsd.image ?? true)
    if ('avatar_url' in results.qsd)
      extra.avatarUrl = unquote(results.qsd.avatar_url)

    const targets = splitPath(results.fullpath)
    if (results.qsd.to?.length) targets.push(...parseList(results.qsd.to))
    extra.targets = targets

    if (results.qsd.token?.length) {
      extra.auth = NtfyAuth.TOKEN
      extra.token = unquote(results.qsd.token)
    }
    if (results.qsd.auth?.length)
      extra.auth = unquote(results.qsd.auth).trim().toLowerCase()
    if (!extra.auth && results.user && !results.password) {
      extra.auth = TOKEN_DETECT_RE.test(results.user)
        ? NtfyAuth.TOKEN
        : NtfyAuth.BASIC
    }
    if (extra.auth === NtfyAuth.TOKEN && !extra.token) {
      if (results.user && !results.password) extra.token = unquote(results.user)
      else if (results.password) extra.token = unquote(results.password)
    }

    let mode: string
    if (results.qsd.mode?.length)
      mode = unquote(results.qsd.mode).trim().toLowerCase()
    else
      mode =
        isHostname(results.host) && targets.length > 0
          ? NtfyMode.PRIVATE
          : NtfyMode.CLOUD
    extra.mode = mode
    if (mode === NtfyMode.CLOUD) {
      if (!CLOUD_HOST_RE.test(results.host)) targets.unshift(results.host)
    } else if (mode === NtfyMode.PRIVATE && !isHostname(results.host))
      return null
    return results
  }

  static override parseNativeUrl(url: string): Record<string, unknown> | null {
    const match =
      /^(?:http|ntfy)s?:\/\/ntfy\.sh(?<topics>\/[^?]+)?(?<params>\?.+)?$/i.exec(
        url,
      )
    if (!match) return null
    const topics = match.groups?.topics ?? ''
    const params = match.groups?.params
    return NotifyNtfy.parseUrl(
      `ntfys://${topics}${params ? `${params}&mode=cloud` : '?mode=cloud'}`,
    ) as unknown as Record<string, unknown> | null
  }
}

registerPlugin(['ntfy', 'ntfys'], NotifyNtfy as unknown as PluginConstructor)
