/**
 * @soulpass/passkey-sdk/react — React integration layer.
 *
 * `<SoulPassProvider>` owns one `SoulPassWallet` instance, persists the
 * connection to sessionStorage, and silently restores it on page reload so
 * users don't re-tap their passkey on every refresh. `useSoulPass()` exposes
 * connection state and the signing API.
 *
 * The `beginSign*` functions returned by the hook are the SAME synchronous
 * functions as on `SoulPassWallet` — call them directly inside a click
 * handler, never after an `await`, or the browser drops the popup's
 * transient-user-activation grant.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { SoulPassWallet } from '../wallet'
import type {
  BatchSignTransactionSession,
  SignMessageSession,
  SignTransactionSession,
  SoulPassSession,
  SoulPassWalletConfig,
  StatePda,
  VaultPda,
} from '../types'

/** Shape persisted to sessionStorage — exactly `restoreSession()`'s input. */
interface PersistedConnection {
  publicKey: VaultPda
  walletAddress: VaultPda
  accountAddress: StatePda
  session: SoulPassSession | null
}

export interface SoulPassContextValue {
  /** The underlying wallet — an escape hatch for anything the hook doesn't surface. */
  wallet: SoulPassWallet
  connected: boolean
  connecting: boolean
  /** Vault PDA — the user-facing Solana address. Null while disconnected. */
  walletAddress: VaultPda | null
  /** MachineWallet state PDA — only needed for advanced flows (see ARCHITECTURE.md). */
  accountAddress: StatePda | null
  /** Matrix-user JWT from the signin popup, when the popup forwarded one. */
  session: SoulPassSession | null
  /** Last connect() failure, cleared on the next attempt. */
  error: Error | null
  /** Open the connect popup. Call from a click handler. */
  connect: () => Promise<void>
  disconnect: () => void
  /** Synchronous passthroughs — call inside the click handler tick. */
  beginSignTransaction: () => SignTransactionSession
  beginSignMessage: () => SignMessageSession
  beginBatchSignTransaction: () => BatchSignTransactionSession
}

const SoulPassContext = createContext<SoulPassContextValue | null>(null)

export interface SoulPassProviderProps {
  config?: SoulPassWalletConfig
  /**
   * Persist the connection to sessionStorage and restore it on reload
   * (default true). The stored value is addresses + the short-lived access
   * token — never key material; the passkey itself never leaves the
   * authenticator.
   */
  persist?: boolean
  /** Override the sessionStorage key. Default scopes by productType. */
  storageKey?: string
  children: ReactNode
}

function readPersisted(key: string): PersistedConnection | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<PersistedConnection>
    if (
      typeof v.publicKey !== 'string' ||
      typeof v.walletAddress !== 'string' ||
      typeof v.accountAddress !== 'string' ||
      v.publicKey !== v.walletAddress
    ) {
      return null
    }
    return {
      publicKey: v.publicKey as VaultPda,
      walletAddress: v.walletAddress as VaultPda,
      accountAddress: v.accountAddress as StatePda,
      session:
        v.session && typeof v.session.accessToken === 'string' ? v.session : null,
    }
  } catch {
    // Corrupt JSON / storage blocked — treat as signed-out, never throw
    // during render bootstrap.
    return null
  }
}

export function SoulPassProvider({
  config,
  persist = true,
  storageKey,
  children,
}: SoulPassProviderProps) {
  // One wallet per provider lifetime. Config is captured on first render —
  // remount the provider (e.g. via `key`) to change network/productType.
  const walletRef = useRef<SoulPassWallet | null>(null)
  if (walletRef.current === null) {
    walletRef.current = new SoulPassWallet(config)
  }
  const wallet = walletRef.current

  const key =
    storageKey ?? `soulpass:connection:${config?.productType ?? 'default'}`

  // One state slot for the whole connection — `connected` and the address /
  // session fields are all views of it, so the pieces can't drift apart and
  // every write point is a single setConnection call.
  const [connection, setConnection] = useState<PersistedConnection | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Restore once on mount, before the user can interact. Synchronous
  // (sessionStorage), so there is no "flash of signed-out" beyond the first
  // render.
  useEffect(() => {
    if (!persist || typeof window === 'undefined') return
    if (wallet.connected) return
    const saved = readPersisted(key)
    if (!saved) return
    try {
      wallet.restoreSession(saved)
    } catch {
      sessionStorage.removeItem(key)
      return
    }
    setConnection(saved)
  }, [])

  // Keep React state honest if something disconnects the wallet directly.
  useEffect(() => {
    const onDisconnect = () => {
      setConnection(null)
      if (persist && typeof window !== 'undefined') sessionStorage.removeItem(key)
    }
    wallet.on('disconnect', onDisconnect)
    return () => wallet.off('disconnect', onDisconnect)
  }, [wallet, persist, key])

  const connect = useCallback(async () => {
    setError(null)
    setConnecting(true)
    try {
      const result = await wallet.connect()
      const next: PersistedConnection = {
        publicKey: result.publicKey,
        walletAddress: result.walletAddress,
        accountAddress: result.accountAddress,
        session: result.session ?? null,
      }
      setConnection(next)
      if (persist && typeof window !== 'undefined') {
        try {
          sessionStorage.setItem(key, JSON.stringify(next))
        } catch {
          // Storage full / blocked — connection still works for this page view.
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
      throw err
    } finally {
      setConnecting(false)
    }
  }, [wallet, persist, key])

  const disconnect = useCallback(() => {
    // wallet.disconnect() emits 'disconnect' → the effect above clears
    // state + storage.
    wallet.disconnect()
  }, [wallet])

  // Bound passthroughs, NOT wrapped in anything async — the synchronous
  // call-in-click-handler contract must survive the hook layer.
  const beginSignTransaction = useCallback(
    () => wallet.beginSignTransaction(),
    [wallet],
  )
  const beginSignMessage = useCallback(() => wallet.beginSignMessage(), [wallet])
  const beginBatchSignTransaction = useCallback(
    () => wallet.beginBatchSignTransaction(),
    [wallet],
  )

  const value = useMemo<SoulPassContextValue>(
    () => ({
      wallet,
      connected: connection !== null,
      connecting,
      walletAddress: connection?.walletAddress ?? null,
      accountAddress: connection?.accountAddress ?? null,
      session: connection?.session ?? null,
      error,
      connect,
      disconnect,
      beginSignTransaction,
      beginSignMessage,
      beginBatchSignTransaction,
    }),
    [
      wallet,
      connection,
      connecting,
      error,
      connect,
      disconnect,
      beginSignTransaction,
      beginSignMessage,
      beginBatchSignTransaction,
    ],
  )

  return <SoulPassContext.Provider value={value}>{children}</SoulPassContext.Provider>
}

export function useSoulPass(): SoulPassContextValue {
  const ctx = useContext(SoulPassContext)
  if (ctx === null) {
    throw new Error(
      'useSoulPass must be used inside <SoulPassProvider> — wrap your app root with it.',
    )
  }
  return ctx
}
