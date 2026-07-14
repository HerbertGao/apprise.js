// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0.
//
// The diagnostic sink is a TS-specific, per-instance injection point that
// replaces upstream's module-level `logger` (see design.md D1). Emit sites in
// the engine call `asset.diagnostic(event)` unconditionally; level filtering
// lives inside the default sink so an injected sink still receives every level.

/** Severity, mirroring upstream `logger.error/warning/info/debug` (v1.12.0). */
export type DiagnosticLevel = 'error' | 'warning' | 'info' | 'debug'

/**
 * Structured failure category, orthogonal to the human-readable message. Tests
 * assert `kind`, never message text (message text is not a stability promise).
 * `warning` is type-reserved for a later change; this batch emits only
 * `error`/`debug` (design.md D5).
 */
export type DiagnosticKind =
  | 'unsupported-url' // no scheme
  | 'unparseable-url' // scheme registered but parseUrl rejected
  | 'unregistered-scheme' // scheme not registered
  | 'plugin-error' // constructor threw
  | 'no-targets' // notify() with no targets
  | 'empty-content' // no title/body/attachment
  | 'invalid-type' // invalid NotifyType
  | 'bad-attachment' // attachment could not be constructed
  | 'unsupported-attachment' // plugin does not support attachments
  | 'unhandled-exception' // plugin threw during delivery
  | 'loaded' // successfully loaded (level=debug)

/** A per-instance diagnostic sink (upstream module-level `logger`, D1). */
export type Diagnostic = (event: {
  level: DiagnosticLevel
  kind: DiagnosticKind
  message: string
}) => void

// Line/terminal-forging characters neutralised before a message reaches the
// console (CWE-117 / CWE-150). `\p{Cc}` = all C0+C1 control chars — CR, LF, but
// also ESC (terminal escape injection), VT, FF, NEL, DEL — plus U+2028/U+2029,
// which many terminals and ECMAScript itself treat as line terminators. Masking
// only CR/LF (the obvious pair) still lets ESC-based title-spoof / screen-clear
// and Unicode line separators through. Done at the sink so it covers the whole
// composed line — service names and exception text included.
const LINE_FORGING = /[\p{Cc}\u2028\u2029]/gu

/**
 * Default sink: writes `error`/`warning` to `console`, drops `info`/`debug`
 * (mirroring Python logging's default level). Filtering happens HERE so emit
 * sites can call unconditionally and an injected sink still sees debug/info;
 * injecting a no-op silences everything.
 */
export const defaultDiagnostic: Diagnostic = ({ level, kind, message }) => {
  if (level !== 'error' && level !== 'warning') {
    return
  }
  const line = `apprise.js [${kind}]: ${message.replace(LINE_FORGING, '␤')}`
  if (level === 'error') {
    console.error(line)
  } else {
    console.warn(line)
  }
}

/**
 * Wrap a sink so a throwing consumer sink can never break the boolean /
 * `Promise<boolean>` contract of `add()` / `notify()`. The sink exists to
 * *explain* a graceful failure, not to *replace* it with an exception — so a
 * sink that throws (a logger under backpressure, a buggy callback) is swallowed
 * rather than allowed to escape the engine's failure paths.
 */
export function safeSink(sink: Diagnostic): Diagnostic {
  return (event) => {
    try {
      const result = sink(event) as unknown
      // The `(event) => void` type structurally accepts an `async` sink, whose
      // rejection would otherwise surface as an unhandledRejection later —
      // still a diagnostics-broke-control-flow breach, just deferred. Swallow it.
      if (
        result != null &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        // `Promise.resolve` assimilates ANY thenable (not just native
        // Promises, and not only ones exposing `.catch`) into a real promise
        // whose rejection we then handle here — so nothing escapes unhandled.
        void Promise.resolve(result).catch(() => {})
      }
    } catch {
      // Diagnostics must never change control flow. Intentionally swallowed.
    }
  }
}
