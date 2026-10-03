# Architecture — @soulpass/passkey-sdk

Internal architecture notes: where this SDK sits in the SoulPass system and
the cross-language wire-format contracts it owns. **Integrating a dApp? Start
with [README.md](./README.md) instead — you don't need anything on this page.**

This SDK is browser-native Solana wallet tooling powered by WebAuthn
passkeys — and the **TypeScript single source of truth for MachineWallet
wire formats**.

## Where this SDK sits

The SoulPass system has two signer SDKs. They are not two language ports of
one SDK — they are **two different signers for the same on-chain
MachineWallet program**, each owning a different authority slot type:

| SDK | Signer | SigScheme | Runs in |
|---|---|---|---|
| `@soulpass/passkey-sdk` (this repo) | WebAuthn passkey (platform authenticator) | `Webauthn (2)` | Browser |
| `soulpass-swift-sdk` | Apple Secure Enclave P-256 (plus native iOS passkeys) | `Secp256r1 (0)` / `Webauthn (2)` | iOS / macOS |

The AddAuthority + proof-of-possession ceremony exists precisely so these two
kinds of keys can be added to the same wallet as co-authorities.

## What this package exports

Six entries (`.`, `./react`, `./solana-adapter`, `./protocol`, `./payments`,
`./payments-react` — see `tsup.config.ts`), layered by audience (the split
keeps dApp autocomplete free of protocol internals and keeps
`@solana/wallet-adapter-base` — an optional peer, never bundled — out of the
main bundle):

