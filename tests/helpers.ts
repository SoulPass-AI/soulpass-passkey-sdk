import { vi } from 'vitest'
import { SoulPassWallet } from '../src/wallet'

/** Character class + length of a relay channel id — the cross-stack contract
 * (backend validation, iOS AASA match) every test asserts against. */
export const CHANNEL_ID_CHARS = '[A-Za-z0-9_-]{22,64}'
export const CHANNEL_ID_RE = new RegExp(`^${CHANNEL_ID_CHARS}$`)

/** The backend wraps every relay response in `{ code, success, data }`. */
export function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ code: 200, success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Mock the four PopupManager touchpoints (open/send/onMessage/close) so a
 * wallet flow runs without a real window. Pass `isOpen` to also drive the
 * close watchdog. */
export function setupPopupSpies(w: SoulPassWallet, isOpen?: () => boolean) {
  const openSpy = vi
    .spyOn(w['popup'], 'open')
    .mockImplementation(() => ({}) as Window)
  const sendSpy = vi.spyOn(w['popup'], 'send').mockImplementation(() => {})
  vi.spyOn(w['popup'], 'close').mockImplementation(() => {})
  if (isOpen) {
    vi.spyOn(w['popup'], 'isOpen', 'get').mockImplementation(isOpen)
  }
  let onMessage: ((msg: any) => void) | null = null
  vi.spyOn(w['popup'], 'onMessage').mockImplementation((h) => {
    onMessage = h as typeof onMessage
  })
  return { openSpy, sendSpy, getOnMessage: () => onMessage }
}

export const TEST_VAULT = '7xKXjJ8x9kN3mNpQrStuvWxY1zZ2aAbBcCdDeEfFgG'
export const TEST_STATE = '4rL8RczAsg3MHfJkMPXN5pzGYrmE1EWQP6pJqBrxVo'

/** A wallet primed past connect() — beginSign* passes assertConnected. */
export function connectedWallet(): SoulPassWallet {
  const w = new SoulPassWallet({ network: 'devnet' })
  w['handleConnectSuccess']({
    publicKey: TEST_VAULT,
    walletAddress: TEST_VAULT,
    accountAddress: TEST_STATE,
  } as any)
  return w
}
