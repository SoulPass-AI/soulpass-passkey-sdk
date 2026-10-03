# @soulpass/passkey-sdk

Passkey wallet and stablecoin payments for web apps. The package deliberately
has two surfaces: Web3 products keep full control of transaction construction;
Web2 products pass an amount and receiving addresses to one checkout call.

- **One tap to connect.** WebAuthn passkey → Solana smart wallet. Nothing to
  install, nothing to back up.
- **Sign + submit in one step.** The wallet signs and lands the transaction;
  you get back the signature to confirm.
- **No dashboard, no API key.** Install the package, construct the client,
  ship.

## Choose your integration

| Your product | Import | You own |
|---|---|---|
| Web3 / arbitrary on-chain actions (for example Tens) | `@soulpass/passkey-sdk` | transaction construction; SoulPass authorizes and submits |
| Web2 / checkout (for example Siya) | `@soulpass/passkey-sdk/payments` | amount, your order reference, and receiving addresses; SoulPass owns transaction construction and reconciliation |

Do not make a Web2 checkout learn about RPC nodes, token mints, ATAs,
blockhashes or Solana instructions. That complexity belongs behind the
PaymentIntent API.

## Quickstart (stablecoin payment)

No SoulPass account, API key, client secret, HMAC, or server integration is
required. Checkout opens one SoulPass-hosted popup; if necessary the user signs
in or creates a SoulPass payment wallet there, then reviews and approves the
best funded chain without a separate wallet-connect step:

```ts
import {
  createSoulPassPayments,
  isPaymentError,
} from '@soulpass/passkey-sdk/payments'

const soulpass = createSoulPassPayments()

payButton.onclick = async () => {
  try {
    const { intent, transactionId } = await soulpass.pay({
      amount: '10.00',
      currency: 'USDC',
      recipients: {
        solana: 'YOUR_SOLANA_ADDRESS',
        evm: 'YOUR_EVM_ADDRESS',
      },
      // Opaque correlation only. SoulPass does not need your order schema.
      reference: order.id,
      // Fulfilment signal: one Ed25519-signed POST per terminal state, retried
      // until your server answers 2xx. No secret to configure — verify against
      // the public key at /v1/payment-webhook-keys (see PAYMENTS.md).
      webhookUrl: 'https://api.yourshop.com/soulpass/webhook',
    })

    // Browser-side signal only — update the UI here. Fulfil the order on your
    // server when the signed webhook arrives: this callback runs in a browser
    // the payer controls, and a payer who closes the tab never reaches it.
    showReceipt(intent, transactionId)
  } catch (err) {
    if (isPaymentError(err) && err.code === 'PAYMENT_STATUS_UNKNOWN') {
      // Funds may already have moved — never create a second charge. The SDK
      // keeps the short-lived recovery capability in this tab; query the SAME
      // intent, even after a reload. Your webhook still fires when it settles.
      const current = await soulpass.retrieveDirectPayment(err.paymentIntentId!)
      showPendingState(current, err.transactionId)
    }
  }
}
```

In React, the same thing without the state plumbing — declines already do not count as
errors, and a second click cannot start a second charge:

```tsx
import { useSoulPassPayments } from '@soulpass/passkey-sdk/payments-react'

const { pay, paying, error } = useSoulPassPayments()

<button disabled={paying} onClick={() => pay({
  amount: '10.00',
  recipients: { solana: MERCHANT, evm: MERCHANT_EVM },
  reference: order.id,
  webhookUrl: 'https://api.yourshop.com/soulpass/webhook',
})}>
  {paying ? 'paying…' : 'pay $10.00'}
</button>
```

