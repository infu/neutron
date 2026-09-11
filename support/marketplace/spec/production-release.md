# Initial production release

Status recorded on 2026-09-10 UTC. Deployment and the first marketplace
publication, including its exact-byte repeat check, are verified. The legacy
transition publication and its exact-byte repeat check are also verified. User
installation remains a separate action.

## Deployed protocol

| Item | Verified result |
| --- | --- |
| Network | Internet Computer mainnet |
| Canister | `sj2r4-haaaa-aaaay-aadgq-cai` |
| Initial Wasm SHA-256 | `1bd60e9e252c7372d2e6939d3a3896fd0566c18abf4022bd4a49c8542f633d8b` |
| Installation CLI | `icp 1.0.2` |
| Initial publisher and assigned roles | Existing Blast ID 0, verified through authenticated queries |
| Reserved app IDs | 27, owned by the configured first-party publisher |
| Initial rates | ICP/USD, BTC/USD and USDC/USD refreshed successfully through XRC |
| Burn-service destinations | All three unset; awaiting owner-supplied accounts |

The canister is separate from the existing source
`233tv-xiaaa-aaaay-aacta-cai`. Reservations establish ownership; they do not
publish packages or make listings eligible for the store. Deployment evidence,
initialization and operator configuration remain in the private release record.

## Package publication

The read-only review selected 27 free app releases for the marketplace, including
Kernel 356, Kitchensink 317 and Marketplace 107. It reported every selected
package as changed and no skipped listing metadata. Its request ID is
`906193c0249aa5848ce128918552c171077d84e080529b601be8ee4fcc8ed48c`.

Marketplace batch **1** published all 27 releases atomically. Its receipt-v2
postflight verified each package and offered-source artifact against the frozen
review, including version, SHA-256, size and source URL/path. A separate anonymous
catalog check at **21:07:31 UTC** returned all 27 apps in one complete page;
public detail queries confirmed every expected version, free price, first-party
owner, visible listing and approved candidate/audit. No catalog verification
call performed an update or requested a download grant.

Repeating the same marketplace command with unchanged inputs returned
`batch_id: null`; all 27 packages and offered sources were verified `unchanged`
with the expected version, digest, size and source URL/path.

The reviewed legacy transition contains the same exact bytes for the 26 existing
apps; Marketplace is a new installation and is excluded from that transition.
The legacy set contains 15,437,945 package bytes and 19,773,838 offered-source
bytes. Each transition manifest names `sj2r4-haaaa-aaaay-aadgq-cai` and keeps its
state-preserving memory lineage.

Old-source batch **97** published all 26 transition packages and offered sources
atomically. Its first receipt verified their versions, SHA-256, sizes and source
locations against the same frozen artifacts. Both sources now advertise the
compatible release set. The identical old-source repeat returned `batch_id:
null`, verifying all 26 packages and offered sources `unchanged` against those
same bytes.

| Release step | Status |
| --- | --- |
| Marketplace publication of 27 releases and initial free listings | Verified, batch 1 |
| Repeat marketplace publication: verified receipt-v2 no-op | Verified, `batch_id: null`; all packages and sources unchanged |
| Old-source atomic publication of 26 transition releases | Verified, batch 97 |
| Repeat old-source publication: verified receipt-v2 no-op | Verified, `batch_id: null`; all packages and sources unchanged |
| Installation into existing Neutrons | User action after verified publication |

A response loss requires reconciliation using the original request and unchanged
artifact bytes. The
first-party automatic audit describes the archive, manifest and source checks
actually performed; it does not claim a manual malware review.

## User upgrade path

