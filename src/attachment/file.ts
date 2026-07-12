// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/attachment/file.py).

import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { AttachBase, registerAttachmentBackend } from './base.js'

/** Filesystem-backed attachment (upstream `AttachFile`). */
export class AttachFile extends AttachBase {
  private readonly filePath: string

  constructor(
    path: string,
    options: { name?: string | null; mimetype?: string | null } = {},
  ) {
    super(options.name ?? null, options.mimetype ?? null)
    this.filePath = path
  }

  override exists(): boolean {
    // Missing / non-regular files report failure rather than throwing
    // (upstream file.py download(): `not os.path.isfile` -> False).
    try {
      if (!statSync(this.filePath).isFile()) {
        return false
      }
    } catch {
      return false
    }

    if (!this.detectedName) {
      this.detectedName = basename(this.filePath)
    }
    return true
  }

  protected override read(): Buffer | null {
    if (!this.exists()) {
      return null
    }
    try {
      return readFileSync(this.filePath)
    } catch {
      return null
    }
  }
}

// Register the `file` scheme (and the no-scheme default) with the container.
registerAttachmentBackend('file', (url) => new AttachFile(fileUrlToPath(url)))

/** Strip an optional `file://` prefix and any query, decoding the path. */
function fileUrlToPath(url: string): string {
  const match = /^file:\/\/(.*)$/i.exec(url)
  if (!match) {
    return url
  }
  const raw = (match[1] ?? '').split('?', 1)[0] ?? ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
