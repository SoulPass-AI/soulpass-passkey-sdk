#!/usr/bin/env node
/**
 * Verify this repo's hand-copied golden-vector fixtures are byte-identical to
 * their canonical copies in the sibling soulpass-swift-sdk checkout. The
 * fixtures are synced by hand (no generator gate yet) — this check is the
 * machine guard that manual process lacks: copies that drift stop proving a
 * cross-language contract and start hiding its absence.
 *
 * Skips (exit 0) when the sibling checkout is absent: CI and fresh clones of
 * this repo alone must not fail on a repo they don't have.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const here = resolve(new URL('.', import.meta.url).pathname)
const swiftFixtures = resolve(here, '../../soulpass-swift-sdk/Tests/Fixtures')
const swiftKitFixtures = resolve(here, '../../soulpass-swift-sdk/Tests/SoulPassKitTests/Fixtures')
const localFixtures = resolve(here, '../tests/fixtures')

// Every fixture this repo copies from the Swift SDK, with the Swift directory
// it lives in. Extend when a new shared-vector file lands. The three
// machine-wallet KATs keep the program's own file names and are verbatim
// copies of machine-wallet `program/tests/vectors/`, as the Swift SDK's are.
const SHARED = [
  ['p256-compression-vectors.json', swiftFixtures],
  ['signed_message_kat.json', swiftFixtures],
  ['session_data_kat.json', swiftKitFixtures],
  ['layout_kat.json', swiftKitFixtures],
]

if (!existsSync(swiftFixtures)) {
  console.log('check-fixtures: sibling soulpass-swift-sdk checkout not found — skipped')
  process.exit(0)
}

const problems = []
for (const [f, swiftDir] of SHARED) {
  const local = resolve(localFixtures, f)
  const swift = resolve(swiftDir, f)
  if (!existsSync(local)) problems.push(`missing local fixture: ${f}`)
  else if (!existsSync(swift)) problems.push(`missing in swift-sdk (was it renamed?): ${f}`)
  else if (!readFileSync(local).equals(readFileSync(swift))) problems.push(`content differs: ${f}`)
}

if (problems.length > 0) {
  console.error('check-fixtures: shared fixtures out of sync with soulpass-swift-sdk')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('fix: re-copy the canonical file so both suites read identical vectors')
  process.exit(1)
}

console.log(`check-fixtures: ${SHARED.length} shared fixtures verified in sync`)
