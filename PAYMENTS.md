# SoulPass Payments contract

SoulPass exposes two intentional lanes:

1. **Wallet lane** — Web3 products build arbitrary transactions and use
   `SoulPassWallet` as their signing/submission port.
2. **Payments lane** — Web2 products pass an amount and receiving addresses;
   `SoulPassPayments` creates a server-owned PaymentIntent, selects a funded
   stablecoin route, authorizes it, and reconciles the chain result.

## Multichain checkout flow

```text
merchant browser / SDK                         wallet             payment API
      | create direct intent (amount + recipients + Origin) ---------------->|
      |<-- public PaymentIntent + SDK-internal clientSecret -----------------|
      |                        | open /wallet/pay ---->|                     |
      |                        |                       | sign in/create wallet|
      |                        | discover balances --->|                     |
      |                        |<-- funded accounts ----|                     |
      |                        | prepare(option,payer) --------------------->|
      |                        |<-- attemptId + execution -------------------|
      |                        | authorize/submit ----->|                     |
      |                        |<-- transactionId ------|                     |
      |                        | complete(attempt,tx) ---------------------->|
      |                        |<-- processing PaymentIntent ----------------|
      | webhook: succeeded <--- chain verification + reconciliation          |
```

The normal integration is `await soulpass.pay({ amount, recipients })`. The
SDK opens the wallet synchronously in the click handler, creates the intent,
and keeps its capability secret internal. A merchant can therefore start with
only self-custodied addresses.

When an opaque `reference` is supplied, the SDK hashes it into a stable
Origin-scoped idempotency key. A submitted-but-unconfirmed payment keeps its
short-lived capability in tab-scoped session storage, so
`retrieveDirectPayment(paymentIntentId)` can recover canonical state without
turning that capability into developer configuration.

Selection is deterministic:

- an explicit `settlementOptionId` wins if it has sufficient balance;
- otherwise a funded Solana option wins by default;
- otherwise configured preferences and then merchant option order apply;
- a Solana route is eligible only when its atomic stablecoin balance covers the
  merchant's gross checkout price;
- an EVM route additionally requires the current browser passkey to be a live
  on-chain MachineAccount owner, a checkout-supported 1-of-n threshold, and
  a configured sponsored relay. When that relay has a user-side fee, route
  discovery also checks the fee-token balance and reserves it before reporting
  how much remains available for the merchant payment.

This is a choice among routes snapshotted into the PaymentIntent. After create,
neither wallet nor browser can change its network, token, gross price, merchant net,
protocol fee, or either recipient.

What the payer reviews is server-canonical, not merchant-relayed. Create and
retrieve both issue a display-scoped `displayToken` (`pdt_…`) alongside the
intent; the SDK forwards it in the checkout popup's first message, and the
wallet uses it to fetch canonical intent state directly from the payment API.
The intent the merchant page relays is a hint for instant first paint — the
wallet renders and signs against what the server says, and hard-fails the
checkout when no token is present. The token grants a read of display fields
only: it is not a secret on par with the client secret (it necessarily transits
the merchant page), but it must never be logged and never appear in a URL.

## When no route is funded

`PAYMENT_INSUFFICIENT_FUNDS` is now the *second* thing that happens, not the first.
When every offered route is short, the wallet holds its balance reply and offers a
card top-up inside the same checkout; the PaymentIntent is untouched and resumes on
its own once the funds land. The top-up is sized to actually close the gap, not to
match it: the shortfall plus a 6% buffer, with a $2 minimum — onramp quotes drift
between quote and settlement, and delivering exactly the gap would strand the
payment short a second time. The merchant sees nothing — no extra state, no second
intent, no callback — because the SDK is still awaiting the same
`getPaymentAccounts()` it was already awaiting.

A payer who cancels at the top-up screen has declined the payment, not exposed a
funding shape: that surfaces as `USER_REJECTED` — the same silent decline as
closing the window — never as `PAYMENT_INSUFFICIENT_FUNDS`.

`PAYMENT_INSUFFICIENT_FUNDS` still reaches you unchanged when a top-up cannot
close the gap: the shortfall is on a chain the onramp does not deliver to, or the
settlement asset is one it does not sell. Treat it exactly as before. What changed
is how rarely you should expect it, not what it means.

## Protocol fee semantics

The amount passed by the merchant is the gross purchase price. The platform
computes any merchant protocol fee from server-owned configuration and deducts
it from merchant settlement in the same stablecoin; this fee never increases
the purchase price. An independently configured EVM relay fee is user-side,
shown separately by the wallet, and is not part of merchant pricing.
Every settlement option exposes:

- `amount`: gross purchase price / merchant payment debit;
- `merchantReceives`: net merchant receipt after fees;
- `protocolFee`: frozen basis points, atomic amount, and platform recipient;

The fee is never accepted from merchant input. PaymentIntent creation freezes
the current rate, rounded atomic amount, merchant net, and network-specific
platform address, so a later configuration refresh cannot alter a payment
already shown to the user. Solana submits both SPL transfers in one
MachineWallet transaction; EVM submits both ERC-20 calls in one MachineAccount
`executeBatch`. Either both succeed or both revert, and their sum always equals
the purchase price. If configured, the EVM wallet prepends its user relay-fee
transfer to that same atomic batch, matching the Swift/CLI submission channel.

