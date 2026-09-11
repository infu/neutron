# Marketplace implementation and release checklist

Implementation is on `plan/app-marketplace`. The production marketplace is
deployed at `sj2r4-haaaa-aaaay-aadgq-cai`, with 27 initial free app releases
published. The old source also has the 26 transition releases for existing
Neutrons. Publication does not install apps into users' Neutrons. The owner
authorized deployment and publication, and authorized pushing this branch to the
existing PR on 2026-09-11. Exact release and verification status is in the
[production release record](support/marketplace/spec/production-release.md).

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
  Ordinary updates travel through Neutron with native cycles attached. Assigned
  auditors' review updates and the four assigned-admin endpoints are exempt;
  these roles do not exempt ordinary purchases, publishing or withdrawals.
- Fixed cycle estimates cover processing and one prepaid storage year for uploads.
  There is no automatic protocol tariff adjustment. The operator funds storage
  after the first year; packages, unfinished uploads and entitlements do not expire.
- The app requests the approved budgets of 1 trillion cycles per call and
  10 trillion per day. Existing Install/Upgrade actions disclose the source's
  download authorization charge; no separate approval flow is introduced.
- Any Neutron may publish. Initial app-ID reservations preserve existing
  publishers. An assigned auditor approves exact package/source hashes or gives
  a rejection reason. Pending candidates do not displace approved releases.
- Blast ID 0 owns the initial listings. All releases published by our scripts
  under that exact configured principal are cycle-free and automatically
  approved after artifact checks. It can withdraw its own earnings through the
  CLI. Other publishers retain cycle charges and assigned-auditor review.
- Keep current approved packages/source and pending review content in the new
  marketplace. Retire superseded bytes, preserving purchases, payment records,
  audit history and local release archives.
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
- [x] Direct administration from assigned CLI principals. The four admin-only
  updates accept no caller cycles; ordinary purchases, publishing, uploads and
  withdrawals retain the Neutron route and its cycle charges. No admin or auditor
  interface is part of the app.
- [x] Standalone `icp` build/install/upgrade configuration and a reviewable fixed
  cost preset. Actual deployment uses explicit operator configuration.
- [x] First-party direct publishing and own earnings withdrawal, exact-principal
  automatic atomic approval, root publication-script migration and no-op checks.
- [x] Latest-package retention, safe staged/shared artifacts, certified deletion,
  and explicit UI recovery when a prepared release has been retired.

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

The IC/Ethereum protocol baseline passed 37 unit tests and 82 Ash tests
with no skips. The 40 PocketIC host cases have passing results: the aggregate
passed 39, and its storage-upgrade fixture passed a focused rerun after adding
subnet rounds following the simulated year-long clock jump. That correction
changes test scheduling, not production behavior. That normal build's Wasm
SHA-256 was `18def141b7ed5cb081e18b4e58cb1bd11ece899985987e62d97a8d3b8799fe0f`,
matching the public-actor integration fixture.

Marketplace 101 passes 86 client tests, Motoko initialization/restoration checks,
real protocol adapter tests, responsive browser suites, typecheck and complete
packaging. Its archive SHA-256 is
`f3286df1e087f09c950964adf84202038a0e09d440b6e77adb7f7bb1043c70c1`.
The shared SDK passes 402 tests, including preserved browser-wallet error codes.

Marketplace 103 additionally fixes installation cost disclosure, direct tile
handoff to the Kernel, and durable recovery of prepared or interrupted install
requests. Reloading My Apps retains the original request; a saved setup URL
opens without another preparation update. Both scoped agent modes keep their
invocation-bound handoff. Its 88 top-level tests pass, including isolated suites
with 26 installation and 8 handoff cases, alongside Motoko restoration, real
protocol integration, five browser suites, typecheck and complete packaging.
Archive SHA-256:
`4c6381ee1aedb29b38de860b4356ef11194e92d22dbb4fddf6b070f910b6e426`.
Archives 100–102 and managed memory version 1 remain unchanged.