**The webhook is the fulfilment source of truth.** `pay()` resolving is a browser event:
it fires only after canonical on-chain verification, but it fires in the payer's browser,
which your server must not trust and which may already be closed. Ship goods from your
webhook endpoint after verifying the Ed25519 signature **and** checking that the event is
your order — reference, currency, amount and a recipient address you own
(`verifyPaymentWebhook` + `assertPaymentWebhookMatchesOrder` from
`@soulpass/passkey-sdk/payments`). A signature alone is not enough: anyone can create a
direct payment that names your webhook URL. Treat the resolved promise as UI state.
Verification needs no stored secret — fetch the platform public key once from
`/v1/payment-webhook-keys`. See
[PAYMENTS.md](./PAYMENTS.md#getting-the-result-on-your-server-direct-mode).

`solana` and `evm` are family aliases. SoulPass expands them across the
supported mainnets, checks the payer's live USDC balances, prefers Solana, and
falls back to a funded EVM route. Exact network keys can narrow or override the
routes. The amount passed to `pay()` is the merchant's purchase price. Any
merchant protocol fee is included in that price and deducted from settlement,
matching traditional payment processing. A separately configured EVM relay fee
remains a user-side execution charge and is shown independently by the wallet.

When `reference` is present the SDK deterministically derives the idempotency
key from it, so double-clicks and safe retries converge on the same immutable
intent. Reusing a reference with different payment parameters is rejected;
start a genuinely new checkout with a new reference.

The standard HTTP contract, authenticated advanced mode, and server-side
invariants are specified in [PAYMENTS.md](./PAYMENTS.md). The
`PaymentIntentProvider` interface remains public for tests and products with a
custom API client.

## Install

```bash
npm install @soulpass/passkey-sdk
```

> Not yet on the public npm registry — until then, vendor the built `dist/`
> (see [Distribution](./ARCHITECTURE.md#distribution)) or install from the
> git repo.

## Quickstart (Web3 / React)

```tsx
import { SoulPassProvider, useSoulPass } from '@soulpass/passkey-sdk/react'

function App() {
  return (
    <SoulPassProvider config={{ productType: 'your-product' }}>
      <Wallet />
    </SoulPassProvider>
  )
}

function Wallet() {
  const { connected, walletAddress, connect, beginSignTransaction } = useSoulPass()

  if (!connected) return <button onClick={() => connect()}>Connect</button>

  const onSend = () => {
    // ① Open the popup NOW, synchronously in the click handler…
    const session = beginSignTransaction()
    // ② …then build the transaction async and deliver it.
    buildMyTransaction(walletAddress!)
      .then((tx) => session.send(tx.serialize({ requireAllSignatures: false })))
      .then(({ signature }) => console.log('landed:', signature))
      .catch((err) => session.cancel(String(err)))
  }

  return <button onClick={onSend}>Send ({walletAddress})</button>
}
```

The provider persists the connection to `sessionStorage` and restores it on
reload — users tap their passkey once per browser session, not once per page
view.

## Quickstart (vanilla / any framework)

```ts
import { SoulPassWallet } from '@soulpass/passkey-sdk'

const wallet = new SoulPassWallet({ productType: 'your-product' })

// In a click handler:
const { walletAddress, session } = await wallet.connect()

// Later, in another click handler:
const signSession = wallet.beginSignTransaction()   // ① sync — keeps the popup
const tx = await buildMyTransaction(walletAddress)  // ② async is fine now
const { signature } = await signSession.send(
  tx.serialize({ requireAllSignatures: false }),
)
```

### The one rule: `connect()` / `beginSign*()` go inside the click handler

Browsers only allow a real popup during the click's own tick ("transient user
activation"). Call `beginSignTransaction()` synchronously in the handler,
*then* do your async transaction building, *then* `session.send(bytes)`. If
you call it after an `await`, the popup silently degrades to a tab or gets
blocked — the SDK logs a `console.warn` when it catches you doing this.

## Configuration

```ts
new SoulPassWallet({
  productType: 'your-product', // First-party Matrix products: REQUIRED (your
                               // backend ProductType name). Third-party dApps:
                               // omit it — your session is automatically
                               // scoped to your origin, zero registration.
  network: 'mainnet-beta',     // or 'devnet' (default: 'mainnet-beta')
  // walletUrl, apiUrl — advanced overrides, defaults are right (walletUrl
  // must be https; http is accepted only on localhost)
})
```

## Handling errors

Every rejection carries a typed `code` — branch on it, not on message text:

```ts
import { isSoulPassError } from '@soulpass/passkey-sdk'

try {
  await wallet.connect()
} catch (err) {
  if (isSoulPassError(err)) {
    switch (err.code) {
      case 'USER_REJECTED':  /* user said no — not an error, stay quiet */ break
      case 'POPUP_CLOSED':   /* user closed the window — offer retry */ break
      case 'POPUP_BLOCKED':  /* ask the user to allow popups */ break
      case 'IN_APP_BROWSER': /* show "open in Safari/Chrome" guidance */ break
      default:               /* NETWORK_ERROR, TIMEOUT, … — show a retry */
    }
  }
}
```

Full code list: `USER_REJECTED`, `PASSKEY_FAILED`, `NETWORK_ERROR`,
`POPUP_CLOSED`, `POPUP_BLOCKED`, `CANCELLED`, `SESSION_USED`,
`SEND_IN_FLIGHT`, `NOT_CONNECTED`, `TIMEOUT`, `SIGN_FAILED`, `BAD_REQUEST`,
`IN_APP_BROWSER`, `NO_BROWSER`, `PROTOCOL_ERROR`, `UNKNOWN` — see
`src/errors.ts` for when each fires. A popup code outside this list (a newer
wallet build) arrives as `UNKNOWN`. Payment flows add their own codes; see
PAYMENTS.md — in particular `PAYMENT_STATUS_UNKNOWN`, which is never a
decline.

## Session persistence (vanilla)

The React provider does this for you. Without it, persist the `connect()`
payload yourself and re-prime the SDK on reload:

```ts
// After connect():
sessionStorage.setItem('sp', JSON.stringify(await wallet.connect()))

// On page load:
const saved = sessionStorage.getItem('sp')
if (saved) wallet.restoreSession({ session: null, ...JSON.parse(saved) })
```

`restoreSession` is silent (no events, no passkey tap). The stored value is
addresses plus a short-lived JWT — never key material. Because storage is
untrusted, `restoreSession` validates both addresses (canonical base58,
vault ≠ state PDA) and throws on tampering; it restores the JWT only while the
absolute `session.expiresAt` that `connect()` stamps is still in the future —
otherwise `wallet.session` is `null` and you re-run `connect()` for a new
token.

## Using with @solana/wallet-adapter

```ts
import { SoulPassWalletAdapter } from '@soulpass/passkey-sdk/solana-adapter'

const adapter = new SoulPassWalletAdapter({ productType: 'your-product' })
```

One intentional difference: `adapter.signTransaction()` **throws**. SoulPass
signs and submits in a single WebAuthn-bound step, so there is no "signed but
unsent" transaction to hand back — use `adapter.sendTransaction(tx, connection)`.

## The two addresses (you usually need one)

| | What it is | When you need it |
|---|---|---|
| `walletAddress` (= `publicKey`) | The user's Solana address — funds, ATAs, receiving | **Always. This is the address.** |
| `accountAddress` | The wallet program's internal state account | Only for advanced flows (ephemeral signers, nonce prediction) via `./protocol` |

The two are branded types (`VaultPda` / `StatePda`), so passing one where the
other belongs is a compile error, not a runtime mystery.

## In-app browsers (WeChat, Instagram, …)

Embedded webviews can't run WebAuthn. The SDK throws `InAppBrowserError`
(code `IN_APP_BROWSER`, with `appName`) *before* opening a dead popup — catch
it and show "open in Safari / Chrome" guidance. To check proactively:

```ts
import { detectInAppBrowser } from '@soulpass/passkey-sdk'
const host = detectInAppBrowser() // 'WeChat' | 'Facebook' | … | null
```

## Package layout

| Entry | Contents | For |
|---|---|---|
| `@soulpass/passkey-sdk` | `SoulPassWallet`, typed errors, PDA brands | every integration |
| `…/react` | `SoulPassProvider`, `useSoulPass` | React apps |
| `…/payments` | `SoulPassPayments`, HTTP provider, PaymentIntent types/errors | Web2 checkout |
| `…/payments-react` | `useSoulPassPayments` | React checkout |
| `…/solana-adapter` | `SoulPassWalletAdapter`, PDA validators | wallet-adapter apps |
| `…/protocol` | MachineWallet wire formats, state parsing | advanced / internal |

## Internals

Cross-language wire-format contracts, the dual-SDK model, and distribution
notes live in [ARCHITECTURE.md](./ARCHITECTURE.md). Version history and
migration notes in [CHANGELOG.md](./CHANGELOG.md).

## Solana v1 transactions

`@soulpass/passkey-sdk/solana-transaction` owns the Solana wire formats. It uses the Solana Kit 8.2.0 compiler and codec, with web3.js 1.99 instruction and RPC types.

**First-party (machine wallet) transactions are v1 only.** v1 messages inline all accounts (≤ 64), carry the CU limit, loaded-accounts limit, TOTAL priority fee in lamports and optional heap in their config, and put outer signatures at the end. The 4096-byte limit includes those signature slots. ComputeBudget instructions and lookup tables are rejected; overflow is an explicit `SolanaTransactionCapacityError`, never a split or downgrade.

Construct with `compileV1Transaction`, add authority evidence, call `optimizeV1Transaction(rpc, tx, { computeUnitPriceMicroLamports })`, then sign the final message. Optimization simulates the complete envelope and reserves 10% CU and loaded-data headroom (data rounded to 32 KiB). The total priority fee is `priorityFeeLamportsFromPrice(price, measuredCu)` = `ceil(price × cu / 1e6)`, where `price` is the route's `computeUnitPriceMicroLamports`; it is capped at `MAX_PRIORITY_FEE_LAMPORTS` (1,400,000 lamports, shared with the Swift SDK and the sponsor) and `compileV1Transaction` refuses anything above it. Missing measurements fail closed; an already outer-signed transaction cannot be optimized.

**External wallets negotiate.** `compileExternalWalletTransaction({ supportedTransactionVersions, payerKey, recentBlockhash, instructions, resources, addressLookupTables? })` picks `1` when the wallet offers it, else `0`, else `'legacy'` (`selectExternalWalletTransactionVersion`), before any signature. For 0 / legacy it prepends `computeBudgetInstructions(resources)` (CU limit, CU price `ceil(total × 1e6 / cu)`, loaded-accounts limit, heap) and enforces 1232 bytes; v0 uses the caller's lookup tables. A wallet offering none of these, or a draft that does not fit, is an explicit error.

**dApp input accepts legacy, v0 and v1.** `normalizeDappTransaction(input, connection)` (used by `SoulPassWalletAdapter.sendTransaction`) resolves v0 lookup tables over RPC (missing or deactivated → error), drops the dApp's ComputeBudget instructions and v1 CU / fee config (`stripComputeBudget`), keeps a heap request (32–256 KiB, 1 KiB steps), and returns the unsigned v1 draft the wallet wraps in Execute.

The wallet ABI has separate funds (N), session (S) and governance (G) nonces; every `compute*Message` names the one it binds, and session-key instructions and RevokeSession bind the session's generation. Contract-derived layout and signing vectors are shared with Swift and the relay.

For the same signatures and priority fee, v1 does not inherently charge less than v0+ALT. The savings come from removing ALT setup/extension transactions and rent deposits, and from combining operations that otherwise required multiple envelopes. ALT deposits are refundable rent-exempt balances, not burned transaction fees. Fewer bytes alone do not reduce Solana's base fee.

Protocol references: [larger transactions](https://solana.com/upgrades/larger-transaction-sizes), [SIMD-0385](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md).
