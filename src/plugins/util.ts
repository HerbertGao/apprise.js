// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0.
//
// Helpers shared by the custom-* / apprise-api meta-plugins. Kept out of url.ts
// so that file stays a line-for-line port of parse.py + url.py.

import { unquote } from '../url.js'

/**
 * Apply {@link unquote} to a plain object's keys and values (upstream re-unquote
 * of the `+`headers map). The `Map`-typed twin for the order-sensitive
 * `-`params / `:`payload maps is {@link import('../url.js').mapUnquoteMap}.
 */
export function mapUnquote(
  src: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(src)) {
    out[unquote(k)] = unquote(v)
  }
  return out
}

/**
 * Basic-auth header value, mirroring requests `_basic_auth_str` (latin1). A
 * missing password serialises to the literal `None` (Python `str(None)`).
 */
export function basicAuth(user: string, password: string | null): string {
  const pass = password ?? 'None'
  return `Basic ${Buffer.from(`${user}:${pass}`, 'latin1').toString('base64')}`
}