Marketplace 104 adds an explicit **Prepare latest selection** action for an old
ready offer whose release has been replaced or revoked. It displays a new cost
quote before preparation, preserves the old request, and keeps the new request
ID through an interrupted reply. The 88 top-level tests, 27 focused installation
cases, Motoko state restoration, protocol integration, all five browser suites,
typecheck and packaging pass. Its archive SHA-256 is
`1d8afeb405d5935372004df85664a8b0b7ae6fdfe2d9e44f73936cd89cadb02e`.
Archives 100–103 and memory version 1 remain unchanged. Its offered source
contains 334 files and no private protocol or storage-configuration inputs.

A later full-installation check found a certified-witness lookup defect in the
pinned IC JavaScript client: comparison continued beyond the first differing
byte, rejecting valid package-absence proofs when multiple release labels were
present. The shared asset reader now compares labels lexicographically while
retaining certificate/root verification and rejection of unresolved proofs.
All 406 SDK tests and both real repository certification cases pass, including
the captured failing witness and a same-canister upgrade.

The documented `icp 1.0.2` install and `--wasm-memory-persistence keep` upgrade
commands also passed on an isolated local network. The module hash matched the
tested build, and retained configuration survived deliberately changed upgrade
initialization arguments. That disposable network has been stopped.

Two additional PocketIC cases pass against DFINITY's actual native ICP ledger
Wasm: direct ICRC-1/2 compatibility and production purchase/withdrawal recovery
across upgrades. They extend the original generic ckBTC/ckUSDC fixtures and use
no ledger-history interfaces. The exact release and hashes are retained in the
[fixture provenance](support/marketplace/test/fixtures/native-icp.md).

A further production-limit PocketIC case passes for 5,000 apps and 25,020
acquisitions, verifying all six ranking charts and 25,000 weekly expiries. Its
largest measured execution used 99.07 million instructions, 0.248% of the IC
update limit. No catalog quota or production ranking change was introduced.

A broader `neutron-scripts` sweep reports 72 passes and an existing collection-
style failure in `apps/evm_wallet/test/concurrency_await_wallet.mo` (`Array.concat`
assignment). That unrelated fixture is unchanged; this is not a claim that the
entire repository test suite passes.

The existing Kernel `kernel` v4 and `kernel_activation` v1 roots and the released
v3→v4 migration are unchanged. Generic acquisition uses transient state; no fake
memory migration was introduced. Kernel release 354 and marketplace release 106
were the candidates at that local validation checkpoint; those artifacts remain
immutable. Package construction and qualification are not publication.

Kernel 354 passes all 840 TypeScript tests and 33 Motoko suites, complete
packaging, fresh certified-assets qualification and its final candidate-binding
check. The compiler suite passes 370 tests with 165 documented opt-in/environment
skips. The Kernel archive SHA-256 is
`b22aeb303d936753f896780148243763597af114ab80452dbe9b482a1e829156`;
its retained offered-source artifact is
`2aba64fa0b0c01e0ac0172c47e0153802e3714650a476aa8db31becd7c02514e`.

The prior 353 test run passed 839 TypeScript cases; its growing retained-archive
comparison exceeded the default five-second test timeout without an assertion
failure. Version 354 gives that compatibility test an explicit 30-second budget
and passes the complete suite. The 353 archive remains unchanged, alongside
351–352; these retained local artifacts are included as immutable test fixtures.

The Marketplace 103 paid-install lifecycle also passes through the normal
host runner: one case with 113 assertions on Marketplace 103 / Kernel 354.
A single ledger collection grants two apps; certified private downloads feed
actual checked installs and registry reads. Uninstall/reinstall preserves
ownership and unrelated memory. After Marketplace itself is uninstalled, both
paid apps update together through their source, preserving their remaining
managed state and installation identities. The test observes five private reads
and two batch download grants, with no second purchase.

Before the direct-admin change, host discovery contained 45 cases. Evidence combines the original 40-case
baseline with five added focused cases: native ICP (2), ranking scale (1),
two-release certification (1), and checked installation (1). This is not a claim
of a fresh 45-case aggregate run. The existing repository case was also rerun.

