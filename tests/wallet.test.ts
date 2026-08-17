import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SoulPassWallet } from '../src/wallet'
import {
  CHANNEL_ID_CHARS,
  setupPopupSpies,
  connectedWallet as connected,
  TEST_VAULT,
} from './helpers'

describe('SoulPassWallet', () => {
  let wallet: SoulPassWallet

  beforeEach(() => {
    wallet = new SoulPassWallet({ network: 'devnet' })
  })

  it('initializes as disconnected', () => {
    expect(wallet.connected).toBe(false)
    expect(wallet.publicKey).toBeNull()
    expect(wallet.walletAddress).toBeNull()
  })

  it('emits connect event', () => {
    const handler = vi.fn()
    wallet.on('connect', handler)

    // publicKey === walletAddress is the wire-level invariant — both
    // carry the vault PDA. Pre-dedup the test passed two different
    // strings, which the SDK never produced and which masked the
    // SSoT bug this dedup eliminates.
    const vault = '7xKXjJ8x9kN3mNpQrStuvWxY1zZ2aAbBcCdDeEfFgG'
    const acct = '4rL8RczAsg3MHfJkMPXN5pzGYrmE1EWQP6pJqBrxVo'
    wallet['handleConnectSuccess']({
      publicKey: vault,
      walletAddress: vault,
      accountAddress: acct,
    } as any)

    expect(handler).toHaveBeenCalledWith(vault)
    expect(wallet.connected).toBe(true)
    expect(wallet.publicKey).toBe(vault)
    expect(wallet.walletAddress).toBe(vault)
    expect(wallet.accountAddress).toBe(acct)
  })

  it('emits disconnect event', () => {
    const handler = vi.fn()
    wallet.on('disconnect', handler)

    const vault = '7xKXjJ8x9kN3mNpQrStuvWxY1zZ2aAbBcCdDeEfFgG'
    wallet['handleConnectSuccess']({
      publicKey: vault,
      walletAddress: vault,
      accountAddress: '4rL8RczAsg3MHfJkMPXN5pzGYrmE1EWQP6pJqBrxVo',
    } as any)
    wallet.disconnect()

    expect(handler).toHaveBeenCalled()
    expect(wallet.connected).toBe(false)
    expect(wallet.publicKey).toBeNull()
    expect(wallet.accountAddress).toBeNull()
  })

  it('throws on signTransaction when disconnected', async () => {
    await expect(wallet.signTransaction(new Uint8Array())).rejects.toThrow('Wallet not connected')
  })

  it('throws on signMessage when disconnected', async () => {
    await expect(wallet.signMessage(new Uint8Array())).rejects.toThrow('Wallet not connected')
  })

  it('removes event handler with off()', () => {
    const handler = vi.fn()
    wallet.on('disconnect', handler)
    wallet.off('disconnect', handler)

    wallet['handleConnectSuccess']({
      publicKey: 'test',
      walletAddress: 'test',
      accountAddress: 'test',
    } as any)
    wallet.disconnect()

    expect(handler).not.toHaveBeenCalled()
  })

  it('forwards productType to popup on CONNECT', () => {
    // Why this is pinned: passkey signin is hosted by a cross-origin popup whose
    // own X-Exchange-Info reflects productType=soulpass. The dApp's productType
    // (e.g. 'tens') must reach matrix-user via the CONNECT payload → popup verify
    // body → JwtSessionStore.issueWithProductOverride. Drop the forwarding and
    // the JWT lands under the popup's namespace and the Gateway on the dApp's
    // domain returns 401 immediately after sign-in.
    const w = new SoulPassWallet({ network: 'devnet', productType: 'tens' })
    const sendSpy = vi.spyOn(w['popup'], 'send').mockImplementation(() => {})
    vi.spyOn(w['popup'], 'open').mockImplementation(() => ({}) as Window)
    let onMessage: ((msg: any) => void) | null = null
    vi.spyOn(w['popup'], 'onMessage').mockImplementation((h) => {
      onMessage = h as typeof onMessage
    })
    vi.spyOn(w['popup'], 'close').mockImplementation(() => {})

    void w.connect()
    // Popup handshake — the SDK only sends CONNECT after READY arrives, so the
    // forwarding bug is invisible until a real popup is loaded. Synthesizing
    // READY here exercises the same code path under unit-test latency.
    onMessage?.({ type: 'READY' })

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'CONNECT',
      id: expect.any(String),
      payload: { network: 'devnet', productType: 'tens' },
    })
  })

  describe('beginSignTransaction (two-phase)', () => {
    /**
     * The whole point of the two-phase API is to keep `popup.open()` on the
     * synchronous click-handler tick. These tests pin the state machine so a
     * refactor that re-orders open/send/onMessage can't silently re-introduce
     * the popup-becomes-a-tab regression.
     */
    it('opens the popup synchronously (preserves user gesture)', () => {
      const w = connected()
      const { openSpy } = setupPopupSpies(w)
      w.beginSignTransaction()
      // Same-tick assertion — open() must have fired before any microtask hop.
      // Since the dual-channel flow the path carries a relay channel id so an
      // iOS universal-link takeover knows which mailbox to claim.
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^/wallet/sign\\?channel=${CHANNEL_ID_CHARS}$`)),
      )
    })

    it('queues send() until popup READY arrives', () => {
      const w = connected()
      const { sendSpy, getOnMessage } = setupPopupSpies(w)
      const session = w.beginSignTransaction()

      // Caller calls send before popup has loaded — must NOT send yet.
      void session.send(new Uint8Array([1, 2, 3]))
      expect(sendSpy).not.toHaveBeenCalled()

      // Popup boots → SDK flushes the queued SIGN_TRANSACTION message.
      getOnMessage()?.({ type: 'READY' })
      expect(sendSpy).toHaveBeenCalledTimes(1)
      const message = sendSpy.mock.calls[0][0] as { type: string }
      expect(message.type).toBe('SIGN_TRANSACTION')
    })

    it('sends immediately when send() is called after popup READY', () => {
      const w = connected()
      const { sendSpy, getOnMessage } = setupPopupSpies(w)
      const session = w.beginSignTransaction()

      // Popup ready first → no queued payload to flush yet.
      getOnMessage()?.({ type: 'READY' })
      expect(sendSpy).not.toHaveBeenCalled()

      // Caller's tx-build resolves → send() posts straightaway.
      void session.send(new Uint8Array([1, 2, 3]))
      expect(sendSpy).toHaveBeenCalledTimes(1)
    })

    it('resolves with the signature on SIGN_SUCCESS', async () => {
      const w = connected()
      const { getOnMessage } = setupPopupSpies(w)
      const session = w.beginSignTransaction()
      getOnMessage()?.({ type: 'READY' })

      const promise = session.send(new Uint8Array([1, 2, 3]))
      // The popup answers with the matching id — pull it off the spy.
      const messageId = (
        vi.mocked(w['popup'].send).mock.calls[0][0] as { id: string }
      ).id
      getOnMessage()?.({
        type: 'SIGN_SUCCESS',
        id: messageId,
        payload: { signature: 'sigBase58' },
      })
      await expect(promise).resolves.toEqual({ signature: 'sigBase58' })
    })

    it('cancel() rejects a pending send() with CANCELLED', async () => {
      const w = connected()
      setupPopupSpies(w)
      const session = w.beginSignTransaction()
      const promise = session.send(new Uint8Array([1]))
      session.cancel('user closed')
      await expect(promise).rejects.toThrow(/CANCELLED/)
    })

    it('throws on a second send() — sessions are single-shot', async () => {
      const w = connected()
      const { getOnMessage } = setupPopupSpies(w)
      const session = w.beginSignTransaction()
      getOnMessage()?.({ type: 'READY' })

      // First call wires up the pending promise but never resolves (no
      // SIGN_SUCCESS injected). Second call must reject immediately so a
      // confused caller can't accidentally double-spend.
      void session.send(new Uint8Array([1]))
      await expect(session.send(new Uint8Array([2]))).rejects.toThrow(/single-shot/)
    })

    it('rejects send() on popup ERROR', async () => {
      const w = connected()
      const { getOnMessage } = setupPopupSpies(w)
      const session = w.beginSignTransaction()
      getOnMessage()?.({ type: 'READY' })

      const promise = session.send(new Uint8Array([1]))
      const messageId = (
        vi.mocked(w['popup'].send).mock.calls[0][0] as { id: string }
      ).id
      getOnMessage()?.({
        type: 'ERROR',
        id: messageId,
        payload: { code: 'USER_REJECTED', message: 'user said no' },
      })
      await expect(promise).rejects.toThrow(/USER_REJECTED.*user said no/)
    })
  })

  describe('beginPaymentAuthorization (two-leg checkout)', () => {
    const intent = {
      id: 'pi_test',
      status: 'requires_confirmation' as const,
      presentment: { value: '1000000', decimals: 6, currency: 'USDC' },
      settlementOptions: [{
        id: 'pmo_sol',
        rail: 'solana_spl',
        network: 'SOLANA',
        chainType: 'SOLANA',
        chainId: 'devnet',
        assetAddress: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        amount: { value: '1000000', decimals: 6, currency: 'USDC' },
        merchantReceives: { value: '1000000', decimals: 6, currency: 'USDC' },
        protocolFee: {
          basisPoints: 0,
          amount: { value: '0', decimals: 6, currency: 'USDC' },
          recipient: null,
        },
        recipient: TEST_VAULT,
      }],
      merchant: { id: 'merchant', name: 'Merchant' },
      createdAt: new Date().toISOString(),
    }

    it('opens /wallet/pay synchronously and keeps discovery + execution in one popup', async () => {
      const w = connected()
      const { openSpy, sendSpy, getOnMessage } = setupPopupSpies(w)
      const session = w.beginPaymentAuthorization()

      expect(openSpy).toHaveBeenCalledWith('/wallet/pay')
      const accountsPromise = session.getPaymentAccounts(intent, 'pdt_test_token')
      expect(sendSpy).not.toHaveBeenCalled()

      getOnMessage()?.({ type: 'READY' })
      // The display token rides the first leg so the popup can fetch canonical
      // intent state itself; the relayed intent is only a first-paint hint.
      expect(sendSpy).toHaveBeenCalledWith({
        type: 'PAYMENT_DISCOVER',
        id: expect.any(String),
        payload: { intent, displayToken: 'pdt_test_token' },
      })
      const id = (sendSpy.mock.calls[0][0] as { id: string }).id
      getOnMessage()?.({
        type: 'PAYMENT_ACCOUNTS',
        id,
        payload: {
          accounts: [{
            settlementOptionId: 'pmo_sol',
            payerAddress: TEST_VAULT,
            availableAmount: '2000000',
          }],
        },
      })
      await expect(accountsPromise).resolves.toHaveLength(1)

      const execution = {
        kind: 'solana_machine_wallet_transfer' as const,
        protocol: 'solana_machine_wallet_execute_v1' as const,
        network: 'SOLANA',
        account: TEST_VAULT,
        mint: intent.settlementOptions[0].assetAddress,
        recipient: TEST_VAULT,
        amount: '1000000',
        protocolFeeRecipient: null,
        protocolFeeAmount: '0',
        decimals: 6,
        submissionPath: '/v1/wallet/solana/tx/submit' as const,
      }
      const executePromise = session.execute(execution)
      expect(sendSpy).toHaveBeenLastCalledWith({
        type: 'PAYMENT_EXECUTE',
        id,
        payload: { execution },
      })
      getOnMessage()?.({
        type: 'PAYMENT_SUCCESS',
        id,
        payload: { transactionId: 'solana-signature' },
      })
      await expect(executePromise).resolves.toEqual({ transactionId: 'solana-signature' })
    })

    it('refuses execution before wallet-owned balance discovery completes', async () => {
      const w = connected()
      setupPopupSpies(w)
      const session = w.beginPaymentAuthorization()
      await expect(session.execute({} as any)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    })

    it('holds a between-legs wallet ERROR so the next leg gets the real code', async () => {
      const w = connected()
      const { sendSpy, getOnMessage } = setupPopupSpies(w)
      const session = w.beginPaymentAuthorization()
      getOnMessage()?.({ type: 'READY' })

      const accountsPromise = session.getPaymentAccounts(intent, 'pdt_test_token')
      const id = (sendSpy.mock.calls[0][0] as { id: string }).id
      getOnMessage()?.({
        type: 'PAYMENT_ACCOUNTS',
        id,
        payload: {
          accounts: [{
            settlementOptionId: 'pmo_sol',
            payerAddress: TEST_VAULT,
            availableAmount: '2000000',
          }],
        },
      })
      await accountsPromise

      // The payer rejects in the popup while the SDK is mid-prepare: neither
      // leg is pending, so without the held error this would surface as a
      // generic CANCELLED and the merchant could not stay silent on a decline.
      getOnMessage()?.({
        type: 'ERROR',
        id,
        payload: { code: 'USER_REJECTED', message: 'payer declined' },
      })

      await expect(session.execute({} as any)).rejects.toMatchObject({
        code: 'USER_REJECTED',
      })
    })

    it('does not close the wallet window when the wallet reports a fatal ERROR', async () => {
      const w = connected()
      const { sendSpy, getOnMessage } = setupPopupSpies(w)
      const closeSpy = vi.mocked(w['popup'].close)
      const session = w.beginPaymentAuthorization()
      getOnMessage()?.({ type: 'READY' })

      const accountsPromise = session.getPaymentAccounts(intent, 'pdt_test_token')
      const id = (sendSpy.mock.calls[0][0] as { id: string }).id
      getOnMessage()?.({
        type: 'ERROR',
        id,
        payload: { code: 'PASSKEY_FAILED', message: 'ceremony failed' },
      })

      await expect(accountsPromise).rejects.toMatchObject({ code: 'PASSKEY_FAILED' })
      // The wallet keeps its error screen open so the user can read it; the SDK
      // detaches its channel but must not close a window it does not own the
      // explanation for.
      expect(closeSpy).not.toHaveBeenCalled()
    })

    it('opens checkout while disconnected so /wallet/pay can authenticate in place', () => {
      const w = new SoulPassWallet({ network: 'devnet' })
      const { openSpy } = setupPopupSpies(w)
      expect(() => w.beginPaymentAuthorization()).not.toThrow()
      expect(openSpy).toHaveBeenCalledWith('/wallet/pay')
    })
  })

  describe('connect() popup-close watchdog', () => {
    // A user who opens the connect popup and then closes it via the OS ✕
    // produces no postMessage at all. Without a watchdog the connect()
    // promise never settles and the dApp's "Connecting…" state spins forever.
    it('rejects with POPUP_CLOSED when the user closes the connect popup', async () => {
      vi.useFakeTimers()
      try {
        const w = new SoulPassWallet({ network: 'devnet' })
        let open = true
        setupPopupSpies(w, () => open)

        const promise = w.connect()
        // Attach the rejection expectation BEFORE advancing timers so the
        // rejection is observed, not unhandled.
        const expectation = expect(promise).rejects.toThrow(/POPUP_CLOSED/)
        open = false
        await vi.advanceTimersByTimeAsync(1000)
        await expectation
        expect(w.connected).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not reject after a successful connect (watchdog cleared)', async () => {
      vi.useFakeTimers()
      try {
        const w = new SoulPassWallet({ network: 'devnet' })
        let open = true
        const { getOnMessage } = setupPopupSpies(w, () => open)

        const promise = w.connect()
        getOnMessage()?.({ type: 'READY' })
        const messageId = (
          vi.mocked(w['popup'].send).mock.calls[0][0] as { id: string }
        ).id
        const vault = '7xKXjJ8x9kN3mNpQrStuvWxY1zZ2aAbBcCdDeEfFgG'
        getOnMessage()?.({
          type: 'CONNECT_SUCCESS',
          id: messageId,
          payload: {
            publicKey: vault,
            walletAddress: vault,
            accountAddress: '4rL8RczAsg3MHfJkMPXN5pzGYrmE1EWQP6pJqBrxVo',
          },
        })
        await expect(promise).resolves.toMatchObject({ walletAddress: vault })

        // Popup is closed after success — the (cleared) watchdog must not
        // fire and flip anything.
        open = false
        await vi.advanceTimersByTimeAsync(2000)
        expect(w.connected).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('omits productType from CONNECT when not configured (back-compat)', () => {
    // Older popup builds may strictly typecheck the payload — sending an explicit
    // `productType: undefined` key would still trip a "has own property" guard.
    // Spread-conditional in wallet.ts keeps the key absent when no productType.
    const w = new SoulPassWallet({ network: 'devnet' })
    const sendSpy = vi.spyOn(w['popup'], 'send').mockImplementation(() => {})
    vi.spyOn(w['popup'], 'open').mockImplementation(() => ({}) as Window)
    let onMessage: ((msg: any) => void) | null = null
    vi.spyOn(w['popup'], 'onMessage').mockImplementation((h) => {
      onMessage = h as typeof onMessage
    })
    vi.spyOn(w['popup'], 'close').mockImplementation(() => {})

    void w.connect()
    onMessage?.({ type: 'READY' })

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const sentMessage = sendSpy.mock.calls[0][0] as { payload: Record<string, unknown> }
    expect(sentMessage.payload).toEqual({ network: 'devnet' })
    expect('productType' in sentMessage.payload).toBe(false)
  })
})
