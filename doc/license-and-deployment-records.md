# License And Deployment Records

This document describes the implemented package-information and deployment
record contracts introduced with the private Kernel v0.3.7 bridge candidate.
It does not represent v0.3.7 as an NPL release. Version 0.3.7 is deliberately
`GPL-3.0-only`; an NPL release remains a later, separately qualified decision.
The candidate is compatibility evidence and a supported installed predecessor,
not a mandatory production hop between v0.3.5/v0.3.6 and that later release.

The records operate at two different levels:

```text
Kernel package information  \
App package information A    -> one ordered compilation -> one canister Wasm
App package information B   /                              -> one module hash
```

Each package has its own archive, license, source, and package-information
identity. A deployment has one ordered package set, build result, install
transport, and live canister module hash. An installed app never has a
separate installed module hash because all backends and the Kernel are
assembled into one actor.

These are automatic technical integrity, review, and recovery features of the
v0.3.7 implementation. The NPL/NSAL drafts do not require a Sovereign User or
app author to create, sign, publish, register, retain, or audit these records or
hashes, and they do not make a certified live-module match a license condition.
The licenses permit the browser-generated package composition and combined Wasm
to remain private. The current record-capable v0.3.7 product nevertheless makes
its deployment record public after a later in-product install, exposing package
IDs, versions, and integrity identities but not archive bytes or generated Wasm.
That disclosure is optional product behavior, not a license prerequisite.

## Package Information Record V1

The fixed archive path is `legal/package-record.v1.json`. Package preparation
maps it to:

- `/pkg/legal/package-record.v1.json` for the Kernel; or
- `/app/<id>/pkg/legal/package-record.v1.json` for an ordinary app.

This sidecar remains separate from the format-3 manifest and does not create a
legal registry field. A legacy format-3 package without the sidecar remains
valid when it does not use reserved archive-only paths. It is one optional
machine-readable implementation of ordinary package information, not a
hand-authored license form.

For a normal app with `update_source`, the tooling generates the record,
governing license, application notice, complete derived third-party notices,
and Complete App Source gzip artifact automatically. The legal
files use ordinary installable `legal/**` paths. The source artifact is retained
outside `dist` at
`<app>/.neutron/sources/<sha256>.source.v1.msgpack.gz`, and the record identifies
its certified HTTPS URL. This production form has no package or record feature
marker. App authors and Sovereign Users do not hand-write hashes, maintain a
registry, or operate a source host.

The record is closed, bounded UTF-8 JSON with `format: 1` and exactly these
top-level fields:

```text
format
features      optional closed features; archive-only records require archive-only-legal-v1
package       id, version, and the neutron.json path/size/SHA-256
license       governing id and one or more embedded license texts
source        embedded | https | status
dependencies  exact copy of the manifest dependency contract
notices       embedded notice paths/sizes/SHA-256 values
memory        neutron.lock.json identity, or null for no managed memory
build         important source inputs and informational build argv vectors
```

Normal provider-hosted records omit `features`. The optional embedded-source
form contains exactly `features: ["archive-only-legal-v1"]`; its packaged
manifest contains the matching marker. The installer requires both markers
whenever a reserved archive-only path is present and rejects unknown, repeated,
or noncanonical features.

An embedded or HTTPS source offer records a revision, byte length, and SHA-256.
An embedded offer also records a safe package-relative path. A production HTTPS
offer records the canonical certified URL
`https://<update-source>.icp0.io/repo/v1/sources/<sha256>.source.v1.msgpack.gz`.
A factual status record uses one of `not-provided`, `not-required`, or
`unknown`. A status is a package claim, not a license conclusion.

The authoritative parser and bounds are exported from
`packages/neutron-tools/src/package_record.ts`. Important limits include a
64 KiB record, eight license texts of at most 2 MiB each, 64 notices of at most
4 MiB each, an encoded source snapshot of at most 16 MiB, and a generated gzip
transport of at most 17 MiB. The snapshot is additionally limited to
8,192 files, 4 KiB per path, 16 MiB per file, and 32 MiB of decoded file bytes.
Paths, text, arrays, dependency declarations, source URLs, build inputs, and
command vectors have their own fixed limits.

