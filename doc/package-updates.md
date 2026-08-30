# App Package Updates

[Back to the documentation index](./index.md).

Neutron exposes application updates in the **Installed Apps** table and uses
the same `.neutron` package, validation, compiler, permission review,
managed-memory planner, checked deployment journal, and atomic asset commit
used by ordinary installation. Opening Settings checks update sources, and the
global Settings refresh checks them again. There is no standalone updates
section, background polling, automatic installation, or second package format.
The owner may update one row, select an exact subset with **Update selected**,
or use **Upgrade all** with no row selection to review and install every
verified available release as one batch.

## Maintainer Release Workflow

This is the single repository guide for changing an app, bumping its version,
building its `.neutron` archive, and publishing that archive to an update
source. Other documents describe package internals or deployment architecture
and link here instead of repeating these commands.

Before starting a production publication, ensure the repository dependencies
are installed and `.neutron/update-source-publisher.json` exists with mode
`0600` and the source's Commit-only authority. If publisher configuration,
rotation, recovery, or monitoring is needed, stop and use the
[update-source operator reference](../support/update-source/README.md).

### 1. Change The App And Bump Its Version

Change the app source, then increment `version` in the app's source
`neutron.json`. Versions use:

~~~text
major * 10000 + minor * 100 + patch
~~~

For example, `301` is `0.3.1`, `302` is `0.3.2`, and `401` is `0.4.1`.
The generated archive name follows the same value:
`<id>.v<major>.<minor>.<patch>.neutron`.
Minor and patch are restricted to `0..99`; major is bounded only by the packed
safe-integer representation, and the first supported release is `0.1.0`
(`100`). App release versions are independent of managed-memory schema
versions. There is no repository bump command: edit
`apps/<directory>/neutron.json`, not the workspace `package.json`.

For a production-discoverable update, the manifest must keep the production
source:

~~~json
{
  "update_source": "233tv-xiaaa-aaaay-aacta-cai"
}
~~~

Also update app-local assertions or documentation that name the old packed
version or archive. Never reuse a packed version for different bytes. The
source publisher rejects equal-version/different-digest publication.

### 2. Build The Authoritative Package

Run the app workspace's normal package command from the repository root:

~~~sh
npm --workspace <app-workspace-name> run package
~~~

The workspace name is the `name` in `apps/<directory>/package.json`. It can be
read without guessing:

~~~sh
node -p "require('./apps/<directory>/package.json').name"
~~~

Use the app's complete `package` script rather than invoking `pack.ts`
directly. Apps may add required schema, memory, or release-evidence steps
around the common build. A failed package command is a release blocker;
do not publish a partially produced archive.

The package script does not necessarily run the app's complete unit,
integration, Motoko, or E2E suite. Run and record the tests required by the
app's release policy separately; the source publisher does not run them.

Files deliberately keeps its Playwright worker check out of `package`. Run
`npm --workspace neutron-vfs run release:browser` separately when qualifying a
Files release. The command is pass/fail, writes no browser-evidence artifact,
and does not supply an input to the package command.

When several apps change, package each changed workspace before publication.
The resulting actor code is target-neutral, but the archive still embeds
manifest policy such as `update_source`. The update source, local provisioning
configs, and the Dispenser use the same exact archive bytes when their
respective selections pin that archive.

Production apps with `update_source` use a legacy-readable package envelope.
Their governing license and notices use ordinary `legal/**` paths, their source
record identifies a provider-hosted HTTPS offer, and their packaged manifest
and record contain no archive-only feature marker. Packaging writes the exact
generator-produced source gzip object outside `dist` at:

~~~text
apps/<directory>/.neutron/sources/<sha256>.source.v1.msgpack.gz
~~~

Keep that generated artifact with the prepared `.neutron` archive through
publication and postflight. The catalog publisher verifies it and supplies it
to the update source; app authors and users do not upload source separately.

