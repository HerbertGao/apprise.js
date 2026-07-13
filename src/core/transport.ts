// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (the requests/adapters transport seam).
//
// The HTTP transport seam (design.md Decision 5). Every plugin routes its wire
// request through {@link request}; the underlying implementation is injectable
// so the golden-differential suite can intercept and record the final request
// (method/url/headers/body) instead of hitting the network, and so a future
// proxy / undici Agent can be slotted in without touching plugin code.

/** A wire request as assembled by a plugin's `send()`. */
export interface TransportRequest {
  method: string
  url: string
  /** Semantic headers the plugin sets explicitly (e.g. `User-Agent`). */
  headers?: Record<string, string>
  body?: string | Uint8Array | null
  /**
   * Total request deadline in MILLISECONDS. Filled in by `NotifyBase.request()`
   * from the plugin's `?cto=`/`?rto=` (default 8000); a custom transport is
   * free to interpret it (e.g. split it back into connect/read timeouts).
   */
  timeout?: number
}

/**
 * The structural subset of the Fetch `Response` the engine relies on. The
 * native `Response` satisfies this, and a recording transport can return any
 * object with the same shape.
 */
export interface TransportResponse {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  readonly headers: Headers
  text(): Promise<string>
}

/** An injectable transport (default wraps the global `fetch`). */
export type Transport = (
  request: TransportRequest,
) => Promise<TransportResponse>

/** Default transport: a thin wrapper over the platform's global `fetch`. */
async function nativeFetchTransport(
  req: TransportRequest,
): Promise<TransportResponse> {
  return fetch(req.url, {
    method: req.method,
    headers: req.headers,
    // ponytail: native fetch throws TypeError on a GET/HEAD carrying a body, so
    // drop it (upstream slack's files.getUploadURLExternal is a GET with an
    // ignored `{}` body — the param it needs already rides in the query string).
    body:
      req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : (req.body ?? undefined),
    // Native fetch has NO default timeout: without this a stalled server hangs
    // the notify() promise forever and leaks the socket.
    signal:
      req.timeout === undefined ? undefined : AbortSignal.timeout(req.timeout),
  })
}

let active: Transport = nativeFetchTransport

/**
 * Replace the active transport (e.g. inject a recorder in tests). Passing
 * `null` restores the default native-fetch transport.
 *
 * INTERNAL — deliberately NOT part of the public surface (`src/index.ts` does
 * not re-export it): `active` is a process global, so two consumers sharing a
 * process would clobber each other. A consumer injects a transport PER
 * INSTANCE instead: `new Apprise({ transport })`.
 */
export function setTransport(transport: Transport | null): void {
  active = transport ?? nativeFetchTransport
}

/** Issue a request through the currently active transport. */
export function request(req: TransportRequest): Promise<TransportResponse> {
  return active(req)
}
