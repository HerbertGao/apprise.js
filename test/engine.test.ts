// SPDX-License-Identifier: BSD-2-Clause
// Engine tests (core-foundation, group C — tasks 3.2/3.4/3.6/3.7).
// Covers the registry (scheme resolution, runtime register, unknown scheme,
// native-URL scan), the Apprise orchestrator (aggregation, concurrency,
// empty-target / empty-content / invalid-type guards), and the
// attachment_support runtime gate. Behaviour mirrors upstream apprise.py /
// plugins/base.py @ v1.12.0.

import { describe, expect, test } from 'vitest'
import { AppriseAttachment } from '../src/attachment/base.js'
import { AttachMemory } from '../src/attachment/memory.js'
import { NotifyType } from '../src/common.js'
import { Apprise } from '../src/core/apprise.js'
import { NotifyBase, type SendOptions } from '../src/core/notify-base.js'
import {
  type PluginConstructor,
  registerPlugin,
  resolvePlugin,
} from '../src/registry.js'

interface SentCall {
  body: string
  title: string
  notifyType: NotifyType
  attach: AppriseAttachment | null
}

/** Records every send() and reports a configurable outcome. */
class RecordingPlugin extends NotifyBase {
  static override attachmentSupport = true
  readonly calls: SentCall[] = []
  behavior: 'ok' | 'fail' | 'throw' = 'ok'

  override async send(
    body: string,
    title = '',
    notifyType: NotifyType = NotifyType.INFO,
    options: SendOptions = {},
  ): Promise<boolean> {
    this.calls.push({ body, title, notifyType, attach: options.attach ?? null })
    if (this.behavior === 'throw') {
      throw new Error('boom')
    }
    return this.behavior === 'ok'
  }
}

/** attachment_support stays at the NotifyBase default of false. */
class NoAttachPlugin extends NotifyBase {
  readonly calls: SentCall[] = []
  override async send(
    body: string,
    title = '',
    notifyType: NotifyType = NotifyType.INFO,
    options: SendOptions = {},
  ): Promise<boolean> {
    this.calls.push({ body, title, notifyType, attach: options.attach ?? null })
    return true
  }
}

/** Recognises a `gizmo://host/hook` NATIVE URL (unregistered scheme). */
class NativePlugin extends NotifyBase {
  static override attachmentSupport = true
  override async send(): Promise<boolean> {
    return true
  }
  static override parseNativeUrl(url: string): Record<string, unknown> | null {
    const match = /^gizmo:\/\/([^/]+)\/hook$/.exec(url)
    if (!match) {
      return null
    }
    return NativePlugin.parseUrl(`nativep://${match[1]}`) as unknown as Record<
      string,
      unknown
    > | null
  }
}

const rec = RecordingPlugin as unknown as PluginConstructor
const native = NativePlugin as unknown as PluginConstructor

function pushServer(
  app: Apprise,
  behavior: RecordingPlugin['behavior'],
): RecordingPlugin {
  const server = new RecordingPlugin({ schema: 'rec', host: 'h' })
  server.behavior = behavior
  app.servers.push(server)
  return server
}

describe('registry (task 3.2)', () => {
  test('registers all schemes (protocol + secure_protocol + aliases)', () => {
    registerPlugin(['recp', 'recps', 'recalias'], rec)
    expect(resolvePlugin('recp')).toBe(RecordingPlugin)
    expect(resolvePlugin('recps')).toBe(RecordingPlugin)
    expect(resolvePlugin('recalias')).toBe(RecordingPlugin)
  })

  test('scheme lookup is case-insensitive', () => {
    registerPlugin('RecUpper', rec)
    expect(resolvePlugin('recupper')).toBe(RecordingPlugin)
  })

  test('unknown scheme resolves to undefined (explicit unsupported)', () => {
    expect(resolvePlugin('doesnotexist')).toBeUndefined()
  })
})

describe('Apprise.add + instantiate (tasks 3.2/3.6)', () => {
  test('registered scheme is parsed and instantiated', () => {
    registerPlugin('addrec', rec)
    const app = new Apprise()
    expect(app.add('addrec://host/path')).toBe(true)
    expect(app.servers).toHaveLength(1)
    expect(app.servers[0]).toBeInstanceOf(RecordingPlugin)
  })

  test('unknown scheme is not registered and does not throw', () => {
    const app = new Apprise()
    expect(app.add('doesnotexist://x')).toBe(false)
    expect(app.servers).toHaveLength(0)
  })

  test('invalid host is rejected (parse failure -> not added)', () => {
    registerPlugin('badhost', rec)
    const app = new Apprise()
    // Missing a valid host -> URLBase.parseUrl returns null.
    expect(app.add('badhost://')).toBe(false)
    expect(app.servers).toHaveLength(0)
  })

  test('native URL is recognised via parseNativeUrl scan', () => {
    registerPlugin('nativep', native)
    const app = new Apprise()
    expect(app.add('gizmo://myhost/hook')).toBe(true)
    expect(app.servers[0]).toBeInstanceOf(NativePlugin)
  })

  test('base parseNativeUrl is a no-op returning null', () => {
    expect(NotifyBase.parseNativeUrl('whatever://x')).toBeNull()
  })
})

