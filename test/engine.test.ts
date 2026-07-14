// SPDX-License-Identifier: BSD-2-Clause
// Engine tests (core-foundation, group C — tasks 3.2/3.4/3.6/3.7).
// Covers the registry (scheme resolution, runtime register, unknown scheme,
// native-URL scan), the Apprise orchestrator (aggregation, concurrency,
// empty-target / empty-content / invalid-type guards), and the
// attachment_support runtime gate. Behaviour mirrors upstream apprise.py /
// plugins/base.py @ v1.12.0.

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
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

/**
 * An Apprise whose diagnostic sink collects emitted `kind`s (plugin-diagnostics
 * task 4.2). Asserting the kind — not just the boolean — is what makes a
 * failure-path `false` falsifiable: it pins WHICH guard fired.
 */
function appWithKinds(): { app: Apprise; kinds: string[] } {
  const kinds: string[] = []
  const app = new Apprise({
    asset: new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) }),
  })
  return { app, kinds }
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
    const { app, kinds } = appWithKinds()
    expect(app.add('doesnotexist://x')).toBe(false)
    expect(app.servers).toHaveLength(0)
    expect(kinds).toContain('unregistered-scheme')
  })

  test('invalid host is rejected (parse failure -> not added)', () => {
    registerPlugin('badhost', rec)
    const { app, kinds } = appWithKinds()
    // Missing a valid host -> URLBase.parseUrl returns null.
    expect(app.add('badhost://')).toBe(false)
    expect(app.servers).toHaveLength(0)
    expect(kinds).toContain('unparseable-url')
  })

  // Upstream apprise.py:230-231 — `loggable_url = url if not secure_logging
  // else cwe312_url(url)`. Masking unconditionally would silently overrule a
  // consumer who explicitly asked to see their own URL while debugging.
  test('a failure URL honours secureLogging: masked by default, verbatim when off', () => {
    registerPlugin('seclog', rec)
    const raw = 'seclog://user:s3cret@' // no host -> parseUrl rejects

    const off: { kind: string; message: string }[] = []
    const shown = new Apprise({
      asset: new AppriseAsset({
        secureLogging: false,
        diagnostic: (e) => off.push(e),
      }),
    })
    expect(shown.add(raw)).toBe(false)
    expect(off.map((e) => e.kind)).toContain('unparseable-url')
    expect(off.some((e) => e.message.includes(raw))).toBe(true)

    const on: { kind: string; message: string }[] = []
    const secure = new Apprise({
      asset: new AppriseAsset({ diagnostic: (e) => on.push(e) }),
    })
    expect(secure.add(raw)).toBe(false)
    expect(on.map((e) => e.kind)).toContain('unparseable-url')
    expect(on.some((e) => e.message.includes('s3cret'))).toBe(false)
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
    const { app, kinds } = appWithKinds()
    const a = pushServer(app, 'ok')
    const b = pushServer(app, 'throw')
    const c = pushServer(app, 'ok')
    expect(await app.notify({ body: 'hi' })).toBe(false)
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
    expect(c.calls).toHaveLength(1)
    // The rejection is surfaced, not swallowed into a bare false.
    expect(kinds).toContain('unhandled-exception')
  })

  test('no targets -> false (upstream len==0)', async () => {
    const { app, kinds } = appWithKinds()
    expect(await app.notify({ body: 'hi' })).toBe(false)
    expect(kinds).toContain('no-targets')
  })

  test('empty content -> false, no send performed', async () => {
    const { app, kinds } = appWithKinds()
    const a = pushServer(app, 'ok')
    expect(await app.notify({ body: '', title: '' })).toBe(false)
    expect(a.calls).toHaveLength(0)
    expect(kinds).toContain('empty-content')
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

// A plugin whose constructor always throws — drives the `plugin-error` path.
class ThrowingCtorPlugin extends NotifyBase {
  constructor(_args: Record<string, unknown>) {
    super(_args as never)
    throw new Error('ctor boom')
  }
  override async send(): Promise<boolean> {
    return true
  }
}
const throwingCtor = ThrowingCtorPlugin as unknown as PluginConstructor

// A plugin whose send() rejects with a URL-bearing message — drives the
// `unhandled-exception` masking path with real secrets to hide. Carries BOTH a
// parse-REJECTED URL (tgram token in the authority) and a PARSEABLE one whose
// secret sits in a non-allowlisted query key. The parseable case is the one
// that diverges between the two maskers: `cwe312Url` would leak it (the
// per-component heuristic passes a non-allowlisted key), only the fail-closed
// masker hides it — so this input makes the test go red if the fix regresses.
class UrlThrowPlugin extends NotifyBase {
  static override attachmentSupport = true
  override async send(): Promise<boolean> {
    throw new Error(
      'delivery failed: tgram://123456789:ABCdef_ghi-jkl/12345 and ' +
        'json://api.example.com/x?password2=hunter2SECRET',
    )
  }
}

// These pin each diagnostic `kind` to the guard that emits it: without the kind
// assertion a failure-path `false` holds for every reason, so mutating the emit
// site would leave the suite green (the "hollow kind" the review-loop caught).
describe('diagnostic kind pinning + sink-contract robustness (review-loop)', () => {
  test('no scheme -> unsupported-url', () => {
    const { app, kinds } = appWithKinds()
    expect(app.add('this-has-no-scheme')).toBe(false)
    expect(kinds).toContain('unsupported-url')
  })

  test('unresolvable attachment -> bad-attachment', async () => {
    const { app, kinds } = appWithKinds()
    pushServer(app, 'ok')
    expect(await app.notify({ body: 'hi', attach: 'unsupported://x' })).toBe(
      false,
    )
    expect(kinds).toContain('bad-attachment')
  })

  test('invalid notify type -> invalid-type', async () => {
    const { app, kinds } = appWithKinds()
    pushServer(app, 'ok')
    expect(await app.notify({ body: 'hi', type: 'bogus' as NotifyType })).toBe(
      false,
    )
    expect(kinds).toContain('invalid-type')
  })

  test('a successful add emits loaded (debug; visible to an injected sink)', () => {
    registerPlugin('loadok', rec)
    const { app, kinds } = appWithKinds()
    expect(app.add('loadok://host/path')).toBe(true)
    expect(kinds).toContain('loaded')
  })

  test('a throwing sink never breaks the add()/notify() boolean contract', async () => {
    const seen: string[] = []
    const asset = new AppriseAsset({
      diagnostic: (e) => {
        seen.push(e.kind) // record that the sink ran...
        throw new Error('sink boom') // ...then blow up inside it.
      },
    })
    const app = new Apprise({ asset })
    // add() reaches the sink on an unsupported-url failure; must still be false.
    expect(app.add('this-has-no-scheme')).toBe(false)
    // notify() reaches the sink on no-targets; must still resolve, not reject.
    expect(await app.notify({ body: 'hi' })).toBe(false)
    // The sink WAS invoked on both paths and threw both times — proving the
    // swallow is what preserved the contract, not the sink being skipped.
    expect(seen).toHaveLength(2)
  })

  test('a rejection whose reason cannot be stringified does not reject notify()', async () => {
    const app = new Apprise()
    const server = new RecordingPlugin({ schema: 'rec', host: 'h' })
    server.send = async () => {
      throw {
        toString() {
          throw new Error('unstringifiable')
        },
      }
    }
    app.servers.push(server)
    expect(await app.notify({ body: 'hi' })).toBe(false)
    expect(server.calls).toHaveLength(0) // send() replaced; the throw path ran
  })

  test('plugin-error honours secureLogging (raw only when explicitly off)', () => {
    registerPlugin('throwctor', throwingCtor)
    const raw = 'throwctor://user:s3cret@host/path'

    const off: { kind: string; message: string }[] = []
    const shown = new Apprise({
      asset: new AppriseAsset({
        secureLogging: false,
        diagnostic: (e) => off.push(e),
      }),
    })
    expect(shown.add(raw)).toBe(false)
    expect(off.map((e) => e.kind)).toContain('plugin-error')
    expect(off.some((e) => e.message.includes('s3cret'))).toBe(true)

    const on: { kind: string; message: string }[] = []
    const secure = new Apprise({
      asset: new AppriseAsset({ diagnostic: (e) => on.push(e) }),
    })
    expect(secure.add(raw)).toBe(false)
    expect(on.map((e) => e.kind)).toContain('plugin-error')
    expect(on.some((e) => e.message.includes('s3cret'))).toBe(false)
  })

  test('unhandled-exception message masks a URL-borne secret (RC finding C)', async () => {
    const messages: string[] = []
    const app = new Apprise({
      asset: new AppriseAsset({ diagnostic: (e) => messages.push(e.message) }),
    })
    app.servers.push(new UrlThrowPlugin({ schema: 'rec', host: 'h' }))
    expect(await app.notify({ body: 'hi' })).toBe(false)
    const emitted = messages.join('\n')
    // Parse-rejected token collapses via fail-closed.
    expect(emitted).not.toContain('123456789:ABCdef_ghi-jkl')
    expect(emitted).toContain('tgram://1...5')
    // The DIVERGENCE guard: a secret in a non-allowlisted query key of a
    // PARSEABLE URL. `cwe312Url` leaks this verbatim; only the fail-closed
    // masker hides it — so reverting `maskUrlsInText` to `cwe312Url` reddens
    // exactly this assertion (RC round-2 finding: the old input didn't diverge).
    expect(emitted).not.toContain('hunter2SECRET')
  })
})

describe('attachment_support gate (task 3.7 guardrail)', () => {
  const attach = (): AppriseAttachment =>
    new AppriseAttachment(new AttachMemory({ content: 'x', name: 'a.txt' }))

  test('attachment-only call is skipped when attachment_support=false', async () => {
    const kinds: string[] = []
    const plugin = new NoAttachPlugin({
      schema: 'x',
      host: 'h',
      asset: new AppriseAsset({ diagnostic: (e) => kinds.push(e.kind) }),
    })
    expect(await plugin.notify({ attach: attach() })).toBe(false)
    expect(plugin.calls).toHaveLength(0)
    expect(kinds).toContain('unsupported-attachment')
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
    const received: string[] = []
    Apprise.register('customfail', (ctx) => {
      received.push(ctx.body)
      return false
    })
    const app = new Apprise()
    app.add('customfail://host')
    expect(await app.notify({ body: 'ping' })).toBe(false)
    // A genuine delivery result, not a pre-flight guard: the handler was
    // actually reached (it received the body) before returning false.
    expect(received).toEqual(['ping'])
  })
})

describe('two Apprise instances stay diagnostically isolated (task 4.5)', () => {
  // asset.test.ts covers two AppriseAssets; this covers the engine end-to-end:
  // the sink is per-instance (design.md D1, no module-level global), so a failure
  // driven through one Apprise reaches only that instance's sink.
  test('each instance routes diagnostics only to its own sink', async () => {
    const a = appWithKinds()
    const b = appWithKinds()
    expect(a.app.add('doesnotexist://x')).toBe(false)
    expect(await b.app.notify({ body: 'hi' })).toBe(false)
    // No cross-talk: a saw only its add failure, b only its notify failure.
    expect(a.kinds).toEqual(['unregistered-scheme'])
    expect(b.kinds).toEqual(['no-targets'])
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
