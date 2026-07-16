// SPDX-License-Identifier: BSD-2-Clause
// Internal deterministic Pushover E2EE codec. This file is deliberately not a
// package entrypoint; tests may import its seams through the source tree only.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/plugins/pushover.py).

import { createCipheriv, createHmac, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'

type EntropySource = (size: number) => Buffer
let entropySource: EntropySource = randomBytes

export function setPushoverEntropySourceForTest(
  source: EntropySource | null,
): void {
  entropySource = source ?? randomBytes
}

/** Python 3.14 gzip.compress(data, compresslevel=9, mtime=0) bytes. */
export function python314Gzip(data: Buffer): Buffer {
  const compressed = gzipSync(data, { level: 9 })
  // Python pins mtime=0 and forces the gzip OS byte to 255. Node already emits
  // zero mtime today; write both fields explicitly to remove that dependency.
  compressed.fill(0, 4, 8)
  compressed[9] = 0xff
  return compressed
}

export function encryptPushoverField(plaintext: string, key: Buffer): string {
  const iv = entropySource(16)
  if (iv.length !== 16)
    throw new Error(`Pushover IV must be 16 bytes; got ${iv.length}`)
  const compressed = python314Gzip(Buffer.from(plaintext, 'utf8'))
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()])
  const mac = createHmac('sha256', key)
    .update(Buffer.concat([iv, ciphertext]))
    .digest()
  return Buffer.concat([iv, ciphertext, mac]).toString('base64')
}
