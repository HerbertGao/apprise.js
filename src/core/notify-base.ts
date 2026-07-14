// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/base.py).
//
// NotifyBase is the base class for every notification plugin. It carries the
// overridable defaults (body_maxlen/title_maxlen/notify_format/overflow_mode/
// attachment_support), the overflow processing (UPSTREAM/TRUNCATE/SPLIT with
// smart_split), the per-plugin notify() aggregation over overflow chunks, the
// url_parameters() emission of format/overflow, and the parse_native_url hook.
// Concrete plugins (group F) override the async send() to perform the actual
// wire request.

import { AppriseAsset } from '../asset.js'
import { AppriseAttachment, type AttachmentInput } from '../attachment/base.js'
import { NotifyFormat, NotifyType, OverflowMode } from '../common.js'
import { URLBase, type UrlBaseArgs } from '../url.js'
import {
  request as moduleRequest,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from './transport.js'

// --- Python-style whitespace stripping --------------------------------------

// ponytail: Python str.strip()/rstrip() (no-arg) strips the ASCII whitespace
// set plus some Unicode whitespace. batch-1 fixtures are ASCII, so we match the
// ASCII set exactly; extend WS if a Unicode-whitespace fixture ever appears.
const WS = ' \t\n\r\x0b\x0c'

function rstripWs(s: string): string {
  let end = s.length
  while (end > 0 && WS.includes(s.charAt(end - 1))) {
    end--
  }
  return s.slice(0, end)
}

function stripWs(s: string): string {
  let start = 0
  while (start < s.length && WS.includes(s.charAt(start))) {
    start++
  }
  return rstripWs(s.slice(start))
}

/** `str.lstrip(chars)` — drop leading characters that appear in `chars`. */
function lstripChars(s: string, chars: string): string {
  let start = 0
  while (start < s.length && chars.includes(s.charAt(start))) {
    start++
  }
  return s.slice(start)
}

// --- smart_split (upstream utils/format.py) ---------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: \x0b (VT) and \x0c (FF) are part of the upstream whitespace set the split pattern must match.
const PUNCT_SPLIT_RE = /[.!?:;][ \t\r\n\x0b\x0c]+/g
const HTML_ENTITY_LOOKBACK = 16
const HTML_ENTITY_LOOKAHEAD = 16

/** `str.rfind(ch, start, end)` (returns absolute index or -1). */
function rfind(text: string, ch: string, start: number, end: number): number {
  const idx = text.slice(start, end).lastIndexOf(ch)
  return idx === -1 ? -1 : idx + start
}

/** `str.find(ch, start, end)` (returns absolute index or -1). */
function find(text: string, ch: string, start: number, end: number): number {
  const idx = text.slice(start, end).indexOf(ch)
  return idx === -1 ? -1 : idx + start
}

function lastPunctEnd(text: string, start: number, end: number): number {
  const seg = text.slice(start, end)
  const re = new RegExp(PUNCT_SPLIT_RE.source, 'g')
  let last = -1
  let m: RegExpExecArray | null = re.exec(seg)
  while (m !== null) {
    last = start + m.index + m[0].length
    m = re.exec(seg)
  }
  return last
}

/** Avoid splitting inside a short HTML entity (upstream `html_adjust`). */
function htmlAdjust(
  text: string,
  windowStart: number,
  splitAt: number,
): number {
  if (splitAt <= windowStart || splitAt > text.length) {
    return splitAt
  }
  const searchStart = Math.max(windowStart, splitAt - HTML_ENTITY_LOOKBACK)
  const ampIndex = rfind(text, '&', searchStart, splitAt)
  if (ampIndex === -1) {
    return splitAt
  }
  const forwardEnd = Math.min(text.length, splitAt + HTML_ENTITY_LOOKAHEAD)
  const semiIndex = find(text, ';', ampIndex, forwardEnd)
  if (
    semiIndex !== -1 &&
    ampIndex > windowStart &&
    ampIndex < splitAt &&
    splitAt <= semiIndex
  ) {
    return ampIndex
  }
  return splitAt
}

/** Avoid splitting a Markdown/chat link construct (upstream `markdown_adjust`). */
function markdownAdjust(
  text: string,
  windowStart: number,
  splitAt: number,
): number {
  if (splitAt <= windowStart || splitAt > text.length) {
    return splitAt
  }
  const forwardEnd = Math.min(
    text.length,
    splitAt + (splitAt - windowStart) + 1,
  )

  let linkStart = rfind(text, '[', windowStart, splitAt)
  if (linkStart === -1) {
    const bang = rfind(text, '!', windowStart, splitAt)
    if (
      bang !== -1 &&
      bang + 1 < text.length &&
      text.charAt(bang + 1) === '['
    ) {
      linkStart = bang
    }
  }
  if (linkStart !== -1) {
    const linkEnd = find(text, ')', linkStart, forwardEnd)
    if (linkEnd !== -1 && linkStart < splitAt && splitAt < linkEnd) {
      return linkStart
    }
  }

  const angleStart = rfind(text, '<', windowStart, splitAt)
  if (angleStart !== -1) {
    const pipeIdx = find(text, '|', angleStart + 1, forwardEnd)
    if (pipeIdx !== -1) {
      const angleEnd = find(text, '>', pipeIdx, forwardEnd)
      if (angleEnd !== -1 && angleStart < splitAt && splitAt <= angleEnd) {
        return angleStart
      }
    }
  }
  return splitAt
}

/**
 * Split `text` within `limit`, preferring natural boundaries (newline, then
 * space/tab, then punctuation+whitespace, then a hard limit). Faithful port of
 * upstream `smart_split`. HTML/Markdown formats additionally avoid cutting
 * entities and link constructs. Split counts are content-driven, NOT
 * `ceil(len/limit)`.
 */
function smartSplit(
  text: string,
  limit: number,
  bodyFormat: NotifyFormat | null,
): string[] {
  if (!text || limit <= 0) {
    return ['']
  }

  const result: string[] = []
  let start = 0
  const length = text.length

  while (start < length) {
    const remaining = length - start
    if (remaining <= limit) {
      result.push(text.slice(start))
      break
    }

    const windowEnd = Math.min(start + limit, length)

    // Priority 1: newline
    const lastNl = Math.max(
      rfind(text, '\n', start, windowEnd),
      rfind(text, '\r', start, windowEnd),
    )
    const splitNl = lastNl !== -1 ? lastNl + 1 : -1

    // Priority 2: space / tab
    const lastSpaceTab = Math.max(
      rfind(text, ' ', start, windowEnd),
      rfind(text, '\t', start, windowEnd),
    )
    const splitSpaceTab = lastSpaceTab !== -1 ? lastSpaceTab + 1 : -1

    // Priority 3: punctuation followed by whitespace
    const splitPunct = lastPunctEnd(text, start, windowEnd)

    let splitAt: number
    if (splitNl !== -1) {
      splitAt = splitNl
    } else if (splitSpaceTab !== -1) {
      splitAt = splitSpaceTab
    } else if (splitPunct !== -1) {
      splitAt = splitPunct
    } else {
      // Priority 4: hard split
      splitAt = windowEnd
    }

    const origSplit = splitAt
    if (bodyFormat === NotifyFormat.HTML) {
      splitAt = htmlAdjust(text, start, splitAt)
    } else if (bodyFormat === NotifyFormat.MARKDOWN) {
      splitAt = htmlAdjust(text, start, splitAt)
      splitAt = markdownAdjust(text, start, splitAt)
    }

    if (splitAt <= start) {
      splitAt = origSplit
    }

    result.push(text.slice(start, splitAt))
    start = splitAt
  }

  return result
}

// --- NotifyBase --------------------------------------------------------------

/** A single overflow chunk (a body/title pair to deliver). */
interface OverflowChunk {
  body: string
  title: string
}

/** Constructor arguments for {@link NotifyBase}, extending the URL fields. */
export interface NotifyBaseArgs extends UrlBaseArgs {
  /** Effective notify format override (`?format=`, validated). */
  format?: NotifyFormat
  /** Effective overflow override (`?overflow=`, validated). */
  overflow?: OverflowMode
  /** Presentation asset; a default is created when omitted. */
  asset?: AppriseAsset
  /**
   * Per-instance HTTP transport. When omitted, the module-level transport is
   * used. `Apprise` threads its own `transport` option into every plugin it
   * creates, so two Apprise instances in one process can carry different
   * transports without clobbering each other.
   */
  transport?: Transport
}

/** Options accepted by {@link NotifyBase.notify}. */
export interface PluginNotifyOptions {
  body?: string
  title?: string
  notifyType?: NotifyType
  /** Per-call overflow override (defaults to the instance `overflowMode`). */
  overflow?: OverflowMode
  attach?: AttachmentInput | null
  /** Source format of `body` (upstream `body_format`). */
  bodyFormat?: NotifyFormat | null
}

/** Options bag passed to {@link NotifyBase.send} (attach + source format). */
export interface SendOptions {
  attach?: AppriseAttachment | null
  bodyFormat?: NotifyFormat | null
}

/**
 * Base class for all notification plugins (upstream `NotifyBase`). Overridable
 * class-level defaults are declared `static` (mirroring Python class
 * attributes); subclasses override them with `static` re-declarations, and the
 * engine reads them via the instance getters below so a subclass override is
 * always honoured. `format`/`overflow` may additionally be overridden per
 * instance from the URL.
 */
export class NotifyBase extends URLBase {
  // Overridable defaults (upstream base.py:186/191/196/206/209/288, and the
  // SPLIT-mode knobs at base.py:406-429).
  static bodyMaxlen = 32768
  static titleMaxlen = 250
  static bodyMaxLineCount = 0
  static notifyFormat: NotifyFormat = NotifyFormat.TEXT
  static overflowMode: OverflowMode = OverflowMode.UPSTREAM
  static attachmentSupport = false
  static overflowBuffer = 0
  static overflowMaxDisplayCountWidth = 12
  static overflowDisplayCountThreshold = 130
  static overflowDisplayTitleOnce: boolean | null = null
  static overflowAmalgamateTitle = false
  static defaultHtmlTagId = 'b'

  /** Presentation asset (upstream `self.asset`). */
  asset: AppriseAsset

  // Per-instance overrides applied from the URL (`?format=` / `?overflow=`).
  #formatOverride?: NotifyFormat
  #overflowOverride?: OverflowMode
  #transport?: Transport

  constructor(args: NotifyBaseArgs = {}) {
    super(args)
    this.asset = args.asset ?? new AppriseAsset()
    if (args.format !== undefined) {
      this.#formatOverride = args.format
    }
    if (args.overflow !== undefined) {
      this.#overflowOverride = args.overflow
    }
    if (args.transport !== undefined) {
      this.#transport = args.transport
    }
  }

  /**
   * Issue a wire request. Every plugin's `send()` goes through here so that the
   * per-instance transport (when one was injected) is honoured, and so that no
   * request can ever be issued without a deadline: an unset `timeout` is filled
   * in from this instance's `?cto=` + `?rto=` (default 8000ms).
   */
  protected request(req: TransportRequest): Promise<TransportResponse> {
    const withTimeout =
      req.timeout === undefined
        ? { ...req, timeout: this.requestTimeoutMs }
        : req
    return this.#transport
      ? this.#transport(withTimeout)
      : moduleRequest(withTimeout)
  }

  /** The concrete class, used to read the static (subclass-overridable) defaults. */
  private get cls(): typeof NotifyBase {
    return this.constructor as unknown as typeof NotifyBase
  }

  get bodyMaxlen(): number {
    return this.cls.bodyMaxlen
  }
  get titleMaxlen(): number {
    return this.cls.titleMaxlen
  }
  get bodyMaxLineCount(): number {
    return this.cls.bodyMaxLineCount
  }
  get attachmentSupport(): boolean {
    return this.cls.attachmentSupport
  }
  get overflowBuffer(): number {
    return this.cls.overflowBuffer
  }
  get overflowMaxDisplayCountWidth(): number {
    return this.cls.overflowMaxDisplayCountWidth
  }
  get overflowDisplayCountThreshold(): number {
    return this.cls.overflowDisplayCountThreshold
  }
  get overflowDisplayTitleOnce(): boolean | null {
    return this.cls.overflowDisplayTitleOnce
  }
  get overflowAmalgamateTitle(): boolean {
    return this.cls.overflowAmalgamateTitle
  }
  get defaultHtmlTagId(): string {
    return this.cls.defaultHtmlTagId
  }

  /** Effective notify format (URL override, else the class default). */
  get notifyFormat(): NotifyFormat {
    return this.#formatOverride ?? this.cls.notifyFormat
  }

  /** Effective overflow mode (URL override, else the class default). */
  get overflowMode(): OverflowMode {
    return this.#overflowOverride ?? this.cls.overflowMode
  }

  /**
   * Perform notification for this single target. Applies overflow to produce
   * one or more chunks and delivers them in order via {@link send}, AND-folding
   * the per-chunk results into this target's outcome (upstream
   * `NotifyBase.notify` + `_build_send_calls`). Returns `false` (rather than
   * throwing) when the content/attachment guards reject the call.
   */
  async notify(options: PluginNotifyOptions = {}): Promise<boolean> {
    const calls = this.buildSendCalls(options)
    if (calls === null) {
      return false
    }

    // Deliver each chunk in order. A `false` return keeps going (all chunks are
    // attempted), while a thrown send rejects this whole target's promise — the
    // Apprise orchestrator's allSettled folds either into an overall `false`.
    const results: boolean[] = []
    for (const call of calls) {
      results.push(
        await this.send(call.body, call.title, call.notifyType, {
          attach: call.attach,
          bodyFormat: call.bodyFormat,
        }),
      )
    }
    return results.every(Boolean)
  }

  /**
   * Build the per-chunk send calls (upstream `_build_send_calls`). Returns
   * `null` — the TypeError-equivalent — when there is no body and no
   * attachment, or when an attachment is present but the plugin does not
   * support attachments (the attachment_support gate).
   */
  private buildSendCalls(options: PluginNotifyOptions): Array<{
    body: string
    title: string
    notifyType: NotifyType
    attach: AppriseAttachment | null
    bodyFormat: NotifyFormat | null
  }> | null {
    let body = options.body ?? ''
    let title = options.title ?? ''
    const notifyType = options.notifyType ?? NotifyType.INFO
    const bodyFormat = options.bodyFormat ?? null
    const overflow = options.overflow ?? this.overflowMode

    let attach: AppriseAttachment | null = null
    const raw = options.attach
    if (raw != null && !(raw instanceof AppriseAttachment)) {
      try {
        attach = new AppriseAttachment(raw)
      } catch {
        // Bad attachments (upstream re-raises TypeError -> notify() False).
        this.asset.diagnostic({
          level: 'error',
          kind: 'bad-attachment',
          message: 'Could not load the specified attachment(s).',
        })
        return null
      }
      body = body ? body : ''
    } else {
      attach = raw ?? null
      if (!(body || attach?.valid)) {
        // No body and no (valid) attachment.
        this.asset.diagnostic({
          level: 'error',
          kind: 'empty-content',
          message: 'No message content was specified; nothing to deliver.',
        })
        return null
      }
    }

    if (!body && !this.attachmentSupport) {
      // Attachment present but this plugin can't send attachments; skip it.
      this.asset.diagnostic({
        level: 'error',
        kind: 'unsupported-attachment',
        message:
          'Attachment(s) are not supported by this service; content was not sent.',
      })
      return null
    }

    // TRUNCATE with >1 attachment: only the first attachment passes through
    // (upstream base.py:802-807). Done once here (not per chunk).
    if (attach && attach.length > 1 && overflow === OverflowMode.TRUNCATE) {
      attach = new AppriseAttachment(attach.attachments[0] as AttachmentInput)
    }

    title = title ? title : ''
    const chunks = this.applyOverflow(body, title, overflow, bodyFormat)
    return chunks.map((chunk) => ({
      body: chunk.body,
      title: chunk.title,
      notifyType,
      attach,
      bodyFormat,
    }))
  }

  /**
   * Apply overflow handling (UPSTREAM / TRUNCATE / SPLIT) to a body/title pair.
   * Faithful port of `NotifyBase._apply_overflow` (base.py:822-1102); boundary
   * math (rstrip/slice/lstrip, smart_split, the independent title/body budgets
   * when `overflowAmalgamateTitle` is false, and the SPLIT counter suffix) is
   * kept 1:1 with upstream.
   */
  protected applyOverflow(
    bodyIn: string | null | undefined,
    titleIn: string | null | undefined,
    overflowIn?: OverflowMode,
    bodyFormatIn?: NotifyFormat | null,
  ): OverflowChunk[] {
    const response: OverflowChunk[] = []

    // Tidy
    let title = !titleIn ? '' : stripWs(titleIn)
    let body = !bodyIn ? '' : rstripWs(bodyIn)

    const overflow = overflowIn ?? this.overflowMode
    const bodyFormat = bodyFormatIn ?? this.notifyFormat

    // If the service does not support a title, amalgamate it into the body.
    if (this.titleMaxlen <= 0 && title.length > 0) {
      if (this.notifyFormat === NotifyFormat.HTML) {
        body = `<${this.defaultHtmlTagId}>${title}</${this.defaultHtmlTagId}><br />\r\n${body}`
      } else if (
        this.notifyFormat === NotifyFormat.MARKDOWN &&
        (bodyFormat === NotifyFormat.TEXT || bodyFormat === NotifyFormat.HTML)
      ) {
        title = lstripChars(title, '\r\n \t\x0b\x0c#-')
        if (title) {
          body = `# ${title}\n${body}`
        }
      } else {
        body = `${title}\r\n${body}`
      }
      title = ''
    }

    // Enforce line count
    if (this.bodyMaxLineCount > 0) {
      const lines = body.split(/\r*\n/)
      body = lines.slice(0, this.bodyMaxLineCount).join('\r\n')
    }

    // UPSTREAM mode: do not touch content further
    if (overflow === OverflowMode.UPSTREAM) {
      response.push({ body, title })
      return response
    }

    // A value of 2 allows for the \r\n applied when amalgamating.
    const overflowBuffer =
      this.titleMaxlen === 0 && title.length
        ? Math.max(2, this.overflowBuffer)
        : this.overflowBuffer

    // Handle amalgamated title/body budgets.
    const titleMaxlen = !this.overflowAmalgamateTitle
      ? this.titleMaxlen
      : Math.min(
          title.length + this.overflowMaxDisplayCountWidth,
          this.titleMaxlen,
          this.bodyMaxlen,
        )

    if (title.length > titleMaxlen) {
      title = rstripWs(title.slice(0, titleMaxlen))
    }

    let bodyMaxlen: number
    if (
      this.overflowAmalgamateTitle &&
      this.bodyMaxlen - overflowBuffer >= titleMaxlen
    ) {
      bodyMaxlen =
        (!title ? this.bodyMaxlen : this.bodyMaxlen - titleMaxlen) -
        overflowBuffer
    } else {
      bodyMaxlen = !this.overflowAmalgamateTitle
        ? this.bodyMaxlen
        : this.bodyMaxlen - overflowBuffer
    }

    // If the body fits, we are done.
    if (bodyMaxlen > 0 && body.length <= bodyMaxlen) {
      response.push({ body, title })
      return response
    }

    // TRUNCATE mode: hard truncation (no smart-splitting).
    if (overflow === OverflowMode.TRUNCATE) {
      response.push({
        body: rstripWs(lstripChars(body.slice(0, bodyMaxlen), '\r\n\x0b\x0c')),
        title,
      })
      return response
    }

    // SPLIT mode
    let overflowDisplayTitleOnce: boolean
    if (this.overflowDisplayTitleOnce === null) {
      overflowDisplayTitleOnce = Boolean(
        this.overflowAmalgamateTitle &&
          bodyMaxlen < this.overflowDisplayCountThreshold,
      )
    } else {
      overflowDisplayTitleOnce = this.overflowDisplayTitleOnce
    }

    if (
      !overflowDisplayTitleOnce &&
      !(this.overflowAmalgamateTitle && bodyMaxlen <= 0)
    ) {
      // SPLIT with repeated title (with/without counter).
      let showCounter = Boolean(
        title &&
          body.length > bodyMaxlen &&
          ((this.overflowAmalgamateTitle &&
            bodyMaxlen >= this.overflowDisplayCountThreshold) ||
            (!this.overflowAmalgamateTitle &&
              titleMaxlen > this.overflowDisplayCountThreshold)) &&
          titleMaxlen > this.overflowMaxDisplayCountWidth + overflowBuffer &&
          this.titleMaxlen >= this.overflowDisplayCountThreshold,
      )

      let effectiveBodyMaxlen = bodyMaxlen
      if (showCounter) {
        effectiveBodyMaxlen -= overflowBuffer
      }

      const chunks = smartSplit(body, effectiveBodyMaxlen, bodyFormat)
      const count = chunks.length

      let digits = 0
      if (showCounter) {
        digits = String(count).length
        const overflowDisplayCountWidth = 4 + digits * 2
        if (overflowDisplayCountWidth <= this.overflowMaxDisplayCountWidth) {
          const tMax = titleMaxlen - overflowDisplayCountWidth
          if (title.length > tMax) {
            title = title.slice(0, tMax)
          }
        } else {
          // Too many messages; fall back to a repeated title without counter.
          showCounter = false
        }
      }

      chunks.forEach((chunkBody, index) => {
        const suffix = showCounter
          ? ` [${String(index + 1).padStart(digits, '0')}/${String(count).padStart(digits, '0')}]`
          : ''
        response.push({
          body: rstripWs(lstripChars(chunkBody, '\r\n\x0b\x0c')),
          title: `${title}${suffix}`,
        })
      })

      return response
    }

    // SPLIT mode: display the title once, then continue title-less.
    let remainder = body
    if (bodyMaxlen > 0 && body) {
      const firstChunks = smartSplit(body, bodyMaxlen, bodyFormat)
      const firstBody = firstChunks.length > 0 ? (firstChunks[0] as string) : ''
      remainder = body.slice(firstBody.length)
      response.push({
        body: rstripWs(lstripChars(firstBody, '\r\n\x0b\x0c')),
        title,
      })
    } else {
      response.push({ body: '', title })
    }

    if (remainder) {
      const moreChunks = smartSplit(remainder, this.bodyMaxlen, bodyFormat)
      for (const chunkBody of moreChunks) {
        response.push({
          body: rstripWs(lstripChars(chunkBody, '\r\n\x0b\x0c')),
          title: '',
        })
      }
    }

    return response
  }

  /**
   * Perform the actual wire request. This base implementation is a skeleton:
   * concrete plugins (group F) override it to build and send their request via
   * the injectable transport seam.
   */
  send(
    _body: string,
    _title = '',
    _notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    return Promise.reject(
      new Error('send() is not implemented by the child class.'),
    )
  }

  /**
   * Provides the query parameters for {@link url}. On top of URLBase's `verify`
   * this ALWAYS emits `format` and `overflow` (upstream
   * `NotifyBase.url_parameters`, base.py:1137-1140) — even when they hold their
   * default value — so a serialised URL round-trips to an equivalent instance.
   * The upstream retry/wait/optional/store/tz parameters are out of scope for
   * batch-1 and deliberately omitted.
   */
  override urlParameters(): Record<string, string> {
    return {
      format: this.notifyFormat,
      overflow: this.overflowMode,
      ...super.urlParameters(),
    }
  }

  /**
   * Optionally recognise a service's NATIVE URL (not an apprise scheme) and
   * translate it into apprise constructor args. The base implementation is a
   * no-op returning `null` (upstream `parse_native_url`, base.py:1277-1291);
   * plugins such as apprise-api override it.
   */
  static parseNativeUrl(_url: string): Record<string, unknown> | null {
    return null
  }
}