describe('Apprise.notify aggregation + concurrency (tasks 3.4/3.7)', () => {
  test('all targets succeed -> true', async () => {
    const app = new Apprise()
    const a = pushServer(app, 'ok')
    const b = pushServer(app, 'ok')
    expect(await app.notify({ body: 'hello' })).toBe(true)
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
    expect(a.calls[0]?.body).toBe('hello')
  })

  test('one failure -> false, others still attempted', async () => {
    const app = new Apprise()
    const a = pushServer(app, 'ok')
    const b = pushServer(app, 'fail')
    const c = pushServer(app, 'ok')
    expect(await app.notify({ body: 'hi' })).toBe(false)
    // Every target was still tried (no early interruption).
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
    expect(c.calls).toHaveLength(1)
  })

  test('a thrown send -> false, others still attempted', async () => {
    const app = new Apprise()
    const a = pushServer(app, 'ok')
    const b = pushServer(app, 'throw')
    const c = pushServer(app, 'ok')
    expect(await app.notify({ body: 'hi' })).toBe(false)
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
    expect(c.calls).toHaveLength(1)
  })

  test('no targets -> false (upstream len==0)', async () => {
    const app = new Apprise()
    expect(await app.notify({ body: 'hi' })).toBe(false)
  })

  test('empty content -> false, no send performed', async () => {
    const app = new Apprise()
    const a = pushServer(app, 'ok')
    expect(await app.notify({ body: '', title: '' })).toBe(false)
    expect(a.calls).toHaveLength(0)
  })

  test('whitespace-only body passes the guard and sends rstripped ""', async () => {
    const app = new Apprise()
    const a = pushServer(app, 'ok')
    expect(await app.notify({ body: ' ' })).toBe(true)
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0]?.body).toBe('')
  })

  test('invalid notify type -> false, no send performed', async () => {
    const app = new Apprise()
    const a = pushServer(app, 'ok')
    expect(await app.notify({ body: 'hi', type: 'bogus' as NotifyType })).toBe(
      false,
    )
    expect(a.calls).toHaveLength(0)
  })
})

describe('attachment_support gate (task 3.7 guardrail)', () => {
  const attach = (): AppriseAttachment =>
    new AppriseAttachment(new AttachMemory({ content: 'x', name: 'a.txt' }))

  test('attachment-only call is skipped when attachment_support=false', async () => {
    const plugin = new NoAttachPlugin({ schema: 'x', host: 'h' })
    expect(await plugin.notify({ attach: attach() })).toBe(false)
    expect(plugin.calls).toHaveLength(0)
  })

  test('attachment-only call reaches send when attachment_support=true', async () => {
    const plugin = new RecordingPlugin({ schema: 'x', host: 'h' })
    const container = attach()
    expect(await plugin.notify({ attach: container })).toBe(true)
    expect(plugin.calls).toHaveLength(1)
    expect(plugin.calls[0]?.attach).toBe(container)
    expect(plugin.calls[0]?.body).toBe('')
  })
})

describe('Apprise.register runtime custom handler (task 3.2)', () => {
  test('registered handler is invoked on notify', async () => {
    let seenBody = ''
    Apprise.register('customx', (ctx) => {
      seenBody = ctx.body
      return true
    })
    const app = new Apprise()
    expect(app.add('customx://host')).toBe(true)
    expect(await app.notify({ body: 'ping' })).toBe(true)
    expect(seenBody).toBe('ping')
  })

  test('handler returning false makes notify false', async () => {
    Apprise.register('customfail', () => false)
    const app = new Apprise()
    app.add('customfail://host')
    expect(await app.notify({ body: 'ping' })).toBe(false)
  })
})

describe('url() emits format + overflow (task 3.1 / url-contract)', () => {
  test('a default instance still serialises format and overflow', () => {
    const plugin = new RecordingPlugin({ schema: 'json', host: 'h' })
    const params = plugin.urlParameters()
    expect(params.format).toBe('text')
    expect(params.overflow).toBe('upstream')
    // url() carries them even though they are defaults.
    expect(plugin.url()).toContain('format=text')
    expect(plugin.url()).toContain('overflow=upstream')
  })
})