The entire user-facing checkout lives at `soulpass.ai/wallet/pay`. The merchant
page receives only funded route metadata and the final transaction ID; it never
receives the Matrix wallet JWT, Helius/Alchemy credentials, WebAuthn assertion,
or chain transaction bytes. Payment checkout does not require a preceding
`wallet.connect()` ceremony. Existing users sign in inside that popup; first-time
users can create their passkey and default Solana payment wallet there, then
continue the same checkout. Arbitrary Web3 signing still requires `connect()`.

## Standard HTTP provider

Every endpoint returns the backend's canonical `ResponseVo<T>` envelope:

```json
{ "code": 0, "message": "success", "data": {}, "success": true }
```

| Method and path | Request JSON | `data` on success |
|---|---|---|
| `POST /payment-intents/direct` | `{ "amount": "10.50", "currency": "USDC", "settlementOptions": [{ "network": "SOLANA", "recipient": "..." }] }` | `{ "paymentIntent": PaymentIntent, "clientSecret": "...", "displayToken": "pdt_..." }` |
| `POST /payment-intents/retrieve` | none | `{ "paymentIntent": PaymentIntent, "displayToken": "pdt_..." }` |
| `POST /payment-intents/prepare` | `{ "settlementOptionId": "...", "payerAddress": "..." }` | `{ "paymentIntent": PaymentIntent, "attemptId": "...", "execution": PaymentExecution }` |
| `POST /payment-intents/complete` | `{ "paymentIntentId": "...", "attemptId": "...", "transactionId": "..." }` | `PaymentIntent` |

Every request also carries `X-Matrix-Response-Mode: http-status-v1`, the opt-in
defined by Matrix HTTP Response Standard v1. The body above is unchanged by it —
that envelope is the permanent contract, and `code` stays the value to branch
product behaviour on. What changes is the transport: a failure arrives as its
semantic HTTP status (401 for a revoked secret, 409 for an unpayable intent, 422
for any other domain rejection, 500/503 for faults) instead of a blanket 200.
That is what makes `err.retryable` a real answer — under the legacy transport
every outcome looked identical to a retry policy.

Two consequences worth stating, because both are easy to get backwards:

- **A non-2xx response still has a body.** The SDK parses it and surfaces the
  server's `message`; an HTTP client that discards bodies on error would replace
  the merchant's reason with a bare status number.
- **HTTP 501 is not a fault.** It is business code 700, "feature under
  development", and never retryable. Anything deciding retries with
  `status >= 500` will retry it forever.

Backends that predate v1 ignore the header and keep answering HTTP 200, so the
opt-in needs no negotiation or version gate.

Create Direct carries `Origin` and `Idempotency-Key`; it intentionally needs no
credential. Every later call carries `X-SoulPass-Client-Secret`; the secret
never appears in a URL or JSON body and the high-level SDK never exposes it.

The backend canonicalizes the browser Origin and derives a stable, opaque
`pk_o_…` product key. This key provides abuse/usage attribution only. It does
not prove domain ownership, grant spending authority, or create a permanent
recipient binding. Non-HTTPS origins are rejected except localhost development.

### Getting the result on your server (direct mode)

`pay()` resolving is a browser event, and a payer who closes the tab after signing has
still moved the funds. Pass `webhookUrl` and SoulPass POSTs one signed event per terminal
state, retried until your endpoint returns 2xx:

```ts
await soulpass.pay({
  amount: '10.00',
  recipients: { solana: MERCHANT },
  reference: order.id,
  webhookUrl: 'https://api.yourshop.com/soulpass/webhook',
})
```

There is **no secret to configure**. Events are signed with the platform's Ed25519 key:

```
SoulPass-Event-Id: 9f2c…
SoulPass-Key-Id:   pwk_1b7d…
SoulPass-Signature: t=1760000000,ed25519=<hex>
```

Verify `sha512/ed25519` over the exact bytes `"{t}.{rawBody}"` using the public key whose
`keyId` matches, fetched once from `GET /v1/payment-webhook-keys`. Reject a timestamp
outside your tolerance; the timestamp is inside the signed bytes, so it cannot be swapped.

The URL must be on the checkout page's own host, or a subdomain of it. That constraint is
what stands in for a credential on an endpoint that has none: since Origin is spoofable by
a non-browser, restricting the destination to a domain the caller demonstrably serves is
what stops this from being a signed-request reflector — or a way to read another merchant's
payment events. The URL is frozen into that one PaymentIntent and registers nothing.

### Authenticated Store mode (optional)

Products that need centrally managed recipients and signed webhooks can keep
using merchant-server `POST /payment-intents/create` with the Store HMAC
contract, then call `beginPayment(clientSecret)` in the browser. In that mode,
the backend reads recipients from Store configuration and sends terminal-state
webhooks through registered endpoints. Direct mode intentionally publishes no
webhook and performs no Store lookup.