This envelope is intentionally readable by immutable production Kernel v0.3.5
and v0.3.6 and by the compatible private v0.3.7 candidate. A compatible
successor Kernel and all app updates can therefore be published together and
installed with one **Upgrade all** action. Do not introduce a Kernel-first
publication phase or a timing window. Explicit embedded-source packages still
use `package_features: ["archive-only-legal-v1"]`; they are not eligible for
this legacy-to-current simultaneous production cutover.

### 3. Keep Tracked Archive References Coherent

The package command retains older local archives for that app as immutable
upgrade and release-history evidence. Search for old filename references
before publishing so active consumers move to the intended new archive while
historical consumers remain pinned:

~~~sh
rg -n '<id>\.v<old-version>\.neutron' \
  --glob '!node_modules/**' \
  --glob '!*.tsbuildinfo'
~~~

Review each match rather than rewriting history. Update active path-only local
deployment configs only when they should use the new package. Do not rewrite
immutable historical receipts, completed sessions, or release evidence.
Where an active production config intentionally pins an artifact, update its
path, packed version, byte length, and SHA-256 from the actual new archive:

~~~sh
stat -c '%s %n' apps/<directory>/<archive>.neutron
sha256sum apps/<directory>/<archive>.neutron
~~~

Updating local deployment configs is not required for source publication.
If future Dispenser-created Neutrons should start with this version, separately
update `support/dispenser/starter-packages.json`. That file is the tracked
input for the next starter, not proof of the currently committed live starter.
Editing it does not change the live Dispenser; staging it is the optional final
step below.

`support/update-source/release-catalog.json` deliberately contains app IDs and
directories, not copied versions or digests. The publisher derives those from
each source manifest and archive, so a normal version bump does not edit the
catalog.

### 4. Publish To The Production Source

The normal production command is:

~~~sh
npm run updates:publish
~~~

It reads the production catalog, validates every current manifest/archive pair,
and resolves every HTTPS source offer to the exact app-local source artifact.
For each offered source it verifies the compressed length and digest, bounded
gunzip and closed source snapshot, package identity, and declared build inputs.
It does not require recompression by another zlib runtime to reproduce the
artifact byte for byte. It then atomically publishes missing digest-addressed
source objects, missing digest-addressed packages, and changed release pointers.
Packages and source objects already present with the same identities are
verified no-ops, so this command is safe when only a subset changed. It also
requires every catalog manifest and archive to name the catalog's production
source and every hosted-source URL to name that source's canonical certified
origin. Use this wrapper for routine SushiOS production releases.
The lower-level generic publisher is reserved for deliberately operated
non-catalog sources; it does not prove that an archive's manifest
`update_source` equals its `--canister-id`.

The command prints a `neutron-update-source-publish-v2` JSON receipt. A changed
release has a non-null `batch_id` and `status: "published"`. Each package row
also reports its source URL, path, size, digest, and `published` or `unchanged`
status, or `source: null` when that package makes no HTTPS offer. Keep that
receipt with the exact package and source artifacts.
Publication changes the source used by Settings upgrades; it does not install
the package into existing Neutrons or alter the Dispenser starter.
The publisher does not build apps or run their tests, has no dry-run or
interactive confirmation, and does not serialize multiple operators. Review
the catalog and prepared archives before invoking it, and run only one
production publisher at a time.

### 5. Verify The Source

Run the same publication command one more time. The required idempotent
postflight result is:

- `batch_id: null`;
- every selected package has `status: "unchanged"`; and
- each reported version, size, and SHA-256 matches the local archive; and
- every reported source has `status: "unchanged"` and matching URL, path, size,
  and SHA-256.

The publisher performs certified HTTP verification of every public release,
package, and offered source during both the publish and no-op runs. A second ad
hoc upload or a controller call is not a verification step.

If the first command loses its response after a possible commit, do not rebuild,
regenerate source, or bump again. Rerun the same command against the exact same
archive and source-artifact bytes. The publisher reconciles an already-committed
identical release as a verified no-op and rejects conflicting or missing bytes.

### 6. Optionally Update The Dispenser Starter

Do this only when newly created production Neutrons should receive the new
versions immediately. First publish the same exact package bytes to the
production source and update `support/dispenser/starter-packages.json`. Then
stage the starter exactly once:

