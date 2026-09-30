/**
 * Cross-language known-answer tests for the signed-message hash.
 *
 * `tests/fixtures/signed_message_kat.json` is a byte-for-byte copy of
 * machine-wallet's `program/tests/vectors/signed_message_kat.json`, produced by
 * the on-chain implementation itself (57 vectors = 19 operations × 3 deployment
 * domains).
 *
 * Why this matters more than a self-consistency test: a signature the chain
 * rejects is a wallet that cannot move funds. Nothing in this repo can detect a
 * hash-format drift on its own, because both sides of a self-check would drift
 * together. These vectors came from the program, so they go red on exactly the
 * side that drifted.
 *
 * Three layers:
 *  1. the hash primitive reproduces every vector;
 *  2. the SDK's tag table is exactly the fixture's tag set — one extra or one
 *     missing tag is a failure;
 *  3. every public `compute*Message` entry point, fed the operands split back
 *     out of the vector's payload parts, lands on the vector's digest — this is
 *     what catches a field fed in the wrong order.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import { bytesToHex as hex, hexToBytes } from '@noble/hashes/utils'
import {
  hashSignedMessage,
  deploymentDomain,
  SIGNED_MESSAGE_ENVELOPE,
  type MachineWalletDeployment,
} from '../../src/wire-format/signed-message'
import {
  computeExecuteMessage,
  computeExecuteEphemeralMessage,
  EXECUTE_TAG,
  EXECUTE_EPHEMERAL_TAG,
} from '../../src/wire-format/operation-hash'
import {
  MACHINE_WALLET_TAGS,
  type AuthorityMessageBase,
  computeCreateWalletMessage,
  computeCloseWalletMessage,
  computeAdvanceNonceMessage,
  computeCreateSessionMessage,
  computeRevokeSessionMessage,
  computeOwnerCloseSessionMessage,
  computeAddAuthorityMessage,
  computeAddAuthorityPopMessage,
  computeRemoveSelfMessage,
  computeRemoveOtherMessage,
  computeSetThresholdMessage,
  computeRotateRootMessage,
  computeProposeRecoveryMessage,
  computeCancelRecoveryMessage,
  computeExecuteRecoveryMessage,
  computeSetRecoveryThresholdMessage,
  computeBumpEpochMessage,
} from '../../src/wire-format/authority-messages'

interface Vector {
  name: string
  domain: string
  tag: string
  payload_parts_hex: string[]
  keccak256_hex: string
}

interface Fixture {
  format: string
  envelope: string
  vectors: Vector[]
}

const fixture: Fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../fixtures/signed_message_kat.json'),
    'utf8',
  ),
)

const DEPLOYMENTS: MachineWalletDeployment[] = ['local', 'devnet', 'mainnet']

/** Reverse of {@link deploymentDomain} — fails loudly on an unknown domain. */
const deploymentFor = (domain: string): MachineWalletDeployment => {
  const deployment = DEPLOYMENTS.find(
    (d) => new TextDecoder().decode(deploymentDomain(d)) === domain,
  )
  if (!deployment) throw new Error(`fixture domain ${domain} matches no known deployment`)
  return deployment
}

const u64 = (b: Uint8Array): bigint => {
  expect(b).toHaveLength(8)
  return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true)
}
const u8 = (b: Uint8Array): number => {
  expect(b).toHaveLength(1)
  return b[0]!
}

/** Split the shared `wallet || creation_slot || nonce || max_slot` preamble. */
const prefix = (
  parts: Uint8Array[],
  deployment: MachineWalletDeployment,
): { base: AuthorityMessageBase; rest: Uint8Array[] } => {
  const [wallet, creationSlot, nonce, maxSlot, ...rest] = parts
  return {
    base: {
      walletPDA: new PublicKey(wallet!),
      creationSlot: u64(creationSlot!),
      nonce: u64(nonce!),
      maxSlot: u64(maxSlot!),
      deployment,
    },
    rest,
  }
}

