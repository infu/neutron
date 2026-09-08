# Hyperliquid implementation

Build an independent Neutron Hyperliquid app for default perpetual markets.
UI and Agent tools share the resident browser implementation. Research remains
outside the repository at `/tmp/neutron-hyperliquid-research/`.

## Scope and architecture

- [x] Inspect the current Wallet, Curve, Uniswap, Aave, Agent and platform contracts.
- [x] Base implementation on current upstream `449d68f` without changing custody.
- [x] Select perps only: no spot trading, HIP-3 markets or vault management.
- [x] Select browser-direct market data, order submission and CCTP API calls.
- [x] Keep the master account in EVM Wallet; use a separate approved browser
  trading key. Browser profile loss requires a fresh key approval. Accepted
  venue orders persist when the browser closes; browser strategies do not run
  while Neutron is closed.
- [x] Implement installation-owned encrypted browser key storage, lifecycle,
  nonce coordination, approval state and revocation.
- [x] Persist ordinary trade intent and exact signed envelopes in browser
  storage before dispatch; reconcile ambiguous outcomes without fresh orders.
- [x] Persist funding operations in managed `hyperliquid@1` memory with exact
  Wallet request identities, wallet binding and caller provenance.

## Trading and informed Agent tools

- [x] Discover current default perps metadata, margin parameters and delistings.
- [x] Read balances, account mode, positions, open orders, fills, fees and funding
  with timestamps and explicit unavailable/partial data.
- [x] Provide candles and chart analysis with named windows and sufficient-data
  checks; expose orderbook depth, spread, imbalance and executable-size analysis.
- [x] Implement exact-decimal market IOC and limit GTC/post-only orders, previews,
  partial fills, order edits/cancellations and reduce-only full/partial closes.
- [x] Implement leverage, isolated margin and position protection controls.
- [x] Register discoverable closed-schema tools with correct effect annotations,
  invocation cancellation and exact human/Agent provider review.

## USDC liquidity

- [x] Verify Circle deployments, fees, hook encoding and signing against primary
  sources; use native USDC and CCTP domain IDs explicitly.
- [x] Deposit Ethereum/Arbitrum USDC through CCTP into default perps collateral.
- [x] Withdraw HyperCore USDC to the same Wallet on Ethereum/Arbitrum.
- [x] Reconcile source transactions, CCTP forwarding and destination evidence;
  a burn or API acknowledgement alone is not completion.
- [x] Fix Wallet's demonstrated Hyperliquid EIP-712 type-name incompatibility
  with independent digest vectors and understandable protocol reviews.

## UX and qualification

- [x] Build a polished trading tile with candles, book, order entry, positions,
  orders, liquidity transfers and recoverable activity.
- [x] Verify narrow full-height tiles, wide/short shapes, keyboard interaction,
  readable errors, pending states and no horizontal overflow.
- [x] Exercise actual resident tools and frontend with deterministic browser
  fixtures, including interrupted requests and permission rejection.
- [x] Run read-only live API/CORS checks separately from deterministic tests.
- [x] Test managed-memory clean initialization and restoration; retain all
  released Wallet schema and lock history.
- [x] Complete both app package commands, release suites, type checks and shared
  license/security checks. Record real evidence and any remaining limitations.
- [x] Register the new app in repository/catalog workflows; review archives and
  matching offered-source artifacts before production publication.
- [x] Publish the changed package set through the canonical update source and
  repeat identical bytes for the required verified receipt-v2 no-op.

No Kernel policy restrictions, custody resets or starter changes are part of
this implementation.

## Release qualification — 2026-09-07

- Hyperliquid `0.1.0` (`100`) and EVM Wallet `0.1.20` (`120`) completed their
  full workspace package commands. The Wallet change adds Hyperliquid typed
  signing and transfer presentation; its three released memory roots and
  `neutron.lock.json` remain byte-for-byte unchanged.