The direct-admin follow-up passes 59 unit tests and 16 affected Ash cases
(initialization, access and rates). Its added public-actor case covers all four
zero-cycle admin methods, direct signing identities, existing canister admins,
invalid initial admin configuration and unauthorized callers. Ordinary listing
and purchase methods still enforce the Neutron and cycle requirements. The
existing full acquisition/withdrawal/private-download/upgrade case also passes.

An actual Blast 4.2.0 smoke test found and fixed controller-only Candid metadata.
The build now publishes only the service interface; constructor and stable-type
metadata remain private and unchanged. That admin-only revision's protocol Wasm SHA-256:
`0d9af11fa662a51da3ff9200070fe04db1838cc064c01998400d85b47bc2debc`.
On an isolated `icp` local network, a non-controller Blast identity successfully
discovered and called all four admin methods, assigned/removed an auditor, and
retained roles/configuration through a same-canister keep upgrade. Unauthorized
admin calls and ordinary direct publisher writes were rejected. The test network
is stopped. Host discovery now contains 46 cases; the added focused evidence is
not a new full-suite aggregate run.

The final-artifact paid-install lifecycle was rerun successfully with Marketplace
104, Kernel 354 and the public-Candid protocol build above: one host case, 113
assertions, no failures. It verifies one purchase collection, five private HTTP
reads, two download grants, owned reinstall and grouped updates after removing
Marketplace, with unrelated managed state preserved.

Local browser and PocketIC evidence does not establish mainnet behavior or a
complete live Wallet acceptance test. Those require a separately reviewed
release and smoke test; no paid production testing was authorized here.

## First-party publication and retention follow-up

The root `npm run updates:publish` now targets the configured marketplace using
the existing Blast ID 0. Exact archive/source checks precede one atomic
automatic-approval batch. Publication journals retain the original candidates
and batch across lost replies, and the second run verifies receipt-v2 unchanged
results. The legacy publisher remains explicit for source migration.

Only that configured principal receives free publishing, own-file grants and
withdrawal of its own earnings. Other admins, auditors and publishers do not
inherit this exception. Four public-actor PocketIC cases cover those boundaries,
real ledger collection/royalty withdrawal, upgrades and rollback after an earlier
package's promotion and content retirement within a failed batch.

Superseded artifact removal preserves current releases, pending reviews and
genuinely staged uploads. Explicit upload/candidate associations protect new
uploads with the same digest as old content. Storage and certified-HTTP tests
cover reuse of freed allocations, old streaming tokens, current content and
ownership through upgrades. Stable-memory capacity itself does not shrink when
an allocation is freed.

Marketplace 106 fixes recovery after a successful preparation whose reply was
lost and whose release was subsequently retired. Only an explicit protocol
`release_unavailable` answer enables a fresh reviewed selection; unknown replies
retain the original ID. Approval headings describe an approved release without
claiming a malware scan. Its complete app gates pass: 88 top-level tests,
29 focused installation cases, Motoko initialization/restoration, five browser
suites, real protocol integration, typecheck and packaging. The memory root and
lock remain unchanged; archives 104 and 105 are preserved.

Current package: `marketplace.v0.1.6.neutron`, 2,166,004 bytes, SHA-256
`72b71a5ae2857948620c3801dff7884ffb4e01d75d4c23817f3353d4a02ab0a9`.
Its offered source contains 334 files with no private paths. The current normal
protocol build matches the tested Wasm:
`1bd60e9e252c7372d2e6939d3a3896fd0566c18abf4022bd4a49c8542f633d8b`.
The final 106/354 paid-install lifecycle passes 113 assertions, including grouped
upgrades after Marketplace uninstall and preservation of unrelated state.

The actual publishing CLI also passes against a disposable local canister using
the same Wasm and the existing Blast ID 0. One atomic batch publishes a free app,
a $1 app and both hosted source artifacts. The exact repeat returns receipt-v2
`batch_id: null` with all artifacts unchanged. The checks verify automatic stamps,
ownership, anonymous denial and paid-package privacy; the network was stopped.
This local smoke does not publish production apps.

