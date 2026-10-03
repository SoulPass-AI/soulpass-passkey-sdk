#!/usr/bin/env node
/**
 * Verify this repo's hand-copied golden-vector fixtures are byte-identical to
 * their source of truth:
 *
 *  - the three machine-wallet KATs against the program's own
 *    `machine-wallet/program/tests/vectors/` (never against another client's
 *    copy — a copy of a copy can agree with itself and still disagree with
 *    the chain);
 *  - the cross-client vectors no program produces (P-256 compression, the v1
 *    transaction wire) against the sibling soulpass-swift-sdk, which reads
 *    the same files.
 *
 * Copies that drift stop proving a cross-language contract and start hiding
 * its absence. Skips a source (exit 0 for it) when its sibling checkout is
 * absent: CI and fresh clones of this repo alone must not fail on a repo they
 * don't have.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const here = resolve(new URL('.', import.meta.url).pathname)
const localFixtures = resolve(here, '../tests/fixtures')
const programVectors = resolve(here, '../../machine-wallet/program/tests/vectors')
const swiftFixtures = resolve(here, '../../soulpass-swift-sdk/Tests/Fixtures')
const swiftKitFixtures = resolve(here, '../../soulpass-swift-sdk/Tests/SoulPassKitTests/Fixtures')

// [fixture, canonical directory, source name]. Extend when a
// new shared-vector file lands. The machine-wallet KATs keep the program's own
// file names and are verbatim copies.
const SHARED = [
  ['signed_message_kat.json', programVectors, 'machine-wallet'],
  ['session_data_kat.json', programVectors, 'machine-wallet'],
  ['layout_kat.json', programVectors, 'machine-wallet'],
  ['p256-compression-vectors.json', swiftFixtures, 'soulpass-swift-sdk'],
  ['solana-v1.json', swiftKitFixtures, 'soulpass-swift-sdk'],
]

const problems = []
const skipped = new Set()
let verified = 0
for (const [f, dir, source] of SHARED) {
  if (!existsSync(dir)) {
    skipped.add(source)
    continue
  }
  const local = resolve(localFixtures, f)
  const canonical = resolve(dir, f)
  if (!existsSync(local)) problems.push(`missing local fixture: ${f}`)
  else if (!existsSync(canonical)) problems.push(`missing in ${source} (was it renamed?): ${f}`)
  else if (!readFileSync(local).equals(readFileSync(canonical))) problems.push(`content differs from ${source}: ${f}`)
  else verified++
}

for (const source of skipped) console.log(`check-fixtures: sibling ${source} checkout not found — its fixtures skipped`)

if (problems.length > 0) {
  console.error('check-fixtures: shared fixtures out of sync with their source of truth')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('fix: re-copy the canonical file so every suite reads identical vectors')
  process.exit(1)
}

console.log(`check-fixtures: ${verified} shared fixtures verified in sync`)
