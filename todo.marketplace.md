# Marketplace implementation and release checklist

Implementation is local on `plan/app-marketplace`. No production marketplace has
been deployed, no production packages have been uploaded or published, and no
financial transactions have been performed. The user authorized local commits
but has not authorized pushing this work.

Protocol specifications, pinned ledger references, configuration and operator
commands are in [support/marketplace](support/marketplace/README.md). The client
is [apps/marketplace](apps/marketplace/README.md).

## Confirmed behavior

- One standalone canister owns the catalog, artifacts, audits, purchases,
  entitlements, ratings, referrals and token accounting. Domain modules share
  durable storage; the actor connects authentication, billing and scheduled work.
- Ownership belongs to the Neutron canister principal and survives uninstalling
  the marketplace or a purchased app. Acquisitions include future approved
  releases even after price changes. Revocation preserves ownership while
  preventing ordinary downloads of revoked bytes; there are no automatic refunds.
- Prices are free or $1–$50 USD inclusive before discounts. ICP, ckBTC and ckUSDC
  use daily XRC observations; a failed refresh retains the last successful price
  and reports its age/error. No price is invented before the first valid result.
- A referral code gives a default 10% discount. The affiliate and developer each
  receive 30% of the actual amount paid; the remainder goes toward burning NTN.
  Without a code, the developer receives 30% and burning receives 70%. Each
  Neutron has one universal code; self-referrals are rejected.
- Buyers pay approval/collection fees in addition to the price. Withdrawal fees
  come from the withdrawing beneficiary's credit; forwarding fees come from the
  burn allocation. Credits remain denominated in the token collected.
- Daily forwarding sends only the burn allocation to the owner's external
  conversion/burn service. Missing destinations retain funds. A forwarding
  receipt proves delivery to that service, not the subsequent NTN burn.
- Public and authenticated private queries and certified HTTP are browser-direct.
  All non-auditor updates travel through Neutron with native cycles attached.
  Assigned auditors' review updates are exempt; their other updates are not.
- Fixed cycle estimates cover processing and one prepaid storage year for uploads.
  There is no automatic protocol tariff adjustment. The operator funds storage
  after the first year; packages, unfinished uploads and entitlements do not expire.
- The app requests the approved budgets of 1 trillion cycles per call and
  10 trillion per day. Existing Install/Upgrade actions disclose the source's
  download authorization charge; no separate approval flow is introduced.
- Any Neutron may publish. Initial app-ID reservations preserve existing
  publishers. An assigned auditor approves exact package/source hashes or gives
  a rejection reason. Pending candidates do not displace approved releases.
- Top free/paid ranks distinct first acquisitions over rolling 7/30 days and all
  time. Downloads, reinstalls and retries do not increase counts. Free and paid
  owners can each maintain one editable rating per app.
- The protocol is [all rights reserved](support/marketplace/LICENSE). The user
  selected [standard NSAL 1.1](LICENSE.APP) for the separate app. Private build
  inputs are ignored and are not included in app source offers.

## Implemented

- [x] Typed public API, separate domain modules, durable orders, immutable ledger
  attempts, accounting reservations, upload journals and artifact identities.
- [x] Atomic initial publisher reservations before public registration, with
  owner conflicts rejected and existing roots preserved during upgrades.
- [x] Catalog/search, acquisition charts with coherent rolling snapshots,
  ratings, referral codes, publisher listings and review history.
- [x] Resumable byte uploads, digest/size verification, one-year storage charging,
  immutable package/source artifacts, screenshots and candidate submission.
- [x] Checkout includes required unowned paid/free dependencies before funding;
  shared dependencies are charged once and owned dependencies are not re-bought.
- [x] Admin-assigned auditors, private inspection downloads, exact digest-bound
  approval/rejection/revocation and developer-visible reasons.
- [x] One purchase and one withdrawal mutation supporting same-ID recovery,
  guaranteed ledger responses, exact deduplication and durable returned receipts.
