# Neutron update source

This directory is the reference update-source canister and publisher for
Neutron app packages. It uses DFINITY's standard certified asset canister; there
is no custom upload or HTTP backend. The production deployment pins the actual
build inputs rather than a mutable recipe or `releases/latest` URL:

- DFINITY SDK `0.32.0` `assetstorage.wasm.gz`, SHA-256
  `04e565b3425fe7510ee16b02adcfe3f01abc9a2725c82a21cb08969241debd62`;
- certified-assets sync plugin `migration-v2.2.1-6b48585`, SHA-256
  `ca7cb5666c30d2875f8d5e10535f8a53f97a86c79c263f7d5bdac2fdd1bbf83c`.

The source publishes the shared repository v1 paths:

```text
/repo/v1/releases/<app-id>.json
/repo/v1/packages/<sha256>.neutron
/repo/v1/sources/<sha256>.source.v1.msgpack.gz
```

The Neutron-owned update-source scripts and configuration are Apache-2.0.
`LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md` identify the pinned upstream
canister and sync-plugin bytes. Published `.neutron` resources and Complete App
Source objects remain separate payloads and keep their own licenses, notices,
and source obligations.

A release record is the small mutable pointer to one immutable package:

```json
{
  "protocol": "neutron-repo-v1",
  "id": "mail",
  "version": 102,
  "sha256": "64 lowercase hexadecimal characters",
  "size": 123456
}
```

The scripts import the canonical paths, closed release codec, package limits,
and real `.neutron` installer from `neutron-tools` and `neutron-compiler`.
They do not maintain a parallel package format.

An update check groups installed apps by source as one logical job, but the
HTTP cache unit remains one exact app ID. Neutron sends one certified
`GET /repo/v1/releases/<app-id>.json` per installed app that names this source,
sorted and scheduled in waves of at most 20. It does not send installed
versions or fetch a source-wide catalog. The wave size bounds client
concurrency; it does not limit how many hundreds or thousands of packages the
source may hold.

## Security model

The deployment administrator remains a controller and therefore retains full
canister and permission-management authority. The CI/developer publishing
identity receives exactly the asset canister's `Commit` role. Commit can upload
chunks and atomically publish them, but cannot upgrade, stop, delete,
reconfigure, or drain the canister.

Do not add the publisher as a controller. The configuration scripts read the
controller list and refuse to grant Commit to a controller. They also enforce
one explicit Commit publisher because the asset canister has no generation
compare-and-swap operation. Serialize publication in CI; an administrator with
stronger authority must not publish concurrently.

Publishing uses authenticated Candid update calls (`create_batch`,
`create_chunk`, and `commit_batch`) through `@dfinity/agent`. Package bytes are
passed directly to the typed asset-canister actor and never written to command
arguments or subprocess files. There is no HTTP POST endpoint, form, bearer
token, public update route, or `icp` subprocess in the publisher.

Public downloads use a verified canister origin, never a raw domain. The ICP
HTTP gateway cryptographically verifies certified responses. The publisher
also requires the complete response-certification v2 envelope on every
successful preflight and post-commit GET, checks all served metadata, and then
verifies the exact byte length, SHA-256 digest, ETag, and release contents.
Browser CORS processing can hide both proof headers from JavaScript; the
Neutron browser client relies on the fixed verified gateway in that case and
requires the complete envelope whenever either header is visible. The
publisher's server-side fetch sees and always requires both headers.

## Prerequisites

- the workspace dependencies installed;
- Bun and Node.js available through the repository toolchain;
- `icp` CLI available only for the production canister deployment;
- a deployed update-source canister;
- a mode-0600 Ed25519 identity JSON file for administrative permission changes;
- a separate mode-0600, non-controller Ed25519 identity JSON file for
  publishing.

Run focused validation from the repository root:

```sh
npm --workspace neutron-update-source run check
npm --workspace neutron-update-source run icp:build
```

## Local development

This package does not own a local network or a local deployment command. From
the repository root, prepare a separately named archive-only format-3 config
with the required closed package pins, then start and populate the single
shared PocketIC instance through the Neutron provisioner:

