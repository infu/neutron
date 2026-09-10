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
