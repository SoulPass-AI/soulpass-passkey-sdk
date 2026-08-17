// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SoulPassProvider, useSoulPass, type SoulPassContextValue } from '../src/react'
import { SoulPassWallet } from '../src/wallet'

// The provider's contract: one wallet instance, session persisted to
// sessionStorage, silently restored on reload, cleared on disconnect —
// and beginSign* passed through synchronously (no async wrapper that
// would burn transient user activation).

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VAULT = '7xKXjJ8x9kN3mNpQrStuvWxY1zZ2aAbBcCdDeEfFgG'
const STATE = '4rL8RczAsg3MHfJkMPXN5pzGYrmE1EWQP6pJqBrxVo'
const KEY = 'soulpass:connection:default'

let container: HTMLDivElement
let root: Root
let latest: SoulPassContextValue | null

function Probe() {
  latest = useSoulPass()
  return null
}

function render(ui: React.ReactNode) {
  act(() => {
    root.render(ui)
  })
}

beforeEach(() => {
  sessionStorage.clear()
  latest = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('SoulPassProvider', () => {
  it('starts disconnected and exposes the wallet instance', () => {
    render(
      <SoulPassProvider>
        <Probe />
      </SoulPassProvider>,
    )
    expect(latest!.connected).toBe(false)
    expect(latest!.walletAddress).toBeNull()
    expect(latest!.wallet).toBeInstanceOf(SoulPassWallet)
  })

  it('connect() updates state and persists to sessionStorage', async () => {
    render(
      <SoulPassProvider>
        <Probe />
      </SoulPassProvider>,
    )
    vi.spyOn(latest!.wallet, 'connect').mockImplementation(async () => {
      // Mirror the real connect(): mutate wallet state, then resolve.
      latest!.wallet.restoreSession({
        publicKey: VAULT,
        walletAddress: VAULT,
        accountAddress: STATE,
        session: { accessToken: 'jwt-abc' },
      } as any)
      return {
        publicKey: VAULT,
        walletAddress: VAULT,
        accountAddress: STATE,
        session: { accessToken: 'jwt-abc' },
      } as any
    })

    await act(async () => {
      await latest!.connect()
    })

    expect(latest!.connected).toBe(true)
    expect(latest!.walletAddress).toBe(VAULT)
    expect(latest!.accountAddress).toBe(STATE)
    expect(latest!.session?.accessToken).toBe('jwt-abc')
    expect(JSON.parse(sessionStorage.getItem(KEY)!)).toMatchObject({
      walletAddress: VAULT,
      accountAddress: STATE,
      session: { accessToken: 'jwt-abc' },
    })
  })

  it('restores a persisted connection on mount without re-running WebAuthn', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        publicKey: VAULT,
        walletAddress: VAULT,
        accountAddress: STATE,
        session: { accessToken: 'jwt-restored' },
      }),
    )
    render(
      <SoulPassProvider>
        <Probe />
      </SoulPassProvider>,
    )
    expect(latest!.connected).toBe(true)
    expect(latest!.walletAddress).toBe(VAULT)
    expect(latest!.session?.accessToken).toBe('jwt-restored')
    // The inner wallet must be primed too, so beginSign* passes assertConnected.
    expect(latest!.wallet.connected).toBe(true)
  })

  it('rejects tampered persisted state (publicKey ≠ walletAddress)', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        publicKey: 'EvILAddressvILAddressvILAddressvILAddress11',
        walletAddress: VAULT,
        accountAddress: STATE,
        session: null,
      }),
    )
    render(
      <SoulPassProvider>
        <Probe />
      </SoulPassProvider>,
    )
    expect(latest!.connected).toBe(false)
  })

  it('disconnect() clears state and storage', async () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        publicKey: VAULT,
        walletAddress: VAULT,
        accountAddress: STATE,
        session: null,
      }),
    )
    render(
      <SoulPassProvider>
        <Probe />
      </SoulPassProvider>,
    )
    expect(latest!.connected).toBe(true)

    act(() => latest!.disconnect())
    expect(latest!.connected).toBe(false)
    expect(latest!.walletAddress).toBeNull()
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })

  it('connect() failure lands in error state and rethrows', async () => {
    render(
      <SoulPassProvider>
        <Probe />
      </SoulPassProvider>,
    )
    const boom = new Error('POPUP_CLOSED: user closed the wallet window')
    vi.spyOn(latest!.wallet, 'connect').mockRejectedValue(boom)

    await act(async () => {
      await expect(latest!.connect()).rejects.toBe(boom)
    })
    expect(latest!.error).toBe(boom)
    expect(latest!.connected).toBe(false)
  })

  it('beginSignTransaction is a synchronous passthrough (activation-safe)', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        publicKey: VAULT,
        walletAddress: VAULT,
        accountAddress: STATE,
        session: null,
      }),
    )
    render(
      <SoulPassProvider>
        <Probe />
      </SoulPassProvider>,
    )
    const fakeSession = { send: vi.fn(), cancel: vi.fn() }
    const spy = vi
      .spyOn(latest!.wallet, 'beginSignTransaction')
      .mockReturnValue(fakeSession as any)
    // Must return the session in the same tick — a Promise here would mean
    // an async wrapper snuck in and user activation is already lost.
    const session = latest!.beginSignTransaction()
    expect(session).toBe(fakeSession)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('useSoulPass outside the provider throws with guidance', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(/SoulPassProvider/)
    spy.mockRestore()
  })

  it('scopes the storage key by productType', async () => {
    render(
      <SoulPassProvider config={{ productType: 'tens' }}>
        <Probe />
      </SoulPassProvider>,
    )
    vi.spyOn(latest!.wallet, 'connect').mockResolvedValue({
      publicKey: VAULT,
      walletAddress: VAULT,
      accountAddress: STATE,
    } as any)
    await act(async () => {
      await latest!.connect()
    })
    expect(sessionStorage.getItem('soulpass:connection:tens')).not.toBeNull()
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })
})
