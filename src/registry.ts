// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/manager*.py equivalent).
//
// Static scheme -> plugin map (design.md Decision 4). Each plugin module
// registers ALL of its schemes at load time — `protocol` (plain), the
// independent `secure_protocol` (TLS), and every alias — so a single
// `registerPlugin([...])` call from a plugin covers, e.g., both `json` and
// `jsons`. Unknown schemes resolve to `undefined` (an explicit "unsupported"),
// and there is no filesystem scan (unlike upstream `manager*.py`), which keeps
// per-plugin imports tree-shakeable.

import type { NotifyBase } from './core/notify-base.js'

/** Constructor signature every registered plugin exposes. */
export type PluginConstructor = new (
  args: Record<string, unknown>,
) => NotifyBase

const registry = new Map<string, PluginConstructor>()

/** Register a plugin constructor under one or more (lower-cased) schemes. */
export function registerPlugin(
  schemes: string | readonly string[],
  ctor: PluginConstructor,
): void {
  const list = typeof schemes === 'string' ? [schemes] : schemes
  for (const scheme of list) {
    registry.set(scheme.toLowerCase(), ctor)
  }
}

/** Resolve a scheme to its plugin constructor, or `undefined` if unknown. */
export function resolvePlugin(scheme: string): PluginConstructor | undefined {
  return registry.get(scheme.toLowerCase())
}

/**
 * Every distinct registered plugin constructor (de-duplicated across its
 * schemes). Used by the native-URL fallback in {@link Apprise} to scan plugins
 * that implement `parseNativeUrl`.
 */
export function registeredConstructors(): PluginConstructor[] {
  return [...new Set(registry.values())]
}
