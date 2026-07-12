// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/matrix/base.py store).
//
// In-memory persistent-store STUB for stateful plugins (matrix / telegram). It
// holds the per-notify state upstream keeps in `self.store` — access_token /
// home_server / device_id / user_id caches, the matrix `transaction_id` counter,
// telegram `bot_owner` — for a SINGLE notify lifecycle only. Cross-call on-disk
// persistence is deferred (upstream `persistent_store`); this stub is pure
// in-memory (no-op persistence).
//
// txnId semantics (faithful to upstream matrix base.py):
//   * login mode:  store-driven incrementing counter (0,1,2…). The plugin reads
//     the start via get("transaction_id", 0) and set()s +1 after each send
//     (base.py:544-546, 1076-1082). This stub only supplies the get/set
//     primitive; the plugin drives the increment.
//   * raw-token mode: one fixed uuid4 reused for every send, never incremented
//     (base.py:837-839, 1076). transactionUuid() supplies it.
//
// Determinism seam (mirrors transport.ts `setTransport`): the golden-diff suite
// pins the counter start (`txn`) and the raw-token uuid (`uuid`) via
// setStoreSeeds() BEFORE the plugin is constructed; the store reads them at
// construction. clearStoreSeeds() restores real behaviour.

/** Test-only seeds pinning txnId determinism (see setStoreSeeds). */
interface StoreSeeds {
  /** Counter start for the login-mode `transaction_id` (default 0). */
  txn?: number
  /** Fixed uuid reused by raw-token mode (default: a real crypto uuid). */
  uuid?: string
}

let seeds: StoreSeeds = {}

/**
 * Pin the txnId counter start and raw-token uuid for deterministic golden
 * capture/replay. Call before constructing the plugin (the store reads seeds at
 * construction). Test-only, analogous to {@link setTransport}.
 */
export function setStoreSeeds(s: StoreSeeds): void {
  seeds = { ...s }
}

/** Clear any pinned store seeds, restoring real (random-uuid) behaviour. */
export function clearStoreSeeds(): void {
  seeds = {}
}

/**
 * A single-notify-lifecycle in-memory key/value store. Minimal surface used by
 * matrix/telegram: {@link get} / {@link set}, plus {@link transactionUuid} for
 * the raw-token txnId. Not part of the public package surface — imported by
 * plugins and the golden suite via relative paths only.
 */
export class PersistentStoreStub {
  readonly #data = new Map<string, unknown>()
  readonly #uuid?: string

  constructor() {
    // Seed the login-mode counter start so get("transaction_id", 0) returns it.
    if (seeds.txn !== undefined) {
      this.#data.set('transaction_id', seeds.txn)
    }
    this.#uuid = seeds.uuid
  }

  /** Return the stored value for `key`, or `dflt` when unset. */
  get<T>(key: string, dflt: T): T {
    return this.#data.has(key) ? (this.#data.get(key) as T) : dflt
  }

  /** Store `value` under `key` (in-memory; no cross-call persistence). */
  set(key: string, value: unknown): void {
    this.#data.set(key, value)
  }

  /**
   * The raw-token-mode transaction id: a fixed uuid reused for every send
   * (upstream `transaction_id = uuid.uuid4()`, base.py:839). Pinned by
   * setStoreSeeds({uuid}); otherwise a real random uuid.
   */
  transactionUuid(): string {
    return this.#uuid ?? crypto.randomUUID()
  }
}
