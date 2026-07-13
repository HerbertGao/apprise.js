// SPDX-License-Identifier: BSD-2-Clause
// PersistentStoreStub unit tests (plugins-im, group A — task 1.4).
// Locks the in-memory KV primitive, the login-mode txnId counter start pin, and
// the raw-token fixed-uuid seam that make matrix/telegram deterministic.

import { afterEach, describe, expect, test } from 'vitest'
import {
  clearStoreSeeds,
  PersistentStoreStub,
  setStoreSeeds,
} from '../src/core/store.js'

afterEach(() => {
  clearStoreSeeds()
})

describe('PersistentStoreStub', () => {
  test('get returns the default for an unset key, the stored value once set', () => {
    const store = new PersistentStoreStub()
    expect(store.get('access_token', null)).toBe(null)
    store.set('access_token', 'abc')
    expect(store.get('access_token', null)).toBe('abc')
    // Falsy stored values are still returned (not confused with "unset").
    store.set('transaction_id', 0)
    expect(store.get('transaction_id', 99)).toBe(0)
  })

  test('unseeded login-mode txnId counter starts at the default 0 and increments', () => {
    const store = new PersistentStoreStub()
    let txn = store.get<number>('transaction_id', 0)
    expect(txn).toBe(0)
    // Drive the increment the way the matrix plugin will (per send).
    for (let i = 0; i < 3; i++) {
      txn += 1
      store.set('transaction_id', txn)
    }
    expect(store.get<number>('transaction_id', 0)).toBe(3)
  })

  test('setStoreSeeds pins the counter start read at construction', () => {
    setStoreSeeds({ txn: 7 })
    const store = new PersistentStoreStub()
    expect(store.get<number>('transaction_id', 0)).toBe(7)
    // clearStoreSeeds restores the default-0 behaviour for later stores.
    clearStoreSeeds()
    expect(new PersistentStoreStub().get<number>('transaction_id', 0)).toBe(0)
  })

  test('transactionUuid returns the pinned uuid when seeded, else a real uuid', () => {
    // A realizable cross-language value: Python's uuid.UUID(...) must parse it.
    setStoreSeeds({ uuid: '00000000-0000-4000-8000-000000000000' })
    expect(new PersistentStoreStub().transactionUuid()).toBe(
      '00000000-0000-4000-8000-000000000000',
    )
    clearStoreSeeds()
    const uuid = new PersistentStoreStub().transactionUuid()
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })
})
