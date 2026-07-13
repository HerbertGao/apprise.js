// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0
//   (apprise/attachment/base.py + apprise/apprise_attachment.py).

/** Fallback MIME type when none can be determined (upstream `unknown_mimetype`). */
export const UNKNOWN_MIMETYPE = 'application/octet-stream'

// Fixed extension -> MIME map. Upstream uses Python `mimetypes.guess_type`,
// whose result depends on the host registry; this table pins the common
// results so inference is deterministic and does not rely on a runtime MIME
// library. Extensions not listed fall back to UNKNOWN_MIMETYPE (best-effort);
// the golden-differential suite pins exact values against Python for any
// extension a fixture actually exercises.
const MIME_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  xml: 'text/xml',
  json: 'application/json',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/vnd.microsoft.icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp3: 'audio/mpeg',
  wav: 'audio/x-wav',
  mp4: 'video/mp4',
  doc: 'application/msword',
}

/** Guess a MIME type from a filename's extension (upstream `guess_type`). */
export function guessMimetype(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot < 0) {
    return null
  }
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * Base class for individual attachment backends (upstream `AttachBase`).
 * Concrete backends supply raw bytes via {@link read} and accessibility via
 * {@link exists}; the base resolves name, MIME type, size and base64.
 */
export abstract class AttachBase {
  /** Forced filename, if the caller supplied one. */
  protected forcedName: string | null
  /** Forced MIME type, if the caller supplied one. */
  protected forcedMimetype: string | null
  /** Filename detected from the source (e.g. a file's basename). */
  protected detectedName: string | null = null
  /** MIME type detected from the (forced or detected) name. */
  protected detectedMimetype: string | null = null

  protected constructor(
    name: string | null = null,
    mimetype: string | null = null,
  ) {
    this.forcedName = name
    this.forcedMimetype = mimetype
  }

  /** True when the content is accessible (upstream `exists`/`__bool__`). */
  abstract exists(): boolean

  /** Raw content bytes, or `null` when the attachment is inaccessible. */
  protected abstract read(): Buffer | null

  /** The filename (upstream `name`). */
  get name(): string | null {
    if (this.forcedName) {
      return this.forcedName
    }
    if (!this.exists()) {
      return null
    }
    return this.detectedName
  }

  /** The MIME type (upstream `mimetype`), inferred when not forced. */
  get mimetype(): string | null {
    if (!this.exists()) {
      return null
    }
    if (this.forcedMimetype) {
      return this.forcedMimetype
    }
    if (!this.detectedMimetype) {
      const source = this.forcedName ?? this.detectedName
      if (source) {
        this.detectedMimetype = guessMimetype(source)
      }
    }
    return this.detectedMimetype ?? UNKNOWN_MIMETYPE
  }

  /** Content size in bytes, or 0 when inaccessible (upstream `__len__`). */
  get size(): number {
    const bytes = this.read()
    return bytes ? bytes.length : 0
  }

  /**
   * Base64 encoding of the content (upstream `base64`). Throws when the
   * attachment is missing, matching upstream's `AppriseFileNotFound`.
   */
  base64(): string {
    const bytes = this.read()
    if (bytes === null) {
      throw new Error('Attachment Missing')
    }
    return bytes.toString('base64')
  }
}

// --- container --------------------------------------------------------------

// Backends register a factory here at module load so the container can
// instantiate string sources without a base<->backend circular import (index
// loads base.ts before file.ts, so a static `import { AttachFile }` here would
// hit the extends TDZ). Mirrors upstream's AttachmentManager indirection.
const BACKENDS = new Map<string, (url: string) => AttachBase | null>()

/** @internal Registered by a backend module at load time. */
export function registerAttachmentBackend(
  scheme: string,
  factory: (url: string) => AttachBase | null,
): void {
  BACKENDS.set(scheme, factory)
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i

/** One or more attachment sources accepted by the container. */
export type AttachmentInput =
  | string
  | AttachBase
  | AppriseAttachment
  | ReadonlyArray<string | AttachBase | AppriseAttachment>

/** Container managing one or more attachments (upstream `AppriseAttachment`). */
export class AppriseAttachment {
  readonly attachments: AttachBase[] = []

  constructor(paths?: AttachmentInput) {
    if (paths != null && !this.add(paths)) {
      throw new TypeError('One or more attachments could not be added.')
    }
  }

  /** Add one or more attachments; returns false if any could not be added. */
  add(input: AttachmentInput): boolean {
    const items = Array.isArray(input)
      ? input
      : [input as string | AttachBase | AppriseAttachment]

    let ok = true
    for (const item of items) {
      if (item instanceof AttachBase) {
        this.attachments.push(item)
      } else if (item instanceof AppriseAttachment) {
        this.attachments.push(...item.attachments)
      } else if (typeof item === 'string') {
        const instance = AppriseAttachment.instantiate(item)
        if (instance) {
          this.attachments.push(instance)
        } else {
          ok = false
        }
      } else {
        ok = false
      }
    }
    return ok
  }

  /**
   * Resolve a string source to a backend instance. A source without a scheme
   * is assumed to be a file (upstream `instantiate`). Schemes without a
   * registered backend yield `null`.
   */
  static instantiate(url: string): AttachBase | null {
    const match = SCHEME_RE.exec(url)
    // No scheme -> assume a local file path (upstream: schema = "file").
    const scheme = match?.[1]?.toLowerCase() ?? 'file'
    const factory = BACKENDS.get(scheme)
    return factory ? factory(url) : null
  }

  /** Total size of all accessible attachments (upstream `size`). */
  size(): number {
    return this.attachments.reduce(
      (total, a) => total + (a.size > 0 ? a.size : 0),
      0,
    )
  }

  /** Remove and return an attachment (default: the last). */
  pop(index = -1): AttachBase | undefined {
    const at = index < 0 ? this.attachments.length + index : index
    return this.attachments.splice(at, 1)[0]
  }

  /** Empty the attachment list (upstream `clear`). */
  clear(): void {
    this.attachments.length = 0
  }

  /** Number of attachments loaded (upstream `__len__`). */
  get length(): number {
    return this.attachments.length
  }

  /** True when at least one attachment is loaded (upstream `__bool__`). */
  get valid(): boolean {
    return this.attachments.length > 0
  }

  [Symbol.iterator](): Iterator<AttachBase> {
    return this.attachments[Symbol.iterator]()
  }
}