~~~sh
npm --workspace dispenser run production:starter:set
~~~

For the local Dispenser, the equivalent command is:

~~~sh
npm --workspace dispenser run starter:set
~~~

The uploader compiles the complete selected set once, stages it, and commits a
new starter revision atomically. It affects only Neutrons created afterward.
Do not rerun the production staging command merely to verify it, because an
identical upload still creates a needless revision. Read the committed
production starter instead:

~~~sh
icp canister call -n ic --identity dispenser-mainnet \
  2o4cy-waaaa-aaaay-aacqq-cai starter '()' --query
~~~

Confirm the new revision, deployment ID, ordered package IDs, Wasm size, and
Wasm digest against `.neutron/dispenser-production.json`.

### Release Checklist

- app behavior is complete;
- source `neutron.json` has a strictly newer packed version;
- the full app `package` command completed;
- the new archive's path, size, digest, ID, and version agree;
- every HTTPS source offer has its exact app-local generated gzip artifact;
- active tracked archive references point to the intended archive while
  immutable historical references remain unchanged;
- one atomic source publication committed all intended source objects, packages,
  and release pointers;
- the repeated publication was a verified package-and-source no-op;
- the Dispenser starter was staged once only if future Neutrons need it.

## Manifest Contract

An app may name one update-source canister:

~~~json
{
  "id": "mail",
  "version": 102,
  "update_source": "233tv-xiaaa-aaaay-aacta-cai"
}
~~~

**update_source** is optional. Its value must be a canonical IC principal and
cannot be anonymous or the management canister. The normalized value is
persisted in the committed app registry, so Settings does not reopen every
installed package merely to group update checks.

Omitting the field means manual updates only. A newer package may add, remove,
or change the source, but Settings shows that change in the combined review and
it becomes active only if the deployment commits.

The source is committed package state, not a kernel-wide default. An app that
was installed before its package added `update_source` remains **Manual** even
after the Kernel itself is updated. That installation needs one owner-reviewed
manual update to a newer source-bearing package. After that one-time migration,
future releases can be discovered from Settings. SushiOS instances provisioned
from the current production starter already contain source-bearing packages.

App versions keep the packed semantic representation:

~~~text
major * 10000 + minor * 100 + patch
~~~

Minor and patch are between 0 and 99; major is bounded by the packed
safe-integer representation. An update target must be strictly newer than the
installed app.

## Certified Repository Paths

Update sources share these repository v1 paths:

~~~text
/repo/v1/releases/<app-id>.json
/repo/v1/packages/<sha256>.neutron
/repo/v1/sources/<sha256>.source.v1.msgpack.gz
~~~

The release path contains one small closed JSON record:

~~~json
{
  "protocol": "neutron-repo-v1",
  "id": "mail",
  "version": 102,
  "sha256": "64 lowercase hexadecimal characters",
  "size": 123456
}
~~~

The shared neutron-tools repository module owns release parsing,
serialization, validation, and both path builders. Records are limited to 16
KiB and reject duplicate or unknown JSON fields, malformed app IDs, invalid
versions, noncanonical digests, zero or excessive sizes, and unsafe numbers.
The package path is derived from the digest; a source cannot supply an
arbitrary download URL.

Release records are mutable latest-version pointers. Digest-addressed packages
and any Complete App Source objects offered by their package-information record
are immutable and retained when a newer pointer is published. The source
object's digest and size cover the exact generator-produced gzip bytes.

## Why Checks Use Per-App Assets

Settings groups installed apps by source and treats each source as one logical
check. Within that job it makes one certified HTTP GET for the fixed release
asset of each installed app ID that names that source. IDs are sorted and
processed in waves of at most 20.

This permits one source canister to host hundreds of unrelated apps without
making Neutron download or reveal a complete catalog. A Neutron with 57 apps
from one source makes waves of 20, 20, and 17 requests; it never fetches the
source's other records.

