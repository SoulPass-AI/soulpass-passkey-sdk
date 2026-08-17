/**
 * Cross-language known-answer tests for the signed-message hash.
 *
 * `tests/fixtures/signed-message-kat-vectors.json` is a byte-for-byte copy of
 * machine-wallet's `program/tests/vectors/signed_message_kat.json`, produced by
 * the on-chain implementation itself.
 *
 * Why this matters more than a self-consistency test: a signature the chain
 * rejects is a wallet that cannot move funds. Nothing in this repo can detect a
 * hash-format drift on its own, because both sides of a self-check would drift
 * together. These vectors came from the program, so they go red on exactly the
 * side that drifted.
 *
 * The contract's `kat_file_is_current` test fails CI whenever the envelope,
 * domains, tags, header framing, or payload order change — that is the signal
 * to re-copy this fixture and fix whatever turns red here.
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
  computeCreateWalletMessage,
  computeCloseWalletMessage,
  computeAdvanceNonceMessage,
  computeCreateSessionMessage,
  computeRevokeSessionMessage,
  computeOwnerCloseSessionMessage,
  computeAddAuthorityMessage,
  computeAddAuthorityPopMessage,
  computeRemoveAuthorityMessage,
  computeSetThresholdMessage,
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
    join(dirname(fileURLToPath(import.meta.url)), '../fixtures/signed-message-kat-vectors.json'),
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

/** Vectors are named `<operation>_<deployment>` by the generator. */
const digestFor = (operation: string, deployment: MachineWalletDeployment): string => {
  const name = `${operation}_${deployment}`
  const vector = fixture.vectors.find((v) => v.name === name)
  if (!vector) throw new Error(`fixture is missing vector ${name}`)
  return vector.keccak256_hex
}

