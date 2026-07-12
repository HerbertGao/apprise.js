// SPDX-License-Identifier: BSD-2-Clause
// Overflow tests (core-foundation, group C — tasks 3.5/3.7).
// Boundaries are hand-traced against upstream NotifyBase._apply_overflow +
// smart_split @ v1.12.0. The golden split/truncate fixtures (group E/F) cover
// the fuller matrix; these lock the core algorithm.

import { describe, expect, test } from 'vitest'
import { NotifyType, OverflowMode } from '../src/common.js'
import { NotifyBase, type SendOptions } from '../src/core/notify-base.js'

/** body_maxlen shrunk to 10 so overflow is easy to trigger; title stays 250. */
class SizedPlugin extends NotifyBase {
  static override bodyMaxlen = 10
  static override attachmentSupport = true
  readonly sent: Array<{ body: string; title: string }> = []

  override async send(
    body: string,
    title = '',
    _notifyType: NotifyType = NotifyType.INFO,
    _options: SendOptions = {},
  ): Promise<boolean> {
    this.sent.push({ body, title })
    return true
  }
}

function make(): SizedPlugin {
  return new SizedPlugin({ schema: 'x', host: 'h' })
}

describe('overflow UPSTREAM (default, no split)', () => {
  test('body is delivered untouched except for tidy rstrip', async () => {
    const plugin = make()
    // 16 chars > body_maxlen but UPSTREAM never splits/truncates.
    await plugin.notify({ body: 'abcdefghijklmnop  ' })
    expect(plugin.sent).toEqual([{ body: 'abcdefghijklmnop', title: '' }])
  })
})

describe('overflow TRUNCATE', () => {
  test('over-long body is hard-truncated to body_maxlen, single chunk', async () => {
    const plugin = make()
    await plugin.notify({
      body: 'abcdefghijklmnop',
      overflow: OverflowMode.TRUNCATE,
    })
    expect(plugin.sent).toEqual([{ body: 'abcdefghij', title: '' }])
  })

  test('a body that fits is not modified', async () => {
    const plugin = make()
    await plugin.notify({ body: 'short', overflow: OverflowMode.TRUNCATE })
    expect(plugin.sent).toEqual([{ body: 'short', title: '' }])
  })
})

describe('overflow SPLIT (smart_split natural boundaries)', () => {
  test('splits on the space boundary, not by length division', async () => {
    const plugin = make()
    // 19 chars; smart_split breaks after "aaaa bbbb " (last space in window).
    await plugin.notify({
      body: 'aaaa bbbb cccc dddd',
      overflow: OverflowMode.SPLIT,
    })
    expect(plugin.sent).toEqual([
      { body: 'aaaa bbbb', title: '' },
      { body: 'cccc dddd', title: '' },
    ])
  })

  test('with a title, each chunk repeats the title plus a [i/n] counter', async () => {
    const plugin = make()
    await plugin.notify({
      body: 'aaaa bbbb cccc dddd',
      title: 'T',
      overflow: OverflowMode.SPLIT,
    })
    expect(plugin.sent).toEqual([
      { body: 'aaaa bbbb', title: 'T [1/2]' },
      { body: 'cccc dddd', title: 'T [2/2]' },
    ])
  })
})
