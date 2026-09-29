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
import { createHash } from 'node:crypto'
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
  computeCreateSessionV2Message,
  computeRotateRootMessage,
  computeAdoptRootMessage,
  computeRemoveAuthorityV2Message,
  computeSetThresholdV2Message,
  computeCloseWalletV2Message,
  CREATE_SESSION_V2_TAG,
  ROTATE_ROOT_TAG,
  ADOPT_ROOT_TAG,
  REMOVE_AUTHORITY_V2_TAG,
  SET_THRESHOLD_V2_TAG,
  CLOSE_WALLET_V2_TAG,
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
    // 3 deployment domains × 18 operations (12 v1 + 6 machine-wallet v2). A
    // shrunken fixture must not quietly pass as "all vectors matched".
    expect(fixture.vectors).toHaveLength(54)

    for (const vector of fixture.vectors) {
      const actual = hashSignedMessage({
        deployment: deploymentFor(vector.domain),
        tag: new TextEncoder().encode(vector.tag),
        payloadParts: vector.payload_parts_hex.map(hexToBytes),
      })
      expect(hex(actual), `vector ${vector.name}`).toBe(vector.keccak256_hex)
    }
  })

  /**
   * The v2 sync (machine-wallet ca6073d) only ADDED vectors. Every signature a
   * v1 client already produces must keep verifying, so the 36 pre-v2 vectors
   * are pinned as a set: same names, same bytes. The digest is sha256 over
   * JSON.stringify of those vectors sorted by name, computed from the fixture
   * as it stood before the sync (the program interleaves the new ops per
   * deployment, so file order moved — content did not).
   */
  it('keeps the 36 v1 vectors byte-identical across the v2 sync', () => {
    const V1_OPS = [
      'execute', 'execute_ephemeral', 'create_session', 'close_wallet',
      'add_authority_pop', 'create_wallet', 'advance_nonce', 'revoke_session',
      'owner_close_session', 'add_authority', 'remove_authority', 'set_threshold',
    ]
    const v1Names = new Set(DEPLOYMENTS.flatMap((d) => V1_OPS.map((op) => `${op}_${d}`)))
    const v1 = fixture.vectors
      .filter((v) => v1Names.has(v.name))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
    expect(v1).toHaveLength(36)
    expect(createHash('sha256').update(JSON.stringify(v1)).digest('hex')).toBe(
      'd6289b23678ce01b8cd197b323a1fe83fdbcb53f4b1abfabb0b100b73e856a5d',
    )
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

describe('machine-wallet v2 message hashes against the contract vectors', () => {
  // Mirrors the constants at the top of the contract's signed_message_kat.rs.
  const wallet = new PublicKey(new Uint8Array(32).fill(0xaa))
  const base = (deployment: MachineWalletDeployment) => ({
    walletPDA: wallet,
    creationSlot: 1000n,
    nonce: 7n,
    maxSlot: 250_000n,
    deployment,
  })
  // rotate/adopt/remove v2 run on the PoP operand set, like their v1 siblings.
  const popBase = (deployment: MachineWalletDeployment) => ({
    walletPDA: wallet,
    creationSlot: 100n,
    nonce: 5n,
    maxSlot: 200n,
    deployment,
  })
  const popPubkey = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x42)])

  it.each(DEPLOYMENTS)('every v2 message matches on %s', (deployment) => {
    expect(
      hex(computeCreateSessionV2Message({ ...base(deployment), sessionDataHash: new Uint8Array(32).fill(0x33) })),
    ).toBe(digestFor('create_session_v2', deployment))
    expect(
      hex(computeRotateRootMessage({ ...popBase(deployment), newRootSigScheme: 0, newRootPubkey: popPubkey })),
    ).toBe(digestFor('rotate_root', deployment))
    expect(
      hex(computeAdoptRootMessage({ ...popBase(deployment), rootSigScheme: 0, rootPubkey: popPubkey })),
    ).toBe(digestFor('adopt_root', deployment))
    expect(
      hex(
        computeRemoveAuthorityV2Message({
          ...popBase(deployment),
          removeSigScheme: 0,
          removePubkey: popPubkey,
          newThreshold: 2,
        }),
      ),
    ).toBe(digestFor('remove_authority_v2', deployment))
    expect(hex(computeSetThresholdV2Message({ ...base(deployment), newThreshold: 2 }))).toBe(
      digestFor('set_threshold_v2', deployment),
    )
    expect(
      hex(computeCloseWalletV2Message({ ...base(deployment), destination: new Uint8Array(32).fill(0xbb) })),
    ).toBe(digestFor('close_wallet_v2', deployment))
  })

  /**
   * RotateRoot / AdoptRoot are new operations (`_v1`); the three v2-wallet
   * authority ops and CreateSessionV2 re-tag an existing payload (`_v2`) so a
   * v1 signature can never authorize them. A mechanical "_v1 → _v2" sweep
   * would break exactly the two root tags.
   */
  it('uses the program tag strings verbatim', () => {
    const d = (t: Uint8Array) => new TextDecoder().decode(t)
    expect(d(CREATE_SESSION_V2_TAG)).toBe('machine_wallet_create_session_v2')
    expect(d(ROTATE_ROOT_TAG)).toBe('machine_wallet_rotate_root_v1')
    expect(d(ADOPT_ROOT_TAG)).toBe('machine_wallet_adopt_root_v1')
    expect(d(REMOVE_AUTHORITY_V2_TAG)).toBe('machine_wallet_remove_authority_v2')
    expect(d(SET_THRESHOLD_V2_TAG)).toBe('machine_wallet_set_threshold_v2')
    expect(d(CLOSE_WALLET_V2_TAG)).toBe('machine_wallet_close_v2')
  })

  it('a v2 message never equals its v1 counterpart over the same payload', () => {
    const b = base('devnet')
    expect(hex(computeSetThresholdV2Message({ ...b, newThreshold: 2 }))).not.toBe(
      hex(computeSetThresholdMessage({ ...b, newThreshold: 2 })),
    )
    const h = new Uint8Array(32).fill(0x33)
    expect(hex(computeCreateSessionV2Message({ ...b, sessionDataHash: h }))).not.toBe(
      hex(computeCreateSessionMessage({ ...b, sessionDataHash: h })),
    )
  })

  it('rejects root operands of the wrong width', () => {
    expect(() =>
      computeRotateRootMessage({ ...popBase('devnet'), newRootSigScheme: 2, newRootPubkey: new Uint8Array(32) }),
    ).toThrow(RangeError)
    expect(() =>
      computeAdoptRootMessage({ ...popBase('devnet'), rootSigScheme: 256, rootPubkey: popPubkey }),
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
