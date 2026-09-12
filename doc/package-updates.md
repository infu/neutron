# App Package Updates

Use this guide for state-compatible package releases and update-source changes.
`AGENTS.md` owns production policy. The implementation uses the same bounded
package parser, compiler, capability review, managed-memory planner, checked
deployment journal, and atomic asset commit as ordinary installation. There is
no separate update package format or automatic installation path.

## Maintainer Release Workflow

Complete migration and release checks before publication. Do not publish an
incomplete candidate, repair package bytes in place, or use destructive
provisioner reinstall as an application upgrade.

### 1. Preserve State And Version The Release

Audit every managed-memory root of each changed app. If persistent state
changes, add a new schema and explicit forward migrations from every supported
installed version, including skipped releases. Never replace released schemas,
migrations, or lock lineage. If the schema is unchanged, retain its memory
version and verify restoration; do not manufacture a migration for a code-only
release. Test clean initialization and supported production migration paths.

After the state-compatible change is complete, increase `version` in
`apps/<app>/neutron.json`. App release versions are independent of memory
versions and workspace `package.json` versions. The packed representation and
archive name are defined by `packages/neutron-tools/src/version.ts`:

```text
major * 10000 + minor * 100 + patch
<id>.v<major>.<minor>.<patch>.neutron
```

Every change to production package bytes requires a strictly higher release
version. Never reuse a version with different bytes or publish a downgrade.

Keep `update_source` set to `233tv-xiaaa-aaaay-aacta-cai` for packages distributed
through the SushiOS production source. Marketplace packages must instead name
the actual source selected by the Marketplace catalog. Do not substitute a
placeholder, silently rewrite installed registry entries, or redirect a
production-pinned source to a different local fixture. A source transition is
reviewed package state and takes effect only on successful installation.

### 2. Build And Qualify The Exact Package

From the repository root, use each changed app's complete workspace command:

```sh
npm --workspace <app-workspace-name> run package
```

Read the workspace name and its release gates from the app's `package.json`.
Do not call `pack.ts` directly: workspace scripts may perform required memory,
metadata, or release-evidence steps. A failed package command blocks release.
Run the app's release tests separately where they are not part of packaging;
the publisher does not build apps or run those tests. See
[Testing And Verification](./testing-and-verification.md).

Review the archive's actual ID, version, size, digest, dependencies, capability
changes, and package-information record. Production-compatible hosted-source
packages install ordinary `legal/**` metadata and retain the exact generated
source gzip artifact outside `dist`:

```text
apps/<app>/.neutron/sources/<sha256>.source.v1.msgpack.gz
```

Keep that artifact with the archive through publication and postflight. The
publisher checks the exact compressed bytes and decoded source/build bindings;
a recompressed equivalent is not the same artifact.