- Hyperliquid release suite: **111 tests, 1,109 assertions**, managed-memory
  initialization/restoration, real React browser scenarios at **320×900,
  400×900, 900×700 and 1440×900**, and the actual resident service/SDK transport.
  The resident fixture exercised 24 service descriptors, one Wallet setup
  signature and nine direct exchange requests, with no per-trade canister call.
- The candlestick chart has volume, live updates, precise OHLCV inspection,
  zoom/pan, keyboard navigation, timeframe controls, fit/latest controls and
  optional position, liquidation and order overlays. Browser checks include
  stale/error states, market identity, stream cleanup and narrow tile overflow.
- Wallet release validation: **267 tests, 2,675 assertions**, independent
  EIP-712 digest vectors, browser review checks and both memory test programs.
  The final repack also passed the 14 package tests (725 assertions).
- **22 live read-only checks passed** against mainnet/testnet Hyperliquid,
  Circle and deployed USDC/CCTP contracts in Chromium with web security enabled.
- Both app TypeScript projects, shared build/publisher TypeScript, license
  boundaries, third-party license material tests, security checks and
  `git diff --check` passed.
- The new 21-entry catalog exposed a publisher bug: it applied the existing
  20-package mutation bound to unchanged inventory too. The bound now applies
  to changed packages within the same atomic batch. Every catalog package and
  offered source still receives preflight/postflight verification. Existing
  byte bounds remain unchanged. Publisher validation: **54 tests, 529
  assertions**; independent review found no concrete blocker.
- All **21** archives and exact offered-source objects passed local inspection.
  Read-only production pointer comparison found precisely **two** intended
  changes: new Hyperliquid and Wallet 119 → 120. The other 19 matched.

### Prepared artifacts

- `apps/evm_wallet/evm_wallet.v0.1.20.neutron`: 640,571 bytes; SHA-256
  `dcdfffcf0a1fc536ee2046e8ed435a30ccee12faec342a0831fbf9b97e08a7a4`.
  Offered source: 718,139 bytes; SHA-256
  `ce5990c1b70a487162df32d97e61677f1d9e29dcc16833feb23806d1a3d05bfd`.
- `apps/hyperliquid/hyperliquid.v0.1.0.neutron`: 452,007 bytes; SHA-256
  `90e9c8c8a9cfd125bbf0db4bf04c8697416fd5244bd2aaf399d35232611898f1`.
  Offered source: 533,686 bytes; SHA-256
  `3230ed9d53ca9f15b28381b7e19fa133ad28fce49057993f8cc448c873d761dc`.

### Evidence and practical limits

Detailed logs and research remain outside repository documentation:
`/tmp/neutron-hl-release-tests-final.log`,
`/tmp/neutron-hyperliquid-browser/`,
`/tmp/neutron-hyperliquid-chart/`,
`/tmp/neutron-hyperliquid-live-evidence.json`, and
`/tmp/neutron-hl-release-preflight.json`.

Live qualification used public reads only. No funded order, approval, deposit
or withdrawal was sent to a live venue. Deterministic tests cover those effect
and recovery paths with synthetic venue/Wallet evidence.

Deposit evidence distinguishes a proven HyperEVM mint/forwarding queue event
from an observed matching HyperCore credit. The public ledger does not expose
an exact EVM transaction-hash link, so matching credit is contextual evidence;
it is not promoted to proof of final Core execution. Withdrawal completion
requires the exact destination native-USDC mint evidence. Unknown outcomes
retain their original operation identities and signed bytes.

### Publication completed

Canonical `npm run updates:publish` published Hyperliquid 100 and Wallet 120,
including both exact offered-source objects, atomically in **batch 69**. The
other 19 catalog packages were unchanged. Repeating the same command against
identical bytes returned receipt-v2 **`batch_id: null`**; all **21 packages and
21 offered sources** were `unchanged`. Every receipt version, URL/path, size and
SHA-256 was compared with the prepared inventory and current local bytes.