Final unit coverage is 96 passing cases. Protocol domain coverage is 93 passing
cases across the full run and focused reruns: the repository test now expects a
superseded release's bytes to be retired while retaining ownership and the
original request, and the new rate test verifies that ckBTC payments request
BTC/USD from XRC and retain that rate against the ckBTC ledger. No ckBTC/USD
oracle pair is requested.

All 54 host integration cases also pass on the final Wasm: 12 fixture, 6 HTTP,
22 protocol and 14 upgrade cases. This is combined evidence, not an uninterrupted
single-command pass: three older public-actor fixtures needed the new optional
initialization field explicitly empty; the corrected admin case passed on
rerun. That installed-app lifecycle was run separately against Marketplace 106
and Kernel 354. The production candidates, Marketplace 107 and Kernel 356, then
passed the same complete lifecycle with 113 assertions: paid installation,
reinstallation without repurchase, Marketplace removal, and grouped private
upgrades preserving both installed apps' state. No mainnet purchases were used
for these tests.

## Production release

- [x] Select Blast ID 0 as administrator and initial listing owner:
  `y7t6r-gtsqz-45ogs-2k3gk-l6hic-2h7wm-zosg6-uldzf-l4ams-2jaky-wqe`.
  The deployed configuration reserves all 26 existing catalog IDs plus
  Marketplace to that principal. Other auditors can be assigned later.
- [x] Deploy `sj2r4-haaaa-aaaay-aadgq-cai` through `icp` and verify its controllers
  and exact tested Wasm:
  `1bd60e9e252c7372d2e6939d3a3896fd0566c18abf4022bd4a49c8542f633d8b`.
- [x] Review the fixed [cycle-cost preset](support/marketplace/config/README.md),
  ledger fees and initialization, and retain the exact operator inputs outside
  Git. Verify initial ICP/USD, BTC/USD and USDC/USD refreshes.
- [ ] Supply the three ICP/ckBTC/ckUSDC conversion-service receiving accounts.
  They may remain unset initially; allocations then stay in the protocol.
- [x] Obtain authorization before pushing the local Git commits (2026-09-11).
- [x] Publish all 27 initial free releases and offered-source artifacts as Blast
  ID 0 in marketplace batch 1, with exact-byte automated audit records. Verify
  the live catalog's ownership, prices, approvals and versions.
- [x] Build higher state-compatible transition packages naming the actual new
  `update_source`, including the Kernel. Preserve all released memory lineage.
- [x] Verify the new source's exact bytes, then publish all 26 existing apps
  atomically to the old source in batch 97. The transition sidecar pins both
  sources and every app version/package hash.
- [x] Repeat marketplace publication and require receipt-v2 `batch_id: null`,
  with all 27 packages and offered sources unchanged.
- [x] Repeat old-source publication and require the same verified no-op for all
  26 transition packages and offered sources. Keep the exact bytes and retained
  request identities if any reply is interrupted.
- [x] Exercise selected installs and grouped upgrades in PocketIC. Kernel 356
  passes 840 TypeScript tests, 33 Motoko suites and fresh certified-assets
  qualification. All 27 apps pass their package and release gates; memory
  schemas, migrations, locks and earlier archives remain unchanged.
- [x] Retain the old source and transition releases for late or skipped upgrades.
  Existing users choose **Settings → Upgrade all**, then install Marketplace 107
  separately if desired. Future updates, including Kernel updates, use the new
  source after those transition packages are installed.
- [ ] Optionally update the Dispenser starter under separate authorization.
  This release leaves it unchanged and installs nothing into existing Neutrons.

The source publications are ordered, not cross-canister atomic. The old source
`233tv-xiaaa-aaaay-aacta-cai` remains the migration entry point for users who have
not upgraded. No registry rewrite, Kernel-first delay or destructive reinstall
is used. Follow [package updates](doc/package-updates.md) and
[managed-memory migrations](doc/memory-migrations-and-uninstall.md).

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