describe('signed-message KATs', () => {
  it('reproduces every vector byte-for-byte', () => {
    // 3 deployment domains × 12 operations. A shrunken fixture must not
    // quietly pass as "all vectors matched".
    expect(fixture.vectors).toHaveLength(36)

    for (const vector of fixture.vectors) {
      const actual = hashSignedMessage({
        deployment: deploymentFor(vector.domain),
        tag: new TextEncoder().encode(vector.tag),
        payloadParts: vector.payload_parts_hex.map(hexToBytes),
      })
      expect(hex(actual), `vector ${vector.name}`).toBe(vector.keccak256_hex)
    }
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

// The vector suite above only proves the hash primitive agrees. It would still
// pass if computeExecuteMessage fed its fields in the wrong order, because that
// function is never called. These drive the public entry points.
describe('operation hashes against the contract vectors', () => {
  // Mirrors the constants at the top of the contract's signed_message_kat.rs.
  const wallet = new PublicKey(new Uint8Array(32).fill(0xaa))
  const creationSlot = 1000n
  const nonce = 7n
  const maxSlot = 250_000n
  const innerHash = new Uint8Array(32).fill(0x22)
  const ephemeralSignerBumps = Uint8Array.of(254, 253)

  it.each(DEPLOYMENTS)('computeExecuteMessage matches on %s', (deployment) => {
    const actual = computeExecuteMessage({
      walletPDA: wallet,
      creationSlot,
      nonce,
      maxSlot,
      innerHash,
      deployment,
    })
    expect(hex(actual)).toBe(digestFor('execute', deployment))
  })

  it.each(DEPLOYMENTS)('computeExecuteEphemeralMessage matches on %s', (deployment) => {
    const actual = computeExecuteEphemeralMessage({
      walletPDA: wallet,
      creationSlot,
      nonce,
      maxSlot,
      ephemeralSignerBumps,
      innerHash,
      deployment,
    })
    expect(hex(actual)).toBe(digestFor('execute_ephemeral', deployment))
  })

  /**
   * The tag that bit us: on chain, plain Execute is `machine_wallet_execute_v1`
   * and the ephemeral variant is `machine_wallet_execute_ephemeral_v2`. This SDK
   * previously used `machine_wallet_execute_v1` for the ephemeral path, so a
   * mechanical rename would have pointed it at the wrong operation.
   */
  it('names the two execute paths after different operations', () => {
    expect(new TextDecoder().decode(EXECUTE_TAG)).toBe('machine_wallet_execute_v1')
    expect(new TextDecoder().decode(EXECUTE_EPHEMERAL_TAG)).toBe(
      'machine_wallet_execute_ephemeral_v2',
    )
  })
})

describe('authority message hashes against the contract vectors', () => {
  // Mirrors the constants at the top of the contract's signed_message_kat.rs.
  const wallet = new PublicKey(new Uint8Array(32).fill(0xaa))
  const creationSlot = 1000n
  const nonce = 7n
  const maxSlot = 250_000n
  const sessionDataHash = new Uint8Array(32).fill(0x33)
  const destination = new Uint8Array(32).fill(0xbb)
  const sessionAuthority = new Uint8Array(32).fill(0x44)
  const newThreshold = 2
  // The authority-management vectors run on their own operand set.
  const popCreationSlot = 100n
  const popNonce = 5n
  const popMaxSlot = 200n
  const popSigScheme = 0
  const popPubkey = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x42)])

  it.each(DEPLOYMENTS)('every authority message matches on %s', (deployment) => {
    const base = { walletPDA: wallet, creationSlot, nonce, maxSlot, deployment }
    const popBase = {
      walletPDA: wallet,
      creationSlot: popCreationSlot,
      nonce: popNonce,
      maxSlot: popMaxSlot,
      deployment,
    }

    expect(
      hex(
        computeCreateWalletMessage({
          walletPDA: wallet,
          maxSlot: popMaxSlot,
          sigScheme: popSigScheme,
          authority: popPubkey,
          deployment,
        }),
      ),
    ).toBe(digestFor('create_wallet', deployment))

    expect(hex(computeCloseWalletMessage({ ...base, destination }))).toBe(
      digestFor('close_wallet', deployment),
    )

    expect(hex(computeAdvanceNonceMessage(base))).toBe(
      digestFor('advance_nonce', deployment),
    )

    expect(hex(computeCreateSessionMessage({ ...base, sessionDataHash }))).toBe(
      digestFor('create_session', deployment),
    )

    expect(hex(computeRevokeSessionMessage({ ...base, sessionAuthority }))).toBe(
      digestFor('revoke_session', deployment),
    )

    expect(
      hex(computeOwnerCloseSessionMessage({ ...base, sessionAuthority, destination })),
    ).toBe(digestFor('owner_close_session', deployment))

    expect(hex(computeSetThresholdMessage({ ...base, newThreshold }))).toBe(
      digestFor('set_threshold', deployment),
    )

    expect(
      hex(
        computeAddAuthorityMessage({
          ...popBase,
          newSigScheme: popSigScheme,
          newPubkey: popPubkey,
          newThreshold,
        }),
      ),
    ).toBe(digestFor('add_authority', deployment))

    expect(
      hex(
        computeAddAuthorityPopMessage({
          ...popBase,
          newSigScheme: popSigScheme,
          newPubkey: popPubkey,
        }),
      ),
    ).toBe(digestFor('add_authority_pop', deployment))

    expect(
      hex(
        computeRemoveAuthorityMessage({
          ...popBase,
          removeSigScheme: popSigScheme,
          removePubkey: popPubkey,
          newThreshold,
        }),
      ),
    ).toBe(digestFor('remove_authority', deployment))
  })

  /**
   * AddAuthority and its proof-of-possession differ only by a trailing
   * threshold byte. If they ever collapsed into one preimage, a joiner's proof
   * would count as an owner's approval.
   */
  it('approval and proof-of-possession never share a hash', () => {
    const popBase = {
      walletPDA: wallet,
      creationSlot: popCreationSlot,
      nonce: popNonce,
      maxSlot: popMaxSlot,
      deployment: 'devnet' as const,
      newSigScheme: popSigScheme,
      newPubkey: popPubkey,
    }
    expect(hex(computeAddAuthorityMessage({ ...popBase, newThreshold }))).not.toBe(
      hex(computeAddAuthorityPopMessage(popBase)),
    )
  })

  it('rejects operands of the wrong width instead of hashing them', () => {
    const base = { walletPDA: wallet, creationSlot, nonce, maxSlot, deployment: 'devnet' as const }
    expect(() =>
      computeCloseWalletMessage({ ...base, destination: new Uint8Array(31) }),
    ).toThrow(RangeError)
    expect(() =>
      computeAddAuthorityPopMessage({
        ...base,
        newSigScheme: 0,
        newPubkey: new Uint8Array(32),
      }),
    ).toThrow(RangeError)
    expect(() =>
      computeSetThresholdMessage({ ...base, newThreshold: 256 }),
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
    const a = hashSignedMessage({
      deployment: 'devnet',
      tag: encoder.encode('b_tag'),
      payloadParts,
    })
    const b = hashSignedMessage({
      deployment: 'devnet',
      tag: encoder.encode('_tag'),
      payloadParts,
    })
    expect(hex(a)).not.toBe(hex(b))
  })
})