Full receipts and the reviewed artifact inventory are retained alongside local
release artifacts under
`.neutron/publications/2026-09-07-hyperliquid-0.1.0-wallet-0.1.20/` and in `/tmp`.
The published app still needs installation into an existing Neutron; Wallet
0.1.20 must be selected for this integration. No existing canister was
reinstalled, and the Dispenser starter was not changed.

## UX and funding follow-up

- [x] Remove the mainnet/testnet selector from the user interface; retain explicit
  testnet tools and fixtures for development.
- [x] Compact the header, balances and market statistics so the chart is visible
  near the top of narrow tiles, and make browser trading access a prominent action.
- [x] Move secondary order explanations behind accessible info controls and
  describe an observed empty account without a technical balance-mode warning.
- [x] Add precise percentage sliders and Max controls for orders and USDC
  transfers using actual venue capacity, configured leverage and source balances.
- [x] Refresh changing deposit fees before the initial Wallet burn review;
  preserve already-dispatched requests and continuation of released journal rows.
- [x] Prove Root-mode setup, trading and funding require no user clicks and
  Normal-mode effects retain user approval through the existing permission flow.
- [x] Verify dismissal, tile/browser closure and delayed destination evidence
  retain a recoverable transfer in Activity without another burn.
- [x] Complete stalled post-burn transfers with original-message destination
  recovery, attestation refresh and proven cash-to-perps fallback; add Wallet
  HyperEVM gas/signing support while preserving all released memory roots.
- [x] Fix Normal Agent foreground-review identity so prepared orders open the
  real approval dialog; verify the same retained order resumes and Root keeps
  its existing permission-judge path without user clicks.
- [x] Remove the redundant candle icon and Candles badge in every chart layout.
- [x] Remove visible chart navigation tips, the orderbook hint, routine live
  timestamps and the redundant Account details popup; retain the main balances
  and meaningful unavailable/stale-data states.
- [x] Qualify the state-preserving successor, publish its exact package/source,
  verify the identical-byte no-op, and update PR #30.


### Revision implementation

Normal Agent review now accepts the original requester carried by Kernel's
foreground attestation. The previous same-app check rejected that legitimate
handoff after saving a prepared order. The private owner-review route still
requires the authenticated Hyperliquid resident; Root invocations retain the
existing exact permission-judge review. Tool descriptions distinguish a
read-only preview from execution and explain resuming the original prepared ID.

Destination recovery persists original messages, attestations, Wallet request
IDs and attempted transactions before dispatch. It checks consumed CCTP nonces
and exact source/destination evidence, retains uncertain signed requests, and
allows an expired unsigned review to advance only after protocol expiry is
observed. Temporary RPC receipt absence cannot erase the original withdrawal
source identity. Recovery does not create another burn or change the recipient,
amount or fee cap. A proven Core cash fallback can use a same-account master
Wallet cash-to-perps signature without spot trading or an account-mode change.

Wallet adds HyperEVM chain 999, native HYPE gas and canonical USDC configuration
only where absent. Its browser RPC supports explicit historical block reads;
recovery decoders explain exact mint/forward and cash-transfer actions. Wallet's
three v1 memory roots and Hyperliquid's v1 root retain released schema and lock
lineage. No Kernel policy or restriction is introduced.

CCTP does not refund the source after a successful burn. Destination mint
recovery requires HYPE gas for deposits or destination-chain ETH for withdrawals,
and valid Circle attestation evidence. A successful EVM CoreWriter queue with
no observed Core credit still needs protocol investigation: repeating a mint
cannot replay that queued Core action. External chain, Circle and venue outages
can delay delivery; the application preserves the evidence needed to continue.


### Successor qualification — 2026-09-08

- Hyperliquid 101 / 0.1.1: complete workspace package command and release suite
  passed: **169 tests, 1,591 assertions**, memory initialization/restoration,
  four responsive browser viewports, 18 UI fixture effects and 11 owner reviews.
  Actual resident/SDK/React integration passed all seven checkpoints with 27
  resident tools (26 public tools and private identity), four Wallet signatures
  and 13 direct exchange requests.
