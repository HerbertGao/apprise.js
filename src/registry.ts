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

// The registry is a PROCESS-WIDE singleton, not module state. A dual-published
// package is loaded twice by any graph that mixes formats — Node keeps separate
// module caches for ESM and CJS (the dual package hazard), and a bundler may
// inline a copy per entry. Module-scoped state would give each copy its own Map:
// a plugin would register into a registry that `Apprise` never reads, `add()`
// would return false, and `notify()` would report a plain delivery failure.
//
// `@0` is a compatibility key for the SHAPE of `PluginConstructor`, not the
// package version: two copies sharing this symbol assert their constructors are
// interchangeable. Change that shape and the key MUST bump, or an older copy
// resolves schemes to constructors it cannot call.
//
// Scope is the current realm — worker_threads / vm contexts each hold their own
// symbol registry and must import plugins themselves.
const REGISTRY_KEY = Symbol.for('apprise.js/registry@0')

const globalRegistry = globalThis as unknown as Record<
  symbol,
  Map<string, PluginConstructor> | undefined
>

const registry: Map<string, PluginConstructor> =
  globalRegistry[REGISTRY_KEY] ?? new Map<string, PluginConstructor>()
globalRegistry[REGISTRY_KEY] = registry

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
