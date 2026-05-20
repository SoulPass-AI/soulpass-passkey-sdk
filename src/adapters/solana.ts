import {
  BaseMessageSignerWalletAdapter,
  WalletName,
  WalletReadyState,
  WalletSignTransactionError,
} from '@solana/wallet-adapter-base'
import type {
  Connection,
  SendOptions,
  TransactionSignature,
} from '@solana/web3.js'
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { SoulPassWallet } from '../wallet'
import type {
  SoulPassWalletConfig,
  SoulPassSession,
  SignTransactionSession,
  SignMessageSession,
  BatchSignTransactionSession,
  VaultPda,
  StatePda,
  StatePdaKey,
} from '../types'
import { asStatePdaKey } from '../types'

// --- Trust-boundary validators ---
//
// Anywhere a base58 PDA enters the SDK from an untrusted source
// (sessionStorage that might have been XSS'd, dApp user input), pass it
// through one of these to assert it's a valid 32-byte Solana pubkey
// before stamping the brand. `new PublicKey()` throws on bad bytes / wrong
// length — we keep the exception verbatim so the stack trace points at
// the ingest site, not at the downstream popup message that would
// otherwise be the first to fail.
//
// These live in adapters/solana.ts (not types.ts) because they need
// `PublicKey` at runtime; types.ts must stay peerDep-free.

/** Validate `s` is a base58 Solana pubkey and stamp the {@link VaultPda} brand. */
export function validateVaultPda(s: string): VaultPda {
  new PublicKey(s)
  return s as VaultPda
}

/** Validate `s` is a base58 Solana pubkey and stamp the {@link StatePda} brand. */
export function validateStatePda(s: string): StatePda {
  new PublicKey(s)
  return s as StatePda
}

export const SoulPassWalletName = 'SoulPass' as WalletName<'SoulPass'>

