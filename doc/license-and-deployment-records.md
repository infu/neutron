# License And Deployment Records

Use this document when changing package metadata, install review, deployment
records, or integrity inspection. The governing license texts and notices are
selected by [LICENSES.md](../LICENSES.md) and the package's own metadata; a
record parser is not a license authority. Follow
[App Package Updates](./package-updates.md) for production release operations.

Package and deployment identities describe different objects. Each package has
its own archive, license, source offer, and package-information record. The
ordered Kernel-plus-app compilation produces one actor and one installed
canister module hash. Do not assign an installed module hash to an individual
app or infer package provenance from the whole-canister hash alone.

## Source Authorities

- `packages/neutron-tools/src/package_record.ts`: package-information types,
  closed parsing, source paths, and resource bounds.
- `packages/neutron-scripts/src/package_metadata.ts`: ordinary-app metadata
  generation and source packaging.
- `apps/kernel/generate_package_metadata.ts`: Kernel license/source generation
  and immutable released-source checks.
- `packages/neutron-compiler/src/deployment_record.ts`: deployment-record
  schema, canonicalization, and in-product install transport.
- `packages/neutron-compiler/src/install.ts`: archive verification, required
  record transition, checked staging, and commit.
- `apps/kernel/src/settings/installed_package_record.ts` and
  `apps/kernel/src/settings/deployment_build_record.ts`: installed inspection.

Read exported types and bounds instead of copying field inventories, numeric
limits, release versions, or artifact hashes into this guide.

## Package Information Record V1

The archive path is `legal/package-record.v1.json`. Preparation maps it to
`/pkg/legal/package-record.v1.json` for the Kernel and
`/app/<id>/pkg/legal/package-record.v1.json` for an ordinary app. This sidecar
is separate from the manifest and does not add a legal registry field.

A present record binds the exact manifest, governing license texts, notices,
dependencies, managed-memory lock identity, declared source offer, and build
inputs. It is closed, bounded UTF-8 JSON. Preparation rejects malformed or
duplicate fields, unsafe paths, inconsistent identities, and digest/length
mismatches. Embedded source is decoded under shared bounds and checked against
its declared package identity and build inputs. Do not weaken this to a
best-effort metadata parse.

A legacy package without the sidecar remains valid if it does not use reserved
archive-only features. Absence means **legacy / not declared by package**;
a present malformed record fails preparation and must not become a legacy
record. Do not infer license or source terms from the app ID, publisher,
repository, or update-source canister. A factual source status is a package
claim, not a conclusion that the package satisfies its license obligations.

Generate metadata through the workspace package command. New ordinary apps use
the default license and shared notice/source workflow required by `AGENTS.md`;
explicit alternative licenses must be documented. The current Kernel generator
emits NPL metadata and a hosted source artifact. Previously conveyed GPL and
NSAL releases retain their exact terms. Never relabel immutable historical
archives or reuse a released version with different license/package bytes.

## Provider-Hosted Source And Optional Embedded Source

The production-compatible form installs governing license and notice files
under ordinary `legal/**` paths. Complete source stays outside the package's
static assets: the generator retains the exact gzip object at
`apps/<app>/.neutron/sources/<sha256>.source.v1.msgpack.gz`, and the sidecar binds
its canonical certified update-source URL, compressed length, digest, and
revision. This form has no archive-only feature marker.

Package preparation verifies the sidecar but does not fetch a hosted source
offer. Publication separately resolves the offer to the generated local
artifact, checks its exact compressed bytes, boundedly decodes its source
snapshot, and verifies package identity and declared build inputs. Preserve
that exact artifact through publication and recovery; do not substitute a
recompressed equivalent.

The optional embedded form reserves `legal/archive-only/**` and
`legal/source/app-source.v1.msgpack`. Both manifest and record must declare
`archive-only-legal-v1`. An aware installer verifies those bytes from the
archive and omits them from public asset staging; the original archive is the
retained copy. Older closed-schema installers reject the feature. Do not use
this form for a release that must be prepared by such a predecessor.

Digest-addressed source identity does not promise indefinite server retention.
The legacy asset source retains old objects; Marketplace may retire
superseded unreferenced package/source bytes while retaining ownership and
audit history. Keep exact local release artifacts needed for supported
compatibility tests and recovery.

## Installed Inspection And Lazy Verification

Settings validates each installed record independently, fetches its referenced
manifest, and binds the result to the committed app registry. One unavailable
or malformed record must not hide other packages or be displayed as verified.

License/notice verification is explicit. Material omitted by archive-only
staging is identified as retained in the original archive, not as an installed
asset. Rendering Settings does not fetch HTTPS source offers.

A user-initiated source download checks the exact URL, bounded body, identity
HTTP encoding, declared length, and SHA-256 before producing an inert Blob
download. Ambient browser credentials and redirects are excluded. Private
repository offers can use the generic reviewed source-access flow, including
an exact-path bearer grant; do not describe every source download as anonymous.
See `apps/kernel/src/repository_access/client.ts` for grant ownership,
request-bound certification, cost review, and retry handling. An exposed direct
external link is not verified source evidence.

