#!/usr/bin/env node
// SPDX-License-Identifier: BSD-2-Clause
//
// Regression check for the `sideEffects` / plugin-registration contract.
//
// Every plugin registers its URL scheme through a TOP-LEVEL MODULE SIDE EFFECT
// (`registerPlugin(...)` at module scope), and the README documents the usage as
// a BARE import with no used bindings:
//
//     import 'apprise.js/plugins/telegram'   // registers tgram://
//
// If `package.json` claims `"sideEffects": false`, a bundler is licensed to
// elide that import entirely — the registration never runs, `add()` returns
// false, and `notify()` then returns false, INDISTINGUISHABLE from a delivery
// failure. The code looks correct and nothing is ever sent.
//
// This cannot be caught by the Node test suite: Node never tree-shakes, so the
// bug only appears in a bundled consumer. Hence this check runs a REAL bundler
// over a REAL consumer and executes the output.
//
// Requires `dist/` (run `pnpm build` first).

import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const PKG = resolve(import.meta.dirname, '..')

// A consumer written exactly the way the README documents it: the barrel for
// `Apprise` (which registers the four generic webhook plugins), plus bare
// subpath imports for the opt-in IM plugins.
const ENTRY = `
import { Apprise } from 'apprise.js'
import 'apprise.js/plugins/telegram'
import 'apprise.js/plugins/discord'

const a = new Apprise()
const registered = {
  // from the barrel's own side effects
  json: a.add('json://localhost/path'),
  // from the bare subpath imports
  tgram: a.add('tgram://123456789:ABCdef_ghi-jkl/12345'),
  discord: a.add('discord://1234/abcdefghijklmnop'),
}
process.stdout.write(JSON.stringify(registered))
`

const dir = mkdtempSync(join(tmpdir(), 'apprise-bundle-'))
try {
  // esbuild only honours the `sideEffects` field for files inside node_modules,
  // so the package has to be resolved as a real dependency — exactly how a
  // consumer resolves it.
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(PKG, join(dir, 'node_modules', 'apprise.js'), 'dir')
  writeFileSync(join(dir, 'entry.mjs'), ENTRY)

  await build({
    entryPoints: [join(dir, 'entry.mjs')],
    outfile: join(dir, 'out.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    treeShaking: true,
    logLevel: 'silent',
  })

  const stdout = execFileSync(process.execPath, [join(dir, 'out.mjs')], {
    encoding: 'utf8',
  })

  let registered
  try {
    registered = JSON.parse(stdout)
  } catch {
    console.error(`✗ bundled consumer produced unparseable output: ${stdout}`)
    process.exit(1)
  }

  const dropped = Object.entries(registered)
    .filter(([, ok]) => !ok)
    .map(([scheme]) => scheme)

  if (dropped.length > 0) {
    console.error(
      '\n✗ The bundler DROPPED plugin registration for: ' +
        `${dropped.join(', ')}\n\n` +
        '  A bundler honouring `"sideEffects"` elided the module whose top-level\n' +
        '  `registerPlugin(...)` call registers the scheme, so `add()` returned\n' +
        '  false — which `notify()` then reports as a plain delivery failure.\n\n' +
        '  Fix: package.json `"sideEffects"` must list the entrypoints that DO\n' +
        '  have import side effects (the plugin modules and the barrel), e.g.\n' +
        '    ["./dist/plugins/*.js", "./dist/plugins/*.cjs",\n' +
        '     "./dist/index.js", "./dist/index.cjs"]\n',
    )
    process.exit(1)
  }

  console.log(
    '✓ bundler preserves plugin registration ' +
      `(${Object.keys(registered).join(', ')} all resolve after tree-shaking)`,
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
