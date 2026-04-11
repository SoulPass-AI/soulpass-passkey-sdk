import {
  BaseMessageSignerWalletAdapter,
  WalletName,
  WalletReadyState,
} from '@solana/wallet-adapter-base'
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { SoulPassWallet } from '../wallet'
import type { SoulPassWalletConfig } from '../types'

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
      const result = await this.wallet.connect()
      this._publicKey = new PublicKey(result.publicKey)
      this.emit('connect', this._publicKey)
    } finally {
      this._connecting = false
    }
  }

  async disconnect(): Promise<void> {
    this.wallet.disconnect()
    this._publicKey = null
    this.emit('disconnect')
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    const serialized = transaction.serialize({ requireAllSignatures: false } as any)
    const result = await this.wallet.signTransaction(
      serialized instanceof Buffer ? new Uint8Array(serialized) : serialized
    )
    const signedBytes = base64ToUint8Array(result.signedTransaction)

    if (transaction instanceof VersionedTransaction) {
      return VersionedTransaction.deserialize(signedBytes) as T
    }
    return Transaction.from(signedBytes) as T
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return this.wallet.signMessage(message)
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