During package preparation, a present record is verified against the exact
archive contents. The parser rejects unknown or duplicate fields, unsafe or
reused paths, non-canonical collections, malformed hashes, size mismatches,
private-looking metadata, and inconsistent package identity, dependencies, or
managed-memory presence. Every referenced embedded manifest, license, notice,
source, and memory-lock object must match its declared length and SHA-256. An
embedded app-source snapshot is also decoded under the fixed limits, checked
for exact package identity and sorted unique safe paths, and cross-checked
against every declared build-input path, length, and digest. Package preparation
does not fetch an HTTPS source offer.

Before production publication, the update-source publisher reads the exact
app-local gzip artifact, verifies its compressed length and digest, boundedly
decompresses and decodes the closed source snapshot, checks package identity
and declared build inputs, and requires the record URL to target its configured
certified origin. It does not recompress with the publisher runtime and demand
byte-for-byte equality with runtime-specific zlib output. Publication and its
postflight verify the resulting source asset independently of package
preparation.
The verified outer `.neutron` archive digest and byte length remain a separate
package identity; a record is not asked to contain the digest of the archive
that contains it.

Absence means **legacy / not declared by package**. Neutron does not infer a
license or source offer from an app ID, update source, repository, publisher,
or authorship. A present malformed record is invalid and fails package
preparation; it is never downgraded to legacy.

## Provider-Hosted Source And Optional Embedded Source

The production form places the applicable governing license and derived notice
corpus at ordinary package paths such as:

```text
legal/LICENSE.APP.txt
legal/LICENSE.APP.USE.txt
legal/LICENSE.Apache-2.0.txt
legal/APPLICATION-NOTICE.txt
legal/THIRD_PARTY_NOTICES.md
legal/third-party/<sha256>.txt
legal/package-record.v1.json
```

Only the applicable governing-license path is present. These bounded legal
files are installed as certified package metadata. Complete App Source is not a
package entry: the packager writes its exact generated gzip artifact below the
app-local `.neutron/sources/` directory and the record binds the certified
update-source URL, exact bytes, digest, and revision. The publisher uploads the
source once to its immutable digest path. Every Neutron that installs the app
therefore avoids duplicating source bytes and does not publish anything on the
user's behalf.

The explicit embedded form remains available for a package without an update
source or an author that deliberately selects it. It uses these reserved paths:

```text
legal/archive-only/LICENSE.APP.txt
legal/archive-only/LICENSE.APP.USE.txt
legal/archive-only/LICENSE.Apache-2.0.txt
legal/archive-only/THIRD_PARTY_NOTICES.md
legal/archive-only/third-party/<sha256>.txt
legal/source/app-source.v1.msgpack
```

Package preparation verifies their record-bound bytes and source semantics.
An archive-only-aware installer omits them from static-asset staging, leaving
the original `.neutron` archive as the retained copy. The required marker makes
older closed-schema Kernels reject this optional form safely.

Neither form creates a public-source duty for a person privately building or
installing an app. For the production form, the first-party provider maintains
the source URL; a Sovereign User merely installing, privately assembling, or
running the package need not operate a repository or publish their Neutron.

## Installed Inspection And Lazy Verification

Settings inspects each installed package independently so one corrupt or
temporarily unreadable app record does not hide the others. Initial inspection:

1. reads the record under its 64 KiB ceiling;
2. performs closed structural validation;
3. discovers and fetches only its referenced `neutron.json`;
4. verifies the manifest bytes, ID, version, dependencies, and whether a
   memory-lock record is required; and
5. binds that result to the installed registry row.

For a provider-hosted package, Settings offers later explicit verification of
its installed license and notices, while the source remains an external
declared offer. For the embedded form, Settings labels omitted archive-only
material as retained in the original package and does not claim it remains in
the canister. Installed record objects remain bounded and digest-verifiable.