A dynamic query containing an arbitrary list of IDs is not used. Arbitrary ID
combinations do not map cleanly to standard static HTTP certification and cache
keys without a custom proof protocol. Fixed per-app assets retain ordinary
gateway-verified response certification, independent cache revalidation, and a
much smaller trusted client.

## Check Privacy And Transport

Checks occur when an authorized user opens Settings and whenever that user
selects the global **Refresh settings** action. Neutron does not contact update
sources during ordinary shell startup, app launch, installation, or a timer.

Release and package requests:

- use a fixed verified canister origin from canisterOrigin;
- never use a raw gateway or publisher-supplied host;
- use GET with CORS, omitted credentials, no referrer, and redirect rejection;
- contain no installed version, principal, cookie, authorization header, or
  request body;
- enforce exact final URLs, content types, identity package encoding, timeouts,
  cancellation, declared and streamed body limits;
- revalidate release JSON and permit normal immutable caching for digest paths.

The fixed, non-raw ICP HTTP gateway is the browser's certification boundary: it
cryptographically verifies the canister response before returning it, and an
invalid proof does not become a successful application response. Browser CORS
processing can hide both `IC-Certificate` and `IC-CertificateExpression` from
JavaScript even when the gateway verified them. The client therefore accepts
their joint absence only on the fixed verified origin. If either header is
visible, it requires the complete response-certification v2 envelope and
rejects an incomplete or `no_certification` expression. The server-side
publisher sees and requires the complete envelope during its public preflight
and post-commit verification. Raw domains are never accepted.

The checker maps a usable gateway-verified `404` to **Not published**. The
standard asset canister used by the reference source does not certify an
arbitrary absent-path `404`; a verifying gateway rejects that response before
the browser receives a usable `404`. Consequently, an absent release path on
the reference source normally appears as **Check failed**, while a source that
can produce a verified `404` uses **Not published**. This distinction is
fail-closed and does not turn an uncertified absence into trusted state.

This minimizes inventory disclosure but is not anonymity. A source and network
infrastructure can observe requested app IDs, timing, Origin, and ordinary
network metadata.

The browser maps each result independently into its Installed Apps row as **Up
to date**, **Update**, **Not published**, **Source behind**, or **Check
failed**. Eligible rows show a spinner while their request is checking. One
unavailable record does not discard successful results from that source or
another source. A later Settings refresh retries failed or regressed app IDs.

The checker seeds a canonically ordered row for every installed app, changes a
row from Queued to Checking as its wave starts, and replaces that row in place
when the result settles. It never reorders rows under the pointer. A new check,
cancellation, Settings unmount, or registry change aborts the old generation;
late completions cannot publish state.

## Package Preparation

When the owner selects an app row's **Update** action, **Update selected**, or
the Installed Apps **Upgrade all** action, Neutron:

1. freezes the requested row, selected verified rows, or every successfully
   verified **Update** row;
2. re-fetches each release record immediately before preparation;
3. requires the exact app ID, version, size, package digest, and release-record
   digest observed during the check;
4. downloads each digest-addressed package through the bounded update client;
5. verifies exact bytes and SHA-256;
6. passes those expectations to preparePackageInstall;
7. validates each authoritative inner manifest and source change;
8. computes every installed-to-target capability-plan diff.

A changed record, changed installed baseline, wrong inner identity, excessive
package, malformed archive, or capability-plan mismatch invalidates the
attempt. Neutron never silently removes the failed app and continues with a
different batch.

The current Settings UI supports one row, an exact selected subset, or all
verified available rows. Selected rows without an available release remain
selected for other Settings actions but are excluded from **Update selected**.
Failed, unpublished, regressed, and manual-only rows are also excluded from
**Upgrade all** and remain visible for the owner to resolve. The shared
preparation boundary remains defensively bounded to 64 packages and 64 MiB of
advertised package bytes. Archive-entry, decoded-byte, generated-copy, and
compiler limits are enforced across the complete prepared set rather than
reset per package.

