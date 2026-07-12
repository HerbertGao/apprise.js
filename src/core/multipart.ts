// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (urllib3.filepost.choose_boundary).
//
// The single multipart-boundary seam shared by every plugin that hand-assembles
// a multipart/form-data body (discord/telegram/slack). Production uses a fresh
// 32-hex boundary (urllib3 `choose_boundary` = hexlify(urandom(16))); the golden
// suite pins it via setMultipartBoundarySeed so the captured/replayed body is
// byte-reproducible. Mirrors transport.ts `setTransport`. Internal — NOT exported
// from src/index.ts.

import { randomBytes } from 'node:crypto'

let seed: string | null = null

/** Pin the multipart boundary for deterministic golden capture/replay (test-only). */
export function setMultipartBoundarySeed(b: string | null): void {
  seed = b
}

/** A multipart boundary: the pinned seed, else a fresh 32-hex (urllib3 choose_boundary parity). */
export function chooseBoundary(): string {
  return seed ?? randomBytes(16).toString('hex')
}
