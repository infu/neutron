# Marketplace implementation draft

Status: research and planning only. No marketplace implementation, package release,
deployment, or production financial action is part of this PR.

Detailed specifications and pinned ledger references are in
[support/marketplace](support/marketplace/README.md).

## Agreed direction

- One standalone canister combines the marketplace and package source, with
  persistent catalog records, packages, offered source, and images.
- A Neutron app provides browsing, purchases/free claims, My Apps, publishers,
  ratings, affiliate codes, and earnings withdrawals. CLI clients handle audits.
- The **Neutron canister principal** is the purchase account ID. Ownership lives
  in the marketplace and survives uninstalling an app or the marketplace client.
- Paid package downloads are restricted to buyers. Publisher/auditor access is
  granted by their protocol roles. A public principal string is an account
  identifier; download authorization must come from that Neutron's authority.
- List prices are free or USD $1–$50 inclusive; discounts apply afterward.
  Accepted payment tokens are ICP, ckBTC, and ckUSDC. The marketplace fetches XRC
  rates daily and collects payments with `transferFrom`. If refresh fails, keep
  using the last successful rate and expose its age and refresh error.
- Acquisitions include all future approved updates, including after price
  changes. The initial protocol has no automatic refunds. Revocation blocks
  ordinary downloads of that package while preserving ownership and access to
  an approved replacement.
- Top free and Top paid rank distinct Neutrons acquiring each app over rolling
  7 days, 30 days, and all time. Retries, downloads and reinstalls do not count.
- Packages and offered source use certified HTTP. Public and authenticated
  reads go directly from the browser. Every non-auditor update goes through
  Neutron with native cycles attached; authenticated audit updates are exempt.
- Admin functions assign auditor principals. Auditors inspect unaudited packages
  and stamp exact candidates approved/rejected. Rejection includes a reason
  visible to the developer. Any Neutron may submit apps; one assigned auditor's
  approval makes a candidate eligible. Authenticated audit update endpoints are
  cycle-exempt.
- With an affiliate code, the default discount is 10%. Affiliate and developer
  each receive 30% of the **actual amount paid**; the remainder is allocated to
  burning NTN. Without a code, developer receives 30% and burning receives 70%.
- Each Neutron can have one universal affiliate code, entered per checkout.
  The discount and shares are global. Self-referrals are rejected by comparing
  the authenticated buyer Neutron with the code's owner.
- Free claimants and paying buyers can each leave one editable rating per app,
  attached to their Neutron-owned entitlement.
- An existing external service converts the proceeds and burns NTN. The
  marketplace forwards each token's daily allocation to its own destination:
  one for ICP, one for ckBTC, and one for ckUSDC. The owner will supply these
  three addresses later.
- Buyers pay approval and collection fees on top of the app price. Developers
  and affiliates pay their own withdrawal fees, and each token's burn allocation
  covers its forwarding fee.
- Protocol cycle charges use fixed rough cost estimates, without automatic fee
  adjustment. Uploads prepay one year of app storage and processing; developers
  also pay estimated processing costs for modifications through their Neutron.
  Charges depend on the stored bytes/work using fixed coefficients, and apply
  before expensive work. They are separate from token ledger fees. After year
  one, the operator funds storage; there is no developer renewal requirement or
  expiration of packages or buyer ownership.
- The Kernel remains marketplace-neutral. Reuse its installation, permission
  review, and Settings update workflows. Add only generic acquisition support
  where authenticated downloads require it; no commerce or entitlement checks
  belong in the Kernel.
- Migrate sources through higher app versions declaring the new canister in
  `update_source`. No Kernel-wide source rewrite or marketplace update resolver.
- Keep one database and separate domain modules. The standalone protocol project
  lives in `support/marketplace/` and uses `icp` CLI for installation/upgrades.
- The protocol is all rights reserved. The separate Neutron app uses standard
  NSAL 1.1 through `LICENSE.APP`. Proprietary database configuration stays out of
  Git, and documentation describes the protocol rather than database internals.
- Use the existing Ash test system with PocketIC for protocol acceptance tests.

## Verified integration boundaries

The existing repository setup supports a selected group of missing apps, one
compilation, and one checked deployment. Installed IDs are skipped; setup does
not update installed dependencies or replace the Kernel. Existing apps continue
through Settings updates. Source changes are already reviewed and committed as
part of ordinary higher-version package installation.