Because preparation happens for the complete set before any deployment starts,
the production compatibility rule applies to the whole latest set. The normal
provider-hosted app envelope is readable by immutable production v0.3.5 and
v0.3.6 and the compatible private v0.3.7 candidate, so one batch may contain
both their state-compatible Kernel successor and current app releases. There is
no hidden Kernel-first install, reload, version picker, or timing window.

## Atomic Update Deployment

The package install session has separate setup and update policies while
retaining one authenticated operation mutex and baseline fingerprint. Setup
mode permits only absent app IDs; update mode permits only installed app IDs.
The session seals the exact prepared file digests and compiled result, then
requires deployment to provide the same package set and exactly one provenance
entry per package. Trusted frontend callers cannot accidentally compile one
set and stage another.

For the selected update set, the kernel:

1. prepares every selected package;
2. resolves dependencies against the proposed final app set;
3. compiles all packages once;
4. builds every managed-memory migration path;
5. creates the complete `/system/deployment-build-record.json` and exact
   deterministic gzip transport;
6. shows one combined review with the canonical record available before
   approval or install-code dispatch;
7. revalidates that reviewed record and records one checked deployment journal;
8. stages the same record with runtime, app assets, registry, capabilities,
   memory, source metadata, and provenance;
9. activates the exact recorded combined Wasm and verifies runtime identity;
10. commits the staged assets together.

If preparation or compilation fails, no deployment begins. Once deployment
begins, the existing checked journal and recovery path remain authoritative.
The final state is the reviewed app set, not a partially applied replacement.

The review includes installed and target versions, source canister, package
size and digest, package-information identity, exact capability changes, target
access categories, dependencies, future source changes, compiler diagnostics,
the managed-memory plan, and the whole-deployment raw/transport identities.
The canonical deployment record is copyable/downloadable before dispatch.
Browser confirmation modals and sandboxed form submission are not used.

Settings distinguishes these boundaries. A check failure says the sources
could not be checked. A preparation failure says no updates were applied. A
deployment failure does not guess whether activation committed; it points at
the checked-journal recovery state and requires a fresh check before another
batch can be prepared.

## Skipped Releases And Managed Memory

The source advertises only its latest package. It does not calculate migrations
and Neutron does not download intermediate app releases merely to migrate
memory.

The target package must carry the complete immutable schema and migration
lineage required by planMemoryMigrations. For example, updating directly from
memory v1 to v3 requires an unambiguous v1-to-v2 and v2-to-v3 path in the v3
package. Missing, ambiguous, cyclic, backward, or incompatible paths reject the
entire update batch.

This is independent of app release numbers. Skipping app versions is safe only
when the newest package remains self-sufficient for every supported installed
memory baseline.

## Provenance

Successful source updates atomically write a certified provenance record in
`/system/install-provenance.json`. That path is publicly readable package
integrity metadata; it must not contain private credentials, owner identities,
or controller principals:

~~~json
{
  "kind": "update_source",
  "source_canister": "233tv-xiaaa-aaaay-aacta-cai",
  "release_digest": "<sha256 of accepted release JSON>",
  "package_digest": "<sha256 of exact package bytes>",
  "checked_at": 1700000000000
}
~~~

Provenance records observed bytes and location. It is not a publisher
signature, endorsement, or capability grant. File and URL installs retain a
closed `manual` provenance record containing the acquisition kind and exact
outer-package digest; this lets an equal-version source record be checked for
equivocation instead of being trusted without evidence. A source update
replaces that record in the same deployment transaction.

The fixed `legal/package-record.v1.json` package-information sidecar and the
single `/system/deployment-build-record.json` deployment record are documented
in [License And Deployment Records](./license-and-deployment-records.md). They
do not change this update-source release format. The retrieved archive digest
binds all sidecar bytes; the record-capable Kernel prepares and exposes the
whole-deployment record before dispatch and stages the same canonical record in
the checked install transaction.

## Reference Update Source

