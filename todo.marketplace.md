# Marketplace implementation draft

Status: research and planning only. No marketplace implementation, package release,
deployment, or production financial action is part of this PR.

## Agreed direction

- One standalone canister combines the marketplace and package source. It uses
  Ashroot for metadata and StableBlob for packages, offered source, and images.
- A Neutron app provides browsing, purchases/free claims, My Apps, publishers,
  ratings, affiliate codes, and earnings withdrawals. CLI clients handle audits.
- The **Neutron canister principal** is the purchase account ID. Ownership lives
  in the marketplace and survives uninstalling an app or the marketplace client.
- Paid package downloads are restricted to buyers. Publisher/auditor access is
  granted by their protocol roles. A public principal string is an account
  identifier; download authorization must come from that Neutron's authority.
- Prices are USD; accepted payment tokens are ICP, ckBTC, and ckUSDC. The
  marketplace fetches XRC rates daily and collects payments with `transferFrom`.
- With an affiliate code, the default discount is 10%. Affiliate and developer
  each receive 30% of the **actual amount paid**; the remainder is allocated to
  burning NTN. Without a code, developer receives 30% and burning receives 70%.
- The Kernel remains marketplace-neutral. Reuse its installation, permission
  review, and Settings update workflows. Add only generic acquisition support
  where authenticated downloads require it; no commerce or entitlement checks
  belong in the Kernel.
- Migrate sources through higher app versions declaring the new canister in
  `update_source`. No Kernel-wide source rewrite or marketplace update resolver.

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
| Neutron marketplace frontend | Browser-direct discovery/images/public reads and authorized bulk uploads/downloads; compact UI and agent tools |
| Small marketplace app backend | Marketplace calls requiring the Neutron's actual principal, including checkout and private account actions |
| IC Wallet | Existing reviewed or root-authorized allowance funding and token information |
| Kernel | Generic source-access calls as the Neutron, acquisition credentials, byte/certificate verification, existing install/update review and checked deployment |
| Publisher/auditor CLI | Upload and release submission; exact-package analysis and assigned auditor verdicts |

Do not proxy catalog browsing, images, package bytes, or every quote through the
user's Neutron backend. Daily XRC calls and ledger collection belong in the
standalone protocol. A browser access credential is recoverable from the Neutron;
it is not a second identity owning purchases.

## Work plan

### 1. Protocol contracts and Ashroot storage

- [ ] Define versioned typed interfaces and error/receipt schemas for public
  catalog, private library, publication, audits, purchases, and payouts.
- [ ] Define generated tables for app/publisher ownership, listing and price
  revisions, artifacts/releases, audit history, orders/items, entitlements,
  affiliate codes, ratings, token allocations, withdrawals, and daily jobs.
- [ ] Keep global short app IDs and import existing publisher ownership before
  allowing registrations. A publisher may only publish its own app versions.
- [ ] Use one retained Ashroot memory root and cached transient database handle.
  An artifact row owns its StableBlob once; releases and images reference that
  row. Implement resumable upload sessions and chunked reads.
- [ ] Compute and verify exact hashes/lengths before attaching artifacts. Reuse
  existing archive inspection and source-offer tooling rather than inventing a
  different package format.
- [ ] Archive deployed schemas/runtime/Wasm; preserve IDs, indexes, Blob ownership,
  entitlements and in-flight journals across explicit upgrades.

Research inspected Ashroot commit
`4f38466b3cef32c41e157383b2001921a531b771` in the adjacent Ashroot checkout. A small
schema prototype validated and generated; no complete protocol was compiled or
deployed. Ashroot supplies storage, not caller authorization, certification, or
cross-canister transactions. Its batch writes can preserve a successful prefix
on a returned error: accounting finalization needs deliberate same-message
atomicity and recovery around ledger awaits.

### 2. Audited source and generic authenticated acquisition

- [ ] Serve the existing release JSON and immutable package/source paths. Preserve
  the closed legacy schemas; add marketplace/audit data through separate APIs.
- [ ] Implement compatible certified repository setup queries and HTTP response
  certification, including file streaming and missing-resource responses.
- [ ] Bind approvals to exact package/source hashes, app/version, auditor
  principal, report, scope, and timestamp. New bytes require new review.
- [ ] Keep pending/rejected uploads out of the public catalog. Preserve the last
  approved release while a newer version awaits review. No approved package
  means no public marketplace listing.
- [ ] Publish the approved release pointer and certified metadata together.
  Record revocation as history; repair installed bad releases with a reviewed
  higher version, not a silent downgrade or uninstall.
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
  URLs, agent results and provenance. Evaluate direct certified chunk transport
  if it avoids expensive per-grant HTTP certification state.
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