An HTTPS source offer is never fetched merely to render Settings. In normal
mode, **Download and verify** performs one user-initiated, credential-free,
no-redirect fetch under the shared 17 MiB ceiling; it rejects transforming HTTP
content encoding, verifies the declared compressed length and SHA-256, and only
then starts an inert Blob download. Developer mode may expose the direct
external URL, but explicitly labels it as unverified. Missing, invalid, and
temporarily unavailable records are distinct UI states.

The files that remain installed are public certified package metadata. They must not
contain credentials, owner or controller principals, private repository URLs,
local absolute paths, browser-origin nonces, installation UIDs, or unrelated
User Data.

### One-Click Production Upgrade Compatibility

Production source-discoverable app packages use the provider-hosted form above:
they contain no reserved archive-only paths and no `package_features` or record
feature marker. Their format-3 manifests therefore remain readable by immutable
production v0.3.5 and v0.3.6 Kernels and the compatible private v0.3.7
candidate. A state-compatible successor Kernel and these app updates may be
published in the same atomic catalog publication and selected by one **Upgrade
all** action. The existing frontend prepares the complete selected set before
dispatch, then compiles and installs it as one checked transaction; it does not
need to install the Kernel first, reload, or rely on a rollout window.

The publisher commits each missing source object, package object, and release
pointer in the same asset-canister batch. A source cannot become newly
discoverable without its exact package and source offer, and a user who upgrades
later sees the same compatible latest set. This is the required production
cutover: do not substitute a timed Kernel-first phase.

The exact private `kernel.v0.3.7.neutron` archive still predates archive-only
filtering. Immutable v0.3.5, v0.3.6, and v0.3.7 safely reject an explicitly
embedded package's marker. Such a package requires an already active
archive-only-aware Kernel and is not suitable for this simultaneous production
cutover. Do not rebuild or reuse version 307, and do not treat the working-tree
filter as if it were present in that immutable archive.

Automated compatibility evidence uses the exact v0.3.5 and v0.3.6 embedded
browser compiler/assembler closures in real Chromium to compile the private
v0.3.7 Kernel and all 14 current clean HTTPS-source app archives as one batch
with zero compiler errors or compatibility diagnostics; v0.3.7 also has exact
parser/batch coverage. The update service separately proves one
prepare/compile/review/deploy session from a v0.3.5 baseline. Those tests do not
replace the manual archived-browser, live-network canister deployment, durable
state, authorization, and controller-preservation gate. Once the intended
successor archive is built, both the automated legacy compatibility suite and
that manual gate must be repeated against its exact bytes.

## The GPL-Only V0.3.7 Bridge

The production v0.3.5 and v0.3.6 frontends can read, compile, review, and
dispatch a legacy-readable successor. They understand format 3 and accept safe
auxiliary files, but their closed manifest parsers reject unknown
`neutron.json` fields. They also predate the deployment-record code and cannot
retroactively create or review a v0.3.7 pre-dispatch record.

The v0.3.7 Kernel package therefore keeps:

- manifest format 3 and its existing field set;
- production update source `233tv-xiaaa-aaaay-aacta-cai`;
- assembler identity `neutron_actor_v25`;
- `kernel` managed memory at v3;
- `kernel_activation` managed memory at v1; and
- `GPL-3.0-only` as its governing license.

Its generated sidecar binds the exact GPLv3 text, a transition notice, and a
package-information record at these archive paths:

```text
legal/GPL-3.0.txt
legal/GPL-TRANSITION-NOTICE.txt
legal/package-record.v1.json
```

The record accurately says that source is not provided and leaves its build
input and command lists empty. No workspace source archive is embedded. The
transition notice states that v0.3.7 is not an NPL release, an NPL compliance
claim, or a GPL-compliant source distribution. Packaging these private test
files does not publish them.

After v0.3.5 or v0.3.6 installs v0.3.7 through the checked in-product
transaction, the package-information sidecar is present and inspectable. The
deployment build record is legitimately absent because the predecessor could
not create it; Settings reports the deployment as legacy/unavailable and does
not invent raw Wasm, warnings, package digests, or install inputs. This is the
bridge limitation, not evidence that a complete pre-dispatch record existed.