The support/update-source directory is the reference developer-owned source.
It deploys DFINITY's standard asset canister rather than a custom HTTP/upload
backend, and therefore inherits certified HTTP assets, streaming, ETags,
chunked Candid uploads, atomic commit_batch, and asset permission roles. Its
production definition pins SDK `0.32.0` `assetstorage.wasm.gz` at SHA-256
`04e565b3425fe7510ee16b02adcfe3f01abc9a2725c82a21cb08969241debd62`
and the `migration-v2.2.1-6b48585` sync plugin at SHA-256
`ca7cb5666c30d2875f8d5e10535f8a53f97a86c79c263f7d5bdac2fdd1bbf83c`.
The definition does not follow a mutable `releases/latest` artifact. For the
fixed PocketIC profile, a format-3 config's `serve` operation installs or
reuses one provision-owned asset canister, synchronizes
`support/update-source/assets`, verifies its `/health.txt` certificate headers
and exact seeded bytes, and records its ID in the config-derived session as
`runtime.fixtures.update_source`. It does not use a second manifest or network.

### SushiOS Production Source

The production target is deliberately stable:

| Property | Value |
| --- | --- |
| Canister | `233tv-xiaaa-aaaay-aacta-cai` |
| Verified origin | `https://233tv-xiaaa-aaaay-aacta-cai.icp0.io` |
| Catalog | `support/update-source/release-catalog.json` |
| Default publisher credential | `.neutron/update-source-publisher.json` |
| Asset-canister module SHA-256 | `04e565b3425fe7510ee16b02adcfe3f01abc9a2725c82a21cb08969241debd62` |

Current package membership comes from the catalog and current versions come
from the source manifests. The tracked next-starter selection comes from
`support/dispenser/starter-packages.json`; the live `starter()` query and
production receipt describe the committed starter. Do not copy those changing
values into another documentation table. The publication receipt and live
certified release records are the authority for what is currently published.

The deployment administrator retains controller and ManagePermissions
authority. A separate publishing identity receives exactly Commit; the
configuration scripts refuse to turn that identity into a controller.
Configure, inspect, rotate, and revoke commands are provided.

Publishing uses authenticated direct-agent Candid update calls, never an
`icp` subprocess, public HTTP POST, form, or bearer token. The publisher:

1. validates each .neutron package with the shared bounded installer;
2. derives identity, version, size, and digest from exact bytes;
3. resolves each HTTPS offer to the app-local source artifact and verifies its
   canonical URL, exact compressed-byte digest and size, bounded gunzip, closed
   snapshot, package identity, and declared build inputs;
4. counts package bytes plus each unique source object against the publication
   byte ceiling;
5. reads one paginated Candid metadata snapshot to distinguish definitely
   absent exact paths from paths that require certified HTTP preflight;
6. reads present release, package, and source paths through certified HTTP;
7. rejects downgrade and equal-version/different-digest publication;
8. uploads missing immutable source and package chunks;
9. stages source objects, packages, and release records in one asset batch;
10. commits atomically;
11. re-fetches and verifies every public release, package, and offered source;
12. prints a source-aware v2 machine-readable receipt.

The metadata snapshot is publisher-only control-plane input. It exists because
the stock asset canister cannot serve a gateway-verifiable arbitrary missing
`404`; it is used only to decide whether a fixed path needs a preflight GET.
Listed paths must still pass certified HTTP verification. An absent metadata
entry merely causes an atomic `CreateAsset` attempt, which fails safely if the
snapshot was stale. Neutron update checks never call `list`, never fetch a
catalog, and reveal only their exact installed app IDs through public GETs.

Same-version/same-digest publication is an idempotent verified no-op that also
re-verifies every HTTPS source object. Old packages and source objects are
retained. The reference setup permits one Commit publisher and documents
serialized CI because the asset canister has no publication generation
compare-and-swap.

Production publication targets an explicitly configured update-source
canister. Local deployment does not discover or deploy that production project.
The PocketIC profile owns its fixed local fixture lifecycle:
`npm run provision -- FORMAT3.ndeploy.json serve` synchronizes the fixture and
that config's `reinstall` requires its session-recorded ID, then binds that
canister's origin into `/system/runtime-config.json`. Fixture canisters are not
fields in the format-3 config, and reinstalling Neutron does not recreate the
update-source canister. The tracked `local.ndeploy.json` is a current writable
format-3 config: `local:start` serves or attaches to its supervised runtime,
and `local:deploy` performs its destructive reinstall.