- **`.` (integration surface)** — `SoulPassWallet`: two-phase signing
  sessions (`begin*()` synchronously inside the click handler to keep
  transient user activation; `session.send(bytes)` after async tx
  construction). Plus typed errors (`SoulPassError`), branded PDA types
  (`VaultPda` / `StatePda` + `*Key` variants — exists to make "vault PDA in
  a state-PDA slot" a compile error instead of a recurring `0x7d2
  ConstraintSigner` bug; stamp them with the checking `validateVaultPda` /
  `validateStatePda`), and in-app-browser detection.
- **`./react`** — `SoulPassProvider` + `useSoulPass()`: owns a wallet
  instance, persists the connection to sessionStorage, restores on reload.
  `react` is an optional peer dependency.
- **`./solana-adapter`** — `SoulPassWalletAdapter` + `deriveVaultPDA`
  (the PDA validators are re-exported here for compatibility).
  `signTransaction()` throws by design: SoulPass signs-and-submits in one
  step; dApps use `sendTransaction`.
- **`./protocol`** — the MachineWallet protocol layer, mirroring
  `machine-wallet/program/src`: program constants and error codes
  (`wire-format/constants.ts`, `wire-format/errors.ts`); wallet and session
  PDAs (`deriveWalletPda`, `deriveSessionPda`) and ephemeral signers; account
  decoders for the wallet (`parseWalletState`, `predictNextExecuteNonce`) and
  the session (`parseSessionState`, `isSessionLive`); and wire formats
  (`src/wire-format/`): signed-message envelope, operation tags, every
  `compute*Message`, the disc table (`MachineWalletDisc`, `REJECTED_DISCS`),
  every instruction-data builder with its account table, and the session
  parameters (`validateSessionParams`, `hashSessionData`). This layer is
  deliberately isomorphic: builders return `Uint8Array`, `@solana/web3.js`
  is an optional peer dependency, and `types.ts` stays peerDep-free at
  runtime.

### MachineWallet account layout

There is one layout per account kind, told apart by byte 0 — no version
field, no older layout to fall back to:

- **Wallet (`'W'`, 0x57)** — a 186-byte header (`bump`, `wallet_id`,
  `threshold`, `authority_count`, `nonce` (funds N), `creation_slot`,
  `vault_bump`, `root`, `authority_epoch`, `pending_root`, `recovery_eta`,
  `vault`, `recovery_threshold`, `session_nonce` (S) @170, `governance_nonce`
  (G) @178) followed by `authority_count` 34-byte authority slots. Each signed
  message binds exactly one of N / S / G / the target session's generation;
  `compute*Message` takes it under its own name (`fundsNonce`,
  `sessionNonce`, `governanceNonce`, `generation`).
  `parseWalletState` accepts exactly `walletAccountSize(count)` bytes and
  rejects what the program's validating `deserialize` rejects (a pending root
  with eta 0 is accepted, as on chain). Offsets: `src/wallet-state.ts`.
- **Session (`'S'`, 0x53)** — a 109-byte header (`generation` @101, the
  post-increment funds nonce of the CreateSession that made it; session-key
  instructions and the owner's RevokeSession bind it), the allowed programs, the
  mandate hash, the creator slot, the rent payer, the cash budgets and a
  16-slot sleeve (`sessionAccountSize(P, C)`). `isSessionLive` mirrors
  `SessionExecute`: not revoked, `slot <= expiry_slot` (live through the
  expiry slot inclusive), and the session's wallet creation slot and
  authority epoch still match the wallet. Pairing the session with the right
  wallet account is the caller's job. Offsets: `src/wire-format/session-state.ts`.

Byte-0 values 0, 1 and 2 (`RETIRED_ACCOUNT_TAGS`) and discriminators 13, 14,
18 and 19 (`REJECTED_DISCS`) are never produced.

### Builder conventions

Every instruction-data builder takes one object parameter (`maxSlot`
included) and validates widths and byte ranges, throwing `RangeError`.
`buildCreateSessionIxData` and `hashSessionData` run `validateSessionParams`
first, which reports faults in the program's order (decoder counts, then
handler checks). `buildExecuteIxData` builds Execute (disc 1) when
`ephemeralSignerBumps` is omitted and ExecuteWithEphemeralSigners (disc 16)
for 1..=4 bumps; an empty array throws.

**`./payments`** (with its hook, **`./payments-react`**) is an additive application layer above the
chain-neutral payment wallet port. It owns canonical multichain PaymentIntent
types, funded-route selection, payment-specific recovery semantics and the
standard HTTP adapter. It deliberately never imports a transaction builder:
the payment API returns semantic Solana/EIP-7702 execution instructions and
the wallet uses its existing chain submission paths. Web3 consumers retain the
arbitrary-transaction path described above. See
[PAYMENTS.md](./PAYMENTS.md) for the control-plane contract.

What is *not* here: PoP relay encoding and ceremony orchestration currently
live in `soulpass-ai/lib/pop-relay.ts` (browser) and the Swift SDK's
`AuthorityCeremony.swift`. This SDK provides only the pure hash primitive
(`computeAddAuthorityPopMessage`).

## Cross-language contract inventory

Everything below must stay byte-identical (or explicitly documented as
divergent) across TS / Swift / Rust. Current guarantee strength:

| Contract | TS | Swift | Guarantee today |
|---|---|---|---|
| signed-message envelope + operation tags | `src/wire-format/` | `MachineWalletSignedMessage.swift` | ✅ shared KAT vectors generated by Rust (`machine-wallet/program/tests/vectors/signed_message_kat.json`, 57 vectors = 19 operations × 3 deployment domains), copied byte-for-byte into both SDKs' test fixtures; every `compute*Message` is checked against every vector. Rust `kat_file_is_current` gates drift, and the TS-side fixture copy's freshness is checked by `scripts/check-fixtures.mjs` in `npm test` |
| session-data hash (CreateSession) | `src/wire-format/session.ts` | `SessionCreation.swift` | ✅ `session_data_kat.json`, generated by the program and copied verbatim (same freshness check) |
| wallet + session account layout | `src/wallet-state.ts`, `src/wire-format/session-state.ts` | `WalletStateDecoder.swift`, `MachineWalletLayout.swift` | ✅ `layout_kat.json` (one wallet `'W'` and one session `'S'` vector), generated by the program and copied verbatim (same freshness check) |
| instruction data | `src/wire-format/instructions.ts`, `src/wire-format/session.ts`, `src/wire-format/execute-ix.ts` | `MachineWalletLayout.swift` | 🔶 partial. Pinned to program vectors in `layout_kat.json`: CreateSession (4), RotateRoot (17), ProposeRecovery (20), CancelRecovery (21), ExecuteRecovery (22), BumpEpoch (23), SetRecoveryThreshold (24). Every other builder (CreateWallet, Execute/ExecuteWithEphemeralSigners, CloseWallet, AdvanceNonce, SessionExecute, Revoke/SelfRevoke/Close/OwnerCloseSession, AddAuthority, RemoveAuthority, SetThreshold, the evidence sidecar) is checked only by self-encoded length / first-byte / field-offset tests. Account tables (`*_ACCOUNTS`) are hand-checked against each processor's account order |
| P-256 point compression | `src/p256.ts` | `WebAuthnPubkeyCompressionTests` | ✅ self-contained golden vectors hand-synced byte-for-byte from `soulpass-swift-sdk/Tests/Fixtures/` into `tests/fixtures/p256-compression-vectors.json` (same mechanism as the signed-message KAT row above); copy-drift gated by `scripts/check-fixtures.mjs` in `npm test` — generation-gating is future work |
| EVM owner PoP digest | `soulpass-ai/lib/evm-pop.ts` | `EVM/EVMOwnerPoP.swift` | ⚠️ hand-copied golden constants in comments/tests |
| PoP relay wire (challenge/proof blobs) | `soulpass-ai/lib/pop-relay.ts` | `AuthorityCeremony.swift` | ⚠️ hand-copied golden blobs |
| ephemeral signer derivation | `src/ephemeral-signers.ts` | `SolanaSigner.swift` | ❌ comment cross-reference only, no shared vectors |
| ceremony slot window (1500) | `src/protocol.ts` | `AuthorityCeremony.challengeWindowSlots` | ❌ comment cross-reference only across languages — TS side is now single-sourced here and byte-pinned by `tests/protocol.test.ts`; Swift side remains comment-only |
| WebAuthn origin policy (exact allowlist per deployment: mainnet/local = `https://soulpass.ai`; devnet adds `https://test.soulpass.ai`) | `src/wire-format/webauthn.ts` | `PasskeyChainEvidence` | mirrors `machine-wallet` `ALLOWED_ORIGIN_HOSTS` (feature `test-origin`) and `machine-account` 1.1.0 verifier; hand-mirrored, no shared test |
| secp256r1 precompile ix layout | `src/wire-format/secp256r1.ts` | `SolanaSigner.swift` | 🔶 **intentionally divergent byte layouts** (header offsets are self-describing; both verify on-chain). Never assume byte equality across the two. |
| signed-message domain separation (`\x19SoulPass Signed Message:\n` + u32-le length preimage) | `src/wire-format/message-domain.ts` | none yet | ❌ TS-only today, no Swift or Rust counterpart — byte-pinned by `tests/wire-format/message-domain.test.ts` against a hardcoded ASCII preimage so a drift here fails loudly the moment a cross-language consumer shows up |
| PaymentIntent / PaymentExecution wire shapes | `src/payment-wire.ts` | wallet `/wallet/pay` popup + matrix-backend `PaymentIntentVo` | ❌ hand-mirrored from the backend DTOs, no shared vectors. The SDK deliberately validates only **shape** and **cross-call consistency** (prepared id == retrieved id, settlement ∈ offered options, payable status, expiry); it does **not** re-derive the issuer's arithmetic (`merchantReceives + fee == amount`, fee-rate ceilings, fee-recipient rules) and forwards unknown `execution.kind` values untouched. Re-adding those checks would turn every new settlement rail or fee model into an SDK release plus a merchant-wide upgrade, while buying no protection against a compromised issuer — which would simply adjust the fields together. Own them server-side and, when a second implementation appears, extend the KAT pattern here. |

The sync strategy is **vectors, not API parity**: extend the KAT pattern
(authoritative side generates a vector file; every consumer copies it and
tests against it; a freshness check gates CI) to the ⚠️/❌ rows above.

## Distribution

Not published to npm. Consumers vendor the built `dist/`:

- `soulpass-ai`, `tens-gg`, `slabz-io` each depend on
  `file:./vendor/soulpass-passkey-sdk` (a committed copy of `dist/`)
  (`slabz-io` currently remains on the 0.1.0 build — not yet resynced).
- Sync is manual: `npm run build` here, copy `dist/` into each consumer's
  `vendor/soulpass-passkey-sdk/`, commit there.
- `soulpass-ai` runs `scripts/check-vendor-sdk.mjs` to detect a stale
  vendor copy when this repo is checked out alongside it.

`SoulPassWalletConfig.productType` exists because of this multi-consumer
model: the popup needs the caller's product type or the JWT lands in the
wrong backend namespace.
