# Repository Setup Manifests

[Back to the documentation index](./index.md).

Repository Protocol v1 (`neutron-repo-v1`) supplies a digest-pinned selection
of `.neutron` packages to the existing installer. Setup installs missing apps;
it never upgrades or replaces installed apps. Updates use a separate release
record in the same repository namespace; see [Package Updates](./package-updates.md).

The Marketplace app and protocol exist separately under `apps/marketplace/`
and `support/marketplace/`. Marketplace prepares manifests and download access
for this installer. `support/repository/` remains a static example provider,
not the Marketplace implementation. Do not infer a catalog, publisher identity,
entitlement, or update subscription from the setup protocol alone.

## Source Of Truth

| Contract | Implementation |
| --- | --- |
| Wire types, closed JSON schemas, resource paths, link parsing, expiry and bounds | [`repository.ts`](../packages/neutron-tools/src/repository.ts) |
| Certified Candid resource verification | [`certified_asset.ts`](../packages/neutron-tools/src/certified_asset.ts) |
| Anonymous retrieval and package transport selection | [`repository/client.ts`](../apps/kernel/src/repository/client.ts) |
| Setup lifecycle, prepared app handoff, selection and review | [`repository/service.ts`](../apps/kernel/src/repository/service.ts), [`repository/model.ts`](../apps/kernel/src/repository/model.ts) |
| Authenticated package baseline and shared compile/deploy transaction | [`reducer/apps.ts`](../apps/kernel/src/reducer/apps.ts), [`install.ts`](../packages/neutron-compiler/src/install.ts) |
| Source-access consent and credentials | [`repository_access/client.ts`](../apps/kernel/src/repository_access/client.ts) |
| Static provider generation | [`support/repository/src/generate.ts`](../support/repository/src/generate.ts) |
| Marketplace manifest and release generation | [`support/marketplace/mo/Repository.mo`](../support/marketplace/mo/Repository.mo) |

Read `REPOSITORY_LIMITS`, `REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS`, and
`KERNEL_INSTALL_MAX_COPIES` for current bounds. Do not copy their values into
provider code or assume the manual installer has the same remote-import limits.

## Provider Link And Handoff

The provider link uses a fragment:

```text
https://<dispenser-origin>/#repo=<canister-principal>&manifest=<manifest-id>&digest=<manifest-sha256>
```

Use the shared link helpers and validators. All three fields are required;
query-string setup fields are rejected. `repo` identifies the canister,
`manifest` names a bounded manifest identifier, and `digest` is the lowercase
SHA-256 of the exact manifest bytes. A changed manifest fails an old pinned
link rather than silently replacing its selection.

The fragment avoids transmission in the dispenser HTTP request. It is still
visible to browser extensions, the address bar and anyone receiving the link.
A provider can assign a unique manifest identifier or digest to correlate later
contact, even when the caller uses an anonymous identity.

The dispenser captures the reference before provisioning and carries it only
in the browser handoff to Neutron. Repository fields do not become provisioning
arguments or dispenser registry data. See
[`support/dispenser/src/provisioning.ts`](../support/dispenser/src/provisioning.ts).

The internal handoff may also carry an independent `activate` bearer. Kernel
captures the handoff before authentication and requires successful same-tab
storage and address-bar removal. Activation authorizes the Neutron-origin
identity; a dispenser identity is not interchangeable with it. Repository setup
resumes after authorization and verified registry load. Preserve these capture
and identity boundaries when changing bootstrap or login code; see
[`apps/kernel/src/bootstrap.ts`](../apps/kernel/src/bootstrap.ts).

Opening or capturing a setup reference does not authorize installation. The
pending-contact dialog does make a public source-access-cost lookup before
`Load setup`; do not claim there is no repository contact before that action.
This lookup neither buys a grant nor downloads the selected manifest/packages.
Loading those resources and acquiring any approved source access requires the
loading action. An already approved app/agent install offer supplies that
loading decision; the Kernel must not repeat it or treat it as final deployment
approval. See [App Install Offers](./app-install-offers.md) and
[`RepositoryAccessCost.tsx`](../apps/kernel/src/repository_access/RepositoryAccessCost.tsx).

## Certified Resources And Retrieval

The fixed query interface is `repositoryIdlFactory` in the shared protocol
module. Provider data cannot supply Candid, method names or arbitrary fetch
URLs. Its methods map to these certified-tree keys:

| Method | Resource |
| --- | --- |
| `repo_info` | `/repo/v1/info.json` |
| `repo_manifests` | `/repo/v1/manifests.json` |
| `repo_manifest` | `/repo/v1/manifests/<manifest-id>.json` |
| `repo_package` | `/repo/v1/packages/<sha256>.neutron` |

Setup reads information, the selected manifest and its packages. It does not
use the manifest index as a discovery catalog. The separate update path reads
`/repo/v1/releases/<app-id>.json` over HTTP.

Metadata queries use a dedicated anonymous agent, not the owner's Internet
Identity actor. The transport omits cookies, referrers and caches. This prevents
the method from receiving the owner's authentication principal; it does not
provide network anonymity or hide a uniquely selected manifest.