Once v0.3.7 is active, its later in-product installs, updates, and removals use
the record-capable flow below. A predecessor earlier than v0.3.7 cannot create
that complete pre-dispatch record, so a direct transition it performs is
reported as legacy/unavailable rather than retroactively reconstructed. That
limitation does not require v0.3.7 as an intermediate: v0.3.5 or v0.3.6 can
prepare and install the legacy-readable successor Kernel and provider-hosted
app packages together, and the new Kernel enforces complete records on
subsequent operations. This is a software evidence distinction, not an
NPL/NSAL permission condition.

## Deployment Build Record V1

This record is generated and checked by the product. It is not an installed
legal registry and requires no user or app-author compliance action. A later
state-compatible Kernel version may simplify or replace it without changing the
license, provided its own release and migration rules are followed.

The fixed public certified asset is:

```text
/system/deployment-build-record.json
```

It is closed, canonical, bounded JSON with `format: 1` and a maximum encoded
size of 4 MiB. The parser accepts two explicit states:

- `complete` is created before dispatch from the exact compiler and install
  inputs.
- `legacy_observed` carries only bounded public facts that were actually
  observed and a closed list of unavailable legacy facts. It cannot pretend to
  be a complete pre-dispatch record.

A complete record binds:

- every target package in compiler dependency order, including retained apps;
- each version, outer archive identity, package-information-record identity,
  and resolved dependency contract;
- compiler, assembler, environment, deployment nonce, and reachable module
  identities;
- previous and target app and managed-memory inventories;
- exact diagnostics, compatibility findings, migration/retirement plan,
  removed apps, and destructive memory roots;
- target canister, install mode, install-argument digest, and Wasm memory
  persistence; and
- raw compiler-output and deterministic install-transport identities.

For retained legacy packages, unavailable archive or sidecar facts are encoded
as `legacy_unavailable`; known outer digests may be retained without inventing
an unavailable archive byte length. A newly supplied package has its exact
archive bytes and identity rechecked at package, batch, review, and deployment
boundaries.

A `legacy_observed` record contains the target canister, deployment/compiler/
assembler identities, public app and memory inventories, known per-package
digests, and a certificate-verified installed module hash. Closed unavailable
codes name facts such as package bytes, raw compiler output, gzip details,
pre-dispatch warnings, install inputs, or prior state. The
v0.3.5/v0.3.6-to-v0.3.7 bridge does not synthesize this record merely to fill
the missing asset.

Because the asset is public, its input language deliberately excludes raw
install arguments, credentials, authorizations, controllers, browser-origin
nonces, and installation UIDs. Only the install-argument length and digest are
retained. Bounded text is checked for prohibited control characters and
obvious secret material before the record can be serialized or installed.

## Pre-Dispatch Review And Atomic Commit

For an operation performed by the record-capable v0.3.7 frontend:

1. The browser reads a consistency-fenced installed baseline and the aligned
   prior deployment evidence.
2. It verifies supplied archives and package-information records, compiles the
   complete target package set, and prepares the exact deterministic install
   transport.
3. It creates the complete deployment record from those sealed facts and
   exposes the canonical record for inspection, copy, or download before any
   install-code dispatch.
4. User approval applies to that reviewed result. Deployment re-parses and
   independently re-derives the compiler, package, install, and Wasm facts;
   changed or mismatched evidence fails before staging.
5. The exact reviewed JSON and the exact recorded transport bytes enter the
   checked transaction. The record is staged with the target registry,
   package assets, Candid, stable signature, and other mutable metadata.
6. Only the expected running actor may commit. Commit promotes and certifies
   `/system/deployment-build-record.json` atomically with the rest of the
   deployment; failure leaves the prior committed deployment authoritative.

