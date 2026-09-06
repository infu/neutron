# EVM Wallet backend

The wallet owns the `main` custody slot. Its public key, address and key
fingerprint are cached in the `evm_wallet` v1 managed root. Ethereum, Arbitrum
One and Sepolia share that address and keep separate nonce reservations.
Compatible upgrades retain the root and key. Installation-scoped custody keys
rotate after uninstall/reinstall; this app does not offer key export or recovery
of a removed installation.

`main.mo` exposes closed versioned methods for snapshot/accounts, balances,
contract reads and code, public transaction evidence, tracked assets, command
preparation, approval, rejection, status reconciliation and paginated history.
The local public wire aliases are required by Neutron's method-schema compiler;
the compiler also checks their structural compatibility with `Types.mo`.
Frontend tool adapters must obtain caller app ID and installation UID from the
Kernel context. Backend methods are private wallet self calls, not public tools
accepting a consumer's claimed identity directly.

## Commands and signing

The command key uses framed Candid `(app_id, installation_uid, request_id)`.
The endpoint is informational and may change after a tile reconnects. Complete
intent bytes are compared for replay: the same identity and intent returns the
stored operation; a changed intent conflicts. No journal entries are silently
expired or pruned.

Preparation obtains live account balance, pending nonce, fees, gas estimation
and contract simulation. It persists the exact transaction for review. Gas
estimation is used once on Arbitrum because its estimate already incorporates
posting costs. Explicit legacy, EIP1559 and access-list semantics are validated
by the backend. Ethereum encodings and signing digests are derived exclusively
from the stored operation.

Approval carries the exact review revision. Nonce reservation runs before the
first signing await and is serialized per account and chain. If a concurrent
approval consumed that nonce, the second operation gets an updated review and
must be approved again. A documented pre-dispatch signing failure returns to
prepared with the same frozen fields; retry requires another explicit approval.
A definitely unsigned rejected reservation can be reused without leaving a
nonce gap. Unknown or potentially released signatures retain their reservation.

The signing phase is persisted before calling the custody capability. An unknown
or interrupted signing result never triggers an automatic second signing call.
On a successful signature, the backend verifies it against the account, applies
low-S normalization, derives Ethereum parity and persists the exact serialized
transaction and hash before any broadcast await.

Personal and EIP712 signatures are recorded as released even though no wallet
broadcast occurs. Typed domains with a chain ID must match the requested chain;
a chainless standard domain remains chainless and is disclosed in the review.

## Recovery and public evidence

`evm_wallet_status_v1` with `refresh = false` reads the stored operation. With
`refresh = true`, it reconciles public receipts and transaction lookup. If both
are absent it may broadcast the already approved, byte-identical transaction.
It does not create a new transfer, nonce or signature. A signed or potentially
signed later replacement suppresses rebroadcast of the superseded original.
The original becomes `replaced` only when the replacement has a receipt in a
verified canonical block; its original receipt remains absent.

Receipt inclusion, execution success/revert and safe/finalized RPC heads are
recorded separately. A missing or changed canonical receipt removes the old
confirmation on reconciliation. Arbitrum sequencer inclusion does not establish
Ethereum settlement or bridge withdrawal readiness. Provider failures and
disagreements remain explicit; no provider is silently selected as a winner.

Public transaction lookup exposes public chain data without disclosing private
commands. An optional expected wallet identity returns only a match boolean
against the stored signed hash, preventing consumers from relabeling an older
successful transaction as a new wallet command.

The RPC adapter is pinned and documented in [rpc/README.md](rpc/README.md).
Selected-token balances and locally known approvals are not exhaustive indexing.

## Verification

- `test/backend.test.ts` runs durable journal tests in WASI and the actual
  Motoko backend with mocked custody/RPC capabilities in isolated PocketIC.
  It covers low-cycle/busy retry, nonce conflicts, lost broadcast replies,
  reload, exact-byte retry, receipt reorganization and revert, replacement,
  chain separation, legacy signing and scoped public evidence matching.
- `test/evm_crypto.test.ts` cross-checks cryptographic/serialization modules
  against independent viem and noble vectors.
- `test/rpc.test.ts` compiles the real Candid RPC adapter and tests provider
  disagreement, exact quotation, response growth and uncertain broadcasting.
- `test/memory_release.test.mo` checks clean initialization and restoration of
  non-default accounts, network/assets, nonce floors and pending signed bytes.

No test broadcasts a production EVM transaction or installs into an existing
production Neutron.
