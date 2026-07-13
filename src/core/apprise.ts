// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/apprise.py).
//
// Apprise is the notification orchestrator: add() parses/instantiates target
// plugins, notify() converts the body per target and delivers concurrently
// (Promise.allSettled), AND-folding into a single boolean, and the static
// register() binds a custom handler to a scheme at runtime (upstream @notify).

import { AppriseAsset } from '../asset.js'
import { AppriseAttachment, type AttachmentInput } from '../attachment/base.js'
import { NOTIFY_TYPES, type NotifyFormat, NotifyType } from '../common.js'
import { convertBetween } from '../conversion.js'
import {
  type PluginConstructor,
  registeredConstructors,
  registerPlugin,
  resolvePlugin,
} from '../registry.js'
import type { NotifyBase } from './notify-base.js'
import { NotifyBase as NotifyBaseClass } from './notify-base.js'
import type { Transport } from './transport.js'

/** Options accepted by {@link Apprise.notify}. */
export interface NotifyOptions {
  title?: string
  body?: string
  /** Notification type (info/success/warning/failure). */
  type?: NotifyType
  /** Source format of `body` (upstream `body_format`), NOT the target format. */
  bodyFormat?: NotifyFormat
  /** One or more attachments to deliver alongside the message. */
  attach?: AttachmentInput | null
}

/** Context passed to a runtime custom handler (see {@link Apprise.register}). */
export interface CustomHandlerContext {
  body: string
  title: string
  notifyType: NotifyType
  /** Parsed URL details (schema/host/user + the serialised url()). */
  meta: Record<string, unknown>
}

/**
 * A runtime custom notification handler bound to a scheme via
 * {@link Apprise.register}. Returning `false` marks the delivery as failed;
 * any other value (including `undefined`) is treated as success.
 */
export type CustomHandler = (
  context: CustomHandlerContext,
) => boolean | undefined | Promise<boolean | undefined>

// Lightweight scheme grab (upstream GET_SCHEMA_RE, parse.py:61).
const SCHEME_RE = /^\s*([a-z0-9]{1,32}):\/\//i

/** Statics a plugin constructor may expose for URL parsing. */
interface PluginStatics {
  parseUrl?: (url: string) => Record<string, unknown> | null
  parseNativeUrl?: (url: string) => Record<string, unknown> | null
}

function pluginParseUrl(
  ctor: PluginConstructor,
  url: string,
): Record<string, unknown> | null {
  const fn = (ctor as unknown as PluginStatics).parseUrl
  return typeof fn === 'function' ? fn.call(ctor, url) : null
}

function pluginParseNativeUrl(
  ctor: PluginConstructor,
  url: string,
): Record<string, unknown> | null {
  const fn = (ctor as unknown as PluginStatics).parseNativeUrl
  return typeof fn === 'function' ? fn.call(ctor, url) : null
}

/** Coerce a notify type to a valid enum value, or `null` when invalid. */
function normalizeType(type: NotifyType | string): NotifyType | null {
  const value = String(type).toLowerCase()
  return NOTIFY_TYPES.has(value) ? (value as NotifyType) : null
}

export class Apprise {
  /** Loaded notification targets. */
  readonly servers: NotifyBase[] = []
  /** Presentation asset applied to every target added. */
  asset: AppriseAsset
  /**
   * HTTP transport applied to every target added (see {@link Transport}). Scoped
   * to THIS instance, so two Apprise objects in one process can use different
   * transports (a proxy, an undici Agent with split connect/read timeouts, a
   * recorder) without interfering.
   */
  transport?: Transport

  constructor(options: { asset?: AppriseAsset; transport?: Transport } = {}) {
    this.asset = options.asset ?? new AppriseAsset()
    this.transport = options.transport
  }

  /**
   * Add one or more apprise URLs as notification targets. Returns `true` only
   * when every URL was instantiated successfully; an unparseable / unknown URL
   * is skipped (not registered) and yields `false` without throwing.
   */
  add(input: string | readonly string[]): boolean {
    const urls = typeof input === 'string' ? [input] : input
    let status = true
    for (const url of urls) {
      const instance = this.instantiate(url)
      if (instance) {
        this.servers.push(instance)
      } else {
        status = false
      }
    }
    return status
  }

  /** Empty the target list. */
  clear(): void {
    this.servers.length = 0
  }