- Normal Agent's real review dialog approves exactly one order or declines
  without dispatch; the saved prepared operation resumes with its original
  cloid. Restoring the old guard in a temporary build reproduces the failure.
  Root setup, trades, funding and revocation complete without a foreground tile.
- Funding coverage includes **69 tests / 538 assertions** across protocol,
  evidence, recovery and Core cash handling. Tests cover fee movement, closed
  notifications/browser sessions, lost replies, concurrent recovery, expired
  unsigned review replacement, re-attestation and consumed message variants,
  and retained completion after ordinary reconciliation.
- Wallet 121 / 0.1.21: full workspace test command passed **271 tests / 2,734
  assertions**, both memory programs and 47 browser checks. Final repack and
  successor package tests passed **15 tests / 779 assertions**, including the
  exact published Wallet 120 predecessor and all three retained memory roots.
- Live read-only qualification: **22 Hyperliquid/Circle/contract checks** and
  **eight HyperEVM Wallet browser checks** passed with normal Chromium web
  security. No funded transaction, signature or exchange request was sent.
- Both app and shared build/publisher TypeScript, license boundaries, security
  checks and diff checks passed. Released memory sources, locks and prior
  100/120 archives are unchanged. Every current app file in the offered source
  matches the working tree (54 Hyperliquid files, 138 Wallet files).
- All 21 catalog archives and offered-source objects passed local inspection.
  Public release-pointer comparison found only Hyperliquid 100 → 101 and
  Wallet 120 → 121 changed; the other 19 packages matched exactly.

### Successor artifacts

- `apps/hyperliquid/hyperliquid.v0.1.1.neutron`: 463,404 bytes; SHA-256
  `2663e454e603cdad6e299c8821f41adefaa8a61bc3483004c9def61034ea4d23`.
  Offered source: 573,736 bytes; SHA-256
  `01834e544be253c84b7c0d5e2261b335f81eaea3008f03c563774052da3f6cef`.
- `apps/evm_wallet/evm_wallet.v0.1.21.neutron`: 643,462 bytes; SHA-256
  `b873d917802af4b7e6eb88943fefba0f3e6d9c197623216702794b33d8112633`.
  Offered source: 723,213 bytes; SHA-256
  `6cdbacf242080e2e6cb2f0db52905fffcc263c9be8c6e71b3012ff29a19424c8`.

Detailed revision research and evidence remain outside repository documentation:
`/tmp/neutron-hl-revision-release-tests-final.log`,
`/tmp/neutron-hl-revision-wallet-release.log`,
`/tmp/neutron-hl-revision-wallet-final-package-tests.log`,
`/tmp/neutron-hyperliquid-browser/`,
`/tmp/neutron-hyperliquid-revision-live-evidence.json`,
`/tmp/neutron-wallet-hyperevm-live-evidence.json`, and
`/tmp/neutron-hl-revision-release-preflight.json`.


### Successor publication completed

Canonical `npm run updates:publish` published Hyperliquid 101 and Wallet 121,
including both offered-source objects, atomically in **batch 70**. The other
19 catalog packages were unchanged. The identical-byte repeat returned
receipt-v2 **`batch_id: null`**, with all **21 packages and 21 offered sources**
`unchanged`. Every version, URL/path, size and SHA-256 matched the reviewed
inventory, and all local archive/source bytes were rehashed unchanged afterward.

Receipts, verification and reviewed inventory are retained under
`.neutron/publications/2026-09-08-hyperliquid-0.1.1-wallet-0.1.21/` and in `/tmp`.
PR #30 carries these successor archives and implementation. Existing Neutrons
need to update Hyperliquid and EVM Wallet to receive the changes. No canister
was reinstalled and the Dispenser starter remains unchanged.