The same rule covers manual file/URL installs, update-source and repository
installs, and removals. Route-specific UI may differ, but it must not construct
the record after approval or dispatch, omit automatically selected
dependencies, or replace unavailable retained-package facts with guesses.

The shared deploy boundary enforces the transition from the checked installed
registry: when the existing Kernel is version 307 or later, deployment is
rejected before upload or staging unless the caller supplies a complete record
that matches the exact operation. The only intentional no-record cases are a
pre-v307 bridge predecessor and a fresh/provisioner path with no installed
Kernel predecessor. There is no install, update, or removal route exemption
after the record-capable bridge is active.

Settings can copy or download the canonical installed record. It checks target
canister, deployment identity, compiler/assembler identity, and app/memory
inventory before using it as current evidence. Missing, unreadable, malformed,
stale, runtime-inconsistent, hash-match, and hash-mismatch states remain
distinct.

## Raw, Transport, And Live Module Hashes

These byte identities support technical review and diagnostics. The licenses do
not require a provider to predict browser-generated Wasm, a user to preserve or
publish a hash, or a live hash match as a condition of private use.

The complete record keeps three byte-domain facts separate:

1. **Raw actor Wasm** is the uncompressed `compiled.wasm` returned by the
   Motoko compiler. Its representation is `neutron_compile_result_wasm` with
   identity content encoding.
2. **Install transport Wasm** is the exact gzip member returned by the shared
   transport helper. Its fixed encoder identity is
   `fflate@0.8.3:default-level:mtime=0`, its representation is
   `ic_install_wasm_payload`, and its content encoding is `gzip`.
3. **Live installed module hash** is the canister-level `module_hash` read from
   certificate-verified IC state or controller-authorized canister status.

The transport helper returns both the record and the exact bytes to dispatch;
callers must not recompress independently. Inline and chunked installation
send that same transport. Under the current IC contract, the live module hash
is compared with SHA-256 of those deterministic gzip transport bytes, never
with the raw compiler-output digest.

There is one transport/live module hash for the whole canister. Per-package
archive and package-information digests remain separate. A missing, malformed,
stale, unverifiable, or different-deployment value is never displayed as a
match; Settings retains the expected value and supports a fresh certified
observation.

## Historical V0.3.5 And V0.3.6 To V0.3.7 GPL Bridge Candidate Checklist

This checklist preserves the manual, state-preserving qualification of the
private v0.3.7 candidate. It does not publish packages or change the Dispenser,
and it is not a required intermediate step in the simultaneous production
successor-and-app cutover described above.

Current automated evidence is green for the exact archived v0.3.5 and v0.3.6
compiler/PocketIC upgrade lanes. The final v0.3.7 qualification suite also
passes against the current generator and candidate binding. Its exact
checked-in evidence is:

```text
apps/kernel/certified-assets-qualification-receipt.json
bytes: 400532
file_sha256: 210cf8d2eb9b8aa15c2a6fe461fcdae2dfa8ab58e684e72da4848f080f8e97a9
status: passed
receipt_sha256: c4efd19145bba944182b54fc975f03ebc8e3a10e5a3f4708f10a9dfb5495df95
qualified_raw_wasm_sha256: b32e71f3a3e69a462fc5ef58a1099b7dc3c504ad854585ad33e120ccc6723ab0
qualified_transport_wasm_sha256: ac6fce5cbfa905b3d6fcde6107eeb857fda38e74033d473c5ce639ba076af1be
```

The manual archived-browser gates remain pending. Qualification does not
resolve two separate release blockers: GPL Complete Corresponding Source has
not been supplied, and redistribution rights for the exact bundled
`icblast@4.3.0` bytes have not been established. The candidate is private and
no publisher, production update-source content, source offer/archive,
Dispenser/starter state, or production canister has been changed.