When a supported predecessor has a closed manifest parser, the complete target
set must use an envelope it can prepare. Ordinary hosted-source packages omit
the archive-only feature marker. Explicit embedded-source packages require an
already active aware installer and cannot substitute for that compatibility
contract. Qualify the exact intended successor and app set, not just synthetic
compatibility fixtures. See
[License And Deployment Records](./license-and-deployment-records.md#historical-compatibility-and-release-evidence).

### 3. Keep Active Artifact References Coherent

Search for old archive-name references and review each consumer. Update active
path-only configs only when they should deploy the new package; preserve
historical receipts, fixture pins, completed sessions, and release archives.
For active configurations that pin artifacts, derive path, version, byte
length, and SHA-256 from the actual archive, not from a copied documentation
inventory.

Release catalogs select app IDs/directories; the publisher derives versions
and digests from the current source manifests and archives. Read the selected
catalog to determine membership. A normal version bump does not require a
catalog edit.

`support/dispenser/starter-packages.json` selects the next starter independently
of update publication. Change it only when future newly dispensed Neutrons
should receive the new set. The selection file does not prove what is live.

### 4. Review And Publish To The Production Source

The normal first-party release command is:

```sh
npm run updates:publish
```

The root script targets Marketplace, using its private production catalog and
the existing Blast ID 0 identity. Missing configuration fails without falling
back to the legacy source. Read
[Marketplace Operations](../support/marketplace/OPERATIONS.md) for catalog,
identity, listing, and recovery-journal configuration. Its no-write review is:

```sh
npm --workspace neutron-marketplace-protocol run production:review
```

Publication has no interactive confirmation. Review the prepared archives and
matching offered-source artifacts first. Only one production publisher may run
at a time; a local journal lock is not a global operator lock.

The publisher verifies selected manifest/archive identity and source bindings,
prepares missing package/source artifacts under retained request and candidate
identities, and atomically approves/publishes the exact first-party release
set. It rejects downgrades and equal-version/different-byte releases. Existing
matching bytes are verified no-ops. The automated audit stamp describes the
checks performed; it does not claim manual malware or behavior review.

Publish a compatible Kernel successor and app set in one catalog transaction
when they are intended for one **Upgrade all** action. Do not create a timed
Kernel-first publication phase. The previously approved Marketplace release
stays available while its successor is staged. After approval, unreferenced
superseded package/source bytes may be retired; ownership and audit records
remain. Preserve local release evidence separately.

The command emits a `neutron-update-source-publish-v2` receipt. A changed
publication reports a non-null `batch_id`; package/source rows identify their
published or unchanged bytes. Keep the receipt with the exact archives, source
artifacts, and recovery journal. Publishing makes releases discoverable; it
does not install them into existing Neutrons or update the Dispenser starter.

The stable legacy SushiOS source remains separate. Use its explicit command
only for an intended legacy-source release or reviewed transition:

```sh
npm --workspace neutron-update-source run production:publish
```

Its catalog and Commit-only publisher configuration are described in
[the update-source operator reference](../support/update-source/README.md).
The root Marketplace command never implicitly publishes to this source.

### 5. Require The Verified Receipt-V2 No-Op

Run the same publication command again against the same bytes. Require:

- `batch_id: null`;
- every selected package reported as `unchanged`, with version, size, and
  SHA-256 matching its local archive;
- every offered source reported as `unchanged`, with URL, path, size, and
  SHA-256 matching its retained artifact.

Both runs verify the published release, package, and source bytes through the
publisher's strict certified-response path. Private objects use first-party
source-access grants; acquiring a grant can write authorization metadata
without publishing another release. An ad hoc upload or controller call is not
a replacement for this postflight.

If the first response is lost after a possible commit, retain the same archive,
source bytes, request identities, and journal. Rerun to reconcile the outcome.
Do not rebuild, bump again, or create a new publication identity while the
original result is unknown.

### 6. Optionally Stage The Dispenser Starter

When future newly dispensed Neutrons need the new set, first publish those
exact package bytes and update `support/dispenser/starter-packages.json`, then:

```sh
npm --workspace dispenser run production:starter:set
```

The uploader compiles the selected complete set, stages it, and commits a new
starter revision atomically. It affects only Neutrons created afterward. Do not
repeat the staging command as verification: identical staging still creates a
revision.

Read the committed `starter()` query from the backend canister recorded in
`.neutron/dispenser-production.json`. Compare revision, deployment ID, ordered
app IDs, transport Wasm size/digest, and file-payload digest with that receipt.
Use the production operator configuration and query commands in
[Dispenser And Provisioning](./dispenser-and-provisioning.md). The local
`npm --workspace dispenser run starter:set` targets the local Dispenser; it is
not a production postflight.

## Manifest And Repository Contract

`update_source` is optional and must be a canonical eligible IC principal.
The installer persists it in the committed registry. An app installed before
its manifest added a source remains manual-only until an owner-reviewed
package update adds it; updating the Kernel alone does not retroactively add
sources to installed apps.

Sources expose fixed repository paths:

```text
/repo/v1/releases/<app-id>.json
/repo/v1/packages/<sha256>.neutron
/repo/v1/sources/<sha256>.source.v1.msgpack.gz
```

`packages/neutron-tools/src/repository.ts` owns the closed release record,
version validation, limits, and path builders. A release binds app ID, packed
version, package digest, and length. The client derives the download path from
the digest; the publisher cannot inject an arbitrary package URL.

Release records are mutable latest-version pointers. Digest-addressed objects
cannot change bytes under an existing identity, but retention is source
specific: the legacy asset source retains older objects while Marketplace may
retire superseded unreferenced bytes. Do not promise every previous version
remains downloadable.

## Checks, Privacy, And Certification

Settings checks on entry and explicit refresh. It groups installed apps by
source and fetches only their fixed release paths in bounded waves, without
fetching the source's complete catalog or starting background update polling.
Exact wave sizes, timeouts, and byte limits live in `apps/kernel/src/updates/`.
Sources can still observe app IDs, request timing, Origin, and network metadata;
per-app queries are inventory minimization, not anonymity.

Release discovery uses public GETs from the fixed non-raw canister origin with
CORS, no ambient credentials, no referrer, and rejected redirects. It does not
send installed versions or user principals. Body limits, exact URLs, media
types, and cancellation are checked before release data is accepted.

Package acquisition is different: an anonymous read can receive a certified
private-repository challenge. The reviewed source-access path can authorize an
exact-path grant through the owning Neutron and retry with its bearer token.
Cost/fee-version approval, owner binding, request-bound certification, and
same-request recovery remain enforced. Do not claim all package downloads omit
authorization or that cancelling a browser read reverses an access update that
may have committed. Source offers use the same access mechanism. See
`apps/kernel/src/repository_access/`.

The update HTTP client currently accepts jointly hidden `IC-Certificate` and
`IC-CertificateExpression` headers as a gateway compatibility exception. If
either is visible, it requires the complete v2 envelope and rejects
`no_certification`. Joint absence does **not** establish full v2 body
certification: it prevents the browser from inspecting the response policy.
This exception is planned for removal; new sources should expose both headers
and supply full certification. See [Deprecated Compatibility](./deprecated.md).
The server-side publisher requires visible proof headers and full verification;
do not conflate its checks with the browser exception.

A usable verified `404` maps to not-published. The legacy stock asset source
cannot certify arbitrary missing release paths, so gateway rejection can instead
appear as check-failed. Never interpret a failed proof as trusted absence.

Results are independent per app. Source regression, equivocation,
unverifiable same-version metadata, and transport failures remain visible;
failed rows do not erase successful checks. Cancellation, Settings unmount,
registry change, or a newer check invalidates the old generation so late
responses cannot publish stale state.

## Preparation And Atomic Deployment

An owner can update one app, an exact selected subset, or all verified available
rows. Unavailable/manual/failed/regressed rows are excluded from the requested
update set and remain visible for resolution. Once preparation starts, the
chosen set is fixed: a failing member rejects the attempt rather than being
silently removed.

Preparation re-fetches release records, binds the same selected identities,
downloads and verifies exact archive bytes, validates inner manifests/source
changes, resolves dependencies, and computes the complete capability and
managed-memory plan. Bounds apply across the complete batch. A changed release
or installed baseline invalidates it.

The shared setup/update session seals the prepared package set and compiled
result under one operation mutex. Setup admits absent app IDs; update admits
installed IDs. Deployment must use that reviewed set and matching provenance,
not a freshly selected alternative. Reused compilation and transport remain
bound to exact input bytes, and approval rechecks the installed baseline.

The Kernel creates the complete deployment record before approval, reviews the
combined result, stages registry/assets/capabilities/memory/provenance and the
same record, activates the exact assembled actor, then commits atomically.
Preparation failure starts no deployment. An ambiguous deployment outcome is
resolved through the checked journal and running identity; it is not evidence
that nothing changed. See
[License And Deployment Records](./license-and-deployment-records.md#pre-dispatch-review-and-atomic-commit).

The source advertises only its latest release. It does not calculate migrations
or supply intermediate packages. Every target package must contain its complete
supported immutable schema/migration lineage. Missing or ambiguous paths reject
the whole batch; skipping app versions is safe only when the latest package is
self-sufficient for the installed memory baseline.

## Provenance And Local Source Fixtures

Successful installs atomically write `/system/install-provenance.json` with the
acquisition kind and exact accepted package/release identities. Source location
is not a publisher signature, endorsement, or capability grant. Manual installs
retain their outer-package digest so equal-version source equivocation can be
detected. Provenance is public metadata and must not contain owner credentials,
private tokens, or controller identities.

The legacy reference source uses a pinned asset-canister implementation and
Commit-only publication. Its exact binary/plugin pins belong in
`support/update-source/icp.yaml`; catalog, permission, and recovery details
belong in its operator README. Marketplace implements authenticated source
access and its own atomic release protocol.

The format-3 PocketIC provisioner owns its local update-source fixture. `serve`
synchronizes its seed assets and records the canister in the selected config's
session. That fixture does not transparently replace a production source: a
local update scenario must package against its actual principal and publish
release/package/source objects to it. Reinstalling a local Neutron is not a
production upgrade or a substitute for exercising an in-product update.

## Verification Boundaries

Find the relevant tests beside `apps/kernel/src/updates/`, the shared compiler,
and each source publisher. Check the actual fixtures and opt-in conditions
before claiming exact-release compatibility. Parser/compiler fixtures establish
their bounded contract; the archived-browser release-artifact gate and
state-preserving predecessor install must use the intended final bytes.

`test/e2e/package-updates.spec.ts` exercises Settings discovery/check lifecycle,
refresh, row presentation, and the manual-only case. It does not publish a
fixture release and perform a real update. Its Internet Identity gate can skip
the scenario, and its fresh wrapper destructively reprovisions the local
fixture. Do not report that suite's name or an unexercised pass as evidence of a
complete publication/download/review/deployment flow. Record the commands and
scenarios actually run with each release; keep receipts and changing results
out of this guide.