- [ ] Fetch ICP/USD, BTC/USD and USDC/USD from XRC daily in the marketplace
  canister. Use BTC/USDC as the explicit ck-token references. Store scaled
  integers, observation timestamps, and refresh diagnostics; do not hardcode
  ckUSDC at one dollar.
- [ ] Store USD prices and token amounts as integers. Freeze the rate, fees,
  beneficiaries, terms, referral and split in each checkout.
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
  again. Approval success is never described as purchase completion.
- [ ] Reserve earnings before withdrawal and only burn allocations before daily
  forwarding. Preserve unknown results and reconcile the original transfers.
- [ ] Persist daily jobs, re-register timers after upgrade, and carry forward
  amounts that cannot yet cover their own transfer fee.

Confirmed example, before ledger fees:

| $10 list price | Buyer pays | Affiliate | Developer | Burning NTN |
|---|---:|---:|---:|---:|
| 10% affiliate discount | $9.00 | $2.70 | $2.70 | $3.60 |
| No affiliate code | $10.00 | $0.00 | $3.00 | $7.00 |

Credits stay denominated in the token actually received. Integer allocations
must sum exactly to the collected sale amount. The treasury contains user
liabilities: the daily job cannot sweep the entire balance.

Forwarding ICP/ckBTC/ckUSDC does not itself burn NTN. Configure the downstream
converter/burner and distinguish allocated, forwarded and verified burned
amounts. Its accounts and the operating-cost budget remain open decisions.

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
  uploads and review status. Auditor operations remain CLI-only.
- [ ] Earnings exposes affiliate codes, per-token available/reserved balances,
  withdrawal previews and exact receipts. Eligible owners can rate apps.
- [ ] Expose typed compact tools for discovery, audit details, library, purchase
  preview/execute/continue/status/reconcile, free claim, install offer, referrals,
  earnings and withdrawals.
- [ ] Normal agents use reviewed Wallet funding. Root agents use the existing
  direct root Wallet tool and continue the same order; nested tools do not
  impersonate root. Install approval keeps the existing Kernel behavior.

Likely paths: `support/marketplace/` for the standalone protocol and CLI,
`apps/marketplace/` for the client. Use the shared `LICENSE.APP.USE` packaging
workflow for the new app unless the author explicitly chooses another license.

### 5. Release and source transition

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

- [ ] Old/public and new/private repository compatibility; exact certificates,
  hashes, source offers, missing assets, streaming and private cache isolation.
- [ ] Clean initialization and supported upgrade paths with representative
  entitlements, balances, journals, Blob references and interrupted uploads.
- [ ] Local ledger tests interrupt every await: success with lost reply,
  duplicates, fee/allowance changes, expired deduplication, concurrent continuation,
  and payment success followed by failed local finalization.
- [ ] Per-token liabilities/allocations and integer rounding; withdrawal
  reservations; daily jobs interrupted across upgrades; no duplicate debits.
- [ ] Audit change during checkout, revoked release behavior, and already-owned
  acquisition according to agreed terms. Paid orders cannot silently lose both
  entitlement and payment when a listing changes.
- [ ] Normal/root Wallet integration, install review dismissal, dependency
  handling, multi-app install, source migration and restart recovery.
- [ ] Narrow/wide tile UI, visible progress, compact tool schemas and media-free
  tool results. No live funds tests are authorized by this planning task.

## Remaining product decisions

| Decision | What needs agreement |
|---|---|
| Burner | Receiving account for each token; existing NTN conversion/burn service or separate implementation; evidence it supplies |
| Fees and operating budget | Buyer pays approval/collection fees? Beneficiary pays withdrawal fee? How are cycles, storage and audits funded when all remainder is allocated to burn? |
| Referral configuration | Global or publisher-selected X/Y; universal or per-app code; per-checkout or remembered; self-referral behavior |
| Roles and audit policy | Initial administrators/auditors; open or approved publisher registration; approval count; revoked-release access for existing owners |
| Purchase terms | Future updates included; refunds and paid-major/free-to-paid changes; remedy after a paid release is revoked |
| Ratings | Paid purchasers only or free claimants too; proposed one editable rating per entitlement/app |
| Price failure | Validity of yesterday's rate after refresh failure and checkout behavior; do not silently invent a cutoff |

Research notes and the exploratory Ashroot schema remain in `/tmp`; this file is
the reviewable implementation plan. Unchecked items describe future work.