Publication to both sources is verified. Existing users choose
**Settings → Upgrade all**. The compatible Kernel and app transition updates
preserve installed state and switch their normal update source to the
marketplace. Users then install
[Marketplace version 112](https://sj2r4-haaaa-aaaay-aadgq-cai.icp0.io/repo/v1/packages/6412027d0bd3fc594c878d653342ce3c4599a9cbe7d3379448c725b5314f9a21.neutron)
separately; publishing does not add that app automatically. This public package
was verified by publication postflight with SHA-256
`6412027d0bd3fc594c878d653342ce3c4599a9cbe7d3379448c725b5314f9a21`.

No existing Neutron has been upgraded by this deployment record. No Dispenser
starter change or Git push is included. The missing burn-service destinations
remain an operator configuration item, not evidence of a completed token burn.

## Marketplace 109 access and storefront follow-up

Marketplace batch **2** publishes only Marketplace 109; the other 26 selected
packages and sources remain unchanged. Request:
`a2d7ccdaa6fa3dea54eccd5693378da464c7f33ae0b633928222563c18a2c589`.
The exact-byte repeated publication passed receipt-v2 with `batch_id: null`;
all 27 selected packages and offered sources were unchanged, with matching
versions, paths, sizes and SHA-256 digests. The legacy source was not modified.
The archive is 471,686 bytes. Its offered source is 1,728,766 bytes with SHA-256
`754c3e2f768b819c8d43c06029ad80d3328ae6ddeed6a6bcf2d4dc1403ed5ac3`.
The emitted, unpublished 108 candidate remains preserved locally.

This release removes the Connect action and restores a permanent read principal
through the existing Neutron custody facility. The browser still performs private
queries directly. Existing v1 app memory and lock lineage are unchanged. The
storefront shows Top paid then Top free, omits Kernel and Marketplace listings
and rank numbers, and labels the retained audit evidence **Audited by AI**.

Validation passed: 111 Bun tests plus the isolated client-access assertions,
Motoko initialization/restoration and delegation vectors, typecheck, five UI
browser suites, direct protocol integration, and the exact-package installed
browser gate. That gate reproduced the original 107 error, then verified 109
automatic setup, reload, fresh-browser access, checked uninstall/reinstall with
the same principal and a new browser seed, and a subsequent nonfinancial update.
Kernel 356 and the protocol module are unchanged; no existing production Neutron
was installed or reinstalled by these tests or by publication.

## Certified download header upgrade

The protocol was upgraded in place to Wasm
`2bde4755ae504b96706c48b752daa681a19a5b0aa302da764c41529c00789143`
using `icp --mode upgrade --wasm-memory-persistence keep`. Its running module
and unchanged controllers were verified afterward. This module was subsequently
upgraded for the acquisition-count response described below.

The upgrade exposes the existing `Vary` header to browser clients and rebuilds
the affected certified responses. Database roots and Candid remain unchanged.
Both the exact deployed-module upgrade test and the portable regression passed
13 certified HTTP cases, including existing grants, streaming continuations,
public downloads, private downloads and denial responses. Representative
ownership, audit, upload and configuration records were retained.

## Kernel 359 and Marketplace 111 installation follow-up

Marketplace batch **3** publishes Kernel 359 and Marketplace 111 together.
The other 25 selected packages and offered sources are unchanged. Request:
`3713dda7aafaef623186309083f521c238f6878ac05722cfea34105878825ecd`.
The receipt-v2 postflight matches the reviewed versions, archive SHA-256 and
size, and offered-source URL, path, SHA-256 and size for all 27 selected apps.
Repeating the identical publication returned `batch_id: null`, with all 27
packages and offered sources verified `unchanged` against the same frozen
files. No archive or source artifact was rebuilt between those calls.

| App | Archive bytes | Archive SHA-256 | Offered-source SHA-256 |
| --- | ---: | --- | --- |
| Kernel 359 | 2,466,756 | `6b506590ab9160a6e8e31859a791d40e60b797f06e9fde28781b8f0beb89574d` | `99072d19ee84b078585d7b4c00597b934e18ad2558795ca652d465d47e73ddde` |
| Marketplace 111 | 476,894 | `e2f861cc3147ed0933216730999d5f74272a988a1e63fb3470faf64d687931be` | `130a7314ee7928ce726d437c2a769dcc6d8c5042668928740b9e2894a57a85e4` |

Installed users choose **Settings → Upgrade all** to obtain the compatible
pair. Marketplace's Install action prepares the selected apps and opens one
Kernel review of their packages and manifest permissions. One approval installs
the selection. Canceling changes no installation, and reopening the saved
selection reuses its preparation and source access without another charge.
The Kernel exposes this workflow through a generic manifest-declared capability.
Marketplace also declares its update permissions at installation, uses the
shared clipboard capability, and exposes the combined preparation cost on
Install. Kernel Settings keeps update source-cost details expandable.

Kernel validation passed 860 TypeScript tests, 33 Motoko suites, complete
packaging and fresh 12-case certified-assets qualification. Marketplace passed
its complete package command, 123 Bun tests plus isolated suites, backend memory
restoration, typecheck, five browser suites and protocol integration. The exact
359/111 installed-browser gate verified automatic access across reload, a fresh
browser profile and checked reinstall, clipboard copying, and two-app
installation with one final review. Cancellation and retry used exactly one
preparation and one source grant. Its disposable ledger counters stayed zero.

All managed-memory schema and migration sources and lock lineages are unchanged.
The emitted, unpublished Kernel 357/358 and Marketplace 110 archives remain
preserved. Publication does not install into an existing production Neutron;
the old source and Dispenser starter were not changed.


## Marketplace 112 storefront and acquisition counts

Marketplace batch **4** publishes only Marketplace 112. Request:
`3aaa08ffb9c29f311b22402e2b1e15e85cb8edd7809c7854325d371657f34ee1`.
The receipt-v2 postflight verifies all 27 selected packages and offered sources
against the frozen review; the other 26 releases, including Kernel 359, are
unchanged. The identical repeated publication returned `batch_id: null`; all
27 packages and offered sources were verified `unchanged` with their exact
versions, paths, sizes and SHA-256 digests.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Marketplace 112 | 476,452 | `6412027d0bd3fc594c878d653342ce3c4599a9cbe7d3379448c725b5314f9a21` |
| Offered source | 1,744,271 | `1cce57d3b5d886d8f2aa0c2c194a93f8435274dbfa29e0937368fcdd5bfd0857` |

The storefront removes its connection settings, ranking-refresh notice and
obsolete installation status box. The existing Install control still recovers
a canceled or interrupted selection using its saved request. Financial operation
recovery remains available. Cards and details show lifetime purchases for paid
apps and acquisitions for free apps, without counting reinstalls or retries.

The protocol was upgraded in place, retaining Wasm memory, to
`26feaa471ee6fbd2c86afffd6de80448f3e0c60ba8dc6dd11068b07540699c00`.
The running module and unchanged controllers were checked after deployment.
Public app responses now include optional acquisition counts from the existing
lifetime counters. Persistent schema and stable types are unchanged. An exact
upgrade from the previous production module retained historical counts,
ownership, orders and audits; repeated acquisition and installation preparation
did not increment counts or ledger effects. Production public reads verified
these fields after deployment.

Focused validation passed: complete Marketplace packaging and typecheck,
backend memory initialization/restoration, three count/compatibility cases,
nine protocol domain cases, the exact deployed-module upgrade case, and the
storefront and installation-recovery browser suites. Browser checks covered
compact and wide layouts, accurate installation handoff, cancellation/retry,
financial recovery, hidden settings/notices and count formatting. The complete
Kernel and installed-browser qualification suites were not rerun for this
follow-up, as requested. No app memory schema or migration lineage changed.


## First-party icons and screenshots

The reviewed [media selection](../catalog/first-party-media.json) publishes
24 existing app icons and 40 screenshots, totaling 2,838,676 bytes. Request:
`598c7293e6f519c6d917a343b4370027bd57888c51e3ead8279ae2b6fcb22291`.
All 24 listings were updated and their public images verified through certified
HTTP against the selected MIME types, sizes and SHA-256 digests. The retained
listing owner, title, description, price, visibility, approved candidate and
package version matched the pre-publication review. No package changed during
media publication. Future ordinary package publication preserves attached media.

Screenshots show the current app UIs with local demo content; no private user
accounts or production financial actions were used for capture. DeFi and social
apps include compact tile examples. Kernel and Marketplace remain excluded from
the storefront; the tools-only Blast app has no UI or existing icon to capture.

The media publisher passed 11 focused retry/preservation tests and 12 existing
transport tests. Its journal retains exact requests and upload responses for
interruption recovery. Repeating the exact media publication verified all 24
listings `unchanged`, with `updateCalls: 0`, and reread all 64 image files through
certified HTTP. A final browser check of the current UI with production public
queries loaded all 25 storefront apps, decoded all 24 published icons, and
verified Wallet/Aave screenshot galleries and readable counts at 380px and
1200px without overflow or page errors. All 33 observed external responses
were HTTP 200; no update or financial calls were made. The release record
retains the exact file and browser evidence.

These updates do not install apps into existing production Neutrons. The legacy
source and Dispenser starter are unchanged, and no Git push is included.

## Saved discounts and Activity — Marketplace113

Marketplace `0.1.13` was published in catalog batch `5` on 2026-09-11.
The archive is 482,863 bytes with SHA-256
`a0ecb6c8839c7bfd765518a5dbb488215d83bc4dade8476022d79d68a50fa689`.
Its offered source is 1,766,790 bytes with SHA-256
`7727dc04d7f3dcbfef3056a03a594405bf79c5751a3578e457e4d09c432d4ac4`.
Only Marketplace changed in the 27-package transaction. Existing listing prices,
icons, screenshots and approved releases were retained.

The app remembers a validated discount code for new purchases. Its header
control changes or clears that preference; listings show original and discounted
prices, and checkout shows the activated code. Validation uses the protocol's
new authenticated `referral_quote` query directly from the browser. Existing
payment IDs keep their original referral terms after the preference changes.

A bell tab after Earnings opens Activity. Financial progress and recovery controls
live on that page. Confirmed browser refusals before submission are omitted from
active notifications; unknown outcomes and transaction evidence remain available.
Fresh receipt observations supersede older local status, and remote payment or
settlement evidence takes precedence over a stale browser rejection.

App managed memory advances from state v1 to v2 through one explicit migration.
The released v1 schema and its lock entries are unchanged. A focused PocketIC
checked upgrade from exact Marketplace112 and Kernel359 preserved the read key,
delegation, seed, configuration revision, pending purchase/install records and
history, and verified clean v2 initialization and discount change/clear behavior.
The gate passed 90 assertions; Kernel359 stayed unchanged. Backend semantic
migration tests, typecheck, complete packaging, focused client/recovery tests
and four focused browser suites also passed. Browser checks cover 320–960px
layouts, activation/change/clear, late preference loading, quiet cancellation,
original-payment recovery and newer receipt precedence. No live purchase or
wallet transaction was used for qualification.

The protocol was upgraded in place with memory retained to
`7ec8262e5067d5e8c20c990767eeb5c214c7741bb1fb3cb1da4477efe29af0a5`.
Its persistent schema and stable types are unchanged. Five focused domain cases
and an exact production-predecessor PocketIC upgrade passed, including delegated
owner authentication, self-code rejection and preservation of listings,
entitlements and referral records. Deployment postflight verified the running
module, unchanged controllers, retained paid listing details and query access.

The repeated publication returned receipt-v2 `batch_id: null`: all 27 packages
and their offered-source artifacts were `unchanged`, with matching versions,
paths, URLs, sizes and SHA-256 digests. The frozen 54 local artifacts matched
both publication postflights. Publication makes the update discoverable in
Settings; it does not install it into existing Neutrons or change the Dispenser
starter.

## Canceled checkout Activity — Marketplace114

Marketplace `0.1.14` was published in catalog batch `6` on 2026-09-11.
The archive is 484,466 bytes with SHA-256
`07ff117cdc5b0a3a27884f7ec9d742f7f6d240d27aa973f1f2f168c0eaca6066`.
Its offered source is 1,773,176 bytes with SHA-256
`6776661910c8184af1738f4c8816f650b80ecee54b20dbb65386959f9ae9ef4b`.
Only Marketplace changed; Kernel359, the protocol, listing prices and media,
the legacy source and Dispenser starter are unchanged.

Canceled unpaid Ethereum invoices remain quiet across history refresh, browser
reload and background balance polling. A retained deposit request or later
payment evidence still exposes recovery. IC purchase intents now retain explicit
Wallet approval rejection and whether collection was requested. Rejected approvals
do not return as approval-required reminders; requested purchases with missing
replies remain recoverable without another Wallet approval. Approval-only and
fully completed notifications can be dismissed. Dismissal is a browser preference
for that observation and does not delete the saved intent; new payment evidence
restores its Activity entry.

Managed memory remains state v2. Released v1/v2 schema sources, the v1-to-v2
migration, lock lineage and backend are byte-for-byte unchanged. Optional purchase
progress fits the existing retained JSON intent map. Focused IC and Ethereum
recovery tests, notification tests, browser refresh/reload regressions, typecheck,
backend clean initialization/migration/restoration checks and the complete package
command passed. No live financial action was used for qualification.

Both publication postflights matched all 54 frozen package/source artifacts. The
exact repeat returned receipt-v2 `batch_id: null`, with all 27 packages and sources
`unchanged` and their versions, paths, URLs, lengths and digests verified.

## Listing descriptions and ownership display — Marketplace115

Marketplace `0.1.15` was published in catalog batch `7` on 2026-09-11.
The archive is 485,071 bytes with SHA-256
`9478432201668f3984621b934d89eb48969c34d89c47e957671a3a9ce4cbca26`.
Its offered source is 1,779,461 bytes with SHA-256
`c69040503aa37ea33b84ad0cc492ee61e4be0b391e503389b0709f4624f7d236`.
Only Marketplace changed in the 27-package transaction. Kernel359, the legacy
source and the Dispenser starter remain unchanged.

The storefront recognizes apps currently installed in the Neutron, including
older installations, and shows Owned on cards and Installed in app details.
Local installation stays distinct from Marketplace acquisition records; it does
not grant paid-download access or rating eligibility. My Apps keeps its existing
entitlement and installed-version behavior. Whole cards, including price labels,
open details. The search input uses one visible focus border.

Publishers can edit an excerpt of up to 255 Unicode characters and an expanded
description of up to 5,000, with matching counters and validation. New listing
revisions enforce those limits. Historical records remain intact, and exact
saved publication retries retain their original text and recovery identities.
All 27 first-party listings received reviewed feature and agent-tool copy from
[the curated inventory](../content/listings.en.json). ICPSwap, Uniswap, Curve,
Hyperliquid and Aave excerpts identify independent Neutron integrations.
The 25 storefront apps remain visible across all ranking windows; Kernel and
Marketplace stay excluded by the storefront filter. Existing prices, titles,
icons, screenshots and approved package references were preserved.

App managed memory remains state v2. Backend, released schemas, migration and
lock lineage are byte-for-byte unchanged. Backend clean initialization,
v1-to-v2 migration and restoration checks passed, along with focused client,
publication and saved-publication recovery tests, typecheck, complete packaging,
and app, publisher, Ethereum-checkout and installation browser suites. Browser
checks cover compact layouts, long copy, installed paid/free apps, detail-first
navigation and the single search focus border.

The protocol was upgraded in place with memory retained to
`f3665ba9677b98df17c6c85fde1207e205bfe3e8bded609a864e5648e3bd2d5e`.
Candid and stable types are unchanged. Four focused catalog domain tests and a
PocketIC clean-initialization/exact-production-predecessor upgrade case passed,
including Unicode boundaries, historical listing retries, preserved acquisitions,
referrals, approvals, publication receipts, package/source data and access grants.
Live postflight verified the running module, retained controllers and matching
listing/release/media records for all 27 apps before the copy update.

The initial publisher attempt stopped in the local response verifier. The exact
same frozen bytes and publication request were retained for reconciliation.
Publication succeeded; its required exact repeat returned receipt-v2
`batch_id: null`, with all 27 packages and offered sources unchanged on repeat,
matching versions, URLs, paths, lengths and digests. All 54 frozen artifacts
matched. Listing-copy postflight separately verified all 27 exact descriptions,
preserved prices/media/releases, and all six public ranking views. No live
purchase or wallet transaction was used for qualification, and no Git push is
included.


## Wallet canister refills — Wallet326

Wallet `0.3.26` was published in catalog batch `8` on 2026-09-11.
The archive is 926,070 bytes with SHA-256
`1c3f152b3c97a4a91c8ab5ddf3194938841f6745cbd4aab7ac5a0287e851dd53`.
Its offered source is 830,756 bytes with SHA-256
`78b81eb6714a76108df5a44e3ec559237393ccf3d55a1672277e3d018bbcf015`.
Only Wallet changed in the 27-package transaction. Kernel, Marketplace protocol,
legacy source and Dispenser starter were not changed.

The compact Refill tab supports ICP and TCYCLES canister funding, plus ICP to
TCYCLES conversion. My Neutron is the default destination; another canister or
recipient principal is available under Advanced. Amount sliders and Max account
for fees. Public balances, fees and the CMC rate use browser queries. One review
precedes payment; normal agents share that review, while root agents can execute
under their existing authority. Fresh Wallets select TCYCLES with the existing
presets; configured Wallets preserve their selected tokens and can use the refill
tab's direct TCYCLES reads regardless of selection.

Seven released memory roots and lock lineages are unchanged. The independent
`wallet_refills` v1 root saves exact ledger requests, conversion notifications,
refunds and onward transfers. Same-ID recovery never invents a replacement debit.
Cycles-ledger withdrawal duplicates remain unverified unless original successful
delivery evidence is retained. Paginated unfinished/history views retain access
to older recovery records. Prepared requests reopen review before first dispatch.
Initial Wallet read failures now show Retry, and a failed query-agent initializer
is evicted so a subsequent refresh can recover.

Complete packaging, 310 Wallet tests (2,680 assertions), 19 Motoko suites,
semantic clean-initialization/restoration and production-predecessor migration
planning passed. Browser release suites cover existing connections, ledger
selection and activity, eight refill scenarios at 320/380/960px, and four initial
read-failure cases across tile and tray. TypeScript passes. PocketIC fixtures
cover all three money flows, refunds, interrupted replies, duplicate semantics,
concurrent recovery and pagination. No live financial action was used for testing.

The first publication verified batch `8`. Two repeat attempts stopped in the
local Wasm response verifier; the same frozen files and request identity were
retained. The subsequent identical-byte repeat passed receipt-v2 with
`batch_id: null`, all 27 packages and offered sources `unchanged`, and matching
versions, paths, URLs, lengths and SHA-256 digests across all 54 artifacts.
No verifier checks were bypassed and no runtime workaround was needed. The
intermittent local verifier trap remains undiagnosed. Publication request:
`f2b1031284c93bbaeae7f0076b9db486151f7473e8f93b5f148183076a0167c4`.
No Git push is included.


## Owner-approved operating-cycle conversion — Kernel360 / Wallet327

Kernel `0.3.60` and Wallet `0.3.27` were published together in catalog batch
`9` on 2026-09-11. Only those two packages changed in the
27-package transaction. The Marketplace protocol, legacy source and Dispenser
starter were unchanged.

| Package | Archive bytes | Archive SHA-256 | Offered-source bytes | Offered-source SHA-256 |
| --- | ---: | --- | ---: | --- |
| Kernel360 | 2,476,358 | `e2abbcac2aaa0d7eec8538a17923454ce4e2ab2d6d634630880533a3af8f2410` | 3,407,733 | `1ca08750d4ece62072b29114e8cdd95261ee2b6d0fc7ad1da79c1cd4e7c98b93` |
| Wallet327 | 941,193 | `c9d8f1ca6ddd9e48af622d91a1a8383905638888a76edef0257359730cb486cd` | 852,993 | `0c0f2c25aeaef5ad19602c560efab53bb852ae8654fab3dcf6375a1ca40914a2` |

Wallet's Refill → Get TCYCLES page now accepts Neutron operating cycles as well
as ICP. My Neutron is the default TCYCLES recipient, with another principal
under Advanced. Max approves an upper amount and trims it downward at dispatch
to leave at least 5T operating cycles plus the measured call cost. The ledger
mint fee is deducted from attached cycles. The receipt records the deposit
block and recipient total balance; the displayed net amount remains an estimate
using the fee retained at review.

The generic Kernel capability reuses backend reservations and owner attention.
Every such call requires the red owner dialog and its unchecked acknowledgment,
including calls requested by root agents. It authorizes one exact target,
method, arguments and amount or upper amount; ordinary app budgets are unchanged.
The new independent `kernel_cycle_calls` v1 root retains the original call and
response before delivery checks. Repeated IDs return the saved result and never
reattach cycles, including after interruption or upgrade. Wallet history pages
read compact records and load full receipts only when requested. Confirmed
pre-dispatch cancellation clears a fresh attempt; uncertain dispatch retains
its original recovery identity.

All eight Wallet roots and lock lineage remain unchanged. Existing Kernel v3/v4
schemas, the v3→v4 migration and activation v1 remain unchanged; the new root
initializes separately. Full package commands, 873 Kernel tests (10,104
assertions), 34 Kernel Motoko suites, 323 Wallet tests (2,838 assertions),
19 Wallet Motoko suites, memory restoration and 17 historical Kernel archive
migration-planning cases passed. Real PocketIC tests verify attached cycles,
reserve enforcement, pending/terminal duplicate prevention and restoration
across upgrades. Certified-HTTP qualification and exact candidate binding
passed. Wallet browser suites and the red-dialog browser checks cover compact
layouts, cancellation, one review and recovery without another deposit.
SDK and compiler release suites also passed. No production financial conversion
was used for testing.

The first postflight stopped on a public source streaming rejection after the
journal had already recorded batch commit. An exact-byte retry reconciled it and
verified the published artifacts; no grant or protocol changes were made. The
precise cause of the transient callback rejection was not established.
The subsequent identical-byte repeat returned receipt-v2 `batch_id: null`, with
all 27 packages and offered sources `unchanged`, matching versions, URLs, paths,
lengths and SHA-256 digests across all 54 frozen artifacts. Publication request:
`87ac78efd271bcd265774fc1d1b577ec6c62feb709c46236c3b18995e1705052`. These updates are installed through the existing Settings
upgrade flow; publication does not install them into an existing Neutron.
No Git push is included.


## Publisher profiles and IC Wallet title — Marketplace116 / Wallet328

Marketplace `0.1.16` and Wallet `0.3.28` were published together in catalog
batch `10` on 2026-09-11. Only those two packages changed in the 27-package
transaction. Kernel, legacy source and Dispenser starter were unchanged.

| Package | Archive bytes | Archive SHA-256 | Offered-source bytes | Offered-source SHA-256 |
| --- | ---: | --- | ---: | --- |
| wallet 328 | 940,936 | `a4910afaaa52f3078d2d9c197b7f8ca5b996664c5ba2bae2d2cf668b8d088c96` | 852,892 | `19796e6fdd6063c793a6f3a90dcd970770c507bc30c49c51abb836d0257c48b3` |
| marketplace 116 | 489,339 | `24d5f63a9bd8e8795696c4246e8fb796a1fe0a0d36591b1fe3d4148ef9812d35` | 1,795,057 | `95bb7030654590c43fd0abbefb25576fd375223338e53e7369169e08912845e2` |

The Marketplace protocol was upgraded in place to module
`62538acd0b35afad2d4222a82c4d5476ea200266dbab49516046711efd0eb438` using ICP CLI upgrade mode with Wasm memory kept.
The first invocation omitted the actor's required initialization argument and
was rejected; the previous module remained active. Reusing the retained
production argument file with the same qualified Wasm succeeded. Controller
principals and the before/after representations of all 27 existing listings,
approved releases and media remained unchanged.

The existing first-party owner registered publisher ID `aae` and permanent name
`aae`. Its 27 listings retain their original owner and gain that profile byline;
25 apps are displayed in the storefront, which continues to omit Kernel and
Marketplace. Anonymous profile reads, listing summaries and paginated portfolio
reads were verified against the live canister. The editable description is
recorded in `content/publisher.json`.

Publisher IDs contain 3–20 lowercase letters and are globally unique. Both ID
and name are permanent. Publish requires profile setup; only the description
can subsequently change. Registration retries return the current profile
without overwriting later edits. Publisher links open a profile with principal,
description, audited apps, review-weighted rating and distinct acquiring Neutron
count. Free and paid acquisitions count once per Neutron across that publisher's
portfolio. Reinstalls, another app from the same publisher and retries do not
inflate the total. Stored counters and the owner index keep profile queries
independent of purchase-history size. Historical backfill is resumable and
marks partial statistics explicitly until complete.

The protocol adds an independent publisher root and preserves its previous
roots. The app retains its released state v2 and v1→v2 migration unchanged.
PocketIC checks cover a keep upgrade from the exact previously deployed
`f3665ba9677b98df17c6c85fde1207e205bfe3e8bded609a864e5648e3bd2d5e`
module, concurrent registration, permanent identity, paid/free user deduplication,
rating edits during backfill, pagination and retained uploads. Protocol unit,
Ash and existing integration suites passed. Marketplace's 152 unit tests,
memory initialization/restoration/migration checks, real Candid SDK integration,
TypeScript and six browser suites passed, including compact profile layouts.
The final Unicode name normalization was rechecked on the exact deployed module.

Wallet's tile title is now **IC Wallet**, and its obsolete alpha footer is
removed. Its eight v1 memory roots and lock lineage remain unchanged.
Wallet qualification passed 323 unit tests, 19 Motoko suites, clean/restored
memory checks, five browser suites and TypeScript; immutable predecessor checks
include Wallet327. No production financial action was used for qualification.

The first repeat check stopped in the local Wasm response verifier with an
out-of-bounds memory error. Frozen package/source bytes were retained and the
same command was retried without bypassing verification. The successful
identical-byte repeat publication returned receipt-v2 `batch_id: null` with
all 27 packages and offered sources `unchanged`. Versions, URLs, paths, lengths
and SHA-256 digests match all 54 frozen artifacts. Publication request:
`a7428718dc496ffbb4acaa9cb35005ebb7abe4656f8f6eb9910c79ad987be7c2`. Existing Neutrons install the updates through Settings.
No Git push is included.


## Sandboxed form actions and SNS tool registration

Wallet `0.3.29`, Marketplace `0.1.17`, SNS Governance `0.1.14` and Kitchen Sink
`0.3.18` were published together in catalog batch `11` on 2026-09-11.
Only those four packages changed in the 27-package transaction. Kernel,
Marketplace protocol, legacy source and Dispenser starter were unchanged.

| Package | Archive bytes | Archive SHA-256 | Offered-source bytes | Offered-source SHA-256 |
| --- | ---: | --- | ---: | --- |
| kitchensink 318 | 479,150 | `07433bd7e88994ade59e4a4d33470efb9367706054bc6b9a3c30bb1ee29a8e33` | 540,647 | `7013ce317461342cf809a7c3cfe46128ed6900260042432b3812d9a91ce0f82c` |
| wallet 329 | 941,108 | `48e56391089ca7e2d22552690bb33e73804ecaa0b7eb51a224a0b88d2aebd7b1` | 853,831 | `34daf241a956b2627ac2afaa023e8fb265189890d9e00515201ce7049c7d6d13` |
| snsgov 114 | 582,749 | `69581edf07bd4c4f995d11797a7570c6109201e763c4758f5f6eecc8f0fa3ad0` | 624,248 | `94b7dbcab331f089de8474b79bbe3ca7f76ffafea104a94ab484d46457b52350` |
| marketplace 117 | 489,552 | `695059aef8314a2546ae14a4118b0903d97b0c7860a931581c260a07f529fe04` | 1,796,708 | `d9f20cd6ab428684bc50f905f085e7eb22e2361ac8cbdaebdc3c4301b5629231` |

SNS's `sns_draft_proposal` used a grouped hexadecimal schema pattern unsupported
by the existing SDK metadata validator, stopping resident registration. The
schema now uses a supported character class and minimum length; existing
even-byte and Candid payload checks remain. All 17 tools register through the
real validator, and the actual packed resident starts in a sandboxed iframe
without the reported exception. Shared validation and app permissions did not
change.

Wallet's Refill/Get TCYCLES review, Marketplace publication/profile setup, and
Kitchen Sink's profile review depended on native form submission. The browser
blocked it before React's submit handler could run. Those flows now use explicit
button actions and input Enter handlers, with validation, busy guards and
multiline/composition behavior preserved. Browser tests run inside actual app
sandboxes without `allow-forms` and verify the action occurs once without native
submission or navigation. The developer guide records this existing iframe
contract and the need to test real tool registration.

Inventory of other app/shared frontend code found no further native-submit
dependencies. EVM Wallet's 55 existing sandbox browser checks and a focused
Gemma sandbox composer check passed on their unchanged packages. Agent's
composer/search handlers already intercept Enter and use explicit buttons;
trusted Kernel host forms remain unchanged.

All four apps retain their released memory declarations, schemas and locks.
Full package commands, TypeScript, memory initialization/restoration and relevant
predecessor upgrade checks passed. Wallet passed 323 unit tests, 19 Motoko suites
and five browser suites. Marketplace passed 152 unit tests, its memory program
and six browser suites. SNS passed 129 tests, with eight opt-in mainnet cases
skipped; Kitchen Sink passed 68 tests plus its sandbox and memory checks.
No production financial action was used for testing.

The Marketplace browser fixture previously returned completion while continuing
to synthesize the same withdrawal as pending; it now retains the completed
record and tests refresh persistence. No payment runtime changed. Wallet's
all-predecessor archive test exceeded its former five-second harness timeout as
the inventory grew; that one test now has a 30-second timeout. An unrelated SNS
browser workflow timeout passed both isolated and unchanged full-suite retries.

Publication request `605405310f12983f93de89c100f6a3b315155e79d0754cac32f6bd2eb6db7255` was verified, and the identical-byte
repeat returned receipt-v2 `batch_id: null`: all 27 packages and offered sources
were `unchanged`, with matching versions, URLs, paths, sizes and SHA-256 digests
across all 54 frozen artifacts. Install the updates through Settings.
No Git push is included.


## Faster Marketplace and Wallet purchase reviews

Marketplace `0.1.18` and IC Wallet `0.3.30` were published together in catalog
batch `12` on 2026-09-11. Only these two packages changed in the 27-package
catalog. Kernel, Marketplace protocol, legacy source and Dispenser starter
remain unchanged.

| Package | Archive bytes | Archive SHA-256 | Offered-source bytes | Offered-source SHA-256 |
| --- | ---: | --- | ---: | --- |
| wallet 330 | 957,812 | `091af7f6bd5ef870e727db265bd549a2024a090c7dede70d6647d25709819e2b` | 860,694 | `58dcb999acc6cbe006669fd17c70843511eef44f2afd2c1b6255c1eaa539bb33` |
| marketplace 118 | 489,788 | `54136d8bd22c9d682fc958c1eef7904816f34e599f6dd2daf503c10c554eec20` | 1,800,241 | `719795cb6852fd4141e21fd0b33ba4d6cb5eb43dc9181711cebf38c45779b73b` |

The Marketplace pricing query was already browser-to-protocol, but checkout
waited for separate discount validation, serial app-detail queries and an
update-backed Wallet token read. New checkout sends the remembered code to the
canonical pricing query, which validates it with prices and ownership. The
activation dialog still validates separately. Catalog/detail presentation is
reused only for a matching listing revision and publisher; payment amounts,
allocations, recipients and opaque execution terms always come from the quote.
Missing details run concurrently. Paid storefront selections overlap the live
Wallet read with pricing, while free canonical quotes do not depend on it.

Wallet now reads metadata, fee and allowance/balance directly from the browser
in parallel, using its existing verified query transport. Additive variants of
`wallet_read_v1` apply the existing selected-ledger, authority, formatting and
original-command checks. The normal funding preview performs no update and
creates no command. Acceptance runs the original durable prepare with fresh
ledger reads before execution; changed review terms require another decision.
Allowance preparation also combines the existing three backend reads into one
batch. Root funding and exact ledger replay protections remain intact.

Cancellation of an unsaved preview first checks its exact original command,
preserving any concurrent pending or completed result. Expired or deselected
previews can still close. Public-ledger outages do not hide existing Wallet
commands. Failed status reads are not reported as definite rejection.
Marketplace still saves its purchase/funding identity before invoking Wallet;
this required update is not claimed to be query-only or guaranteed subsecond.

All eight Wallet v1 roots, Marketplace v2 and its retained v1 migration, released
schema files and locks remain unchanged. Wallet's existing 32 preapproved self
methods are unchanged. Package validation initially rejected separate new query
methods, so the final implementation reuses the existing read method. Two
stale static-test expectations were updated for the additive Account schema
paths and moved resident helper before the successful full run.

Validation passed: Marketplace complete package, 153 outer unit tests (including
14 isolated concurrency/quote regressions), memory program, TypeScript and six
browser suites; Wallet complete package, 334 unit tests, 19 Motoko suites,
clean/restored memory, predecessor checks including 329, TypeScript and five
browser suites. The Marketplace test runner skipped 27 opt-in PocketIC cases;
those cases are not claimed as coverage for this release.
Independent review covered query routing, exact-term reapproval,
original-command recovery and cancellation races. No production financial
mutation was used for testing.

Read-only public protocol queries measured 253-503 ms after the first measured
query (992 ms). A parallel ckUSDC metadata/fee/balance read measured 151 ms warm
and 932 ms on first use. These are component measurements from the development
host, not authenticated checkout or owner-browser latency measurements. Initial
verified reads can additionally fetch certified subnet keys; verification is
retained. The release reduces sequential waits without a fixed one-second SLA.

Publication request `822518850ad10b688fb39101ef9879e322e17fa202a9f690c3fc11147ed8884b` passed receipt-v2 verification.
The identical-byte repeat returned `batch_id: null`, all 27 packages and offered
sources `unchanged`, and matching versions, URLs, paths, sizes and SHA-256 digests
for all 54 frozen artifacts. Update both apps through Settings. No Git push is
included.


## Wallet331 unsigned approval cancellation

Wallet `0.3.31` was published in catalog batch `13` on 2026-09-11.
Only Wallet changed in the 27-package catalog. The archive is
957,817 bytes, SHA-256 `8c6a93776de78da165526f9dfde1b557bac78a743815ffd70d909249eb815ccf`; its offered source is
863,305 bytes, SHA-256 `0d8c6370aa9329c853115fe3ea6570a8d9c75e2a70c537b45225d4a68ce38726`.

Wallet330 incorrectly required the optional `preparation` field when canceling
a query-only approval preview. The existing Kernel Candid projection omits that
field when no durable command exists, returning `{ durable: false }`. Wallet
rejected that valid result as “Invalid Wallet funding cancellation status” and
kept the dialog open. Its earlier mocks used explicit null and missed the
production representation.

Both preview and cancellation parsers now accept an omitted preparation while
still requiring the durability flag and rejecting unexpected fields. Canceling
a confirmed unsigned preview closes it without an update or payment. Existing
pending/completed commands continue through the original durable outcome path;
failed status reads and malformed durable results are not treated as a safe
cancellation. The same correction preserves the underlying public-ledger error
when a preview cannot obtain fresh facts.

The regression was reproduced in the actual allowance dialog using the prior
parser loaded from an external test override. With the fix, omitted and explicit
null replies both close the dialog after its status lookup, return declined, and
make zero update/payment calls in a sandbox without `allow-forms`. Unit coverage
also runs a real Candid encode/decode through the Kernel result projector.

Complete Wallet packaging, 337 unit tests, 19 Motoko suites, clean/restored
memory, historical predecessor checks including Wallet330, TypeScript and six browser
suites passed. All eight v1 memory roots, released schema files, lock lineage
and installed permissions are unchanged. No Kernel or Marketplace app/protocol
change was required, and no production financial action was used for testing.

The initial read-only publication review hit the previously observed local
Wasm response-verifier error. Repeating with identical artifacts succeeded;
verification was not bypassed. Publication request
`7755701aea5c440b5239915f73d26dcd56edc758589c18952a753ed2479bed38` and its identical-byte repeat passed receipt-v2 checks.
The repeat returned `batch_id: null`, with all 27 packages and offered sources
`unchanged`, matching every version, URL/path, size and SHA-256 across all 54
frozen artifacts. Existing users obtain this fix through the Wallet update in
Settings. The legacy source and Dispenser starter are unchanged.
