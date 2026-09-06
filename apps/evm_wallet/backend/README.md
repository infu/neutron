# EVM Wallet backend

The wallet owns the `main` custody slot. Its public key, address and key
fingerprint are cached in the `evm_wallet` v1 managed root. Ethereum, Arbitrum
One and Sepolia share that address and keep separate nonce reservations.
Compatible upgrades retain the root and key. Installation-scoped custody keys
rotate after uninstall/reinstall; this app does not offer key export or recovery
of a removed installation.

`main.mo` exposes closed versioned methods for snapshot/accounts, tracked assets,
browser-observed preparation, approval, rejection, saved operations, submission
bytes, receipt observations and paginated history. Released backend RPC read
methods retain their wire shapes but return an actionable browser-service error.
The resident service implements public reads through direct browser JSON-RPC;
no backend EVM RPC or HTTPS capability is selected.
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

The browser obtains account balance, pending/mined nonces and fees and submits
these observations to `evm_wallet_prepare_browser_v1`. The backend derives a
candidate from the original intent and journal nonce floor. The browser then
estimates and simulates the exact candidate and calls
`evm_wallet_finish_prepare_browser_v1` with fresh balance/nonces and the observed
gas/result. The backend validates and freezes the transaction for review. Gas
estimation is used once on Arbitrum because its estimate already incorporates
posting costs. Explicit legacy, EIP1559 and access-list semantics are validated
by the backend. Ethereum encodings and signing digests are derived exclusively
from the stored operation.

Approval carries the exact review revision. Nonce reservation runs before the
first signing await and is serialized per account and chain. If a concurrent
approval consumed that nonce, the second operation returns to preparing with
a revised candidate. It must be estimated, simulated, reviewed and approved
again; changing a nonce never reuses the prior simulation. A documented pre-dispatch signing failure returns to
prepared with the same frozen fields; retry requires another explicit approval.
A definitely unsigned rejected reservation can be reused without leaving a
nonce gap. Unknown or potentially released signatures retain their reservation.

The signing phase is persisted before calling the custody capability. An unknown
or interrupted signing result never triggers an automatic second signing call.
On a successful signature, the backend verifies it against the account, applies
low-S normalization, derives Ethereum parity and persists the exact serialized
transaction and hash before returning. Signing does not perform a network
broadcast. The wallet browser retrieves the persisted bytes through
`evm_wallet_submission_v1` and broadcasts that exact payload.

Personal and EIP712 signatures are recorded as released even though no wallet
broadcast occurs. Typed domains with a chain ID must match the requested chain;
a chainless standard domain remains chainless and is disclosed in the review.

## Recovery and public evidence

`evm_wallet_operation_v1` queries the saved journal. `evm_wallet_status_v1`
resolves a restored, interrupted signer to an unknown outcome; it makes no RPC
request. The browser queries transaction/receipt state and records it through
`evm_wallet_observe_browser_v1`. If both are absent, recovery may retrieve and
rebroadcast only the saved signed bytes. It never creates a new transfer, nonce
or signature. A signed or potentially signed later replacement suppresses
rebroadcast of the original. The browser follows `evm_wallet_superseding_v1`
first, so an original-only refresh can discover a mined later replacement.

Receipt inclusion, execution success/revert and safe/finalized RPC heads are
recorded separately from the browser provider observations. A missing or changed canonical receipt removes the old
confirmation on reconciliation. Arbitrum sequencer inclusion does not establish
Ethereum settlement or bridge withdrawal readiness. Provider failures remain explicit. These are observations from the browser
RPC provider, not IC replica consensus proofs.

The resident public transaction tool reads chain data in the browser without
disclosing private commands. `evm_wallet_transaction_request_matches_v1` supplies
only a match boolean for an expected wallet identity and the stored signed
hash, preventing consumers from relabeling an older successful transaction as a
new wallet command.

The shared observation JSON parser is documented in [rpc/README.md](rpc/README.md).
Historical EVM107 upgrade fixtures retain their original RPC wire types only
under the compiler test directory; they are not an active wallet transport.
Selected-token balances and locally known approvals are not exhaustive indexing.

## Verification

- `test/backend.test.ts` runs durable journal tests in WASI and the actual
  Motoko backend with mocked custody and browser observations in isolated
  PocketIC. The environment supplies no backend RPC capability.
  It covers low-cycle/busy retry, nonce conflicts, lost broadcast replies,
  reload, exact-byte retry, receipt reorganization and revert, replacement,
  chain separation, legacy signing and scoped public evidence matching.
- `test/evm_crypto.test.ts` cross-checks cryptographic/serialization modules
  against independent viem and noble vectors.
- `test/rpc.test.ts` verifies JSON quantities, Unicode, duplicate fields and
  large observation strings. `test/browser_operations.test.ts` exercises the
  browser preparation and submission orchestration.
- `test/memory_release.test.mo` checks clean initialization and restoration of
  non-default accounts, network/assets, nonce floors and pending signed bytes.

No test broadcasts a production EVM transaction or installs into an existing
production Neutron.