`PaymentExecution` is a discriminated union:

- `solana_machine_wallet_transfer` uses the existing
  `/v1/wallet/solana/tx/submit` channel;
- `evm_machine_account_batch` uses the existing EIP-7702 MachineAccount
  `/v1/wallet/evm/spend/submit` channel and is not ERC-4337.

## Merchant multichain invariant

A permissionless merchant supports multichain collection when each requested
route has a valid address and the exact stablecoin asset is enabled for the
exact chain ID. Authenticated Store mode adds these conditions:

- the store accepts that network;
- the store has a valid receiving address for that chain family.

The backend snapshots `chainType`, `chainId`, asset address, decimals, gross
price, merchant net/recipient, and protocol fee/recipient into each settlement
option. Once issued, these values are immutable.

Direct intents are visibly marked as unverified by the SoulPass wallet, which
shows the full destination address before signing. A claimed product name or
browser-supplied Origin is never presented as verified ownership.

## How deep is confirmed

Confirmation depth is a function of what a reorg would cost, so it is configured as one
rather than as a single global number. Each attempt resolves a depth from its exact chain
and its own value: rollups settle in a couple of blocks, L1 and the higher-reorg chains
take more, and any payment at or above the configured high-value threshold moves to a
deeper tier — including Solana, which then requires `finalized` rather than `confirmed`.

The practical consequence for a merchant: a large payment on Ethereum mainnet can outlast
`pay()`'s confirmation window and surface as `PAYMENT_STATUS_UNKNOWN`. That is not a
failure and must not be retried as one — it is the webhook's job, which is the other
reason to configure `webhookUrl` for anything above pocket change.

## On-chain proof of payment

`complete` records a submitted transaction and normally returns `processing`.
It is not proof of receipt. Reconciliation queries the exact network and checks:

- transaction success and required confirmations/finality;
- exact payer and recipient;
- exact token mint/contract and atomic amount;
- exact protocol-fee amount and platform recipient when the frozen fee is nonzero;
- exact chain ID / Solana genesis identity.

Solana verification prefers Helius RPC. Supported EVM networks prefer Alchemy
RPC. Explicit trusted RPC URLs in the chain registry are failover endpoints and
cover networks outside those providers.

Merchant fulfillment consumes only canonical `succeeded` state or its signed,
idempotent webhook. It never trusts a browser callback.

## Who owns the decimal scale

Callers send a human price (`"10.50"`) and an asset code. The server resolves
the asset per network from its own catalog and scales the price to smallest
units — so supporting a new stablecoin is a catalog row, not an SDK release
followed by a merchant-wide upgrade. The SDK validates only that the amount is
a positive decimal string, and forwards a currency it has never heard of rather
than rejecting it.

## Recovery semantics

Failures before submission can be retried when `err.retryable` is true.
`PAYMENT_STATUS_UNKNOWN` means a transaction ID already exists and funds may
have moved: it is **never** marked retryable — `err.retryable` is always false
on it, so a generic `if (err.retryable) retry()` branch can never double-charge.
Recovering from it means *retrieving* the same PaymentIntent
(`retrieveDirectPayment` in direct mode), never creating a second one.

One checkout at a time: `pay()` and `beginPayment()` are single-flight per
client instance. Starting a second checkout while one is still pending rejects
immediately with `PAYMENT_IN_PROGRESS` instead of opening a second popup over
the first; the slot frees as soon as the pending payment settles, fails, or is
cancelled. (The React hook already swallows the duplicate click before it
reaches the client.)

One `catch`, one guard. `pay()` and `confirm()` reject with a single error
family: `PaymentError` extends `SoulPassError`, so `isSoulPassError(err)`
narrows both payment failures and wallet-side ones — `USER_REJECTED`,
`POPUP_CLOSED`, `POPUP_BLOCKED`, `IN_APP_BROWSER`, `CANCELLED`. Those wallet
codes reach you unchanged rather than flattened into
`PAYMENT_AUTHORIZATION_FAILED`, which matters because a decline is not an
error to show:

```ts
try {
  await soulpass.pay({ amount: '10.50', recipients: { solana: MERCHANT } })
} catch (err) {
  if (!isSoulPassError(err)) throw err
  if (err.code === 'USER_REJECTED' || err.code === 'POPUP_CLOSED') return // silent
  if (err.code === 'PAYMENT_STATUS_UNKNOWN') return reconcile(err.paymentIntentId)
  if (err.retryable) return retry()
  showError(err.message)
}
```

Reach for `isPaymentError(err)` only when a branch is specific to the payment
inventory.

## What the SDK validates

The client checks **shape** and **cross-call consistency**: the prepared
intent is the one you retrieved, the locked settlement is one the merchant
offered, the intent is payable and unexpired. It deliberately does **not**
re-derive the issuer's arithmetic (`merchantReceives + fee == amount`, fee
ceilings) and forwards unfamiliar `execution.kind` values to the wallet
untouched — a compromised server would satisfy such checks anyway, while
enforcing them would make every new settlement rail an SDK release. Those
invariants are owned server-side.
