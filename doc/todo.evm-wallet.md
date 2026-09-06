# EVM Wallet And App Integrations TODO

Created: 2026-09-05. Completed: 2026-09-06. All 64 requirements are complete.
See the [implementation guide](./evm-wallet.md) and
[release qualification](../.neutron/release-receipts/evm-wallet-completion-2026-09-06/validation.md).

The [completion evidence](../.neutron/release-receipts/evm-wallet-completion-2026-09-06/requirements.json)
retains all 64 requirements and their individual verification status. Exact
publication receipts are recorded separately from implementation and fixture
results.

Design and source references: [EVM Wallet research](./evm-wallet-research.md).
This checklist covers a **separate EVM Wallet app**, fixes and integration in
the existing IC Wallet, a Kitchen Sink consumer example, and a **new Uniswap
app** that uses EVM Wallet.

## Scope And Order

| Workstream | Main location | Dependencies |
| --- | --- | --- |
| Signing and caller provenance | Kernel, compiler, shared capability types and SDK | Signing contract/lifecycle decision |
| EVM Wallet | New `apps/evm_wallet` | Signing extension and RPC adapter |
| Consumer SDK and Kitchen Sink | Shared SDK, `apps/kitchensink` | Versioned EVM Wallet tools |
| IC Wallet recovery fixes | `apps/wallet` | Can begin independently |
| IC Wallet wrapping integration | `apps/wallet` | EVM Wallet and IC recovery fixes |
| Uniswap | New `apps/uniswap` | EVM Wallet tools and consumer SDK |
| Production qualification | All changed packages | Completed flows and migration evidence |

EVM Wallet owns signing and EVM transaction state. IC Wallet owns IC assets and
ck-token bridge workflows. Uniswap owns quotes and swap intent. Kernel retains
app isolation and routing without learning swap or token semantics.

Existing namespaced chain-key isolation already prevents another app from
using EVM Wallet's key while installed. Reuse it. A second reservation registry
is only relevant if retaining/reassigning keys after app removal is selected.

## 1. Settle The Signing Contract And Account Lifecycle

- [x] Record the new explicit wallet-custody signing grant: scoped public-key
  retrieval and signing an exact 32-byte digest. Keep existing assertion grants,
  API behavior, and keys unchanged. Update the signing/trust documentation to
  distinguish this authority from the current assertion-only contract.
- [x] Define immutable account/slot identifiers and their derivation. Use a
  separate key-derivation domain for custody; never add a Neutron message prefix
  to an EVM digest. Make the same account usable across networks while keeping
  network balances and nonces separate.
- [x] Decide and document uninstall behavior before funding the release:
  existing installation-scoped keys rotate on reinstall. If same-address
  recovery is wanted, specify durable Kernel key descriptors and explicit
  owner reassignment to an exact replacement installation. Do not silently
  implement that extra registry or claim recovery already works.
- [x] Specify the account lifecycle for compatible upgrades, disabled signing,
  removed slots, app replacement, and whole-canister recovery. No seed/private-key
  export should be implied by the UI.
- [x] Follow `AGENTS.md` for any newly required resource bounds or policy
  behavior: explain and agree actual thresholds instead of introducing ad hoc
  quotas, cooldowns, or spending restrictions.

## 2. Kernel, Compiler, And SDK Support

- [x] Add the closed custody declaration, normalization, capability-plan
  fingerprint, shared Motoko leaf, compiler projection, and install/Settings
  disclosure. Any ordinary app can request the reviewed primitive; do not
  special-case the EVM Wallet app ID.
- [x] Reuse the existing app/installation namespace, trusted key selection,
  management transport, cycle accounting, and runtime enablement/revocation
  mechanisms. Apps must not supply another AppScope or management derivation
  path to access a foreign key.
- [x] Validate key/signature shapes and closed error outcomes; preserve unknown
  signing outcomes and authority changes during awaits without fabricating
  success or automatically repeating signing.
- [x] Add Kernel-derived installation UID to SDK caller provenance for new
  wallet command identities. The additive field extends the existing app/endpoint/session
  context. Forward and validate the new field in human provider and
  root-Agent paths, retaining compatibility for existing tools.
- [x] Reuse `provider_once`, private foreground presentation, scoped self calls,
  and separate direct-root tools. Keep effect invocation and cancellation
  provenance intact.
