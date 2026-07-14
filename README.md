# apprise.js

A faithful TypeScript translation of [caronc/apprise](https://github.com/caronc/apprise) — push notifications to many services via a single URL contract. Translation baseline: upstream **v1.12.0**.

The public contract (URL schemes, query params, enum values, main class/method names) mirrors Python Apprise 1:1; only platform-forced spots are `async`. `notify()` returns `Promise<boolean>` and delivers to all targets concurrently, aggregating to `true` only when every target succeeds.

## Install

```sh
npm i apprise.js
```

Requires Node ≥22. Ships dual ESM + CJS with type declarations.

## Usage

```ts
import { Apprise } from 'apprise.js'

const apprise = new Apprise()
apprise.add('json://user:pass@example.com/webhook') // POSTs a JSON payload
apprise.add('form://example.com/hook')              // POSTs form-urlencoded

const ok = await apprise.notify({ title: 'Hello', body: 'World' })
// ok === true only if every target succeeded (Promise<boolean>)
```

`add()` also accepts an array of URLs. `notify()` takes `{ title?, body?, type?, bodyFormat?, attach? }`; `type` is a `NotifyType` (`info`/`success`/`warning`/`failure`).

### Schemes

Importing the `apprise.js` barrel registers the four generic webhook meta-plugins:

| Scheme                       | Plugin             | Sends                         |
| ---------------------------- | ------------------ | ----------------------------- |
| `json://` / `jsons://`       | `NotifyJSON`       | JSON body                     |
| `form://` / `forms://`       | `NotifyForm`       | form-urlencoded (multipart attach deferred) |
| `xml://` / `xmls://`         | `NotifyXML`        | XML (SOAP) body               |
| `apprise://` / `apprises://` | `NotifyAppriseAPI` | Apprise API server            |

The six instant-messaging plugins are **not** in the barrel — import each from its subpath (or the `all` bucket) so bundlers can tree-shake the rest away:

| Scheme                   | Plugin             | Subpath                        | Sends                                          |
| ------------------------ | ------------------ | ------------------------------ | ---------------------------------------------- |
| `mmost://` / `mmosts://` | `NotifyMattermost` | `apprise.js/plugins/mattermost` | Mattermost incoming webhook                    |
| `discord://`             | `NotifyDiscord`    | `apprise.js/plugins/discord`   | Discord webhook (+ multipart attachments)      |
| `slack://`               | `NotifySlack`      | `apprise.js/plugins/slack`     | Slack incoming webhook or bot (Web API)        |
| `tgram://`               | `NotifyTelegram`   | `apprise.js/plugins/telegram`  | Telegram Bot API (`sendMessage` + media)       |
| `rocket://` / `rockets://` | `NotifyRocketChat` | `apprise.js/plugins/rocketchat` | Rocket.Chat (webhook / token / basic login)   |
| `matrix://` / `matrixs://` | `NotifyMatrix`     | `apprise.js/plugins/matrix`    | Matrix (t2bot webhook or direct room message)  |

To keep only what you use (tree-shakeable), import a single plugin — or the `all` bucket — from a subpath:

```ts
import { Apprise } from 'apprise.js'
import 'apprise.js/plugins/custom-json' // registers only json:// + jsons://
import 'apprise.js/plugins/discord'     // registers only discord://
import 'apprise.js/plugins/telegram'    // registers only tgram://
// or: import 'apprise.js/plugins/all'  // registers every scheme above

const apprise = new Apprise()
apprise.add('discord://webhook_id/webhook_token')
apprise.add('tgram://bot_token/12345')
const ok = await apprise.notify({ title: 'Hello', body: 'World' })
```

Runtime handlers can also be registered without a plugin class via `Apprise.register(scheme, handler)`.

> **Do not add `"sideEffects": false` to `package.json`.** Each plugin registers its scheme through a *top-level module side effect*, and the imports above are bare (no used bindings) — declaring the package side-effect-free licenses a bundler to elide them, after which the scheme never registers and `add()` returns `false` — surfacing, if a diagnostic sink is attached (see [Diagnostics](#diagnostics)), as `unregistered-scheme`. It does not reproduce under plain Node (which never tree-shakes), so `pnpm run test:bundle` runs a real bundler over a real consumer to guard the contract.
>
> **The registry is a process-wide singleton, not module state.** Node caches ESM and CJS separately, so a mixed-format graph would otherwise load it twice and a plugin would register into a table `Apprise` never reads (the dual package hazard). Pinning it to `Symbol.for('apprise.js/registry@0')` makes every load combination — including an ESM app whose transitive dep `require()`s a plugin — share one table. `pnpm run test:formats` executes the built artifact in all six combinations to guard this. The `@0` suffix keys the *shape* of the plugin constructor: change that shape and it must bump.

## Diagnostics

`add()` and `notify()` return only a boolean — `false` tells you *that* something failed, never *why*. To learn the reason, inject a diagnostic sink on the `AppriseAsset`. The sink is a single function receiving `{ level, kind, message }`, and it is **per-instance** (two `Apprise` objects with different sinks never cross-talk), so it is safe to attach one per request.

```ts
import { Apprise, AppriseAsset, type Diagnostic } from 'apprise.js'
import 'apprise.js/plugins/all'

const events: { level: string; kind: string; message: string }[] = []
const diagnostic: Diagnostic = (e) => events.push(e)

const apprise = new Apprise({ asset: new AppriseAsset({ diagnostic }) })
apprise.add('bogus://nowhere')  // false
// events → [{ level: 'error', kind: 'unregistered-scheme', message: '…' }]
```

`kind` is the stable, structured category — assert on it, never on `message` (message text is not a stability promise). Every kind and what raises it:

| `kind` | raised when |
|---|---|
| `unsupported-url` | the string has no `scheme://` at all |
| `unparseable-url` | the scheme is registered but the plugin's `parseUrl` rejected the URL |
| `unregistered-scheme` | well-formed URL, but no plugin registered that scheme (usually a missing `import 'apprise.js/plugins/…'`) |
| `plugin-error` | the plugin constructor threw (e.g. a malformed token it validates) |
| `no-targets` | `notify()` on an `Apprise` with nothing successfully added |
| `empty-content` | no title, no body, and no usable attachment |
| `invalid-type` | `notify({ type })` given a value outside `NotifyType` |
| `bad-attachment` | an attachment could not be constructed or does not exist |
| `unsupported-attachment` | the plugin has no attachment support |
| `unhandled-exception` | a plugin threw during delivery (the aggregate would otherwise swallow it) |
| `loaded` | *(not a failure)* a URL loaded successfully — `level: 'debug'` |

`level` is `'error' | 'warning' | 'info' | 'debug'`, mirroring upstream's `logger`. The **default** sink writes `error`/`warning` to `console` and drops `info`/`debug` (as Python logging's default level does); an **injected** sink receives *every* level, so filtering is yours. Injecting `() => {}` silences the library completely.

### Secure logging

When a diagnostic emits a URL, credentials in it are masked — best-effort, following upstream's CWE-312 rules, **not** a blanket guarantee (see the two boundaries below). Masking keeps the first and last character and elides the middle, so a `tgram://` bot token collapses to `tgram://1...5` — note that a *short* secret is largely revealed by its own first/last characters. Set `secureLogging: false` on the asset to see URLs in full while debugging:

```ts
new AppriseAsset({ secureLogging: false, diagnostic })
```

Two boundaries worth knowing (both faithful to upstream):

- **Query credentials are allowlist-based, not exhaustive.** Values under keys like `password` / `token` / `apikey` are always masked; a secret under a non-standard key such as `access_token` or `api_key` goes through a weaker heuristic and may not be. `secureLogging: true` does not guarantee *every* query secret is hidden.
- **`unhandled-exception` messages mask URL-shaped substrings only**, and always (not gated by `secureLogging`, since exception text carries no "show me raw" intent). A `scheme://…` run is fail-closed-masked; a bare token or a space-split URL inside the message is **not** covered.

## Dev

Requires Node ≥22 and pnpm (via `corepack enable`).

```sh
pnpm install
pnpm run build      # tsup → dist (ESM + CJS + d.ts)
pnpm test           # vitest
pnpm run typecheck  # tsc --noEmit
pnpm run lint       # biome
```

## License

BSD-2-Clause. Derived from [caronc/apprise](https://github.com/caronc/apprise) (© Chris Caron); original copyright retained. See [LICENSE](./LICENSE).
