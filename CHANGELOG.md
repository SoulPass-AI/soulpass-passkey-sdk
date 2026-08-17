# Changelog

## 0.3.0 — 2026-08-17

首个公开发布版本。0.3.0 在开发期内分两批落地，此处合并为一条发布记录：
下方「早期条目」是 8 月 10 日的包入口分层与类型化错误，其余为 payments
结账入口与 Response Standard v1。

### Added

- **`./payments` entry** — canonical server-owned PaymentIntent orchestration
  for Web2 checkout while preserving the existing arbitrary-transaction wallet
  surface. Includes multichain settlement options, synchronous authorization
  reservation, atomic string amounts and typed recovery errors.
- **Standard HTTP payment provider** — three small JSON endpoints for retrieve,
  prepare and complete, aligned with matrix-backend's `ResponseVo<T>` envelope.
  Client secrets travel in a header rather than URLs; `attemptId` binds prepare
  and complete to the same immutable route.
- **Funded-route selection** — exact atomic USDC balances choose among routes
  the merchant accepts. Solana is the default when funded, with automatic EVM
  fallback and an explicit settlement-option override.
- **Chain-native executions** — Solana keeps the existing sponsored
  MachineWallet submit path; EVM uses the Swift-compatible EIP-7702
  MachineAccount batch path and never introduces ERC-4337.
- **Double-charge-safe reconciliation** — once the wallet returns a chain
  transaction id, any completion failure becomes `PAYMENT_STATUS_UNKNOWN` with
  that id. Integrators are directed to retrieve the same PaymentIntent instead
  of initiating a second payment.
- **`PAYMENT_PREPARING` notice** — the merchant's prepare round-trip is
  invisible to the popup, which could only assume it had started and had no way
  to know which route was chosen. `PaymentAuthorizationSession` gained an
  optional advisory `notifyPreparing(settlementOptionId)` so the checkout window
  can name the actual route instead of guessing.
- **`PopupSession`** — one primitive for the cross-origin channel every
  `begin*` flow opens (click-tick open, READY payload queue, id correlation,
  close-once teardown). `beginSign`, `beginBatchSignTransaction` and
  `beginPaymentAuthorization` now share it instead of hand-rolling three
  copies; each keeps its own termination policy, which is what genuinely
  differs between them.

### Changed

- **Matrix HTTP Response Standard v1.** Every backend call — the three payment
  endpoints and both sign-channel relay legs — now sends
  `X-Matrix-Response-Mode: http-status-v1`, so failures arrive as their semantic
  HTTP status instead of a blanket 200. The `ResponseVo` body is unchanged and
  is still parsed on every response including non-2xx ones, where the server's
  `message` and business `code` live. Two behaviour changes follow: an unpayable
  or expired intent (business code 12003 → HTTP 409) now rejects with
  `PAYMENT_INTENT_NOT_PAYABLE` instead of a generic `PAYMENT_API_ERROR`, and
  `retryable` is no longer `status >= 500` — HTTP 501 is business code 700
  ("feature under development"), permanent, and retrying it only wasted the
  payer's time. Backends that predate v1 ignore the header, so no version gate
  is involved.

- **One error family.** `PaymentError` now extends `SoulPassError`, and the
  payment codes joined the shared inventory, so `isSoulPassError()` narrows
  every rejection `pay()` can produce. Wallet-side codes (`USER_REJECTED`,
  `POPUP_CLOSED`, `POPUP_BLOCKED`) are no longer flattened into
  `PAYMENT_AUTHORIZATION_FAILED` — a decline stays distinguishable from a
  failure. `retryable` / `cause` / `paymentIntentId` / `transactionId` moved
  onto the base class, since a relay-leg `TIMEOUT` is as retryable as an HTTP
  503. Removed `PAYMENT_SESSION_USED`, `PAYMENT_SESSION_CANCELLED` and the
  never-thrown `WALLET_NOT_CONNECTED` in favour of the existing `SESSION_USED`
  / `CANCELLED`.
- **Payment wire types moved to `src/payment-wire.ts`.** The split is now "does
  it cross the popup boundary", not "is it a payment thing": core owns the wire
  shapes and `./payments` consumes them, reversing a dependency that had core
  importing a feature module and split `SoulPassWallet`'s public signatures
  across two homes. Public exports are unchanged — `./payments` re-exports
  every moved type. A guardrail test fails if core imports from `./payments`
  again.
- **Client validation scoped to what the client can justify.** Shape and
  cross-call consistency checks stay (prepared id == retrieved id, settlement ∈
  offered options, payable, unexpired); re-derivation of issuer arithmetic
  (`merchantReceives + fee == amount`, fee-rate ceilings, fee-recipient rules)
  is gone, and an unknown `execution.kind` is forwarded to the wallet rather
  than rejected. Those checks stopped no compromised issuer — it would adjust
  the fields together — while making every new settlement rail or fee model an
  SDK release plus a merchant-wide upgrade. Recorded in the cross-language
  contract inventory.
- **The server owns the decimal scale.** `POST /payment-intents/direct` now
  takes a human price plus an asset code (`{ amount: "10.50", currency: "USDC" }`)
  and scales it using the configured stablecoin's decimals, which it already
  resolved per network in order to validate the caller's copy. The SDK's pinned
  `{ USDC: 6 }` table is gone, so adding a stablecoin is a backend catalog row
  rather than an SDK release plus a merchant-wide upgrade; an unrecognised
  currency is forwarded for the server to accept or reject.
- `pay()` no longer re-fetches the PaymentIntent it just created, removing an
  HTTP round-trip from the checkout path while the popup is already open.
- `@soulpass/passkey-sdk/protocol` now exports the popup postMessage message
  types. The wallet popup had been re-declaring the request envelopes by hand,
  which is how `PAYMENT_PREPARING` could otherwise have shipped handled on one
  side only.
