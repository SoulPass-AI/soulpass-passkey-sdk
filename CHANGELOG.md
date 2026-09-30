# Changelog

## 0.6.0 — 2026-09-30（machine-wallet 单一布局）

`./protocol` 与 machine-wallet `feat/session-alignment` 程序逐字节对齐。钱包账户、
session 账户、签名消息、指令各只有一种形态：没有版本字段，没有 v1/v2/v0 分支。

### 账户布局

- **钱包（byte 0 = `'W'`）**：170 字节头（`bump`、`wallet_id`、`threshold`、
  `authority_count`、`nonce`、`creation_slot`、`vault_bump`、`root`、
  `authority_epoch`、`pending_root`、`recovery_eta`、`vault`、`recovery_threshold`）
  + `authority_count` 个 34 字节 authority 槽。`parseWalletState` 只接受
  `walletAccountSize(count)` 字节，拒绝程序 `deserialize` 拒绝的一切；待定 root
  在 eta 为 0 时照样接受（与程序一致）。`MachineWalletState` 字段即上述头字段 +
  `authorities`；`isRoot` / `findAuthority`。
- **Session（byte 0 = `'S'`）**：`parseSessionState` / `sessionAccountSize(P, C)`；
  `isSessionLive` 与 `SessionExecute` 同判：未撤销、`slot <= expirySlot`（到期槽
  当槽仍有效）、`walletCreationSlot` 与 `authorityEpoch` 仍与钱包相等；session 与
  钱包是否配对由调用方负责。`sessionSolPolicy` 取 SOL 预算。

### 签名消息与指令

- 19 个操作的 `compute*Message`（标签均为 `_v1`，见 `MACHINE_WALLET_TAGS`）：
  含 `computeRemoveSelfMessage` / `computeRemoveOtherMessage`、恢复三件
  （propose / cancel / execute）、`computeSetRecoveryThresholdMessage`、
  `computeBumpEpochMessage`。`computeOwnerCloseSessionMessage` 不含 destination
  （租金固定退回 session 记录的 rent payer）。
- 完整 disc 表 `MachineWalletDisc`（0–12、15–17、20–24）与 `REJECTED_DISCS`
  （13、14、18、19）；每条指令一个 `build*IxData` 及其账户表（`*_ACCOUNTS`）。
- 所有 builder 统一取单个对象参数（含 `maxSlot`），宽度或字节越界抛 `RangeError`。
  `buildCreateSessionIxData({ maxSlot, ...params })`。
- 账户表与各 processor 的账户顺序、可写性一致：`ADD_AUTHORITY_ACCOUNTS` /
  `REMOVE_AUTHORITY_ACCOUNTS`（治理三账户 + System Program）、`EXECUTE_ACCOUNTS`
  （disc 1 / 16）、`CLOSE_WALLET_ACCOUNTS` 的 vault 与 `SESSION_EXECUTE_ACCOUNTS` 的
  session / vault 可写。
- `buildAddAuthorityIxData` 的 `newThreshold` 可选（默认 0），必须与
  `computeAddAuthorityMessage` 签的值相同。
- inner 指令数必须为 1..=64（`MAX_INNER_INSTRUCTIONS`）；`computeExecuteEphemeralMessage`
  与 `buildExecuteIxData` 同样要求 1..=4 个 bump。
- `buildExecuteIxData`：省略 `ephemeralSignerBumps` 为 Execute（disc 1），1..=4 个
  bump 为 ExecuteWithEphemeralSigners（disc 16），空数组抛错。
- Session 参数：`CashMintPolicy`、`SessionParams`、`validateSessionParams`、
  `hashSessionData`。校验顺序与链上一致（解码器的 program 数量、cash 数量先于
  handler 的字段检查），多处违规时报出程序会报的那一个。

### 常量、错误码、PDA

- 程序常量（`wire-format/constants.ts`）：账户标签、容量上限、槽数、头尺寸、
  `NATIVE_SOL_MINT` + `isNativeSolMint` 等，每个值只定义一处。
- 程序错误码：`MachineWalletError`、`RETIRED_ERROR_CODES`、`describeMachineWalletError`。
- `deriveWalletPda` / `deriveSessionPda`；种子 `WALLET_SEED` / `VAULT_SEED` / `SESSION_SEED`。

### 已删除

