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
Schemas shipped to beta are released history even when that beta is never
promoted. Retain their immutable lineage and forward paths alongside stable
predecessors; beta users' installed data is production data.

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

### 4. Review And Publish Beta To The Production Source

The normal first-party release command is:

```sh
npm run updates:publish
```

New Marketplace releases enter beta. The root script targets Marketplace using
its private production catalog and the existing Blast ID 0 identity. Missing
configuration fails without falling back to the legacy source. Read
[Marketplace Operations](../support/marketplace/OPERATIONS.md) for catalog,
identity, listing, and recovery-journal configuration. Its no-write review is:

```sh
npm --workspace neutron-marketplace-protocol run production:review
```

Publication has no interactive confirmation. Review the prepared archives and
matching offered-source artifacts first. Only one production publisher may run
at a time; a local journal lock is not a global operator lock.

The source must first have the state-preserving channel protocol upgrade; the
publisher requires its certified descriptor. See the
[channel rollout](../support/marketplace/OPERATIONS.md#channel-protocol-rollout).
The publisher verifies selected manifest/archive identity and source bindings,
prepares missing package/source artifacts under retained request and candidate
identities, and atomically approves/publishes the exact first-party beta set.
It rejects downgrades and equal-version/different-byte releases across both
channels. Existing matching releases are verified no-ops, including unchanged
stable releases which do not need another beta publication. Ordinary publishers
still require auditor approval before beta distribution. The first-party audit
stamp describes automated checks, not manual malware or behavior review.

Publish a compatible Kernel successor and app set in one catalog transaction
when they are intended for one **Upgrade all** action. Do not create a timed
Kernel-first publication phase. Stable remains available while a successor is
staged and offered as beta. Retain package/source bytes referenced by either
head; unreferenced superseded bytes may retire without deleting ownership or
audit records. Preserve local release evidence separately.

The command emits a `neutron-update-source-publish-v2` receipt. A changed
publication reports a non-null `batch_id`, `operation: "publish"`, and
`channel: "beta"`; package/source rows identify their published or unchanged
bytes and the selected channel. Keep the receipt with the exact archives, source
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

Pre-channel Marketplace v1 publication journals retain their original stable
operation. With the original catalog, listing inputs and exact package/source
bytes, the command discovers the predecessor journal before choosing a beta
identity. Recovery queries its original status and verifies stable artifacts,
returning receipt-v2 `operation: "reconcile_legacy_publish"`, `channel: "stable"`,
`batch_id: null` and unchanged packages/sources. It cannot start a beta release
or replay the old publication. Unknown or unfinished outcomes remain blocked.
See [legacy journal recovery](../support/marketplace/OPERATIONS.md#legacy-marketplace-publication-recovery)
for custom journal commands and private-artifact access.

### 6. Promote The Exact Tested Beta Set To Stable

After qualifying the published beta, select explicit app IDs:

```sh
npm run updates:promote -- kernel wallet
npm run updates:promote -- kernel wallet --execute
npm run updates:promote -- kernel wallet --execute
```

The first command performs remote reads and saves a local journal containing
the exact current beta candidates, versions, package/source identities, and
expected stable/beta revisions. Review that selection. `--execute` consumes the
same selection in one atomic promotion; it does not rebuild, upload, change
package bytes, or bump versions. Include compatible dependencies in the same
promotion when they are not already stable. The installer still compiles the
complete target actor against actual installed apps and managed-memory state.

A replacement beta conflicts with an uncommitted selection; it is never
silently substituted. After an uncertain reply, repeat the same command and
journal to reconcile the original receipt before selecting anything else.
Retries cannot replay an older mutation or downgrade stable. Use `--refresh`
without `--execute` to prepare a later beta only after the prior outcome is
verified, the protocol definitively rejected it without commit, or the old
review was never executed. A transport failure does not establish rejection.

The second execution must return receipt-v2 `batch_id: null`,
`operation: "promote"`, `channel: "stable"`, and every package/source `unchanged`
with matching exact identities. A changed first promotion reports packages as
`promoted`; offered-source bytes remain `unchanged`. See
[Marketplace Operations](../support/marketplace/OPERATIONS.md#stable-promotion)
for journal configuration and recovery.

### 7. Optionally Stage The Dispenser Starter

When future newly dispensed Neutrons need the new stable set, first publish and
promote those exact package bytes and update
`support/dispenser/starter-packages.json`, then:

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

Sources expose fixed repository paths. The v1 release path is always the
stable-only projection, with its existing closed JSON schema:

```text
/repo/v1/releases/<app-id>.json
/repo/v1/channels/beta/releases/<app-id>.json
/repo/v1/channels.json
/repo/v1/channels/apps/<app-id>.json
/repo/v1/channels/manifests/<manifest-id>.json
/repo/v1/packages/<sha256>.neutron
/repo/v1/sources/<sha256>.source.v1.msgpack.gz
```

`packages/neutron-tools/src/repository.ts` owns the closed release record,
version validation, limits, and path builders. A release binds app ID, packed
version, package digest, and length. The client derives the download path from
the digest; the publisher cannot inject an arbitrary package URL. Channel
descriptor, head and setup-selection formats are separate versioned contracts
in `packages/neutron-tools/src/release_channels.ts`. They bind the actual source,
channel revisions, exact candidate/package set, and manifest digest. Stable setup
retains its v1 manifest; beta setup uses `neutron-repo-channel-manifest-v1` with
required `channel: "beta"`, so older closed v1 parsers reject beta setup links.
Successor Kernels also require the certified channel-selection evidence. See
[Release Channels](../support/marketplace/spec/release-channels.md).

Each channel head is a mutable release pointer. Digest-addressed objects
cannot change bytes under an existing identity, but retention is source
specific: the legacy asset source retains older objects while Marketplace may
retire superseded unreferenced bytes. Do not promise every previous version
remains downloadable.

## Checks, Privacy, And Certification

**Settings → Advanced users → Beta updates** is a Neutron-wide,
owner-controlled preference, off by default. It governs Settings updates and
Marketplace discovery and new installs. Stable mode excludes beta-only apps;
beta mode selects the newest eligible stable or beta head, using stable for
identical versions and bytes. Turning it off keeps installed packages and
memory. An installed beta ahead of stable shows **Ahead of stable — waiting for
a stable release** and offers no downgrade. Promotion of those same bytes makes
that installation current without reinstallation.

Settings checks on entry and explicit refresh. It groups installed apps by
source and fetches their fixed release paths and required channel metadata in
bounded waves, without fetching the source's complete catalog or starting
background update polling.
Exact wave sizes, timeouts, and byte limits live in `apps/kernel/src/updates/`.
Sources can still observe app IDs, request timing, Origin, and network metadata;
per-app queries are inventory minimization, not anonymity.

Release records use public GETs from the fixed non-raw canister origin with
CORS, no ambient credentials, no referrer, and rejected redirects. Channel
metadata can use anonymous certified Candid queries. Discovery does not send
installed versions or user principals. Body limits, exact URLs, media types,
and cancellation are checked before release data is accepted.

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
do not conflate its checks with the browser exception. New channel evidence
requires full source-authenticated certification and cannot use that exception.

Repository setup negotiates the optional fixed `repo_channel_metadata` query.
A production node's verified method-not-found rejection (`error_code: IC0536`,
`reject_code: 5`) establishes legacy method absence; a generic rejection,
transport error, malformed reply, or failed proof does not. An older repository
which supplies certified v1 Candid reads can still load setup without HTTP
channel endpoints. Once channel support is confirmed, missing or invalid
descriptor, head, or selection evidence fails the request without legacy
fallback. Certified absence is distinct from a failed read.

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
or installed baseline invalidates it. Channel-aware setup verifies a certified
selection snapshot against the complete manifest and current per-app heads;
unrelated app publications do not invalidate it through a global revision.

The shared setup/update session seals the prepared package set and compiled
result under one operation mutex. Setup admits absent app IDs; update admits
installed IDs. Deployment must use that reviewed set and matching provenance,
not a freshly selected alternative. Reused compilation and transport remain
bound to exact input bytes, and approval rechecks the installed baseline.
The prepared review also binds the durable release-preference revision.
Changing the preference invalidates pending checks and prepared approvals;
admission rechecks it before dispatch, including changes from another device.
Already-dispatched work reconciles through its existing journal.

The Kernel creates the complete deployment record before approval, reviews the
combined result, stages registry/assets/capabilities/memory/provenance and the
same record, activates the exact assembled actor, then commits atomically.
Preparation failure starts no deployment. An ambiguous deployment outcome is
resolved through the checked journal and running identity; it is not evidence
that nothing changed. See
[License And Deployment Records](./license-and-deployment-records.md#pre-dispatch-review-and-atomic-commit).

The source advertises its current channel heads. It does not calculate migrations
or supply intermediate packages. Every target package must contain its complete
supported immutable schema/migration lineage. Missing or ambiguous paths reject
the whole batch; skipping app versions is safe only when the latest package is
self-sufficient for the installed memory baseline.

## Provenance And Local Source Fixtures

Successful installs atomically write `/system/install-provenance.json` with the
acquisition kind, accepted release channel where applicable, and exact
package/release identities. Source location is not a publisher signature,
endorsement, or capability grant. Manual installs
retain their outer-package digest so equal-version source equivocation can be
detected. Provenance is public metadata and must not contain owner credentials,
private tokens, or controller identities. Release preferences govern repository
selection; an owner can still deliberately import a local package or URL through
manual review. Package bytes do not intrinsically encode channel membership.

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
