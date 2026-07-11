// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0.

// ponytail: placeholder entry — the real Apprise engine lands in the
// `core-foundation` OpenSpec change. Kept minimal so the toolchain (tsup /
// vitest / tsc / biome) is proven green before any engine code exists.

/** Upstream apprise version this translation targets. */
export const UPSTREAM_VERSION = '1.12.0'