/** Expect exactly `n` operands after the preamble, so a shape drift fails. */
const take = (rest: Uint8Array[], n: number): Uint8Array[] => {
  expect(rest).toHaveLength(n)
  return rest
}

type Recompute = (parts: Uint8Array[], d: MachineWalletDeployment) => Uint8Array

/**
 * One public entry point per operation, keyed by the vector-name stem
 * (`<stem>_<deployment>`). `remove_authority_root` is the program's name for
 * the root-signed removal of another authority — `remove_other_v1`.
 */
const RECOMPUTE: Record<string, Recompute> = {
  create_wallet: ([wallet, maxSlot, scheme, authority, ...extra], deployment) => {
    expect(extra).toHaveLength(0)
    return computeCreateWalletMessage({
      walletPDA: new PublicKey(wallet!),
      maxSlot: u64(maxSlot!),
      sigScheme: u8(scheme!),
      authority: authority!,
      deployment,
    })
  },
  execute: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [innerHash] = take(rest, 1)
    return computeExecuteMessage({ ...base, innerHash: innerHash! })
  },
  execute_ephemeral: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [count, bumps, innerHash] = take(rest, 3)
    expect(u8(count!)).toBe(bumps!.length)
    return computeExecuteEphemeralMessage({
      ...base,
      ephemeralSignerBumps: bumps!,
      innerHash: innerHash!,
    })
  },
  advance_nonce: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    take(rest, 0)
    return computeAdvanceNonceMessage(base)
  },
  create_session: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [sessionDataHash] = take(rest, 1)
    return computeCreateSessionMessage({ ...base, sessionDataHash: sessionDataHash! })
  },
  revoke_session: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [sessionAuthority] = take(rest, 1)
    return computeRevokeSessionMessage({ ...base, sessionAuthority: sessionAuthority! })
  },
  owner_close_session: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [sessionAuthority] = take(rest, 1)
    return computeOwnerCloseSessionMessage({ ...base, sessionAuthority: sessionAuthority! })
  },
  add_authority: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [scheme, pubkey, threshold] = take(rest, 3)
    return computeAddAuthorityMessage({
      ...base,
      newSigScheme: u8(scheme!),
      newPubkey: pubkey!,
      newThreshold: u8(threshold!),
    })
  },
  add_authority_pop: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [scheme, pubkey] = take(rest, 2)
    return computeAddAuthorityPopMessage({ ...base, newSigScheme: u8(scheme!), newPubkey: pubkey! })
  },
  remove_self: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [scheme, pubkey, threshold] = take(rest, 3)
    return computeRemoveSelfMessage({
      ...base,
      sigScheme: u8(scheme!),
      pubkey: pubkey!,
      newThreshold: u8(threshold!),
    })
  },
  remove_authority_root: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [scheme, pubkey, threshold] = take(rest, 3)
    return computeRemoveOtherMessage({
      ...base,
      sigScheme: u8(scheme!),
      pubkey: pubkey!,
      newThreshold: u8(threshold!),
    })
  },
  set_threshold: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [threshold] = take(rest, 1)
    return computeSetThresholdMessage({ ...base, newThreshold: u8(threshold!) })
  },
  close_wallet: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [destination] = take(rest, 1)
    return computeCloseWalletMessage({ ...base, destination: destination! })
  },
  rotate_root: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [scheme, pubkey] = take(rest, 2)
    return computeRotateRootMessage({
      ...base,
      newRootSigScheme: u8(scheme!),
      newRootPubkey: pubkey!,
    })
  },
  propose_recovery: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [scheme, pubkey] = take(rest, 2)
    return computeProposeRecoveryMessage({ ...base, sigScheme: u8(scheme!), pubkey: pubkey! })
  },
  execute_recovery: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [scheme, pubkey] = take(rest, 2)
    return computeExecuteRecoveryMessage({ ...base, sigScheme: u8(scheme!), pubkey: pubkey! })
  },
  cancel_recovery: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    take(rest, 0)
    return computeCancelRecoveryMessage(base)
  },
  bump_epoch: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    take(rest, 0)
    return computeBumpEpochMessage(base)
  },
  set_recovery_threshold: (parts, d) => {
    const { base, rest } = prefix(parts, d)
    const [threshold] = take(rest, 1)
    return computeSetRecoveryThresholdMessage({ ...base, recoveryThreshold: u8(threshold!) })
  },
}