- **`PAYMENT_STATUS_UNKNOWN` is never retryable.** Both status-unknown paths
  (completion failure and confirmation timeout) now set `retryable: false`,
  matching the base-class contract that `retryable` is never set once value may
  have moved. Recovering from it means retrieving the same PaymentIntent —
  `retrieveDirectPayment()` in direct mode — never creating a second one; a
  generic `if (err.retryable) retry()` branch can no longer double-charge a
  reference-less integration.
- **One checkout at a time per client.** A second `pay()` or `beginPayment()`
  while one is in flight on the same `SoulPassPayments` instance rejects
  immediately with the new `PAYMENT_IN_PROGRESS` code instead of opening a
  second popup whose message handler silently clobbers the first session's.
  The slot frees when the pending payment settles or is cancelled. The React
  hook's same-tick ref guard is unchanged and never hits this path.
- **`useSoulPassPayments` exposes `unknownPaymentIntentId`,** extracted from
  the status-unknown error so consumers no longer cast `error` to reach it,
  and `recover()` now takes no argument in the common case — it targets the
  current status-unknown payment by default.

- **Display token threading.** `POST /payment-intents/direct` now returns
  `{ paymentIntent, clientSecret, displayToken }` and
  `POST /payment-intents/retrieve` returns `{ paymentIntent, displayToken }`
  (was a bare PaymentIntent). The SDK validates the token (nonempty), stores it
  beside the client secret in the tab-scoped recovery record (storage key
  bumped to `soulpass_direct_payment_v2:`), and forwards it as a required field
  of the `PAYMENT_DISCOVER` payload — in both direct `pay()` and store-mode
  `beginPayment()`. The wallet popup uses it to fetch canonical intent state
  from the payment API and renders only that; the opener-relayed intent is a
  first-paint hint, not a source of truth, so a page doctoring it changes
  nothing the payer reviews or signs. `PaymentAuthorizationSession.
  getPaymentAccounts` gained the token as a second required parameter, and
  `PaymentIntentProvider.retrieve` now resolves the new
  `RetrievedPaymentIntent` shape.

### Fixed

- The credential-less `POST /payment-intents/direct` endpoint no longer
  reports HTTP 401/403/404 as `INVALID_CLIENT_SECRET` — it sends no secret, so
  the old mapping pointed integrators at a credential that does not exist.
  Those statuses now surface as `PAYMENT_API_ERROR` with a message pointing at
  `paymentApiUrl` misconfiguration.
- A wallet ERROR arriving between the discover and execute legs (for example
  the payer rejecting while the SDK is mid-`prepare`) now surfaces with the
  wallet's own code (`USER_REJECTED`, …) on the next leg instead of degrading
  to a generic `CANCELLED`.
- The SDK no longer closes the checkout window when the wallet reports a fatal
  ERROR: the wallet keeps its explanation on screen and owns that window's
  lifecycle. The SDK detaches its message channel and rejects the pending
  promise; success and dApp-initiated cancel still close the window.

### 早期条目 — 包入口分层与类型化错误（2026-08-10）

#### Breaking: package entry split

The main entry now exports only the integration surface (9 runtime symbols).
The MachineWallet protocol layer moved to a new `./protocol` subpath, and the
wallet-adapter moved out of the main entry (it was already available at
`./solana-adapter`). This keeps dApp autocomplete clean and removes
`@solana/wallet-adapter-base` from the main bundle.

Migration is a one-line import-path change per symbol:

| You imported … from `@soulpass/passkey-sdk` | Now import from |
|---|---|
| `SoulPassWallet`, config/session types, `as*Pda*` casts, `detectInAppBrowser`, `InAppBrowserError` | unchanged |
| `SoulPassWalletAdapter`, `SoulPassWalletName`, `validateVaultPda`, `validateStatePda`, `deriveVaultPDA` | `@soulpass/passkey-sdk/solana-adapter` |
| everything else (protocol constants, `parseWalletState`, `deriveEphemeralSigners`, `wire-format` builders, `base64urlNoPad`, p256 helpers, sign-channel) | `@soulpass/passkey-sdk/protocol` |

#### Added

- **`./react` entry** — `SoulPassProvider` + `useSoulPass()`. Owns the wallet
  instance, persists the connection to sessionStorage (key scoped by
  `productType`), restores silently on reload, clears on disconnect. `react`
  is a new optional peer dependency (`^18 || ^19`).
- **Typed errors** — `SoulPassError` with machine-readable `code`
  (`SoulPassErrorCode` union) plus an `isSoulPassError()` narrower. All
  rejections from `connect()` / `beginSign*()` / `session.send()` now carry a
  code. Message strings keep the historical `"CODE: detail"` shape, so
  existing string-matching keeps working. `InAppBrowserError` now extends
  `SoulPassError`.
- **Runtime guardrails** — `console.warn` when a popup is opened without
  transient user activation (the popup-becomes-a-tab footgun), and once per
  page when `config.productType` is missing (the JWT-in-wrong-namespace →
  401 footgun).

#### Changed

- **`productType` is now optional for third-party integrations.** The wallet
  popup forwards the dApp's postMessage-verified origin to the backend, which
  derives an isolated `ext-{host}` session namespace from it (matrix-backend
  ≥ the paired release). The missing-productType console warning no longer
  claims a guaranteed 401 — it now only nudges first-party products to set
  their canonical name.

#### Fixed

- **`connect()` no longer hangs forever when the user closes the connect
  popup.** It now rejects with `POPUP_CLOSED` within 500 ms, same watchdog
  contract as the sign flows.

## 0.2.0

- Dual-channel signing (popup + relay), in-app browser detection, wallet-state
  projection. Pre-changelog; see git history.