- [x] Test cross-app slot-name collisions, stale handles, disable/re-enable,
  revocation during signing, unchanged upgrades, and the chosen removal policy.
  Confirm existing assertion vectors and old provider/Agent flows still work.
- [x] Audit every affected Kernel memory root; introduce immutable successor
  schemas and explicit forward migrations only where persistent layout changes.

Done when a real EVM digest can be signed through an isolated capability, the
signature verifies independently, and existing keys/authority remain compatible.

## 3. New EVM Wallet App

- [x] Scaffold `apps/evm_wallet` with its own tile, resident tools, managed
  memory, manifest, tests, documentation, and release metadata. Enroll it in
  workspace/build/test catalogs and use the standard `LICENSE.APP.USE` and
  offered-source workflow.
- [x] Define durable roots for accounts, configured networks/assets, commands,
  nonce allocation, signatures, submitted transactions, and history. Distinguish
  wallet settings from disposable frontend state.
- [x] Implement public-key/address derivation, Ethereum signature recovery
  parity, and low-S normalization. Cross-check Motoko cryptography/serialization
  against independent vectors and viem; frontend libraries do not replace the
  authoritative backend implementation.
- [x] Implement EIP-1559 and chain-protected legacy transaction encoding, with
  access lists as needed; personal-message and EIP-712 signing; and explicit
  handling of transaction versus permit nonce domains.
- [x] Add Ethereum and Arbitrum network configurations plus test infrastructure.
  Require an explicit chain in operation records; identify tokens by chain and
  contract, never symbol alone. Keep additional networks adapter-driven.
- [x] Implement the EVM RPC canister adapter through existing backend-call
  reservations. Pin/verify the deployed interface, use supported typed and
  multi-provider methods, estimate attached cycles, and expose inconsistent,
  unavailable, and stale responses honestly.
- [x] Add account/network selection, receive address, native/ERC20 balances,
  selected/custom tokens, sends, contract calls, pending activity, receipts,
  known approvals, and revocation. Report discovery/history completeness rather
  than claiming selected tokens or locally known spenders are exhaustive.
- [x] Prepare transactions with live balance, allowance, nonce, fee, and
  simulation evidence. Present exact network/account, recipient or contract,
  value, decoded effects where known, calldata, and expected/authorized fees.
  Treat caller-supplied labels/ABIs as untrusted descriptions.
- [x] Build the durable command journal: authenticated caller installation plus
  request ID; identical replay returns the same operation; changed intent
  conflicts. Allocate nonces in the backend per account/chain, save exact fields
  before signing, and save signed bytes/hash before broadcasting.
- [x] Implement pending/unknown recovery, receipt status and finality, and
  explicit same-nonce speed-up/cancel. Reconcile lost responses and rebroadcast
  exact bytes where appropriate; do not turn an ambiguous result into a fresh
  transfer. Track released signatures even without wallet broadcast.
- [x] Handle Arbitrum fee estimation and finality separately from Ethereum;
  avoid double-counting posting fees. Distinguish native gas balance from IC
  cycles and sequencer inclusion from final settlement.
- [x] Expose versioned closed-schema accounts, networks, balances, contract
  reads, transaction requests, message signatures, typed signatures, and
  operation-status tools. Human effects use wallet-owned UI; direct-root tools
  reuse the checked backend without granting authority to descendants.
- [x] Test concurrent callers/tiles, separate chains, nonce collisions, changed
  intent, partial sequences, unknown signing/broadcast, replacement, reverts,
  reorgs, reload, and upgrades with pending operations.

Done when Ethereum and Arbitrum reads, sends, contract calls, and signatures
work through the new app and recover correctly without duplicate effects.

## 4. Shared Consumer SDK And Kitchen Sink Example

- [x] Add a typed consumer client for EVM Wallet discovery, closed input/output
  validation, explicit-chain requests, operation IDs, status, and errors. Share
  it between Kitchen Sink, IC Wallet, and Uniswap to avoid divergent adapters.
- [x] Evaluate an EIP-1193 adapter for existing EVM libraries. The implemented
  consumers use the explicit-chain client directly, so no global selected-chain
  adapter is needed for this release; an external-library adapter remains optional.
- [x] Add a sibling **EVM Wallet** page in Kitchen Sink's hash-addressable
  navigation, alongside the current IC Wallet funding example. Keep the
  existing external-browser-wallet demo and IC examples working.