`WALLET_LAYOUT_V1/V2`、`V1_*` 偏移、`*_V2_TAG` 与 `ADOPT_ROOT_TAG` /
`REMOVE_AUTHORITY_TAG`、`compute*V2Message` / `computeAdoptRootMessage` /
`computeRemoveAuthorityMessage`、`hashSessionDataV2`、`SessionV2Params`、
`SessionCashPolicy`（即 `CashMintPolicy`）、`buildCreateSessionV2IxData`、
`buildAdoptRootIxData`、`MAX_SESSION_ALLOWED_PROGRAMS` / `MAX_SESSION_CASH_MINTS`
（即 `MAX_ALLOWED_PROGRAMS` / `MAX_CASH_MINTS`，后者为 5），以及 `src/wire-format/session-v2.ts`。
下游还会碰到：

- `MachineWalletDisc.CreateSessionV2` / `.AdoptRoot` 删除（18、19 进 `REJECTED_DISCS`）。
- `walletAccountSize(version, count)` → `walletAccountSize(count)`。
- `MachineWalletState` 删除 `version` / `sigScheme` / `authority`（用 `authorities` /
  `root` / `isRoot` / `findAuthority`），`root` 不再为 `null`。
- `EXECUTE_EPHEMERAL_TAG` 同名但值改为 `machine_wallet_execute_ephemeral_v1`
  （原为 `…_v2`），disc 16 的签名哈希随之改变。
- `computeOwnerCloseSessionMessage` 不再接受 `destination`。
- `buildExecuteIxData` 传空 `ephemeralSignerBumps` 抛错（disc 1 请省略该字段）。

### 其他

- KAT：`signed_message_kat.json`（57 条 = 19 操作 × 3 域）、`session_data_kat.json`、
  `layout_kat.json` 均逐字节取自程序，`npm test` 校验副本新鲜度。

## 0.5.1 — 2026-09-29（读 v2 钱包）

> 本条描述的是已删除的过渡期程序（v1/v2 双布局）；0.6.0 起不再适用。

### Fixed

- `parseWalletState` / `getWalletState` / `predictNextExecuteNonce` 读得了
  machine-wallet v2 钱包（version 2 = v1 布局 + `53 + N×34` 处 34 字节 root 槽）。
  v2 程序新建的钱包与 AdoptRoot 过的钱包都是 v2，0.5.0 对它们一律抛错。
  `MachineWalletState` 新增 `root`（v1 为 `null`），`version` 放宽为 `1 | 2`；
  长度按版本精确校验（与程序 `deserialize_inner` 一致，session v2 同版本字节的
  账户不会被当成钱包）；root 必须是现有 authority。
- 新导出 `WALLET_LAYOUT_V1` / `WALLET_LAYOUT_V2` / `walletAccountSize`。
- KAT：`v2_layout_kat.json` 的 `wallet_v2_2auth_passkey_root` 逐字段钉住，session v2
  镜像钉为拒绝；layout 循环加数量断言。

### Note

- v1 钱包带尾随字节现在报错（此前宽容）；链上不存在此类账户（程序同样拒绝）。

## 0.5.0 — 2026-09-29（machine-wallet v2）

> 本条描述的是已删除的过渡期程序（v1/v2 双布局）；0.6.0 起不再适用。

纯新增，无破坏性变更；与 machine-wallet ca6073d 的 v2 程序对齐。

### Added

- `MachineWalletDisc.RotateRoot`（17）/ `CreateSessionV2`（18）/ `AdoptRoot`（19）。
- v2 签名消息：`computeCreateSessionV2Message`、`computeRotateRootMessage`、
  `computeAdoptRootMessage`（后两者沿用程序的 `_v1` 标签），以及 v2 钱包上由
  root 签的 `computeRemoveAuthorityV2Message` / `computeSetThresholdV2Message` /
  `computeCloseWalletV2Message`（`_v2` 标签）；对应 `*_TAG` 常量一并导出。
- v2 session：`hashSessionDataV2`、`encodeCashMintPolicy`、`buildCreateSessionV2IxData`，
  以及 `buildRotateRootIxData` / `buildAdoptRootIxData`。
- KAT：`session_data_v2_kat.json`、`v2_layout_kat.json` 与扩到 54 条的
  `signed-message-kat-vectors.json`，均逐字节取自 machine-wallet；原 36 条 v1
  向量逐字节不变（有测试钉住）。

## 0.4.0 — 2026-09-27（审计整改）

0.x 阶段按 semver 惯例以 minor 承载破坏性变更。下列 **Breaking** 条目需要消费方
（soulpass-ai / tens-gg / slabz-io 的 vendor 副本）随同步一起检查。

### Breaking