/** The entry point for a vector, by its name stem; a missing one names the stem. */
const recomputeFor = (vectorName: string): Recompute => {
  const stem = vectorName.replace(/_(local|devnet|mainnet)$/, '')
  const recompute = RECOMPUTE[stem]
  if (!recompute) throw new Error(`no compute*Message entry point for vector stem '${stem}'`)
  return recompute
}

describe('signed-message KATs', () => {
  it('carries 57 vectors (19 operations × 3 deployment domains)', () => {
    // A shrunken fixture must not quietly pass as "all vectors matched".
    expect(fixture.vectors).toHaveLength(57)
  })

  it('reproduces every vector byte-for-byte through the hash primitive', () => {
    for (const vector of fixture.vectors) {
      const actual = hashSignedMessage({
        deployment: deploymentFor(vector.domain),
        tag: new TextEncoder().encode(vector.tag),
        payloadParts: vector.payload_parts_hex.map(hexToBytes),
      })
      expect(hex(actual), `vector ${vector.name}`).toBe(vector.keccak256_hex)
    }
  })

  /** Review focus 4: one tag more or one tag fewer in code is a failure. */
  it('tagSetMatchesKat: the SDK tag table is exactly the fixture tag set', () => {
    const codeTags = Object.values(MACHINE_WALLET_TAGS)
    expect(new Set(codeTags).size).toBe(codeTags.length)
    expect(new Set(codeTags)).toEqual(new Set(fixture.vectors.map((v) => v.tag)))
    for (const tag of codeTags) expect(tag).toMatch(/^machine_wallet_[a-z_]+_v1$/)
  })

  it('pins the envelope this SDK compiles against', () => {
    expect(new TextDecoder().decode(SIGNED_MESSAGE_ENVELOPE)).toBe(fixture.envelope)
  })

  it('covers every deployment the SDK can produce', () => {
    const covered = new Set(fixture.vectors.map((v) => v.domain))
    for (const deployment of DEPLOYMENTS) {
      expect(covered).toContain(new TextDecoder().decode(deploymentDomain(deployment)))
    }
  })
})

describe('every compute*Message entry point against the contract vectors', () => {
  const localVectors = fixture.vectors.filter((v) => v.name.endsWith('_local'))

  it('has one local vector per operation, each with an entry point', () => {
    expect(localVectors).toHaveLength(19)
    expect(new Set(localVectors.map((v) => v.name.slice(0, -'_local'.length)))).toEqual(
      new Set(Object.keys(RECOMPUTE)),
    )
  })

  // Every vector, every domain: the entry points must track the domain too.
  it.each(fixture.vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const actual = recomputeFor(vector.name)(
      vector.payload_parts_hex.map(hexToBytes),
      deploymentFor(vector.domain),
    )
    expect(hex(actual)).toBe(vector.keccak256_hex)
  })
})

describe('tag constants', () => {
  it('Execute and ExecuteEphemeral are different operations, both _v1', () => {
    expect(new TextDecoder().decode(EXECUTE_TAG)).toBe('machine_wallet_execute_v1')
    expect(new TextDecoder().decode(EXECUTE_EPHEMERAL_TAG)).toBe(
      'machine_wallet_execute_ephemeral_v1',
    )
  })
})