For Candid resources, the shared reader verifies the IC certificate, selected
canister, freshness, witness under `http_assets`, chunk bounds, complete bytes
and resource hash. The selected manifest must also match the link's pinned
digest. Local root-key discovery follows the runtime deployment policy; it is
not a production verification bypass.

Package bytes have two supported channels. A certified Candid resource is read
directly. **Only certified absence** selects the same canister's fixed HTTP
package path through the repository-access client. A failed proof, interrupted
read or HTTP error must not select another channel. Marketplace deliberately
certifies absence for package Candid reads and serves packages over HTTP with
repository access. Metadata is public; package download access can require an
approved grant. Do not describe the entire protocol as anonymous public package
download.

Whichever package channel is used, setup verifies the exact manifest size and
SHA-256 before preparation. Access credentials authorize download, not package
identity or deployment. Prepared app requests provide their own scoped download
access; Kernel does not acquire paid access for those requests. Their transient
credentials are not persisted as a resumable setup link.

Repository metadata and manifests are closed-schema data. Provider prose and
publisher/source claims are unverified text, not executable UI or authority.
Each package entry supplies download identity (`id`, `version`, `sha256`,
`size`); the packed `neutron.json` supplies permissions, dependencies, memory and
runtime behavior. Preparation rejects identity mismatches, duplicate app IDs or
digests, and a setup package named `kernel`.

## Selection And Installation Invariants

1. Acquire the shared app-operation session and an authenticated baseline before
   repository loading. Verify and prepare every package in the manifest, even
   already-installed ones, so omitted downloads do not disclose the installed
   subset.
2. Reconcile registry, compiled configuration and runtime presence. Any present
   app is skipped; inconsistent state is not permission to replace it. Resolve
   missing dependencies from verified package manifests. An insufficient or
   inconsistent installed dependency blocks selection rather than triggering an
   implicit upgrade.
3. External-link selections begin unchecked. A prepared app handoff can supply
   selected roots and proceed directly to build review, but its roots must
   belong to the verified manifest and pass the same dependency checks.
4. Freeze the selected closure, check aggregate archive and install-journal
   capacity, and compile one batch. Permission disclosures and deployment review
   derive from verified packages and the compiled result.
5. Require final approval of that exact build. Revalidate package state and
   deployment evidence before one checked, state-preserving journal transaction.
   A concurrent package change requires a new review; it must not reuse an old
   approval against a different deployment.

Selection is local after loading. An empty selection performs no compile or
deployment. Session expiry applies through loading, selection and review. Once
the exact transaction is approved, an in-flight deployment may finish; failure
restores the original expiry check. Failed setup does not disable ordinary
Neutron use.

Preserve the shared install journal's crash recovery and cross-tab fencing;
do not invent repository-specific abort or cleanup behavior. The compiler
owns package decoding, collision checks, capability evidence, managed-memory
compatibility and atomic asset activation. See
[App Package Format](./app-package-format.md),
[Compiler And Actor Assembly](./compiler-and-actor-assembly.md), and
[Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md).

## Certified Provenance

Successful selected apps receive a `kind: "repository"` entry at
`/system/install-provenance.json`, committed with the installed registry. The
entry retains the repository canister, manifest identifier and digest, and
package digest. It is certified public metadata, not a secret store.

Repository provenance does not retain raw links, provider prose, unselected
package IDs, download history or timestamps. The shared file also supports
manual, provisioned and update-source entries; their fields differ. Uninstall
removes the app entry, and later installation replaces its provenance according
to the new acquisition path. Use
[`repository/provenance.ts`](../apps/kernel/src/repository/provenance.ts) rather
than assuming every installed app has repository provenance.

## Provider Development And Verification

The static template reads `support/repository/repository.json`, inspects actual
archives, derives package identity and digests, validates aggregate decoder and
journal capacity, then emits deterministic certified resources and generated
Motoko. Build each referenced app through its complete workspace package
command before `npm run repository:generate`; changing prose or package bytes
changes manifest digests and therefore provider links. See the template's
[`package.json`](../support/repository/package.json) for Wasm and test commands.

`REPOSITORY_CANISTER_ID` selects the deployed provider when printing links.
`REPOSITORY_DISPENSER_ORIGIN` overrides the origin otherwise read from the
dispenser mapping. Generation does not deploy or publish a canister. The
template implements static query resources; Marketplace's mutable catalog,
entitlements, HTTP delivery and publication are separate implementations. A
static template remains controller-upgradeable; certification does not prove
controller immutability or publisher trust.

When changing this protocol, exercise shared schema/handoff tests, Kernel
repository retrieval/model/service tests, dispenser handoff tests and provider
generation tests. Include certified absence versus invalid proof, package
digest/identity mismatch, installed-state reconciliation, dependency closure,
prepared access, approval evidence and expiry. Test deployment changes through
the shared installer suites as well; parser tests do not prove safe activation.
