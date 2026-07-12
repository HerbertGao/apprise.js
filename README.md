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

### Batch-1 schemes

The engine ships with the four generic webhook meta-plugins:

| Scheme                | Plugin            | Sends                          |
| --------------------- | ----------------- | ------------------------------ |
| `json://` / `jsons://` | `NotifyJSON`      | JSON body                      |
| `form://` / `forms://` | `NotifyForm`      | `multipart` / form-urlencoded  |
| `xml://` / `xmls://`   | `NotifyXML`       | XML (SOAP) body                |
| `apprise://` / `apprises://` | `NotifyAppriseAPI` | Apprise API server |

Importing the `apprise.js` barrel registers all four. To keep only what you use (tree-shakeable), import a single plugin — or the `all` bucket — from a subpath instead:

```ts
import { Apprise } from 'apprise.js'
import 'apprise.js/plugins/custom-json' // registers only json:// + jsons://
// or: import 'apprise.js/plugins/all'  // registers every batch-1 scheme

const apprise = new Apprise()
apprise.add('json://example.com/hook')
```

Runtime handlers can also be registered without a plugin class via `Apprise.register(scheme, handler)`.

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
