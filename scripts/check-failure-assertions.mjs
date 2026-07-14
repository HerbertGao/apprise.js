#!/usr/bin/env node
// SPDX-License-Identifier: BSD-2-Clause
//
// Test-discipline guard for the plugin-diagnostics contract (spec: "失败用例必须
// 按 kind 断言机制").
//
// A boolean return value is a black hole: `notify() === false` / `add() === false`
// is true for EVERY failure reason, so a test that asserts only the boolean has
// pinned nothing — a regression that fails for the wrong reason (or emits the
// wrong diagnostic) still passes it. Every failure-path boolean MUST sit beside a
// mechanism assertion that says WHY it failed: the emitted diagnostic `kind`, the
// request count on the wire, elapsed time, etc.
//
// This guard greps every test/ file for a failure-path boolean
// (`notify(` / `.add(` on the same line as `.toBe(false)`) and fails if the
// enclosing `test(...)` block carries no mechanism assertion. It is best-effort
// by design (a token grep, not a type-checker): its job is to stop a NAKED future
// `expect(await x.notify()).toBe(false)` from silently landing, not to prove every
// existing assertion is meaningful.
//
// Zero deps. Run after the assertions have been converted (task 4.2); it is red
// against the pre-conversion tree on purpose.

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const TEST_DIR = resolve(import.meta.dirname, '..', 'test')

// A boolean-false assertion in any form Biome might leave — same-line OR wrapped
// (a long `expect(await x.notify(...))` gets split, stranding `.toBe(false)` on
// its own line). Also catch `toEqual(false)` / `toBeFalsy()`.
const BOOLEAN_ASSERT = /\.(?:toBe\(false\)|toEqual\(false\)|toBeFalsy\(\s*\))/
// The failure-path calls whose bare boolean is a black hole.
const FAILURE_CALL = /notify\(|\.add\(/
// An `expect(` that opens an assertion statement (walk up to it from the matcher).
const EXPECT_OPEN = /\bexpect\s*\(/
// A block opener (test/it) and any block boundary (test/it/describe).
const BLOCK_START = /\b(?:test|it)\s*\(/
const BLOCK_BOUNDARY = /\b(?:test|it|describe)\s*\(/
// Mechanism tokens: a diagnostic kind, a request/call/server count, or timing.
// Kept broad on purpose — the guard only needs to distinguish "has a mechanism"
// from "asserts nothing but the boolean".
const MECHANISM =
  /(toHaveLength|toContain|\bkinds\b|\.kind\b|\bseen\b|\.calls\b|\.sent\b|\.servers\b|\.length\b|\belapsed\b|\breceived\b)/

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return testFiles(full)
    return entry.name.endsWith('.test.ts') ? [full] : []
  })
}

const offenders = []

for (const file of testFiles(TEST_DIR)) {
  const lines = readFileSync(file, 'utf8').split('\n')

  lines.forEach((line, i) => {
    if (!BOOLEAN_ASSERT.test(line)) return

    // Reconstruct the assertion statement across Biome line-wrapping: walk up to
    // its `expect(` opener and join, so a wrapped `notify(`/`.add(` still counts.
    let stmtStart = i
    while (stmtStart > 0 && !EXPECT_OPEN.test(lines[stmtStart])) stmtStart--
    const statement = lines.slice(stmtStart, i + 1).join(' ')
    if (!FAILURE_CALL.test(statement)) return // not a failure-path boolean

    // Enclosing block: nearest test(/it( above, up to the next test/it/describe(
    // below (or EOF).
    let start = i
    while (start > 0 && !BLOCK_START.test(lines[start])) start--
    let end = i + 1
    while (end < lines.length && !BLOCK_BOUNDARY.test(lines[end])) end++

    // A mechanism assertion is any non-boolean line in the block carrying a token
    // (boolean lines are excluded so a sibling `.toBe(false)` can't self-satisfy).
    const hasMechanism = lines
      .slice(start, end)
      .some((l) => !BOOLEAN_ASSERT.test(l) && MECHANISM.test(l))

    if (!hasMechanism) {
      offenders.push(`${file}:${i + 1}: ${line.trim()}`)
    }
  })
}

if (offenders.length > 0) {
  console.error(
    `\n✗ ${offenders.length} failure-path boolean(s) assert nothing but the return value:\n\n` +
      offenders.map((o) => `    ${o}`).join('\n') +
      '\n\n' +
      '  `notify()/add() === false` holds for every failure reason, so on its own\n' +
      '  it pins nothing. Add a mechanism assertion beside it — the emitted\n' +
      '  diagnostic kind (inject a sink: `new AppriseAsset({ diagnostic: (e) =>\n' +
      '  kinds.push(e.kind) })` then `expect(kinds).toContain(...)`), the request\n' +
      '  count (`expect(seen).toHaveLength(n)`), or elapsed time.\n',
  )
  process.exit(1)
}

console.log(
  '✓ every failure-path boolean (notify/add === false) sits beside a mechanism assertion',
)
