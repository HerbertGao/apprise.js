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

Service plugins are **not** in the barrel — import each from its subpath (or the `all` bucket) so bundlers can tree-shake the rest away:

| Scheme                   | Plugin             | Subpath                        | Sends                                          |
| ------------------------ | ------------------ | ------------------------------ | ---------------------------------------------- |
| `mmost://` / `mmosts://` | `NotifyMattermost` | `apprise.js/plugins/mattermost` | Mattermost incoming webhook                    |
| `discord://`             | `NotifyDiscord`    | `apprise.js/plugins/discord`   | Discord webhook (+ multipart attachments)      |
| `slack://`               | `NotifySlack`      | `apprise.js/plugins/slack`     | Slack incoming webhook or bot (Web API)        |
| `tgram://`               | `NotifyTelegram`   | `apprise.js/plugins/telegram`  | Telegram Bot API (`sendMessage` + media)       |
| `rocket://` / `rockets://` | `NotifyRocketChat` | `apprise.js/plugins/rocketchat` | Rocket.Chat (webhook / token / basic login)   |
| `matrix://` / `matrixs://` | `NotifyMatrix`     | `apprise.js/plugins/matrix`    | Matrix (t2bot webhook or direct room message)  |
| `schan://`               | `NotifyServerChan` | `apprise.js/plugins/serverchan` | ServerChan webhook                             |
| `dingtalk://`            | `NotifyDingTalk`   | `apprise.js/plugins/dingtalk`   | DingTalk custom robot                          |
| `wecombot://`            | `NotifyWeComBot`   | `apprise.js/plugins/wecombot`   | WeCom group bot                                |
| `feishu://`              | `NotifyFeishu`     | `apprise.js/plugins/feishu`     | Feishu custom bot                              |
| `lark://`                | `NotifyLark`       | `apprise.js/plugins/lark`       | Lark custom bot                                |
| `wxpusher://`            | `NotifyWxPusher`   | `apprise.js/plugins/wxpusher`   | WxPusher users/topics                          |
| `pushdeer://` / `pushdeers://` | `NotifyPushDeer` | `apprise.js/plugins/pushdeer` | PushDeer cloud or self-hosted API             |
| `pover://`               | `NotifyPushover`   | `apprise.js/plugins/pushover`   | Pushover form/E2EE and image attachments      |
| `pbul://`                | `NotifyPushBullet` | `apprise.js/plugins/pushbullet` | Pushbullet notes and uploaded attachments     |
| `ntfy://` / `ntfys://`   | `NotifyNtfy`       | `apprise.js/plugins/ntfy`       | ntfy cloud or self-hosted JSON/raw publishing |
| `gotify://` / `gotifys://` | `NotifyGotify`   | `apprise.js/plugins/gotify`     | Gotify JSON API                               |
| `bark://` / `barks://`   | `NotifyBark`       | `apprise.js/plugins/bark`       | Bark device push API                          |

To keep only what you use (tree-shakeable), import a single plugin — or the `all` bucket — from a subpath:

```ts
import { Apprise } from 'apprise.js'
import 'apprise.js/plugins/custom-json' // registers only json:// + jsons://
import 'apprise.js/plugins/discord'     // registers only discord://
import 'apprise.js/plugins/telegram'    // registers only tgram://
import 'apprise.js/plugins/feishu'      // registers only feishu://
import 'apprise.js/plugins/ntfy'        // registers only ntfy:// + ntfys://
import 'apprise.js/plugins/gotify'      // registers only gotify:// + gotifys://
// or: import 'apprise.js/plugins/all'  // registers every scheme above

const apprise = new Apprise()
apprise.add('discord://webhook_id/webhook_token')
apprise.add('tgram://bot_token/12345')
apprise.add('feishu://bot_token')
const ok = await apprise.notify({ title: 'Hello', body: 'World' })
```

Minimal URL shapes for the China-oriented plugins are:

```text
schan://token
dingtalk://token/                         # or secret@token/13800138000
wecombot://webhook_key
feishu://bot_token
lark://bot-token
wxpusher://AT_app_token/UID_target/123
pushdeers://pushkey                       # cloud; host/pushkey for self-hosting
pover://user_key@application_token/device
pbul://access_token/device
ntfys://topic                              # ntfy.sh cloud
ntfys://user:password@host/topic?mode=private
gotifys://host/application_token
barks://host/device_key
```

These URLs contain live credentials. Keep them in a secret manager or environment variable, never source control, logs, screenshots, fixtures, or issue reports. `url(true)` and secure diagnostics mask credentials for routine troubleshooting, but masking is defense-in-depth rather than permission to publish a URL.

Pushover `?key=<64-hex>` enables field-level E2EE by default; `?e2ee=no` explicitly disables it. This follows upstream v1.12.0’s behavior, including an important limitation: when attachments are sent, the attachment loop can overwrite the encrypted message/title fields with plaintext filenames while leaving `encrypted=1`. Treat attachment filenames as public metadata; do not put secrets in them, and do not interpret `encrypted=1` as meaning the entire multipart request is encrypted.

Pushover accepts image attachments up to 5 MiB. Pushbullet first uploads attachments to the service-provided upload URL. ntfy sends local attachments as raw bytes, while `?attach=https://…` is only a remote URL reference that the ntfy server fetches. Automated tests use injected transports and fake credentials; they never contact these services.

For an optional pre-release live smoke, set a local-only environment variable such as `TELEGRAM_APPRISE_URL`, `NTFY_APPRISE_URL`, `GOTIFY_APPRISE_URL`, or `PUSHOVER_APPRISE_URL`, import the matching plugin, and send a clearly labeled test message to a disposable/private target. Run live smoke manually and opt in one service at a time; the automated suite never reads these variables and never contacts real notification services.

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