```sh
npm run provision -- UPDATE-SOURCE-DEV.ndeploy.json serve
npm run provision -- UPDATE-SOURCE-DEV.ndeploy.json reinstall
npm run provision -- UPDATE-SOURCE-DEV.ndeploy.json status
```

The provision session is the source of local canister IDs, gateway details,
root key, and fixture state. Do not add a package-specific network, run `icp
deploy` locally, create a second PocketIC instance, or point these publisher
tools at the provision-owned local fixture. Local installation, seeding, and
reinstall belong exclusively to `neutron-provision`; the operator commands in
this package accept IC HTTPS targets only. The root `local.ndeploy.json` is the
current format-3 provision declaration and is not a writable input to these
publisher commands.

The fixture is not a transparent replacement for an arbitrary production
principal. Kernel uses the runtime-bound origin only when its canister id
matches the selected package manifest's `update_source`. The fixture initially
contains only `/health.txt`; a local release test must publish release, package,
and offered-source assets through fixture-specific test tooling and use that
fixture principal in the test package. The mainnet publisher commands below
deliberately reject loopback hosts.

The pinned sync plugin initially uploads `assets/health.txt`. A later canister
deployment that runs the sync step also reconciles the asset directory. Do not
casually rerun `icp deploy` against a source that contains published packages:
the sync step may remove assets that are not in `assets/`. Treat canister-code
deployment and package publication as separate operational procedures.
Preserve publication receipts, packages, and matching `.neutron/sources/`
artifacts before a canister upgrade, then verify or republish them afterward.
Asset synchronization itself requires Prepare/Commit. If the controller's
bootstrap Commit grant was removed during publisher setup, the controller must
temporarily grant itself Commit for the maintenance deployment and then rerun
publisher configuration to remove that grant again.

## Initial mainnet deployment

This command is for a fresh, unmapped source canister only. The production
source below already exists: do not rerun this deployment against its mapping,
because the asset sync contains only `health.txt` and may delete published
release, package, and source assets. For an intentional code upgrade, first
preserve the release receipts, packages, and source artifacts and follow the
maintenance/grant procedure above.

From `support/update-source`, after confirming that the target environment has
no existing `update_source` mapping:

```sh
icp deploy update_source \
  -e ic \
  --identity update-source-admin \
  --subnet re2t4-faa75-v3vhk-kdmdr-uyrkl-aik2l-ixd6u-p3fyr-zlfkc-6c5af-zae \
  --cycles 1t \
  --yes
```

icp-cli downloads the versioned asset-canister Wasm and sync plugin above and
verifies both configured SHA-256 values. No production Wasm is copied into this
repository, and neither deployment configuration follows `releases/latest`.