- [x] Demonstrate real account/network/balance reads and contract reads through
  EVM Wallet, showing returned network, address, amounts, and freshness.
- [x] Add user-initiated native/ERC20 transfer and approval-plus-contract-call
  examples with explicit network, amount, and destination. Use reproducible
  fixture/testnet contracts for automated effect tests; never auto-send when
  the example page mounts.
- [x] Demonstrate harmless personal-message and EIP-712 signing requests and
  independently verify returned signatures against the selected wallet account.
- [x] Persist each complete consumer intent before requesting an effect, using
  the existing IC example's durable retry pattern. Reload, endpoint replacement,
  timeout, and navigation must reuse the same request; reconcile status before
  offering a fresh effect after an ambiguous response.
- [x] Show the EVM Wallet confirmation and real operation/transaction evidence.
  Cover absent/incompatible wallet, rejected request, wrong network, pending,
  reverted, and unavailable-provider states without simulated success.
- [x] Demonstrate/test direct-root automation separately: an ordinary Kitchen
  Sink callback must not gain root authority merely by being called by Agent.
- [x] Add browser/integration tests for decline, identical replay, changed
  intent, lost reply, concurrent callers/chains, and successful approval followed
  by a failed next step. Preserve existing IC Wallet example tests and saved
  records; update Kitchen Sink README and SDK usage documentation.

Done when Kitchen Sink is a working copyable consumer example that uses EVM
Wallet's tools without receiving its signing capability or handling its keys.

## 5. Fix IC Wallet Recovery And Connect EVM Wallet

- [x] Fix false mint completion: replace the current “balance increased” check
  with correlation between the deposit transaction/event, minter outcome, and
  associated IC mint. Test an unrelated incoming transfer during a pending
  deposit; it must not complete that deposit.
- [x] Persist deposit intent, source network/account, helper/token, IC recipient,
  amount, approval/deposit operation IDs, transaction hashes, and mint progress.
  Resume on reload/upgrade and show confirmed deposit/awaiting mint accurately.
- [x] Fix receipt-timeout retry behavior: retain pending/unknown operations,
  reconcile their status, and never silently make a new deposit when the first
  may already have succeeded. Preserve already completed approval steps.
- [x] Repair older IC Send/Withdraw recovery gaps with durable commands and
  frozen ledger/minter arguments before value-moving awaits. Preserve released
  public contracts; add versioned methods where necessary and route new UI
  execution through the shared journal.
- [x] Handle each ledger/minter's actual reconciliation semantics, including
  duplicate-transfer responses, expired deduplication windows, unknown approval,
  and ambiguous withdrawal replies. Where success/failure cannot be established,
  retain an explicit unresolved outcome rather than retrying a fresh operation.
- [x] Add regression tests for an accepted transfer with a lost reply,
  delayed retries, concurrent sends, and partial approval/withdrawal completion.
  Verify existing contact checks, fee checks, funding, approvals, and history.
- [x] Add EVM Wallet as a deposit source while retaining existing external
  browser-wallet behavior. IC Wallet discovers the current supported helper and
  token mapping, then uses the shared client for approval/deposit transactions.
- [x] Keep bridge orchestration in IC Wallet: validate helper/minter identity,
  supported token, principal/subaccount, and exact amounts. Ethereum mainnet
  ck-token deposits must not be offered as direct Arbitrum deposits.
- [x] Support redemption to an EVM Wallet address through the existing minter
  protocols. Explain/quote the ckETH gas requirement and separate allowance for
  ckERC20 redemption; track withdrawal completion durably.
- [x] Add versioned bridge/quote/status tools as needed for the workflow. Agent
  obtains bridge intent from IC Wallet and calls EVM Wallet's root tool directly;
  a nested IC-Wallet call must not impersonate the root.
- [x] Preserve released `wallet` v1 and `wallet_commands` v1 schema sources and
  lineage. Add bridge/command roots or explicit successor migrations as needed;
  test existing configured wallets and pending records across skipped upgrades.

Done when existing Send/Withdraw retries are recoverable and a ck-token deposit
through EVM Wallet survives reload/timeouts and completes only for its own mint.

## 6. New Uniswap App Using EVM Wallet

- [x] Scaffold `apps/uniswap` as a separate app with its own swap UI, resident
  tools, saved operation state, tests, license/source packaging, and catalogs.
  Consume the shared EVM Wallet client; do not add an independent signer.