- [x] Integer USD/token pricing, actual-paid revenue splits, separate liabilities,
  beneficiary withdrawal reservations and burn-only daily forwarding.
- [x] Daily XRC refresh, retained-rate fallback, upgrade-safe scheduled jobs and
  durable ICRC-1/2 write receipts. No ICRC-3 or ledger-history lookup surface.
- [x] Certified HTTP v2 package/source downloads with request-bound authorization,
  streaming, revocation and canonical content types. Legacy repository metadata
  stays compatible without exposing paid bytes through anonymous Candid reads.
- [x] Generic Kernel repository authorization and authenticated downloads across
  installation, grouped installation, offered source and Settings updates.
  Kernel code contains no marketplace commerce or entitlement rules.
- [x] Compact Explore, My Apps, Publish and Earnings UI; token payment reviews,
  exact allocations/fees, agent tools and IC Wallet dependency declarations.
- [x] Browser read delegation and durable protocol operation history, so losing
  local client state does not lose purchases or payment recovery records.
- [x] Publisher/auditor/admin CLI, resumable publication journal, read-only
  migration inventory and explicitly scoped old-to-new source transition tooling.
- [x] Standalone `icp` build/install/upgrade configuration and a reviewable fixed
  cost preset. Actual deployment uses explicit operator configuration.

## Local validation

The executable entry points are:

```sh
npm --workspace neutron-marketplace-protocol test
npm --workspace neutron-marketplace run typecheck
npm --workspace neutron-marketplace test
npm --workspace neutron-marketplace run test:protocol
npm --workspace neutron-marketplace run test:browser
npm --workspace neutron-marketplace run package
npm --workspace neutron-update-source run check
npm --workspace neutron-kernel test
npm --workspace neutron-compiler test
npm --workspace neutron-kernel run package
npm --workspace neutron-kernel run certified-assets:candidate-binding
npm --workspace neutron-kernel run certified-assets:qualify
```

The protocol suites use Ash/PocketIC and distinguish domain tests, scripted
ledger faults, official ICRC ledger Wasm, cryptographic HTTP verification and
actual same-canister upgrades. Coverage includes lost replies, duplicates,
concurrent continuations, fee changes, expired deduplication, allocation traps,
reserved earnings, daily jobs across upgrades, hash-bound audit decisions,
private streaming and retained bytes beyond the prepaid year. See the
[testing specification](support/marketplace/spec/testing.md) for their limits.

The final IC/Ethereum protocol validation passed 37 unit tests and 82 Ash tests
with no skips. The 40 PocketIC host cases have passing results: the aggregate
passed 39, and its storage-upgrade fixture passed a focused rerun after adding
subnet rounds following the simulated year-long clock jump. That correction
changes test scheduling, not production behavior. The normal build's Wasm
SHA-256 is `18def141b7ed5cb081e18b4e58cb1bd11ece899985987e62d97a8d3b8799fe0f`,
matching the public-actor integration fixture.

Marketplace 101 passes 86 client tests, Motoko initialization/restoration checks,
real protocol adapter tests, responsive browser suites, typecheck and complete
packaging. Its archive SHA-256 is
`f3286df1e087f09c950964adf84202038a0e09d440b6e77adb7f7bb1043c70c1`.
The shared SDK passes 402 tests, including preserved browser-wallet error codes.

A broader `neutron-scripts` sweep reports 72 passes and an existing collection-
style failure in `apps/evm_wallet/test/concurrency_await_wallet.mo` (`Array.concat`
assignment). That unrelated fixture is unchanged; this is not a claim that the
entire repository test suite passes.

The existing Kernel `kernel` v4 and `kernel_activation` v1 roots and the released
v3→v4 migration are unchanged. Generic acquisition uses transient state; no fake
memory migration was introduced. Kernel release 352 and marketplace release 101
are local candidates; the preceding local artifacts remain immutable. Package
construction and qualification are not publication.

