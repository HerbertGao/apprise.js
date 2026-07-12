// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/attachment/memory.py).

import { randomUUID } from 'node:crypto'
import { AttachBase } from './base.js'

/** Options for constructing an in-memory attachment. */
export interface AttachMemoryOptions {
  /** String (encoded via `encoding`) or raw bytes. */
  content?: string | Buffer | Uint8Array | null
  /** Forced filename; auto-generated when omitted. */
  name?: string | null
  /** Forced MIME type; heuristically defaulted when omitted. */
  mimetype?: string | null
  /** Text encoding used for string content (default utf-8). */
  encoding?: BufferEncoding
}

/** In-memory-bytes attachment (upstream `AttachMemory`). */
export class AttachMemory extends AttachBase {
  private readonly data: Buffer

  constructor(options: AttachMemoryOptions = {}) {
    const { content = null, encoding = 'utf-8' } = options
    let name = options.name ?? null
    let mimetype = options.mimetype ?? null

    let data: Buffer
    if (content === null || content === undefined) {
      // Empty; nothing to store (upstream memory.py:65-67).
      data = Buffer.alloc(0)
    } else if (typeof content === 'string') {
      data = Buffer.from(content, encoding)
      // String heuristics (upstream memory.py:69-76).
      if (mimetype === null) {
        mimetype = 'text/plain'
      }
      if (!name) {
        name = `${randomUUID()}.txt`
      }
    } else {
      data = Buffer.from(content)
    }

    // Binary / unset defaults (upstream memory.py:87-93).
    if (mimetype === null) {
      mimetype = 'application/octet-stream'
    }
    if (!name) {
      name = `${randomUUID()}.dat`
    }

    super(name, mimetype)
    this.data = data
  }

  override exists(): boolean {
    // Accessible while it holds content (upstream memory.py exists()).
    return this.data.length > 0
  }

  protected override read(): Buffer | null {
    return this.exists() ? this.data : null
  }
}

// ponytail: no `memory://` scheme is registered — memory content cannot be
// carried in a URL, so batch-1 constructs AttachMemory directly. Register a
// backend here if URL-driven memory attachments are ever needed.
