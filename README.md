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

> **Do not add `"sideEffects": false` to `package.json`.** Each plugin registers its scheme through a *top-level module side effect*, and the imports above are bare (no used bindings) — declaring the package side-effect-free licenses a bundler to elide them, after which the scheme never registers, `add()` returns `false`, and `notify()` reports a plain delivery failure. It does not reproduce under plain Node (which never tree-shakes), so `pnpm run test:bundle` runs a real bundler over a real consumer to guard the contract.

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
