#!/usr/bin/env node
// SPDX-License-Identifier: BSD-2-Clause
//
// Regression check for the dual-package (ESM + CJS) registry contract.
//
// The package is published in two formats. Node keeps SEPARATE module caches for
// ESM and CJS, so any graph that mixes them loads `registry` twice — the dual
// package hazard. A bundler may also inline a copy per entry. If the registry is
// module state rather than a process-wide singleton, each copy gets its own Map:
// a plugin registers into a registry that `Apprise` never reads, `add()` returns
// false, and `notify()` reports a plain delivery failure. Nothing is ever sent.
//
// This is invisible to the test suite (vitest runs `src/`, never `dist/`) and to
// publint / attw (they check SHAPE and TYPES, both of which stay valid while the
// registry splits). So this check EXECUTES the built artifact in every load
// combination and asserts `add()` actually resolves. Every combination that
// loads a plugin as CJS goes one step further: it `notify()`s that plugin over
// an injected stub transport and asserts the transport was really called — the
// CJS delivery path (top-level await, `import.meta` leakage) can still explode
// after registration succeeds, and only executing it catches that.
//
// Orthogonal to check-bundler-sideeffects.mjs: that one asks whether a bundler
// tree-shakes the registration away; this one asks whether registration lands in
// the same Map across formats. Both must pass.
//
// Requires `dist/` (run `pnpm build` first).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const PKG = resolve(import.meta.dirname, '..')
const TGRAM = 'tgram://123456789:ABCdef_ghi-jkl/12345'

// Each probe is a standalone program: a fresh process, so no probe can mask a
// split registry by leaving state behind for the next one.
const PROBES = [
  {
    name: 'CJS barrel + CJS subpath plugin',
    type: 'cjs',
    src: `const { Apprise } = require('./dist/index.cjs')
          require('./dist/plugins/telegram.cjs')
          smoke(Apprise, ${JSON.stringify(TGRAM)})`,
  },
  {
    name: 'CJS barrel + CJS plugins/all',
    type: 'cjs',
    src: `const { Apprise } = require('./dist/index.cjs')
          require('./dist/plugins/all.cjs')
          smoke(Apprise, ${JSON.stringify(TGRAM)})`,
  },
  {
    name: 'CJS barrel alone (barrel-bundled meta plugin)',
    type: 'cjs',
    src: `const { Apprise } = require('./dist/index.cjs')
          smoke(Apprise, 'json://localhost/path')`,
  },
  {
    name: 'ESM barrel + CJS plugin (cross-format)',
    type: 'esm',
    src: `import { createRequire } from 'node:module'
          const { Apprise } = await import('./dist/index.js')
          createRequire(process.cwd() + '/x.js')('./dist/plugins/telegram.cjs')
          await smoke(Apprise, ${JSON.stringify(TGRAM)})`,
  },
  {
    name: 'CJS barrel + ESM plugin (cross-format)',
    type: 'cjs',
    src: `const { Apprise } = require('./dist/index.cjs')
          import('./dist/plugins/telegram.js').then(() =>
            report(new Apprise().add(${JSON.stringify(TGRAM)})))`,
  },
  {
    name: 'ESM barrel + ESM plugin (control)',
    type: 'esm',
    src: `const { Apprise } = await import('./dist/index.js')
          await import('./dist/plugins/telegram.js')
          report(new Apprise().add(${JSON.stringify(TGRAM)}))`,
  },
]

