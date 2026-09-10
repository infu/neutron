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
| Installed Wasm SHA-256 | `1bd60e9e252c7372d2e6939d3a3896fd0566c18abf4022bd4a49c8542f633d8b` |
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
[Marketplace version 107](https://sj2r4-haaaa-aaaay-aadgq-cai.icp0.io/repo/v1/packages/03ef7d67e3c7314474049da7ee9ede6678b5a8e291b3ed85e55fc5feddb7f785.neutron)
separately; publishing does not add that app automatically. This public package
was fetched through the gateway and its SHA-256 matched
`03ef7d67e3c7314474049da7ee9ede6678b5a8e291b3ed85e55fc5feddb7f785`.

No existing Neutron has been upgraded by this deployment record. No Dispenser
starter change or Git push is included. The missing burn-service destinations
remain an operator configuration item, not evidence of a completed token burn.