See [install offers](doc/app-install-offers.md),
[repository setup](doc/repository-setup-manifests.md), and
[source changes](doc/package-updates.md#manifest-contract).

Current setup downloads use anonymous certified Candid queries; Settings uses
fixed anonymous HTTP URLs. A tokenized package URL already works for a single
manual/offer installation, but it does not solve batch acquisition, Settings
downloads, or immutable offered-source URLs. Buyer-only delivery therefore needs
a **generic authenticated repository transport**, not a new update workflow.

The current production source is stock Rust assetstorage. Deploy a new combined
canister and preserve the old source; do not replace its Wasm with Motoko and
assume compatible stable memory. See [production source](support/update-source/README.md).

## Architecture and direct access

| Component | Responsibility |
|---|---|
| Marketplace/source canister | Catalog, app ownership, audits, artifacts, purchases, entitlements, rates, earnings, withdrawals, daily forwarding |
| Neutron marketplace frontend | Direct public/signed private queries and certified HTTP; compact UI/tools |
| Small marketplace app backend | Browser read authorization/recovery and all non-auditor updates as the Neutron with cycles attached |
| IC Wallet | Existing reviewed or root-authorized allowance funding and token information |
| Kernel | Generic source-access calls as the Neutron, acquisition credentials, byte/certificate verification, existing install/update review and checked deployment |
| Publisher/auditor CLI | Upload and release submission; exact-package analysis and assigned auditor verdicts |

Do not proxy catalog browsing, images, package bytes, or every quote through the
user's Neutron backend. Bind a browser signing principal to the Neutron once;
subsequent private queries resolve that identity to the durable Neutron account.
Daily XRC calls and ledger collection belong in the standalone protocol. Lost
browser credentials are reauthorized through the Neutron, without losing purchases.

The existing Neutron broker attaches cycles on every non-auditor update,
including purchases, publishing, uploads, ratings and read-grant registration.
Public and authenticated read-only HTTP/queries remain browser-direct. No new
Kernel cycles mechanism is required; browser read keys do not authorize writes.

## Work plan

### 1. Protocol contracts and persistent records

- [ ] Define versioned typed interfaces and error/receipt schemas for public
  catalog, private library, publication, audits, purchases, and payouts.
- [ ] Isolate domains in focused Motoko modules over one database, with
  `main.mo` limited to actor/caller wiring. Share ledger, accounting and billing
  code across purchase, withdrawal and scheduled work.
- [ ] Define records for app/publisher ownership, listing and price
  revisions, artifacts/releases, audit history, orders/items, entitlements,
  affiliate codes, ratings, token allocations, withdrawals, daily jobs and
  per-upload cycle-charge/one-year coverage records.
- [ ] Add immutable acquisition events, per-app free/paid 7d/30d/all-time counts,
  full ordered ranking indexes, two expiry cursors and coherent chart snapshots.
  Keep all ranking candidates so a falling or delisted leader exposes the next app.
- [ ] Keep global short app IDs and import existing publisher ownership before
  allowing registrations. A publisher may only publish its own app versions.
- [ ] Retain immutable artifact identities and resumable upload sessions across
  upgrades. Releases and images reference their exact stored artifacts.
- [ ] Compute and verify exact hashes/lengths before attaching artifacts. Reuse
  existing archive inspection and source-offer tooling rather than inventing a
  different package format.
- [ ] Retain private build inputs outside Git and record release evidence;
  preserve artifacts, entitlements and in-flight journals across explicit upgrades.
- [ ] Test atomic accounting finalization and recovery across ledger awaits.
  A returned ledger result must not leave partially granted ownership or splits.

### 2. Audited source and generic authenticated acquisition

- [ ] Serve the existing release JSON and immutable package/source paths. Preserve
  the closed legacy schemas; add marketplace/audit data through separate APIs.
- [ ] Implement compatible certified repository setup queries and HTTP response
  certification, including file streaming and missing-resource responses.
- [ ] Use certified HTTP for package/source bytes in single installs, grouped
  installs and Settings. Keep Candid setup metadata compatible without exposing
  private package bytes through legacy anonymous chunk methods.
- [ ] Bind approvals to exact package/source hashes, app/version, auditor
  principal, report, scope, and timestamp. New bytes require new review.
- [ ] Add admin-authorized auditor assignment, private unaudited-package queries,
  exact-candidate approval/rejection stamps and developer-visible rejection
  reasons. Accept submissions from any Neutron; one assigned auditor approval
  suffices. Charge no cycles for the authenticated audit update endpoints.
- [ ] Keep pending/rejected uploads out of the public catalog. Preserve the last
  approved release while a newer version awaits review. No approved package
  means no public marketplace listing.
- [ ] Publish the approved release pointer and certified metadata together.
  Record revocation as history and block ordinary downloads of revoked bytes,
  including with existing source grants. Preserve buyer ownership and access to
  approved successors; repair installed bad releases with a reviewed higher
  version, not a silent downgrade or uninstall.
- [ ] Establish a generic repository access method, for example `repo_access_v1`,
  called through an owner-authorized Neutron backend broker for the exact source
  being installed/updated. The source authenticates the actual Neutron caller
  and returns an opaque grant for package/source reads. The marketplace alone
  evaluates ownership and roles.
- [ ] Renew access independently of the marketplace client, so uninstalling that
  app cannot break ordinary Settings updates or offered-source downloads. Grants
  may be transient and reacquired; durable purchases stay in the protocol. An
  acquisition failure must not silently initiate another purchase.
- [ ] Cover single and batch installs, Settings package acquisition, offered
  source, and all streaming/chunk interfaces. Private bytes must not remain
  available through an anonymous fallback endpoint.
- [ ] Prototype credential delivery, retention/renewal, HTTP certification and
  cache isolation before fixing the wire format. Keep secrets out of displayed
  URLs, agent results and provenance. Measure grant-scoped HTTP certification
  cost without constructing a grant-by-entire-catalog cross product.
- [ ] Preserve public repository compatibility. Legacy free transition packages
  remain available to old clients; existing public source offers stay public.
  Never publish future private successors or their source artifacts into those
  public compatibility paths.

Paid delivery is an access-control feature, not copy prevention after delivery.
It must not introduce marketplace-specific launch checks or Kernel restrictions.
No new quotas, cooldowns, focus policy, or resource thresholds are proposed.

References: [repository codec](packages/neutron-tools/src/repository.ts),
[HTTP verifier](support/update-source/src/http.ts),
[IC response certification](https://docs.internetcomputer.org/guides/frontends/certification/).

### 3. Checkout, accounting, and recovery

- [ ] Use query previews/status wherever possible. Expose one public `purchase`
  and one public `withdraw` mutation; repeat the same operation/intent to resume,
  instead of separate execution/continuation endpoints.
- [ ] Enforce list-price bounds in the protocol: zero or $1–$50 inclusive.
  A valid $1 listing with 10% referral discount can cost $0.90 before fees.
- [ ] Fetch ICP/USD, BTC/USD and USDC/USD from XRC daily in the marketplace
  canister. Use BTC/USDC as the explicit ck-token references. Store scaled
  integers, observation timestamps, and refresh diagnostics; do not hardcode
  ckUSDC at one dollar. A failed refresh retains the last valid rate for purchases
  without an age-based stop; expose its age/error. Before the first valid rate
  exists, report that pricing is unavailable rather than inventing a price.
- [ ] Store USD prices and token amounts as integers. Freeze the rate, fees,
  beneficiaries, terms, referral and split in each checkout.
- [ ] Enforce the one-code-per-Neutron, global per-checkout referral rules and
  reject the buyer's own code before funding/collection. No sticky attribution
  or publisher-specific discount overrides are part of this design.
- [ ] Use one payment token per basket and one collection transfer. Bind an
  order-specific spender subaccount to the immutable checkout.
- [ ] Reuse Wallet funding tools and declare their dependencies. Wallet already
  adds the collection fee to the allowance; pass the bare purchase amount.
- [ ] Persist exact transfer arguments before dispatch. Confirm a ledger block
  before atomically creating entitlements and beneficiary credits.
- [ ] Continue/reconcile the same order after timeout, page closure or upgrade.
  Retain original timestamp/memo/arguments and duplicate evidence. If ledger
  deduplication expires, obtain exact ledger evidence; do not infer nonexecution.
- [ ] Free claims use no ledger transfer. Already-owned apps are not charged
  again, including after later price changes. Both free and paid acquisitions
  include approved future updates. Approval success is never described as
  purchase completion; revocation preserves ownership. No automatic refunds.
- [ ] Reserve earnings before withdrawal and only burn allocations before daily
  forwarding. Preserve unknown results and reconcile the original transfers.
- [ ] Persist daily jobs, re-register timers after upgrade, and carry forward
  amounts that cannot yet cover their own transfer fee.
- [ ] Configure the three owner-supplied forwarding accounts by ledger. Retain
  allocations until the corresponding destination is configured, and record
  each forwarding transfer's exact ledger receipt.
- [ ] Require native attached cycles on every non-auditor update through the
  existing Neutron broker. Keep cycle charges separate from sale-token
  liabilities; expose fixed estimated charges and budgets through queries.
- [ ] Estimate initial fixed processing/storage coefficients, with uploads
  covering one year of storage and processing and modifications paying for their
  work. Require payment before expensive processing/retention, preserve upload
  charge receipts across retries, and do not add automatic tariff recalibration.

Confirmed example, before ledger fees:

| $10 list price | Buyer pays | Affiliate | Developer | Burning NTN |
|---|---:|---:|---:|---:|
| 10% affiliate discount | $9.00 | $2.70 | $2.70 | $3.60 |
| No affiliate code | $10.00 | $0.00 | $3.00 | $7.00 |

Credits stay denominated in the token actually received. Integer allocations
must sum exactly to the collected sale amount. The treasury contains user
liabilities: the daily job cannot sweep the entire balance.

The sale split excludes the buyer-paid approval and collection fees. Withdrawal
previews show the fee charged to that beneficiary and the net amount received.
Daily forwarding deducts its transfer fee from that token's burn allocation.

The existing external service handles conversion and NTN burning; implementing
that service is outside this project. The marketplace records allocation and
daily forwarding to the three supplied destinations. Its transfer receipt proves
delivery to that service, not the service's subsequent burn. Destination addresses
are pending owner input. Fixed cost coefficients still need initial measurement.
The operator funds storage after the prepaid first year.

References: [Wallet adapter](apps/wallet/src/funding.ts),
[existing consumer](apps/icpswap/src/funding.ts),
[ICRC-2](https://github.com/dfinity/ICRC-1/blob/main/standards/ICRC-2/README.md),
[ledger deduplication](https://github.com/dfinity/ICRC-1/blob/main/standards/ICRC-1/README.md#transaction-deduplication),
[XRC](https://docs.internetcomputer.org/guides/chain-fusion/exchange-rates/),
[timer lifecycle](https://docs.internetcomputer.org/concepts/timers/).

### 4. Marketplace client and agents

- [ ] Build Explore, My Apps, Publish and Earnings views with the existing shared
  app header. Use a single-column layout at narrow tile widths and a grid when
  space allows. Avoid large empty headers and media in agent payloads.
- [ ] Explore shows Top free/Top paid with 7-day/30-day/all-time filters. Count
  each first acquisition once and publish snapshots with a coherent `asOf` while
  rolling-window maintenance catches up; ordinary reads do not scan purchase history.
- [ ] Show screenshots, description, publisher, price, ratings and exact audit
  details in app pages. Checkout shows token fees and developer/affiliate
  principals alongside the Burning NTN allocation.
- [ ] My Apps reads durable entitlements by Neutron principal. Uninstall/reinstall
  restores the library, not app data intentionally deleted by uninstall.
- [ ] Resolve the latest approved eligible versions, then pin hashes for the
  existing install review. Include approved dependency closure and disclose
  any paid dependency before purchase. Use Settings for installed-app updates.
- [ ] Prepare install selections before the final click. An install offer being
  presented is not success; reconcile the installed registry afterward.
- [ ] Publisher UI supports listing content, screenshots, price, package/source
  uploads and review status. Show fixed estimated cycle charges and prepaid
  storage coverage before upload/modify. Auditor operations remain CLI-only.
- [ ] Earnings exposes affiliate codes, per-token available/reserved balances,
  withdrawal previews and exact receipts. Free and paid owners have one editable
  rating per Neutron/app.
- [ ] Expose typed compact tools for discovery, audit details, library, purchase
  preview/purchase/status/evidence, free claim through purchase, install offer,
  referrals, earnings and withdrawal preview/withdraw/status. Mutating retries use
  the same function and saved ID.
- [ ] Normal agents use reviewed Wallet funding. Root agents use the existing
  direct root Wallet tool and continue the same order; nested tools do not
  impersonate root. Install approval keeps the existing Kernel behavior.

Paths: `support/marketplace/` for the standalone protocol and CLI,
`apps/marketplace/` for the client. The protocol is [all rights reserved](support/marketplace/LICENSE).
The user selected standard [NSAL 1.1](LICENSE.APP) for the Neutron app; use the
shared application-notice and offered-source packaging workflow without copying
or altering the license. Third-party reference material retains its own license.

### 5. Release and source transition

- [ ] Create the standalone `icp.yaml` script-build project with pinned build
  inputs. Use explicit install for a new empty canister and upgrade for retained
  state. Keep private schema configuration outside Git and preserve private
  release evidence alongside the exact Wasm selected for icp deployment.
- [ ] Deploy/test the new source compatibility interfaces and authenticated
  acquisition extension. Import app ownership and release history/references;
  old historical artifacts can remain at their existing immutable URLs.
- [ ] Build strictly higher, state-compatible transition packages once, each
  naming the new `update_source`. Include a higher Kernel package for its own
  source change and generic acquisition support.
- [ ] Upload, audit, approve and verify exact transition packages/source artifacts
  at the new canister before advertising them from the old source.
- [ ] Add an explicitly scoped old-to-new transition publication mode. Current
  tooling checks publication origin against manifest/source URLs; retain normal
  checks and verify the exact new-source artifacts for this transition.
- [ ] Atomically publish the compatible Kernel/app transition set to the old
  catalog. Old clients require one-time copies of transition package bytes
  because they fetch from the saved source and reject redirects. New offered
  source artifacts may stay solely at their declared new URLs after verification.
- [ ] Use ordinary selected upgrades or Upgrade all. Do not rewrite registry
  sources or introduce a Kernel-first waiting period. Each source switch commits
  through the existing reviewed deployment.
- [ ] Retain old historical artifacts and transition releases for late/skipped
  upgrades. Future releases publish only to the new source. Update the Dispenser
  starter separately after verification.
- [ ] Repeat publication on each canister against identical bytes and require
  verified no-op receipts. Two canister publications are ordered, not one
  cross-canister atomic transaction.

Follow [release rules](AGENTS.md), [package updates](doc/package-updates.md), and
[managed-memory migrations](doc/memory-migrations-and-uninstall.md). Implementing
the agreed source transition also updates the relevant production-source
configuration and documentation; this planning PR changes neither.

### 6. Required validation before production

- [ ] Implement the [Ash/PocketIC acceptance suite](support/marketplace/spec/testing.md),
  pin the tested toolchain and distinguish domain tests from real ledger,
  certificate and upgrade scenarios.
- [ ] Old/public and new/private repository compatibility; exact certificates,
  hashes, source offers, missing assets, streaming and private cache isolation.
- [ ] Clean initialization and supported upgrade paths with representative
  entitlements, balances, journals, stored artifacts and interrupted uploads.
- [ ] Local ledger tests interrupt every await: success with lost reply,
  duplicates, fee/allowance changes, expired deduplication, concurrent continuation,
  and payment success followed by failed local finalization.
- [ ] Per-token liabilities/allocations and integer rounding; withdrawal
  reservations; daily jobs interrupted across upgrades; no duplicate debits.
- [ ] Audit change during checkout, revoked release behavior, and already-owned
  acquisition according to agreed terms. Preserve entitlements after price
  changes or revocation. Test one editable rating for free/paid owners, global
  per-checkout referrals and self-referral rejection. Paid orders cannot silently
  lose both entitlement and payment when a listing changes.
- [ ] Normal/root Wallet integration, install review dismissal, dependency
  handling, multi-app install, source migration and restart recovery.
- [ ] Narrow/wide tile UI, visible progress, compact tool schemas and media-free
  tool results. No live funds tests are authorized by this planning task.
- [ ] Exact rolling-window expiry, new purchases during maintenance, tier changes
  and delisting backfill. Query reads stay usable without a cycle charge;
  authenticated auditor exemptions cannot exempt unrelated mutations.
- [ ] Failed rate refresh continues with the retained rate and explicit freshness
  diagnostics; fixed cycle estimates do not change with observed usage. Upload
  retries do not pay the one-year storage allocation twice.
- [ ] Crossing the first-year coverage boundary retains packages and entitlements
  under operator-funded storage, without charging the developer for renewal.

## Remaining configuration

| Configuration | What remains |
|---|---|
| Forwarding destinations | Existing conversion/burn service confirmed; owner will supply separate ICP, ckBTC and ckUSDC receiving accounts later |
| Fixed cycle coefficients | Measure and choose initial rough processing/storage costs and call budgets. No automatic fee updates; uploads cover one year. |
| Initial roles | Supply initial admin/auditor principals. Any Neutron may submit, with one assigned auditor approval required. |

Detailed specs and selected upstream ledger references live in
`support/marketplace/spec/`. Scratch research remains outside the repository.
Unchecked items describe future work.