Kernel 352 passes all 840 TypeScript tests and 33 Motoko suites, complete
packaging, fresh certified-assets qualification and its final candidate-binding
check. The compiler suite passes 370 tests with 165 documented opt-in/environment
skips. The Kernel archive SHA-256 is
`b8f5fc3e0dd79fcb950e8ae3c1197ef48deccbc07dcaac922854acc61a498c13`;
its retained offered-source artifact is
`a657ab49014433e5074d7e1b6b958e9560839d0bccd330dc3454a94ec482e008`.

Browser fixtures and local ledger tests do not establish mainnet behavior or
complete live Wallet/installation acceptance. Those require a separately
reviewed release and smoke test; no paid production testing was authorized here.

## Production release remains pending

- [ ] Supply the deployed marketplace principal, initial admin Neutron(s),
  assigned auditor principal(s), and complete existing-app publisher bindings.
- [ ] Review the fixed [cycle-cost preset](support/marketplace/config/README.md),
  initial ledger fees and creation cycles; encode a complete initialization file
  outside Git. Include app-ID reservations in the first installation.
- [ ] Supply the three ICP/ckBTC/ckUSDC conversion-service receiving accounts.
  They may remain unset initially; allocations then stay in the protocol.
- [ ] Obtain authorization to push the implementation and deploy reviewed Wasm
  through `icp`. Verify installed module identity and retained-state evidence.
- [ ] Import/upload the intended app releases and source artifacts under their
  proper publisher principals; auditors inspect and approve exact bytes.
- [ ] Build higher state-compatible transition packages naming the actual new
  `update_source`, including the Kernel. Preserve all released memory lineage.
- [ ] Approve and verify transition bytes at the new source before publishing
  the compatible transition set atomically to the old catalog. The transition
  sidecar pins both sources and exact app versions/package hashes.
- [ ] Reconcile a lost publication reply with identical bytes; require receipt-v2
  no-op verification. Two source publications are ordered, not cross-canister atomic.
- [ ] Exercise ordinary selected installs/Upgrade all. No registry source rewrite,
  Kernel-first publication delay or destructive reinstall is part of migration.
- [ ] Retain old source artifacts and transition releases for late/skipped
  upgrades. Future releases use the new source. Update the Dispenser separately
  only when future newly dispensed Neutrons should use the new package set.

The existing production source stays at `233tv-xiaaa-aaaay-aacta-cai` until the
explicit source transition. A new principal has not been guessed or put into
current production manifests. Follow [package updates](doc/package-updates.md)
and [managed-memory migrations](doc/memory-migrations-and-uninstall.md).

## Ethereum USDC extension

The owner added Ethereum USDC checkout after the IC payment implementation.
Both the Neutron EVM Wallet and a browser wallet such as MetaMask must be
supported. App access must not wait for USDC conversion into ckUSDC; revenue
must remain unavailable until the converted funds have actually been collected.

- [x] Verify the official deposit helper supports a marketplace principal and a
  separate invoice subaccount, without a new Ethereum custody key.
- [x] Verify the deployed EVM RPC receipt interface and current minter mapping
  using anonymous metadata queries; no personal RPC token or archive-state
  requests are required.
- [x] Complete the exact-receipt adapter and negative evidence tests.
- [x] Add durable invoices, replay protection, early entitlements and separate
  conversion/collection status. Unlock on a successful mined payment, without
  waiting for wrapping; a pending submission or browser-provided transaction
  data alone is never payment authority.
- [x] Integrate browser-wallet and Neutron EVM Wallet checkout and agent tools.
- [x] Collect converted ckUSDC with the retained original ledger request, then
  release the ordinary developer, affiliate and burn allocations exactly once.
- [x] Cover failed/replaced transactions, duplicate/concurrent verification,
  wrapping delays, interrupted settlement and upgrades in PocketIC.

The Ethereum suites include a public-actor test that downloads an owned package
before any ckUSDC mint, and actual upgrades between retained receipts and local
finalization. Conversion releases earnings only after the original collection
succeeds. This is local validation; no mainnet payment was submitted.