// Injected ahead of every probe body. `report` marks add()-only probes; `smoke`
// drives the CJS delivery path: add() the CJS-loaded plugin, then notify() it
// over a PER-INSTANCE stub transport, asserting BOTH a true result AND that the
// stub was actually called. A non-empty payload is mandatory — an empty one
// trips the empty-content guard (apprise.ts) before any transport call, so
// "stub was called" is what proves send() really ran. The stub returns
// status:200 + a minimal JSON body, all telegram/custom-json's success check
// reads (NOT universal — matrix/discord/slack read the body; adjust if added).
const PRELUDE = `
const report = (ok) => process.stdout.write(ok ? 'OK' : 'DROPPED');
const smoke = async (Apprise, url) => {
  let calls = 0;
  const transport = async () => {
    calls++;
    return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), text: async () => '{"ok":true}' };
  };
  const ap = new Apprise({ transport });
  if (ap.add(url) !== true) return process.stdout.write('add() returned false');
  if ((await ap.notify({ title: 't', body: 'b' })) !== true) return process.stdout.write('notify() returned false');
  if (calls < 1) return process.stdout.write('stub transport was never called');
  process.stdout.write('OK');
};`

const failed = []
for (const probe of PROBES) {
  const args =
    probe.type === 'esm'
      ? ['--input-type=module', '-e', `${PRELUDE}\n${probe.src}`]
      : ['-e', `${PRELUDE}\n${probe.src}`]

  let out
  try {
    out = execFileSync(process.execPath, args, {
      cwd: PKG,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    failed.push([probe.name, `threw: ${String(err.stderr || err).trim()}`])
    continue
  }

  if (out.trim() !== 'OK')
    failed.push([probe.name, out.trim() || '(no output)'])
}

if (failed.length > 0) {
  console.error(
    '\n✗ A dual-package load combination broke:\n\n' +
      failed.map(([name, why]) => `    ${name}\n      -> ${why}`).join('\n') +
      '\n\n' +
      '  `add() returned false`: a plugin registered its scheme into a registry\n' +
      '  that `Apprise` never reads, so nothing would be sent. `notify() returned\n' +
      '  false` / `stub transport was never called`: registration landed, but the\n' +
      '  CJS-loaded plugin’s delivery path failed to reach the transport.\n\n' +
      '  This is the dual package hazard: Node caches ESM and CJS separately, so\n' +
      '  a mixed-format graph loads `registry` twice. The registry must be a\n' +
      '  process-wide singleton (see src/registry.ts), NOT module state. Note a\n' +
      '  bundler-level fix (tsup `splitting`) shares chunks only WITHIN a format\n' +
      '  and leaves the cross-format probes above still broken.\n',
  )
  process.exit(1)
}

// Registration-call observer checks. The observer and registry live only under
// internal Symbol.for keys; neither is exported from the package API.
const OBSERVER = 'apprise.js/test-registration-observer@0'
const REGISTRY = 'apprise.js/registry@0'
const ENTRY_SCHEMES = [
  ['custom-json', ['json', 'jsons']],
  ['custom-form', ['form', 'forms']],
  ['custom-xml', ['xml', 'xmls']],
  ['apprise-api', ['apprise', 'apprises']],
  ['mattermost', ['mmost', 'mmosts']],
  ['discord', ['discord']],
  ['slack', ['slack']],
  ['telegram', ['tgram']],
  ['rocketchat', ['rocket', 'rockets']],
  ['matrix', ['matrix', 'matrixs']],
  ['serverchan', ['schan']],
  ['dingtalk', ['dingtalk']],
  ['wecombot', ['wecombot']],
  ['feishu', ['feishu']],
  ['lark', ['lark']],
  ['wxpusher', ['wxpusher']],
  ['pushdeer', ['pushdeer', 'pushdeers']],
  ['pushover', ['pover']],
  ['pushbullet', ['pbul']],
  ['ntfy', ['ntfy', 'ntfys']],
  ['gotify', ['gotify', 'gotifys']],
  ['bark', ['bark', 'barks']],
]
const ALL_SCHEMES = ENTRY_SCHEMES.flatMap(([, schemes]) => schemes)

// Pushover's `node:zlib` codec must stay behind its own entry. A registration-
// only assertion would miss an accidentally bundled but unused codec. ESM
// output is split into chunks, so inspect the full static-import closure rather
// than just the tiny public entry file.
function assertNoPushoverCodecInEsmClosure(entry) {
  const seen = new Set()

  function visit(file) {
    if (seen.has(file)) return
    seen.add(file)

    const source = readFileSync(file, 'utf8')
    if (source.includes('node:zlib') || source.includes('pushover-codec')) {
      console.error(
        `✗ ${entry}.js reaches Pushover codec code through ${file.replace(`${PKG}/dist/`, '')}`,
      )
      process.exit(1)
    }

    const staticImport = /\b(?:from\s*|import\s*)["'](\.[^"']+)["']/g
    for (const match of source.matchAll(staticImport)) {
      visit(resolve(dirname(file), match[1]))
    }
  }

  visit(resolve(PKG, `dist/${entry}.js`))
}

for (const entry of [
  'index',
  ...ENTRY_SCHEMES.map(([name]) => `plugins/${name}`),
]) {
  if (entry === 'plugins/pushover') continue
  assertNoPushoverCodecInEsmClosure(entry)

  const cjs = readFileSync(resolve(PKG, `dist/${entry}.cjs`), 'utf8')
  if (cjs.includes('node:zlib') || cjs.includes('pushover-codec')) {
    console.error(`✗ ${entry}.cjs unexpectedly contains Pushover codec code`)
    process.exit(1)
  }
}
for (const extension of ['d.ts', 'd.cts']) {
  const declarations = readFileSync(
    resolve(PKG, `dist/plugins/pushover.${extension}`),
    'utf8',
  )
  if (
    declarations.includes('setPushoverEntropySourceForTest') ||
    declarations.includes('python314Gzip')
  ) {
    console.error(
      `✗ pushover.${extension} exposes an internal deterministic seam`,
    )
    process.exit(1)
  }
}

function runModuleProbe(source) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: PKG,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

const calibration = runModuleProbe(`
  const calls = []
  globalThis[Symbol.for(${JSON.stringify(OBSERVER)})] = (scheme) => calls.push(scheme)
  const { Apprise } = await import('./dist/index.js')
  const registry = globalThis[Symbol.for(${JSON.stringify(REGISTRY)})]
  const before = registry.size
  Apprise.register('ObserverStub', () => true)
  Apprise.register('observerstub', () => true)
  const count = calls.filter((scheme) => scheme === 'observerstub').length
  const okay = count === 2 && registry.size === before + 1 && registry.has('observerstub')
  process.stdout.write(okay ? 'OK' : JSON.stringify({ calls, before, size: registry.size }))
`)
if (calibration !== 'OK') {
  console.error(`✗ registration observer calibration failed: ${calibration}`)
  process.exit(1)
}

for (const [entry, schemes] of [...ENTRY_SCHEMES, ['all', ALL_SCHEMES]]) {
  const output = runModuleProbe(`
    const calls = []
    const observerKey = Symbol.for(${JSON.stringify(OBSERVER)})
    const registryKey = Symbol.for(${JSON.stringify(REGISTRY)})
    if (globalThis[registryKey] !== undefined || calls.length !== 0) process.exit(20)
    globalThis[observerKey] = (scheme) => calls.push(scheme)
    await import('./dist/plugins/${entry}.js')
    const registry = globalThis[registryKey]
    const expected = ${JSON.stringify(schemes)}
    const actual = [...registry.keys()].sort()
    const counts = Object.fromEntries(expected.map((scheme) => [scheme, calls.filter((x) => x === scheme).length]))
    const okay = JSON.stringify(actual) === JSON.stringify([...expected].sort()) &&
      expected.every((scheme) => counts[scheme] === 1) &&
      !registry.has('observerstub') && !calls.includes('observerstub')
    process.stdout.write(okay ? 'OK' : JSON.stringify({ actual, expected, calls, counts }))
  `)
  if (output !== 'OK') {
    console.error(`✗ isolated registration failed for ${entry}: ${output}`)
    process.exit(1)
  }
}

console.log(
  `✓ registry is a single process-wide table ` +
    `(${PROBES.length} ESM/CJS load combinations resolve; ` +
    `CJS-loaded plugins deliver over a stub transport; ` +
    `${ENTRY_SCHEMES.length} isolated entries + plugins/all register once)`,
)