The runtime field is an exact-origin binding, not a transparent alias for the
production principal. The Kernel uses it only when the selected manifest
source principal is the canister in that origin. The provision-owned fixture is
initially seeded only with `/health.txt`; a real local update scenario must
publish release, package, and offered-source assets to that fixture and build
its test package with that fixture principal. A production-pinned manifest does
not silently redirect to a different local canister.

See [the update-source operator README](../support/update-source/README.md) for
source deployment, permissions, identity rotation, generic-source CLI details,
monitoring, and recovery.

## Main Implementation Surface

- packages/neutron-tools/src/schema.ts: manifest source normalization.
- packages/neutron-tools/src/repository.ts: release codec and paths.
- packages/neutron-tools/src/package_record.ts: HTTPS source-offer paths,
  transport limits, and package-information parsing.
- packages/neutron-compiler/src/install.ts: registry persistence and package
  preparation/deployment.
- apps/kernel/src/updates/: bounded check, package client, state, preparation,
  review, and application service.
- apps/kernel/src/reducer/apps.ts: generic setup/update batch session.
- apps/kernel/src/settings/AppUpdatesSection.tsx: the Settings-owned update
  coordinator, per-row results/actions, feedback, and package review.
- apps/kernel/src/repository/provenance.ts: closed source-provenance union.
- support/update-source/: certified source and authorized publisher.

## Verification

The checked-in focused unit and contract tests exercise:

- closed manifest, principal, registry, release-record, duplicate-key, version,
  path, size, and digest validation;
- fixed credentialless request construction and absence of installed versions;
- sorted, deduplicated targeted IDs with exact 20/20/17 wave barriers and
  cross-source isolation;
- usable verified-404 handling, timeout, malformed transport, partial failure,
  regression, and equivocation outcomes;
- exact package size, digest, content type, and encoding;
- Settings-refresh state, per-row availability/action, visible partial failures,
  stale-registry invalidation, preparation bounds, and preparation-failure
  copy;
- publisher roles, atomic asset operations, idempotency, downgrade rejection,
  metadata, first-publication absence discovery without an HTTP 404 preflight,
  bounded source decoding, exact compressed-byte verification, certified HTTP
  verification, and v2 receipts;
- existing compiler multi-package atomicity and direct multi-step
  managed-memory migration planning;
- exact immutable predecessor browser compiler and assembler closures compiling
  the historical private bridge candidate plus the catalog-selected clean
  HTTPS-source app archives in one real-Chromium batch with zero compiler errors
  or compatibility diagnostics, with bridge parser/batch coverage as well;
- one **Upgrade all** service session that prepares, compiles, reviews, and
  deploys the Kernel-plus-app selection together from a v0.3.5 installed
  baseline;
- Playwright discovery, automatic checking on Settings load, keyboard refresh,
  the manual-only Installed Apps row, absence of a separate check control or
  standalone updates section, and narrow-layout containment.

The compatibility and service tests prove legacy parsing, real browser
compilation, and one-batch orchestration; they do not drive each archived
predecessor UI through a live canister deployment and verify durable state
afterward. That manual archived-browser end-to-end gate remains required for
the exact intended successor bytes, and the automated legacy compatibility
suite must be rerun against that exact successor archive once it is built. The
Playwright package-update test covers Settings-triggered check
lifecycle, refresh, row presentation, and the manual-only case. It does not
publish a release into the PocketIC fixture or apply a real update. A full local
fixture publish/read/review/deploy browser scenario remains separate release
evidence and must not be claimed from the checked-in test name alone. Its
`:fresh` wrapper first runs the current `local:deploy` destructive reinstall and
then runs the Internet Identity scenario.

There is currently no tracked evidence-matrix file for this protocol; a former
`todo.packageupdate.md` reference pointed at a file that does not exist. Record
which verification commands were actually completed alongside the change that
makes them relevant.