  /**
   * Resolve an apprise (or native) URL to a plugin instance, or `null` on
   * failure. Mirrors upstream `url_to_dict` + `instantiate`: scheme-based
   * lookup first, then a scan of plugins that implement `parseNativeUrl`.
   */
  private instantiate(url: string): NotifyBase | null {
    // Swap a literal hash tag for its encoded form (upstream url_to_dict).
    const normalized = url.replace('/#', '/%23')

    const match = SCHEME_RE.exec(normalized)
    if (!match) {
      return null
    }
    const scheme = (match[1] as string).toLowerCase()

    let ctor = resolvePlugin(scheme)
    let args: Record<string, unknown> | null = null

    if (ctor) {
      args = pluginParseUrl(ctor, normalized)
      if (!args) {
        return null
      }
    } else {
      // Unknown scheme: give native-URL plugins a chance to claim it.
      for (const candidate of registeredConstructors()) {
        const parsed = pluginParseNativeUrl(candidate, normalized)
        if (parsed) {
          ctor = candidate
          args = parsed
          break
        }
      }
      if (!ctor || !args) {
        return null
      }
    }

    try {
      return new ctor({ ...args, asset: this.asset, transport: this.transport })
    } catch {
      return null
    }
  }

  /**
   * Deliver a notification to every loaded target, concurrently. Resolves to
   * `true` only when every target succeeds; any failure or thrown error yields
   * `false` (AND aggregation) without interrupting the other targets.
   *
   * Guards (all before any request is made): no targets -> `false`; empty
   * content (no title, body, or attachment) -> `false`; an invalid `type` ->
   * `false` (upstream apprise.py:941-963).
   */
  async notify(options: NotifyOptions): Promise<boolean> {
    const title = options.title ?? ''
    const body = options.body ?? ''

    // No targets (upstream len==0 -> TypeError -> False).
    if (this.servers.length === 0) {
      return false
    }

    // Build the attachment container up front (no HTTP is performed here).
    let attach: AppriseAttachment | null = null
    if (options.attach != null) {
      try {
        attach =
          options.attach instanceof AppriseAttachment
            ? options.attach
            : new AppriseAttachment(options.attach)
      } catch {
        return false
      }
    }
    const attachValid = attach?.valid ?? false

    // Empty-content guard: only the leading all-empty case (upstream
    // apprise.py:947-950). A whitespace-only body is truthy and passes through.
    if (!title && !body && !attachValid) {
      return false
    }

    // Invalid type -> False, no request (upstream apprise.py:952-963).
    const notifyType = normalizeType(options.type ?? NotifyType.INFO)
    if (notifyType === null) {
      return false
    }

    // Source body format (upstream body_format; asset default when unset).
    const bodyFormat = options.bodyFormat ?? this.asset.bodyFormat ?? undefined

    const outcomes = await Promise.allSettled(
      this.servers.map((server) => {
        const targetFormat = server.notifyFormat
        const convertedBody =
          bodyFormat != null && bodyFormat !== targetFormat
            ? convertBetween(bodyFormat, targetFormat, body)
            : body
        // The title is only converted when it will be blended into the body
        // (title_maxlen <= 0), matching upstream conversion_title_map logic.
        const convertedTitle =
          title && bodyFormat != null && server.titleMaxlen <= 0
            ? convertBetween(bodyFormat, targetFormat, title)
            : title
        return server.notify({
          body: convertedBody,
          title: convertedTitle,
          notifyType,
          attach,
          bodyFormat,
        })
      }),
    )

    return outcomes.every(
      (outcome) => outcome.status === 'fulfilled' && outcome.value === true,
    )
  }

  /**
   * Bind a custom handler to one or more schemes at runtime, replacing
   * upstream's `@notify` decorator. After registration the scheme(s) can be
   * `add()`ed and `notify()` will invoke the handler.
   */
  static register(
    scheme: string | readonly string[],
    handler: CustomHandler,
  ): void {
    class CustomNotifyPlugin extends NotifyBaseClass {
      override async send(
        body: string,
        title = '',
        notifyType: NotifyType = NotifyType.INFO,
      ): Promise<boolean> {
        const result = await handler({
          body,
          title,
          notifyType,
          meta: {
            schema: this.schema,
            host: this.host,
            user: this.user,
            url: this.url(),
          },
        })
        return result !== false
      }
    }

    registerPlugin(scheme, CustomNotifyPlugin as unknown as PluginConstructor)
  }
}