describe('authority message guards', () => {
  const wallet = new PublicKey(new Uint8Array(32).fill(0xaa))
  const base = {
    walletPDA: wallet,
    creationSlot: 100n,
    nonce: 5n,
    maxSlot: 200n,
    deployment: 'devnet' as const,
  }
  const pubkey = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x42)])

  /**
   * AddAuthority and its proof-of-possession differ only by a trailing
   * threshold byte. If they ever collapsed into one preimage, a joiner's proof
   * would count as an owner's approval.
   */
  it('approval and proof-of-possession never share a hash', () => {
    const args = { ...base, newSigScheme: 0, newPubkey: pubkey }
    expect(hex(computeAddAuthorityMessage({ ...args, newThreshold: 2 }))).not.toBe(
      hex(computeAddAuthorityPopMessage(args)),
    )
  })

  /** Same payload, different tag: a self-removal can never authorize removing someone else. */
  it('remove_self and remove_other never share a hash', () => {
    const args = { ...base, sigScheme: 0, pubkey, newThreshold: 1 }
    expect(hex(computeRemoveSelfMessage(args))).not.toBe(hex(computeRemoveOtherMessage(args)))
  })

  it('propose and execute recovery never share a hash', () => {
    const args = { ...base, sigScheme: 0, pubkey }
    expect(hex(computeProposeRecoveryMessage(args))).not.toBe(
      hex(computeExecuteRecoveryMessage(args)),
    )
  })

  it('rejects operands of the wrong width instead of hashing them', () => {
    expect(() => computeCloseWalletMessage({ ...base, destination: new Uint8Array(31) })).toThrow(
      RangeError,
    )
    expect(() =>
      computeOwnerCloseSessionMessage({ ...base, sessionAuthority: new Uint8Array(33) }),
    ).toThrow(RangeError)
    expect(() =>
      computeAddAuthorityPopMessage({ ...base, newSigScheme: 0, newPubkey: new Uint8Array(32) }),
    ).toThrow(RangeError)
    expect(() => computeSetThresholdMessage({ ...base, newThreshold: 256 })).toThrow(RangeError)
    expect(() =>
      computeRemoveOtherMessage({ ...base, sigScheme: 0, pubkey: new Uint8Array(32), newThreshold: 1 }),
    ).toThrow(RangeError)
    expect(() =>
      computeRemoveSelfMessage({ ...base, sigScheme: 256, pubkey, newThreshold: 1 }),
    ).toThrow(RangeError)
    expect(() =>
      computeProposeRecoveryMessage({ ...base, sigScheme: 0, pubkey: new Uint8Array(34) }),
    ).toThrow(RangeError)
    expect(() =>
      computeSetRecoveryThresholdMessage({ ...base, recoveryThreshold: -1 }),
    ).toThrow(RangeError)
    expect(() =>
      computeRotateRootMessage({ ...base, newRootSigScheme: 2, newRootPubkey: new Uint8Array(32) }),
    ).toThrow(RangeError)
  })
})

describe('header framing invariants', () => {
  const payloadParts = [new Uint8Array(32).fill(0x11)]
  const tag = new TextEncoder().encode('operation_v1')

  it('scopes the hash to the deployment', () => {
    const devnet = hashSignedMessage({ deployment: 'devnet', tag, payloadParts })
    const mainnet = hashSignedMessage({ deployment: 'mainnet', tag, payloadParts })
    expect(hex(devnet)).not.toBe(hex(mainnet))
  })

  it('rejects an unknown deployment instead of defaulting', () => {
    expect(() =>
      hashSignedMessage({
        deployment: 'testnet' as MachineWalletDeployment,
        tag,
        payloadParts,
      }),
    ).toThrow(RangeError)
  })

  /**
   * The length prefixes exist precisely so moving bytes across the domain/tag
   * boundary changes the hash. Without them, ("domain_a", "b_tag") and
   * ("domain_ab", "_tag") would share a preimage. Mirrors the contract's
   * `header_boundary_shift_changes_hash`.
   */
  it('separates the domain and tag segments', () => {
    const encoder = new TextEncoder()
    const a = hashSignedMessage({ deployment: 'devnet', tag: encoder.encode('b_tag'), payloadParts })
    const b = hashSignedMessage({ deployment: 'devnet', tag: encoder.encode('_tag'), payloadParts })
    expect(hex(a)).not.toBe(hex(b))
  })
})