- **支付：PAYMENT_EXECUTE 送达后的结局重新分类（F1）。** 一旦执行请求投递进
  活的钱包窗口，除签名前的 `USER_REJECTED` 外，关窗/崩溃/`SIGN_FAILED`/
  `BAD_REQUEST`/`NETWORK_ERROR`/商户 `cancel()` 一律以 `PAYMENT_STATUS_UNKNOWN`
  拒绝（带 `paymentIntentId`、`retryable: false`，原错误在 `cause`），`pay()`
  保留恢复凭证。此前这些会以 `POPUP_CLOSED` 等被当成「用户拒绝」，商户可能
  二次收款。discover 阶段关窗仍是 `POPUP_CLOSED`。归类在支付 client 统一完成，
  对任何 `PaymentWallet` 生效：第三方钱包抛出的普通 `Error`、或 resolve 却缺
  `transactionId`，同样是 `PAYMENT_STATUS_UNKNOWN`（此前为
  `PAYMENT_AUTHORIZATION_FAILED` 并丢弃恢复凭证）；钱包本身只上报原始错误码。
- **`useSoulPassPayments().pay()` 对 `PAYMENT_STATUS_UNKNOWN` 改为 reject**
  （仍同时设置 `statusUnknown`/`error`）。此前 resolve `null`，与「用户拒绝」
  无法区分。
- **`isAllowedWebAuthnOrigin(origin, deployment = 'mainnet')`（F4）** 由
  `*.soulpass.ai` 子域规则改为按 deployment 的精确白名单：mainnet/local 仅
  `https://soulpass.ai`，devnet 另加 `https://test.soulpass.ai`，与链上
  machine-wallet `ALLOWED_ORIGIN_HOSTS`、machine-account 1.1.0 一致。新增
  `allowedWebAuthnOrigins`、`PRODUCTION_WEBAUTHN_ORIGIN`、`TEST_WEBAUTHN_ORIGIN`。
- **`walletUrl` 规范化为 origin 并强制 HTTPS（F11）**；HTTP 仅限 localhost /
  127.0.0.1 / [::1]。非法值在构造 `SoulPassWallet` / `createSoulPassPayments`
  时抛 `TypeError`。
- **`restoreSession` 校验持久化状态（F6/F13）**：地址须为规范 32 字节 base58、
  `publicKey === walletAddress`、vault ≠ state PDA，否则抛错；session 仅在
  `expiresAt`（`connect()` 由 `expiresIn` 盖章的绝对毫秒时间）未过时恢复，
  过期或只有相对 `expiresIn` 的旧记录会被丢弃（`wallet.session === null`，
  地址照常恢复）。
- **删除**从未读取的 `SoulPassWalletConfig.endpoint`，以及恒为 `undefined` 的
  `PopupSignSuccessMessage.payload.signedTransaction`。
- **peer 依赖**：`@solana/web3.js` 收窄为 `>=1.95.8 <2`（排除被投毒的
  1.95.6/1.95.7）；`@solana/wallet-adapter-base` 改为 optional peer，不再打进
  `dist/adapters/solana.*`——使用 `./solana-adapter` 的项目需自行安装它。

### Added

- `verifyPaymentWebhook` / `assertPaymentWebhookMatchesOrder` /
  `PaymentWebhookError`（`./payments`）：direct 模式 webhook 验签 + 订单核对
  （F2）。签名只证明链上发生了该笔支付；必须核对 reference、币种、金额、
  收款地址。
- `validateVaultPda` / `validateStatePda` 进入主入口（纯 base58 校验，不再
  依赖 web3.js）；`./solana-adapter` 继续 re-export。
- 错误码 `BAD_REQUEST`；`PopupErrorMessage.code` 补 `BAD_REQUEST`/`SIGN_FAILED`；
  清单外的 popup 码归一为 `UNKNOWN`（F10）。
- `SoulPassSession.expiresAt`。

### Deprecated

- `asVaultPda` / `asStatePda`（无校验 cast）→ 用 `validateVaultPda` /
  `validateStatePda`。soulpass-ai、tens-gg 仍在使用，下个 major 删除。

### Fixed

- `deriveEphemeralSigners` 拒绝非整数 `count`。
- `useSoulPassPayments` 的 client memo 依赖补上 `network`。
- 文档：`signed-message.ts` 中「deployment domain 防测试站签名上主网」的说法
  更正为「只防跨 deployment 重放」；ARCHITECTURE 入口数量更正为 6 个。

### Internal

- 幂等盐缓存从模块级移到 `SoulPassPayments` 实例，删除生产模块中的
  `__resetIdempotencySaltForTests`。
- `base64ToUint8Array` 移入 `encoding.ts`。

### 此前未记录

- `9ca01b9`：支付 intent 的 EVM `submissionPath` 统一为 `/v1/wallet/evm/submit`。

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