The repository's routine bump, package, production-publication, verification,
and optional Dispenser sequence is maintained only in
[`doc/package-updates.md`](../../doc/package-updates.md#maintainer-release-workflow).
The lower-level operator commands below are run from `support/update-source`.

## Current mainnet deployment

The production deployment, created and last verified on 2026-07-30, is:

| Property         | Value                                                              |
| ---------------- | ------------------------------------------------------------------ |
| Canister         | `233tv-xiaaa-aaaay-aacta-cai`                                      |
| Verified origin  | `https://233tv-xiaaa-aaaay-aacta-cai.icp0.io`                      |
| Subnet           | `re2t4-faa75-v3vhk-kdmdr-uyrkl-aik2l-ixd6u-p3fyr-zlfkc-6c5af-zae`  |
| Controller/admin | `xq4yd-4ajlv-ttqmx-no2l2-qazq5-jmv7f-b5jlv-6bdsh-x6ewa-6cc7u-yae`  |
| Commit publisher | `bqjgi-hc43n-uxdet-w3x2c-qbkwi-opbm2-3tsgg-chnvv-guy3t-avdtj-sqe`  |
| Module SHA-256   | `04e565b3425fe7510ee16b02adcfe3f01abc9a2725c82a21cb08969241debd62` |

The ignored local operator material is:

```text
.neutron/update-source-admin.json
.neutron/update-source-admin.pem
.neutron/update-source-publisher.json
```

The JSON identity files are mode `0600`; the containing `.neutron` directory is
mode `0700`. The admin PEM is also imported into ICP CLI as the plaintext
identity `update-source-admin`. Never commit or print any of those files.

The live permission invariant is one controller, one distinct Commit publisher,
and no Prepare, ManagePermissions, or controller-publisher entries. Verify it
and the canister state with:

```sh
npm run publisher:status -- \
  --canister-id 233tv-xiaaa-aaaay-aacta-cai \
  --host https://icp-api.io \
  --identity-file ../../.neutron/update-source-admin.json

icp canister status -n ic --identity update-source-admin \
  233tv-xiaaa-aaaay-aacta-cai --json
```

Changing publication batches, package versions, digests, and starter revisions
are not copied into this README. The production updater selection and source
principal live in [`release-catalog.json`](./release-catalog.json); versions
come from the selected source manifests, and live certified release records
are the publication authority. The Dispenser's separately reviewed desired
starter selection remains data in
[`../dispenser/starter-packages.json`](../dispenser/starter-packages.json);
its live `starter()` query and production receipt are the committed-state
authority. Neither publisher script hardcodes either product inventory.

## Configure a publisher

Run permission changes as the deployment/controller identity so the scripts can
prove that the publisher is not a controller:

```sh
npm run publisher:configure -- \
  --canister-id "$UPDATE_SOURCE_CANISTER_ID" \
  --host https://icp-api.io \
  --identity-file "$UPDATE_SOURCE_ADMIN_IDENTITY_FILE" \
  '<publisher-principal>'
```

Fresh asset-canister deployment normally gives the controller a bootstrap
Commit grant. Configuration removes controller Commit grants automatically;
controllers already have stronger canister authority and are not publishers.
If a previous non-controller Commit publisher is present, configuration fails.
Use `--replace` only when intentionally replacing every existing publisher:

```sh
npm run publisher:configure -- \
  --canister-id "$UPDATE_SOURCE_CANISTER_ID" \
  --host https://icp-api.io \
  --identity-file "$UPDATE_SOURCE_ADMIN_IDENTITY_FILE" \
  --replace \
  '<new-publisher-principal>'
```

Inspect all roles plus controllers:

```sh
npm run publisher:status -- \
  --canister-id "$UPDATE_SOURCE_CANISTER_ID" \
  --host https://icp-api.io \
  --identity-file "$UPDATE_SOURCE_ADMIN_IDENTITY_FILE"
```

The status output is JSON. A healthy serialized setup has one value in
`status.commit`, no values in `status.controller_publishers`, and
`status.single_commit_publisher: true`.

## Rotate or revoke a publisher

Rotation revokes the old publisher before granting the new one, avoiding a
concurrent-writer interval. If granting the new principal fails, the safe
failure mode is no active publisher.

```sh
npm run publisher:rotate -- \
  --canister-id "$UPDATE_SOURCE_CANISTER_ID" \
  --host https://icp-api.io \
  --identity-file "$UPDATE_SOURCE_ADMIN_IDENTITY_FILE" \
  '<old-publisher-principal>' '<new-publisher-principal>'

npm run publisher:revoke -- \
  --canister-id "$UPDATE_SOURCE_CANISTER_ID" \
  --host https://icp-api.io \
  --identity-file "$UPDATE_SOURCE_ADMIN_IDENTITY_FILE" \
  '<publisher-principal>'
```

The identity file is the canonical JSON returned by
`Ed25519KeyIdentity.toJSON()` and must be owned by the current user with no
group/other permission bits. `UPDATE_SOURCE_CANISTER_ID`,
`UPDATE_SOURCE_HOST`, and `UPDATE_SOURCE_IDENTITY_FILE` are accepted in place
of their corresponding flags. `--source-origin` overrides the certified HTTPS
origin. Agent hosts and source origins must be non-local HTTPS origins; there
is no root-key-fetch or loopback mode.

## Generic Publisher Command

Routine SushiOS production publication belongs to the canonical
[Maintainer Release Workflow](../../doc/package-updates.md#maintainer-release-workflow).
This section documents the lower-level publisher interface for a deliberately
operated source.

Given an already-built `.neutron` archive, invoke the generic source as its
configured publisher identity. When its verified package record offers source
from this update source, the package command has already written the matching
digest-addressed artifact under `.neutron/sources/`; the publisher discovers
it automatically. The app developer and installing user do not upload or
register source separately.

```sh
npm run publish -- \
  --canister-id "$UPDATE_SOURCE_CANISTER_ID" \
  --host https://icp-api.io \
  --identity-file "$UPDATE_SOURCE_PUBLISHER_IDENTITY_FILE" \
  ../../apps/mail/mail.v0.3.5.neutron
```

One command publishes all selected changed packages in one atomic transaction,
subject to the aggregate byte and individual artifact limits. It may
inspect a larger inventory containing unchanged releases:

```sh
npm run publish -- \
  --canister-id "$UPDATE_SOURCE_CANISTER_ID" \
  --host https://icp-api.io \
  --identity-file "$UPDATE_SOURCE_PUBLISHER_IDENTITY_FILE" \
  app-one.neutron app-two.neutron
```

Unlike the catalog publisher used by the production workflow, this generic
command does not prove that each package manifest's `update_source` equals the
target `--canister-id`. The operator owns that binding for a generic source.

`release-catalog.json` is the sole production publication inventory. Its
closed format-1 record contains the canonical `update_source` principal and an
ordered `packages` array of exact app IDs and repository-relative app
directories. Package versions and archive filenames do not live in the
catalog: the generic catalog publisher derives them from each directory's
authoritative `neutron.json`, then requires the packed archive to agree. To use
the same publisher with another reviewed catalog, pass that catalog explicitly:

```sh
bun scripts/publish-catalog.ts path/to/release-catalog.json \
  --identity-file path/to/publisher.json
```

Catalog publication changes certified release pointers and immutable package
and source assets only. It never installs, reinstalls, or copies installed-app
state.

Before making a Candid update, the publisher:

1. prepares every package with Neutron's bounded remote-package decoder;
2. derives the app ID and packed version from the authoritative inner manifest;
3. computes the exact outer byte length and SHA-256;
4. for an HTTPS source offer, requires the canonical same-origin URL, exact
   compressed size and SHA-256, and a gzip sidecar that boundedly decodes to a
   closed source snapshot matching the package ID, version, and build inputs;
5. counts package bytes plus each unique source digest against the publication
   byte limit;
6. pages one Candid asset-metadata snapshot and checks only the exact target
   release/package/source keys in it;
7. reads paths reported present through certified HTTP;
8. rejects downgrade or equal-version/different-digest publication;
9. verifies already-present digest-addressed packages and source artifacts;
10. chunks missing blobs in bounded waves;
11. commits each source, package, and changed release pointer in one
    `commit_batch`;
12. fetches every public URL again and verifies the complete result.

The metadata snapshot is not accepted as release or package content. It is a
publisher-only preflight used to distinguish an absent fixed path from a path
that must be fetched. The stock asset canister cannot produce a
gateway-verifiable arbitrary missing-path `404`, so a first publication cannot
safely discover absence with HTTP alone. If metadata says a path is present,
certified HTTP remains mandatory. If a stale snapshot says it is absent, the
atomic create operation fails rather than overwriting it. This Candid metadata
page is never used by Neutron's browser update checker.

The command prints progress to stderr and one machine-readable JSON receipt to
stdout. Keep that receipt with the CI release artifacts.

An exact same-version/same-digest publication is an idempotent verified no-op.
Receipt protocol v2 reports the exact source URL, path, size, digest, and
`published` or `unchanged` status next to each package. A `batch_id: null`
receipt therefore proves that source as well as package bytes were checked.
Old digest-addressed packages and source objects are retained. The publisher
pages asset keys for the preflight above but does not HTTP-download unrelated
release records, packages, or source. More importantly, a Neutron update check
never requests that metadata or a source-wide catalog: it asks only for its
exact app IDs in waves
of at most 20. A source can therefore hold hundreds or thousands of packages
without disclosing that inventory to a checking Neutron.

## Moving existing apps to the marketplace source

An existing Neutron learns a new source by installing a higher app release
whose packed `update_source` names the marketplace. The old source can publish
that one transition release using an explicitly reviewed sidecar. The sidecar
does not change the catalog's source, assign publisher ownership, or authorize
later versions to bypass ordinary source checks.

First prepare the inventory and migration plan with
[`migration-inventory.ts`](../marketplace/scripts/migration-inventory.ts).
Supply the deployed marketplace principal, an explicit publisher for
every existing app ID, live or retained published-release evidence, and the
exact transition archives. Local packed files are not evidence of what was
published. Put the plan's complete, reviewed `initReservations` array into the
initial canister configuration's `reservations` field. Installation reserves
those app IDs atomically, before public submissions can race them. Later
`admin_reserve_app` calls are for controlled additions, not the initial
migration. First-party entries belong to the configured Blast identity 0 and use
the marketplace's cycle-free atomic publication workflow. Ordinary publishers
upload through their Neutrons with the quoted cycles and obtain auditor approval.
These steps are separate from old-source publication.

The sidecar has exactly these fields:

```text
{
  format: 1,
  from_source: the existing source principal,
  to_source: the deployed marketplace principal,
  packages: [{ id: app ID, version: packed release version, sha256: package SHA-256 }]
}
```

Use the actual principals, versions, and lowercase SHA-256 digests from the
reviewed migration plan, rather than copying example identifiers. For example,
the following read-only preparation extracts those values into a JSON sidecar
from the tool's saved plan:

```sh
jq '{
  format: 1,
  from_source: .oldSource,
  to_source: .marketplace,
  packages: [.packages[] | {
    id: .appId,
    version: .transition.release.version,
    sha256: .transition.release.sha256
  }]
}' /path/reviewed-migration-plan.json > /path/reviewed-source-transition.json
```

Before any publication update, the publisher verifies that the new source
advertises the exact approved transition release and anonymously serves its
package and offered-source bytes through certified HTTP. A paid or otherwise
private candidate is not suitable for this path: transition releases must be
free and publicly downloadable. Their source offers must use the new source's
canonical certified origin. No buyer authorization is obtained to copy private
bytes into the old public source.

All ordinary release requirements still apply, including preserving managed
memory, checking supported migrations, using a strictly higher app release
version, complete packaging and release tests, and reviewing exact archives
with their offered-source artifacts. The sidecar pins each exception to one
app ID, version, and digest; changed bytes or a different version require a new
reviewed release plan. It is not a lasting alternate-source fallback.

After publication is authorized, run from the repository root:

```sh
npm --workspace neutron-update-source run production:publish -- --transition /path/reviewed-source-transition.json
```

The root `npm run updates:publish` command now targets the marketplace; it does
not accept the old-source transition sidecar. Use the explicit legacy workspace
command above only for this reviewed transition.

This command publishes immediately after its checks; it has no interactive
confirmation. Only one production publisher may run at a time. Retain the
receipt and repeat the same command with the exact same archives, source
artifacts, and sidecar. The second receipt must be receipt-v2 with
`batch_id: null`, all selected packages and offered sources `unchanged`, and
their version, URL, path, size, and digest matching as applicable. If a response
is lost, reconcile with those same bytes first; do not rebuild, bump, or edit
the sidecar while the result is uncertain.

The new-source preflight applies when an old-source mutation is needed. An
already-committed no-op verifies the retained old-source release, package, and
source bytes even if the marketplace later changes, revokes that release, or
becomes unavailable. This allows reconciliation after a lost commit reply;
the no-op receipt does not certify the marketplace's continuing availability
or approval state.

Installing the transition changes the app's source for subsequent update
checks. Publish subsequent releases through the marketplace's publisher and
audit workflow. Do not broaden the old-source sidecar into a permanent
exception. Previously public packages and source artifacts remain available at
their original digest-addressed paths; migration does not remove those bytes
or make them private.

## HTTP metadata

Release records are identity-encoded JSON and are stored with:

```text
Content-Type: application/json; charset=utf-8
Cache-Control: public, max-age=0, must-revalidate
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Content-Length, Content-Type, ETag, IC-Certificate, IC-CertificateExpression
X-Content-Type-Options: nosniff
```

Packages are identity encoded and stored with:

```text
Content-Type: application/vnd.neutron.package
Cache-Control: public, max-age=31536000, immutable, no-transform
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Content-Length, Content-Type, ETag, IC-Certificate, IC-CertificateExpression
X-Content-Type-Options: nosniff
```

The publisher stores a certified ETag equal to the supplied SHA-256. Raw access
and path aliasing are disabled for all three asset classes. Large packages
are uploaded and downloaded in chunks while their final digest covers the
original uninterrupted `.neutron` bytes.

Complete App Source objects are exact gzip payloads produced by the package
generator and served without HTTP gzip transformation:

```text
Content-Type: application/gzip
Cache-Control: public, max-age=31536000, immutable, no-transform
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Content-Length, Content-Type, ETag, IC-Certificate, IC-CertificateExpression
X-Content-Type-Options: nosniff
```

Their filename, URL, ETag, package-record revision, exact compressed size, and
SHA-256 all bind the same compressed bytes. Publisher preflight performs a
bounded gunzip and validates the closed v1 MessagePack source snapshot before
uploading it; it does not recompress the snapshot and compare zlib-specific
output. The production asset has no HTTP
`Content-Encoding` header: the `.gz` file bytes themselves are the hashed
payload. The browser verifier tolerates an explicit `identity` value from
another conforming host but rejects transforming encodings.

## Operations, monitoring, and capacity

Monitor the public data plane and the administrative control plane separately.
A production availability probe should GET one known release record from the
verified `https://<canister-id>.icp0.io` origin, then GET the immutable package
it names and any same-origin source object named by that package record. Treat
a missing known release, package, or offered source, a timeout, or a digest/size
mismatch as an outage. Do not use an arbitrary missing path as
a health probe: this stock asset canister does not certify arbitrary `404`
responses, so a verified gateway can reject the response instead of exposing a
usable `404`.

For every successful server-side GET require the complete HTTP certification
v2 envelope:
`IC-Certificate` must contain `certificate`, `tree`, `expr_path`, and
`version=2`, and `IC-CertificateExpression` must be present without
`no_certification`. Also check the documented content type, cache policy, CORS,
ETag, and identity encoding. Header inspection detects a broken or raw gateway;
the verified ICP HTTP gateway performs the cryptographic verification. Never
use a raw-domain probe as evidence of healthy certified serving. Browser code
may not see these proof headers because the gateway's CORS response does not
guarantee their exposure; that is different from server-side operational
verification.

Run `publisher:status` on a schedule and compare its JSON with an explicit
allowlist. Alert on any controller change, any unexpected Prepare or
ManagePermissions grant, anything other than the one expected Commit
publisher, or any value in `controller_publishers`. Zero Commit publishers is a
safe maintenance state but should still alert because releases cannot be
published. An unexpected controller is critical even without Commit: a
controller can replace the canister or grant itself publishing authority.

Archive the publisher's stdout receipt, exact `.neutron` inputs, matching
`.neutron/sources/` artifacts, and CI logs for every attempt. A receipt is
emitted only after post-commit certified HTTP verification succeeds;
`batch_id: null` means an idempotent, verified no-op.
Missing receipt or a nonzero exit is a failed release job. Failures before or in
`commit_batch` expose nothing, but a failure during post-commit verification is
ambiguous because the atomic batch may already be live. In that case freeze the
release lane and rerun the exact same inputs to reconcile it; do not substitute
different bytes at the same version.

Record `icp canister status <canister-id> --json` under the administrative
identity and alert on low cycle runway or abnormal memory growth. The 128 MiB
aggregate byte limit applies to one publication, not to the source's
lifetime. The byte bound still covers every inspected package and unique source,
including unchanged releases. Every selected catalog entry is checked before
mutation and verified again before its receipt is returned; unchanged entries
do not add batch mutations. The catalog itself retains its 256 KiB byte bound.
Each new digest-addressed package and source is retained, so estimate logical
retained bytes by summing each unique `sha256` and `size` once across archived
receipts, then compare that trend with canister memory and cycles. Set
operator-specific warning and critical thresholds early enough to top up or
investigate before publication or HTTP service is endangered.

Routine publication must never delete immutable packages or source objects. A
future garbage collector must be a separate, explicit administrative command
with a dry run, a bounded deletion set, a retention/grace window, proof that no
current or retained package requires each digest, and its own signed or archived
deletion receipt.
Until that procedure and recovery policy exist, storage growth is deliberate
and old packages and sources remain available for in-flight downloads,
auditing, and reproduction.

## App manifest

An app opts into Settings-time update checks with the canonical source
principal. Neutron checks it when an authorized user opens or refreshes
Settings:

```json
{
  "update_source": "233tv-xiaaa-aaaay-aacta-cai"
}
```

The source is a location, not a trust root. Neutron still performs its normal
schema checks, compiler validation, capability review, dependency planning,
managed-memory migration planning, checked journal, and atomic installation.
Because source-discoverable production apps use ordinary format-3 manifests
without archive-only markers, the catalog may publish a state-compatible Kernel
successor and app releases together. Neutrons on immutable production v0.3.5 or
v0.3.6, as well as the compatible private v0.3.7 candidate, install the latest
set with one **Upgrade all** action; operators must not create a timed
Kernel-first publication phase.

## Rollback and recovery

Release versions are monotonic. To restore older application behavior, build
that code as a new, strictly higher semantic version and publish it. Do not
move a release pointer backward. Retained content-addressed packages support
auditing and reproduction but are not an authorization to downgrade.

- If validation or upload fails before `commit_batch`, the script deletes the
  staging batch and no new pointer, package, or source becomes visible.
- If `commit_batch` rejects, its operations are atomic and nothing is applied.
- If the post-commit HTTP verification fails, publication may already be live.
  Do not publish a different candidate blindly. Rerun the same command: it is
  idempotent and repeats certified verification.
- If a release record was corrupted outside this publisher, revoke Commit,
  inspect the certified record and retained package/source, then repair it
  under an explicit administrative incident procedure. The normal publisher
  refuses to guess past malformed or equivocal state.
- Garbage collection is intentionally absent. Deleting old packages or sources
  needs a separate retention policy and proof that no reviewed/recovery
  workflow still references them.

## Tests

The focused `npm test` unit and contract suite covers:

- real `.neutron` inspection for two example apps;
- strict server-side certified HTTP v2 envelope, cache, configured CORS, ETag,
  encoding, size, and digest checks;
- multi-chunk upload/download;
- Commit/Prepare/ManagePermissions authorization boundaries;
- controller rejection, rotation ordering, revocation, and status;
- atomic source/package/release publication and failed-commit invisibility;
- source URL, compressed/uncompressed bounds, bounded gunzip, closed snapshot,
  build-input, exact compressed-byte size and digest, content-type, and
  identity-encoding validation;
- downgrade/equivocation refusal and receipt-v2 idempotent republishing that
  re-verifies hosted source;
- first-publication metadata discovery without an uncertified missing-path
  preflight, plus a source with 100 unrelated records without HTTP-fetching
  those records;
- direct typed agent calls for binary chunks, permissions, and paged metadata;
- closed release-catalog parsing, repository containment, duplicate rejection,
  manifest-derived archive selection, and manifest/archive identity agreement;
- matching immutable production artifact pins.

These tests use in-memory asset behavior and a typed actor adapter. The current
Playwright package-update test covers Settings check lifecycle and manual-only
presentation; it does not seed this local asset fixture, publish a release, or
apply an update. A true PocketIC publish/read/review/deploy browser flow remains
separate evidence.

Primary interfaces:

- [DFINITY asset canister guide](https://docs.internetcomputer.org/guides/frontends/asset-canister/)
- [HTTP gateway protocol](https://docs.internetcomputer.org/references/http-gateway-protocol-spec/)
- [Asset canister Candid and permission design](https://github.com/dfinity/sdk/blob/master/docs/design/asset-canister-interface.md)