1. Preserve the exact released baseline before running a package command:

   ```text
   packages/neutron-compiler/test/fixtures/kernel.v0.3.6.neutron
   bytes: 1858175
   sha256: b25948f68ed10f29c984e936ecfd18b95fa8d4cdec0bbd1e944b53b2a371bd8b
   ```

   The packer retains older same-app archives as immutable upgrade and release
   history. The durable compiler fixture below remains the canonical test
   input, and the supported skipped-predecessor lane uses the equally immutable
   v0.3.5 fixture:

   ```text
   packages/neutron-compiler/test/fixtures/kernel.v0.3.5.neutron
   bytes: 1918481
   sha256: 534e0ded262bb5700d92046a4fafad16ccf42473259edd3f18e8a0578347f2ae
   ```

2. Verify the exact private bridge candidate:

   ```text
   apps/kernel/kernel.v0.3.7.neutron
   bytes: 1924034
   sha256: aaf329e5d526f4b5a436c440ac21a245b068172c6e4e2d6dc07696ecadc60f7d
   ```

   It is Kernel version `307` (`0.3.7`) under `GPL-3.0-only`. Require its exact
   GPL text, transition notice, and
   package-information record. The bridge record must accurately state that
   source is not provided and that its build-input and build-command lists are
   empty; no source archive is embedded. Do not label it NPL or publish it as a
   GPL-compliant source release.

3. Keep format 3, the production update-source value, assembler
   `neutron_actor_v25`, and the existing init arguments. Put new metadata in
   sidecars, never unknown manifest fields.
4. Preserve `kernel` memory v3 and `kernel_activation` memory v1. Do not edit
   their released schemas or lock lineage and do not add a fake migration. If
   persistent state really changes, stop and design a new forward migration.
5. Preserve the passing exact-archive v0.3.5/v0.3.6 compiler and PocketIC
   evidence and the exact passing qualification receipt above. Recheck its file
   hash, internal receipt hash, and bound raw and transport Wasm hashes before
   treating this exact candidate as technically qualified. Do not treat that
   result as GPL source evidence or as proof of third-party redistribution
   rights.
6. Before touching a live Neutron, record representative app data, installed
   IDs and versions, memory inventory, authorized principals, controllers,
   capability state, deployment ID, live module hash, provenance, and pending
   journal state.
7. Complete the still-pending manual archived-browser gate: select the exact
   v0.3.7 archive through the supported predecessor's own manual file-based
   Kernel replacement flow. Do **not** use `neutron-provision reinstall`;
   reinstall erases application state and is not an upgrade mechanism.
8. Require checked commit and reload. Verify all representative app data,
   registry rows, authorizations, controllers, provenance, and capability state
   remain intact; require Kernel v307, memory v3/v1, and no pending journal.
9. Inspect and verify `/pkg/legal/package-record.v1.json`, its declared GPL
   text, its transition notice, and its explicit `source: not-provided` status.
   Confirm that it does not claim or embed Corresponding Source. Expect
   `/system/deployment-build-record.json` to be missing/legacy for this first
   bridge transition; do not manufacture a complete record after dispatch.
10. Exercise a subsequent v0.3.7-owned in-product operation in a disposable
    test Neutron. Require the complete record to be reviewable before approval,
    committed at the fixed path, and matched to the certified whole-canister
    transport hash afterward.
11. The automated exact-fixture v0.3.5 and v0.3.6 direct bridge lanes pass.
    Repeat both with their archived browser frontends before release. Clean
    initialization is additional evidence, not a replacement for a
    state-preserving production-predecessor test.
12. During this candidate phase, do not run the production update publisher,
    do not edit or stage `support/dispenser/starter-packages.json`, and do not
    deploy the Dispenser. Publication and starter staging are later, separate
    release decisions.

If an install response is ambiguous, reconcile the checked journal and running
deployment identity. Do not rebuild different package bytes or attempt a
destructive reinstall while the result is unresolved.

## Related Contracts

- [App Package Format](./app-package-format.md)
- [Compiler And Actor Assembly](./compiler-and-actor-assembly.md)
- [Kernel Frontend Runtime](./kernel-frontend-runtime.md)
- [Managed Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md)
- [App Package Updates](./package-updates.md)
- [Verify Source, Build Artifacts, and Live Canisters](./how_to_verify.md)
