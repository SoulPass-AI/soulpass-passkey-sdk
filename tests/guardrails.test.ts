import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SoulPassWallet } from '../src/wallet'
import { PopupManager } from '../src/popup-manager'

// Runtime guardrails: the two integration mistakes that fail silently in
// production (popup downgraded to a tab; JWT in the wrong backend namespace)
// must announce themselves in the console at the moment they happen.

describe('productType warning', () => {
  // NOTE: test order matters — the warning fires once per module instance,
  // so the "configured → silent" case must run before the first
  // unconfigured construction trips the once-flag.
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('does not warn when productType is configured', () => {
    new SoulPassWallet({ network: 'devnet', productType: 'tens' })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns once (and only once) when productType is missing', () => {
    new SoulPassWallet({ network: 'devnet' })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toMatch(/productType/)
    // Post ext-namespace backend: omitting productType is VALID for third
    // parties — the warning must say so, not threaten a 401.
    expect(warnSpy.mock.calls[0][0]).toMatch(/scoped to your origin/)

    new SoulPassWallet({ network: 'devnet' })
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

describe('user-activation warning', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let openSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window)
  })
  afterEach(() => {
    warnSpy.mockRestore()
    openSpy.mockRestore()
    delete (navigator as { userActivation?: unknown }).userActivation
  })

  function setActivation(isActive: boolean) {
    Object.defineProperty(navigator, 'userActivation', {
      value: { isActive },
      configurable: true,
    })
  }

  it('warns when open() runs without transient user activation', () => {
    setActivation(false)
    new PopupManager('https://soulpass.ai').open('/wallet/connect')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toMatch(/user activation/)
  })

  it('stays silent when activation is live', () => {
    setActivation(true)
    new PopupManager('https://soulpass.ai').open('/wallet/connect')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('stays silent on browsers without navigator.userActivation', () => {
    new PopupManager('https://soulpass.ai').open('/wallet/connect')
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// Layering: `./payments` is an application layer above core. If core ever
// imports from it again, the wire types have drifted back into the feature
// module and `SoulPassWallet`'s public signatures split across two homes.
describe('module layering', () => {
  const CORE = [
    'types.ts', 'wallet.ts', 'index.ts', 'popup-manager.ts', 'protocol.ts',
    'protocol-entry.ts', 'sign-channel.ts', 'errors.ts', 'environment.ts',
    'encoding.ts', 'wallet-state.ts', 'payment-wire.ts',
  ]

  const read = async (file: string) => {
    const { readFile } = await import('node:fs/promises')
    return readFile(`${process.cwd()}/src/${file}`, 'utf8')
  }

  it('core never imports from the payments feature module', async () => {
    for (const file of CORE) {
      expect(await read(file), `${file} must not import from ./payments`)
        .not.toMatch(/from '\.\/payments/)
    }
  })

  it('keeps payment-wire runtime-free of peer dependencies', async () => {
    expect(await read('payment-wire.ts')).not.toMatch(/^import (?!type)/m)
  })
})
