# apprise.js

A faithful TypeScript translation of [caronc/apprise](https://github.com/caronc/apprise) — push notifications to many services via a single URL contract. Translation baseline: upstream **v1.12.0**.

> 🚧 Early WIP — no engine yet. This package is developed inside the apprise.js umbrella repo (OpenSpec specs + upstream reference); its `docs/DECISIONS.md` has the full plan.

## Install

```sh
npm i apprise.js
```

## Usage (planned API — not yet implemented)

The engine lands in the `core-foundation` milestone. Today the package only exports `UPSTREAM_VERSION`. The target API:

```ts
import { Apprise } from 'apprise.js'

const apprise = new Apprise()
apprise.add('discord://webhook_id/webhook_token')

await apprise.notify({ title: 'Hello', body: 'World' }) // Promise<boolean>
```

The public contract (URL schemes, query params, enum values, main class/method names) mirrors Python Apprise 1:1; only platform-forced spots are `async`.

## Dev

Requires Node ≥20 and pnpm (via `corepack enable`).

```sh
pnpm install
pnpm run build      # tsup → dist (ESM + CJS + d.ts)
pnpm test           # vitest
pnpm run typecheck  # tsc --noEmit
pnpm run lint       # biome
```

## License

BSD-2-Clause. Derived from [caronc/apprise](https://github.com/caronc/apprise) (© Chris Caron); original copyright retained. See [LICENSE](./LICENSE).
