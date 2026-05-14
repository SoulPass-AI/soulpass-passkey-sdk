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
import type { SoulPassWalletConfig, SoulPassSession } from '../types'

export const SoulPassWalletName = 'SoulPass' as WalletName<'SoulPass'>

export class SoulPassWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = SoulPassWalletName
  url = 'https://soulpass.ai'
  icon = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxNiIgY3k9IjE2IiByPSIxNiIgZmlsbD0iIzA4MDgwYSIvPjx0ZXh0IHg9IjE2IiB5PSIyMCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iI2M0YTk2MiIgZm9udC1zaXplPSIxNCI+UzwvdGV4dD48L3N2Zz4=' as const

  readonly supportedTransactionVersions = null

  private wallet: SoulPassWallet
  private _publicKey: PublicKey | null = null
  private _connecting = false

  constructor(config: SoulPassWalletConfig = {}) {
    super()
    this.wallet = new SoulPassWallet(config)

    this.wallet.on('connect', (pk: string) => {
      this._publicKey = new PublicKey(pk)
      this.emit('connect', this._publicKey)
    })

    this.wallet.on('disconnect', () => {
      this._publicKey = null
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

  get publicKey(): PublicKey | null {
    return this._publicKey
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
