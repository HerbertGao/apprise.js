// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/common.py).
//
// The string VALUES of these enums are part of the public contract (they
// appear in URL query parameters and the notify() API), so they are kept
// byte-for-byte identical to the upstream Python `Enum` definitions and MUST
// NOT be rewritten to camelCase.

/**
 * Notification type — mirrors upstream `common.py:NotifyType` (39-42).
 */
export enum NotifyType {
  INFO = 'info',
  SUCCESS = 'success',
  WARNING = 'warning',
  FAILURE = 'failure',
}

/** All valid {@link NotifyType} string values (upstream `NOTIFY_TYPES`). */
export const NOTIFY_TYPES: ReadonlySet<string> = new Set(
  Object.values(NotifyType),
)

/**
 * Pre-defined image sizes — mirrors upstream `common.py:NotifyImageSize`.
 */
export enum NotifyImageSize {
  XY_32 = '32x32',
  XY_72 = '72x72',
  XY_128 = '128x128',
  XY_256 = '256x256',
}

/** All valid {@link NotifyImageSize} values (upstream `NOTIFY_IMAGE_SIZES`). */
export const NOTIFY_IMAGE_SIZES: ReadonlySet<string> = new Set(
  Object.values(NotifyImageSize),
)

/**
 * Message body format — mirrors upstream `common.py:NotifyFormat` (69-71).
 */
export enum NotifyFormat {
  TEXT = 'text',
  HTML = 'html',
  MARKDOWN = 'markdown',
}

/** All valid {@link NotifyFormat} string values (upstream `NOTIFY_FORMATS`). */
export const NOTIFY_FORMATS: ReadonlySet<string> = new Set(
  Object.values(NotifyFormat),
)

/**
 * Overflow handling mode — mirrors upstream `common.py:OverflowMode` (85-93).
 */
export enum OverflowMode {
  /** Send content untouched; let the upstream server decide. */
  UPSTREAM = 'upstream',
  /** Truncate content that exceeds the maximum message size. */
  TRUNCATE = 'truncate',
  /** Split the content into multiple smaller messages. */
  SPLIT = 'split',
}

/** All valid {@link OverflowMode} string values (upstream `OVERFLOW_MODES`). */
export const OVERFLOW_MODES: ReadonlySet<string> = new Set(
  Object.values(OverflowMode),
)

/**
 * Reserved tag automatically assigned to every notification plugin
 * (upstream `common.py:MATCH_ALL_TAG`). Kept for contract parity; tag
 * filtering itself is a later milestone.
 */
export const MATCH_ALL_TAG = 'all'

/** Reserved "always match" tag (upstream `common.py:MATCH_ALWAYS_TAG`). */
export const MATCH_ALWAYS_TAG = 'always'