export class SoulPassWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = SoulPassWalletName
  url = 'https://soulpass.ai'
  icon = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxNiIgY3k9IjE2IiByPSIxNiIgZmlsbD0iIzA4MDgwYSIvPjx0ZXh0IHg9IjE2IiB5PSIyMCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iI2M0YTk2MiIgZm9udC1zaXplPSIxNCI+UzwvdGV4dD48L3N2Zz4=' as const

  readonly supportedTransactionVersions = null

  private wallet: SoulPassWallet
  private _publicKey: PublicKey | null = null
  private _accountAddress: StatePdaKey | null = null
  private _connecting = false

  constructor(config: SoulPassWalletConfig = {}) {
    super()
    this.wallet = new SoulPassWallet(config)

    this.wallet.on('connect', (pk: VaultPda) => {
      this._publicKey = new PublicKey(pk)
      const acct = this.wallet.accountAddress
      this._accountAddress = acct ? asStatePdaKey(new PublicKey(acct)) : null
      this.emit('connect', this._publicKey)
    })

    this.wallet.on('disconnect', () => {
      this._publicKey = null
      this._accountAddress = null
      this.emit('disconnect')
    })

    // Forward matrix-user session so dApps can subscribe via the adapter
    // rather than reaching into the inner wallet. Cast is needed because
    // `BaseMessageSignerWalletAdapter.emit` types are closed to the base
    // event set.
    this.wallet.on('session', (session: SoulPassSession) => {
      ;(this as unknown as {
        emit: (event: 'soulpass-session', session: SoulPassSession) => void
      }).emit('soulpass-session', session)
    })
  }

  /**
   * Matrix-user JWT obtained during the passkey signin popup. Null when
   * disconnected, or when the popup build predates session forwarding.
   * Read after `connect()` resolves, or subscribe to the
   * `'soulpass-session'` event to be notified on each connection.
   */
  get session(): SoulPassSession | null {
    return this.wallet.session
  }

  /**
   * Open the sign popup synchronously inside a click handler so the dApp can
   * preserve transient user activation while async tx-build is still pending.
   * The returned session's `.send(serializedTx)` posts the bytes to the popup
   * once they're ready. See `SoulPassWallet.beginSignTransaction` for the
   * timing rules — this is just a passthrough so dApp code that holds the
   * adapter instance doesn't need a reference to the inner wallet.
   */
  beginSignTransaction(): SignTransactionSession {
    return this.wallet.beginSignTransaction()
  }

  /** Same gesture-preserving two-phase contract as `beginSignTransaction`, for
   * WebAuthn-bound message signing. */
  beginSignMessage(): SignMessageSession {
    return this.wallet.beginSignMessage()
  }

  /**
   * Batch counterpart of `beginSignTransaction` — opens the popup once and
   * handles N consecutive signs in the same window. See
   * `SoulPassWallet.beginBatchSignTransaction` for timing rules and contract.
   */
  beginBatchSignTransaction(): BatchSignTransactionSession {
    return this.wallet.beginBatchSignTransaction()
  }

  get publicKey(): PublicKey | null {
    return this._publicKey
  }

  /**
   * MachineWallet state PDA (NOT the vault PDA the wallet-adapter reports
   * as `publicKey`). The protocol seed for `deriveEphemeralSigners` and
   * `predictNextExecuteNonce`; passing `publicKey` / `walletAddress` (which
   * are both the vault PDA) into those silently breaks disc=16 Execute.
   *
   * Null until `connect()` (or `restoreSession()`) resolves.
   */
  get accountAddress(): StatePdaKey | null {
    return this._accountAddress
  }

  get connecting(): boolean {
    return this._connecting
  }

  get connected(): boolean {
    return this.wallet.connected
  }

  get readyState(): WalletReadyState {
    return WalletReadyState.Installed
  }

  async connect(): Promise<void> {
    this._connecting = true
    try {
      await this.wallet.connect()
    } finally {
      this._connecting = false
    }
  }

  async disconnect(): Promise<void> {
    this.wallet.disconnect()
  }

  /**
   * Restore a previously-persisted SoulPass session so that `beginSign*()`
   * is callable without re-running WebAuthn. Silent: does NOT emit the
   * `connect` event — page-reload bootstraps should not re-trigger
   * wallet-adapter `connect` subscribers (they already ran in the original
   * tab session).
   *
   * Trust boundary: `state` may come from sessionStorage (XSS-tamperable)
   * or dApp user input. The `new PublicKey()` calls below throw on
   * malformed base58, halting the restore with a useful stack trace
   * instead of leaking garbage into the next sign-popup message. The
   * caller-friendly equivalent (`validateVaultPda` / `validateStatePda`)
   * is exported so dApps can validate at their own persistence boundary
   * too.
   */
  restoreSession(state: {
    publicKey: VaultPda
    walletAddress: VaultPda
    accountAddress: StatePda
    session: SoulPassSession | null
  }): void {
    if (state.publicKey !== state.walletAddress) {
      // Wire-level invariant: both fields carry the same vault PDA.
      // Divergence means the caller's `state` was synthesised or
      // corrupted — fail before either value reaches the popup.
      throw new Error(
        `restoreSession: state.publicKey (${state.publicKey}) !== state.walletAddress (${state.walletAddress})`,
      )
    }
    const vaultKey = new PublicKey(state.walletAddress)
    const acctKey = new PublicKey(state.accountAddress)
    this.wallet.restoreSession(state)
    this._publicKey = vaultKey
    this._accountAddress = asStatePdaKey(acctKey)
  }

  /**
   * SoulPass signs + submits in a single WebAuthn-bound step. There is no
   * "pre-signed tx" to hand back to the dApp — attempting to return one would
   * lose the on-chain ExecuteWebAuthn wrapper. dApps should use sendTransaction.
   */
  async signTransaction<T extends Transaction | VersionedTransaction>(_transaction: T): Promise<T> {
    throw new WalletSignTransactionError(
      'SoulPass does not expose signTransaction — use sendTransaction (one-step sign+submit).',
    )
  }

  async sendTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
    _connection: Connection,
    _options?: SendOptions,
  ): Promise<TransactionSignature> {
    const serialized = transaction.serialize({ requireAllSignatures: false } as any) as Uint8Array
    return this.wallet.signAndSendTransaction(serialized)
  }

  /**
   * Returns only the raw WebAuthn assertion signature. A dApp cannot verify
   * this byte sequence against a Solana Ed25519 public key — passkey-aware
   * dApps should call `SoulPassWallet.signMessage` directly to also receive
   * `authenticatorData` + `clientDataJSON`.
   */
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const result = await this.wallet.signMessage(message)
    return result.signature
  }
}