Installed package metadata is public. Never put credentials, owner/controller
principals, private repository locations, local absolute paths, installation
UIDs, origin nonces, or unrelated user data into it.

## Deployment Build Record V1

The public certified asset is `/system/deployment-build-record.json`. Its
closed schema distinguishes `complete`, created before dispatch from exact
compiler/install inputs, from `legacy_observed`, containing only actually
observed facts and explicit unavailable fields. Neither state may invent
missing archive bytes, earlier diagnostics, or prior installation inputs.

A complete record binds the ordered target package set, retained-package
identities where available, dependencies, compiler/assembler inputs, previous
and target inventories, diagnostics, migration/removal plan, installation
parameters, and raw/transport Wasm identities. New archives are rechecked
against the supplied bytes. Retained legacy packages explicitly record which
facts are unavailable.

The record is technical review and recovery evidence. Do not turn its
availability or a live hash match into an additional user-facing license gate.
Its public content deliberately excludes raw install arguments, credentials,
authorizations, controller lists, origin nonces, and installation UIDs. Only
bounded allowed facts and the install-argument length/digest are retained.

## Pre-Dispatch Review And Atomic Commit

For a record-capable in-product operation:

1. Read a consistency-fenced installed baseline and aligned prior evidence.
2. Verify supplied packages, resolve the complete final set, compile, and
   prepare the exact install transport.
3. Create the canonical complete record and expose it for inspection before
   approval or install-code dispatch.
4. Re-derive and validate the reviewed facts at deployment. Changed inputs or
   inconsistent records fail before upload/staging.
5. Stage the same record with runtime, registry, assets, capabilities, memory,
   and provenance in the checked deployment transaction.
6. Commit and certify the record only with the expected running actor and the
   rest of that deployment. On failure, reconcile the journal; do not invent a
   successful record or replace the operation with a reinstall.

This applies to file/URL installs, repository and source updates, and removals.
Automatically selected dependencies belong in the same record. Route-specific
review UI must not generate the record only after approval or dispatch.

The immutable compatibility threshold is Kernel packed version `307`: the
shared deploy boundary requires a complete matching record when that or a
later Kernel is already installed. An older predecessor or a fresh provisioning
path can legitimately lack it. A direct upgrade performed by an older frontend
cannot retroactively create pre-dispatch evidence; do not force an intermediate
Kernel merely to manufacture that history.

Settings checks the installed record against the current canister, deployment,
compiler/assembler, and app/memory inventory. Missing, malformed, unreadable,
stale, runtime-inconsistent, hash-match, and hash-mismatch results remain
separate states.

## Raw, Transport, And Live Module Hashes

Keep these identities separate:

- Raw actor Wasm is the compiler output for the complete actor.
- Install transport is the exact byte sequence passed as the installation
  `wasm_module`, including compression where applicable.
- Live `module_hash` is read from certificate-verified IC state or an
  authorized controller status call and compared with that submitted transport.

The in-product deployment-record helper returns the exact transport bytes and
its encoder identity together. Inline and chunked installation must dispatch
those same bytes. Read the encoder contract from the helper; do not recompress
with another library. Fresh provisioning uses its own artifact preparation
path, so an in-product compression identity must not be assumed for a
Dispenser starter.

One canister has one live module hash. A raw digest, package archive digest,
source digest, or record digest cannot substitute for the transport hash.
Missing or stale evidence must not be shown as a match. See
[Verify Source, Build Artifacts, and Live Canisters](./how_to_verify.md).

## Historical Compatibility And Release Evidence

Released archives, fixture identity records, schemas, migrations, and memory
lock lineage are immutable evidence. Preserve their original license terms and
bytes. In particular, the historical GPL-only v0.3.7 bridge remains a distinct
artifact; the current NPL generator must not relabel or reproduce it under the
same release version. Its absence of complete source is not a template for
current package metadata.

Use the predecessor fixtures and gates in
`packages/neutron-compiler/test/legacy_kernel_upgrade*` and
`packages/neutron-compiler/test/legacy_https_package_compat.test.ts` to discover
the supported lanes and exact pinned inputs. Synthetic parser/compiler
fixtures are not proof that the intended production archives were qualified.
Read the opt-in conditions before reporting a release-artifact gate as run.

For a supported successor release, verify the exact final package set with the
archived predecessor frontend/compiler and a state-preserving install. Record
representative app data, managed-memory inventory, authorizations, controllers,
capability state, provenance, and journal state before and after. Clean
initialization is additional evidence and cannot replace predecessor migration
coverage. Repeat qualification when any bound candidate bytes change; do not
copy a previous receipt's status or hashes into this document as current proof.

Publish a compatible Kernel successor and app set atomically when they are
intended for one **Upgrade all** action. Older frontends must be able to prepare
the complete set before any Kernel replacement occurs. Do not introduce a
Kernel-first publication window. If a deployment reply is ambiguous, reconcile
the checked journal and running identity using the original bytes.