- [x] Choose and document the first supported router/protocol and quote source
  for Ethereum and Arbitrum. Verify current official chain deployments and
  supported SDK/API versions during implementation. If a quote API needs a key,
  specify its credential path instead of embedding it in the package.
- [x] Implement account/network selection, token pair and amount, balances,
  route/quote refresh, price impact, estimated fees, minimum received, slippage,
  recipient, and deadline. Make stale or unavailable quotes explicit.
- [x] Build exact approval/permit and swap requests from the selected quote.
  Validate chain, deployed router, input/output tokens, recipient, amount, and
  minimum output. Support native ETH versus wrapped ETH correctly.
- [x] Implement the approval model required by supported routes: ordinary ERC20
  approvals and EIP-2612/Permit2 where used. Show spender, amount, nonce/domain,
  and expiry accurately; never silently substitute an unlimited approval.
- [x] Request signatures and transactions only through EVM Wallet. Uniswap owns
  swap review; EVM Wallet owns the effect/signature decision and actual signed
  bytes. A swap quote or connected account is not standing signing authority.
- [x] Persist quote-derived intent, approval/permit progress, wallet request IDs,
  swap transaction, and final receipt. Recover partial sequences and stale
  quotes without repeating completed steps or claiming a multi-transaction EOA
  sequence is atomic.
- [x] Expose versioned read/quote/prepare/status tools for Agent. In Agent Mode,
  root obtains the prepared intent from Uniswap and calls EVM Wallet's root
  tools directly. Bind any returned execution result to the saved swap request.
- [x] Handle declined review, insufficient token/gas, fee/quote changes,
  slippage revert, expired permits, pending/replaced transactions, provider
  disagreement, and missing/incompatible EVM Wallet.
- [x] Test Ethereum and Arbitrum swaps using reproducible fork/test fixtures:
  native-to-token and token-to-token, supported approval/permit paths, rejection,
  partial completion, reload, and a lost broadcast reply. Verify recipient and
  actual receipt effects against the requested swap.

Done when a real Uniswap route executes through EVM Wallet, with recoverable
state and the same public provider contract demonstrated by Kitchen Sink.

## 7. Compatibility, Documentation, And Release

- [x] Add optional token discovery/history and enhanced simulation only behind
  replaceable adapters. Make coverage/partial failures explicit, resolve any
  provider-credential needs, and verify current APIs before choosing them.
  The selected implementation uses requested/selected token balances, local
  activity and standard `eth_call` simulation. No optional indexer or enhanced
  simulation provider is selected, and no provider credentials are embedded.
  Additional services remain app adapters, with their own coverage and error
  reporting; these optional services are not prerequisites for wallet execution.
- [x] Document network setup, funding/gas, signatures and approvals, pending
  recovery, namespace lifecycle, the SDK, and all three consumer examples.
  Update capability/consent docs to match implemented authority.
- [x] Test old/new Kernel and app combinations: existing IC Wallet remains
  usable, and new EVM features report missing support before an effect. Do not
  let version skew silently weaken the required caller/signing contract.
- [x] Audit every changed app's managed roots. Prove clean initialization,
  retained same-schema data, and every supported production migration path,
  including pending transactions and skipped releases.
- [x] Increase each changed production app's release version only after its
  compatible change is ready. Run complete workspace packaging plus app-specific
  release, integration, and browser tests; retain archive/source evidence.
- [x] Publish the compatible Kernel and app set in one catalog transaction
  through the production source `233tv-xiaaa-aaaay-aacta-cai`. Run only one
  publisher and review prepared archives and matching offered source first.
- [x] Repeat `npm run updates:publish` with identical bytes and require receipt
  v2, `batch_id: null`, every selected package/source `unchanged`, and matching
  version/URL, path, size, and SHA-256. Reconcile lost replies before rebuilding.
- [x] Verify state-preserving in-product upgrades. Leave Dispenser starter
  changes separate unless requested. Follow [package updates](./package-updates.md)
  and [memory migrations](./memory-migrations-and-uninstall.md).

Deferred beyond this checklist: Curve app, WalletConnect/external-site pairing,
smart accounts, EIP-7702, gas sponsorship, and broad NFT management. The shared
EVM Wallet tool contract should allow later consumer apps without Kernel changes.
