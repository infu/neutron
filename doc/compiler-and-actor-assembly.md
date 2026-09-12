# Compiler And Actor Assembly

Use this reference when changing compilation, generated authority, or checked
installation. The Neutron compiler turns one Kernel package plus ordinary app
packages into one Motoko actor and one install plan. Changes must preserve both
the security boundary and every supported production predecessor's state.

Use the source entry points below for current identifiers, limits, and result
fields. Do not treat documentation examples as a generated-source fixture.

```text
bounded packages + prior runtime/stable state + trusted installation context
    -> normalized manifests
    -> dependency, memory, capability, and surface plans
    -> generated actor source
    -> fresh Motoko compilation
    -> Wasm + Candid + stable signature + install inventory
```

The active assembler identity is the `ASSEMBLER_ID` exported by the compiler.
Every compile result records the selected identity, and the installer requires
the running actor to report that exact value. General documentation does not
copy the mutable identifier.

The compiler retains one explicitly named predecessor compatibility lane.
Fresh compilation selects the lane from the selected Kernel manifest through
`assemblerForFreshKernelVersion`; the predecessor lane cannot compile
`browser_permissions` or browser-surface origins. A browser-installed Kernel
frontend produced by that predecessor may therefore be active on the legacy
actor contract until its next checked install, which must use the active
assembler. This is a state-preserving bridge, not permission to reinstall a
production Neutron destructively.

## Inputs

Assembly consumes:

- the Kernel package;
- zero or more ordinary app packages;
- each package's format-3 manifest, Motoko source, and static assets;
- prior manifests, stable signature, managed-memory inventory, and module paths
  for an update;
- an exact deployment nonce;
- the vetKey environment;
- trusted installation identity for a fresh actor; and
- compiler and package decoder limits.

Assembly bounds app instances, resident backgrounds, and scheduled tasks
actor-wide. Read the `NEUTRON_*_LIMIT` constants in `assemble.ts` when diagnosing
admission; frontend and backend admission must agree with them.

Missing `tiles` normalizes to `[]`. A package may be headless; the compiler does
not synthesize `main/index.html` or any other frontend endpoint.

## Trusted Installation Identity

For a fresh actor, the compiler derives a 32-byte network ID from the exact
trusted root-key SPKI DER bytes:

```text
SHA-256(
  u32be(len("neutron.network-id.v1")) ||
  UTF8("neutron.network-id.v1") ||
  u32be(len(root_key_spki_der)) ||
  root_key_spki_der
)
```

Production uses the compiled IC mainnet root key. PocketIC uses the exact pinned
root key returned by its supervised instance.

The trusted context is compiler-branded and bounded before assembly. The
network ID is public identity, not authorization. A state-preserving update
reads the committed installation identity from the prior actor rather than
accepting a new caller-supplied value.

An update predecessor must pass the installation-identity checks and match an
assembler generation explicitly supported by the installer, including its
named predecessor bridge. An unknown generation cannot be treated as
compatible merely because it reports a similar runtime shape. Rejection of
unsupported development state is not permission to replace a supported
production Neutron through a destructive reinstall. Before releasing a changed
contract, retain or add a state-preserving path from every production
predecessor the release continues to support.

## Package Preparation

Each `.neutron` archive is decoded before compilation. The only archive shape
is:

```text
MessagePack map<string safe-relative-path, bin(gzip(file-bytes))>
```

The decoder enforces raw, entry-count, path, compressed-entry,
decoded-entry, and decoded-total limits before materializing the package. It
rejects duplicate/dangerous paths, trailing data, malformed UTF-8, multiple
gzip members, and decompression overflow.

Preparation then:

1. requires `neutron.json`;
2. validates manifest format 3 and package identity;
3. normalizes display text, endpoints, functions, memory, dependencies, and
   capabilities;
4. validates required assets and source paths;
5. hashes package-owned modules and assets;
6. creates the canonical capability plan and fingerprint; and
7. records exact install assets and registry metadata.

The Kernel package also carries closed
`connection-providers.json` support metadata. Compilation selects the incoming
Kernel catalog during a Kernel replacement and otherwise the installed Kernel
catalog, then validates every target app's provider/scope declarations before
loading Motoko. The minimal catalog is installed at
`/pkg/connection-providers.json`; provider URLs and credential encoders remain
inside the trusted Kernel implementation.

Remote repository packages use smaller decode ceilings than deliberate local
file installs.

## One Generated Actor

The actor combines the Kernel and target app modules with compiler-created
scopes, attenuated environments, dispatchers, managed-memory wrappers, and
runtime declarations. Its stable signature and install identity describe the
whole actor; an app is not a separately installed Wasm module.

Ordinary app modules never receive a Kernel service object. The assembler
creates attenuated values and passes them only to the app/configuration point
that declared them.

The literal `kernel` package is the only app identity treated specially. Its
functions provide the actor's trusted system surfaces. Ordinary apps pass
through the same generic manifest, plan, scope, method-mapping, and lifecycle
logic regardless of product name.

## Canonical Capability Projection

For each app the compiler:

1. normalizes the closed `capabilities` object;
2. derives structural entries from memory, dependencies, functions, and
   frontend surfaces;
3. synthesizes Certified Assets read mounts from collection kinds;
4. checks per-app limits and aggregate logical or physical admission, including
   Certified Assets charged, arena-byte, and extent reservations;
5. fingerprints the canonical wire plan;
6. creates backend handles selected by `backend.capabilities`;
7. injects exact function resources;
8. emits runtime capability registrations; and
9. records disclosures in the install plan.

Certified Assets read routes are derived, not authored:

- publication mount -> exact-Neutron-Host `GET`/`HEAD`;
- blob mount -> canister-gateway `GET`.

Authored API-1 POST mounts and derived read mounts share one collision and
aggregate-admission pass.

## Backend Environment

When an app declares managed memory, dependencies, or selected backend
capability interfaces, its `Init` receives one generated environment record.
The groups are `stable_memory`, `app_calls`, and `capabilities`; empty groups
are omitted. Every generated environment also includes `installation`. An app
with none of these groups receives `Init()` rather than an empty environment.

Capability handles capture the app's `AppScope` and closed declaration. A
backend cannot ask for an interface it did not select or construct one for
another scope. Use `backend.capabilities` and the capability catalog for the
available interfaces rather than copying a list into an app.

Install-reviewed backend-call reservation defaults are part of the
`backend_calls` declaration. A pristine actor can materialize all compiled
defaults synchronously. An incremental update prepares changed claims through
the predecessor before installing the target. Target assembly enforces
per-app and aggregate capability bounds and rejects the same exact default
scope claimed across apps. Current bounds are owned by the capability catalog
and assembly admission checks.

## Function Mapping

Logical app methods are not exposed as raw top-level actor names.

The compiler maps:

- owner-authorized query/update functions;
- private internal functions;
- methods exposed to typed app dependencies;
- scheduled-task handlers;
- API-1 HTTP POST handlers;
- public-ingress protocol handlers; and
- Kernel system functions

to collision-resistant physical names and dispatchers.

The manifest fixes function mode, async form, injected resources, app exposure,
and public access. Ordinary apps cannot declare the Kernel-only unauthorized
function escape; public access goes through `public_ingress`.

The compiler rejects duplicate public names, physical-symbol collisions,
invalid injection identifiers, wrong resource combinations, and signatures
that do not match the generated dispatcher contract.

## Source And Import Checks

Before emission the compiler determines the reachable module graph from target
roots. It checks:

- safe module paths;
- canonical hashed package modules;
- forbidden imports and APIs;
- app access to Kernel-private modules;
- injection and physical-symbol collisions;
- actor or stable-state constructs that would bypass managed wrappers; and
- function/resource declarations against parsed source.

These checks reduce the app language surface. They are not a substitute for
runtime capability checks: both compiler projection and live broker policy are
required.

## Managed Stable Memory

Each declared app memory root has:

- owner app;
- current version;
- schema source and hash;
- generated wrapper module;
- optional ordered migration edges;
- optional consumed roots for consolidation; and
- explicit retirement state.

`neutron.lock.json` is the source lock for these schema hashes and migration
edges. Its current format is independent from the app manifest and deployment
config formats.

The compiler compares the previous stable signature and memory inventory with
the target. A state-preserving update must provide a valid path for every
changed root. It emits deterministic migration and retirement metadata into
both the generated source and install plan.

Managed-memory retirement runs synchronously inside the successful install
commit. A later trap rolls it back with the rest of that update.

Large app-owned repair, recertification, or semantic migration that cannot fit
the bounded atomic contract must be designed by the app as resumable
post-activation work. The Kernel does not scan every app's data in upgrade
hooks.

## App Dependencies

An app dependency declaration names:

- a local alias;
- provider app ID;
- minimum version; and
- exact exposed functions.

The target inventory must contain a compatible provider. The provider must
expose each function as an internal app export. The compiler creates a typed
attenuated handle; the consumer cannot call arbitrary provider methods or
Kernel methods.

Dependencies are product architecture, not a Core allowlist. Any valid app ID
may participate.

## Frontend Surface Projection

The compiler records only declared surfaces:

- zero or more exact tile endpoints;
- optional resident background endpoint plus frame security mode; and
- optional tray endpoint, only when that resident background exists.

For the browser-surface-origin assembler, package preparation also derives the
exact adopted app set. A selected ordinary package is eligible only when it
carries the packer-owned readiness marker or declares `browser_permissions`;
already adopted apps stay adopted across unrelated installs, and uninstall
removes them. The compiler projects the adopted set into the actor's browser
surface configuration and the install plan's certified sidecar. Each adopted
tile ID, tray, and ordinary background becomes a separate installation-derived
surface. No app ID or release-version exception participates in that decision.

It derives frontend runtime admission counts and injects them into the actor.
The backend and trusted frontend independently enforce the declared admission
bounds before activation or mounting.

Static assets are copied only for declared package paths. A headless backend
does not need `web/index.html`, an icon fetch, or a synthetic tile.

## Browser Compiler Isolation

The vendored Motoko compiler has process-global virtual filesystem and retained
internal state. Neutron serializes compile requests and gives every compile an
isolated compiler-service lifecycle.

Within one compile:

1. a fresh Worker/compiler inspects reachable modules and type/source
   structure;
2. that compiler is disposed;
3. a second fresh Worker/compiler receives only reachable files and performs
   final whole-actor emission; and
4. the service is disposed on success, failure, rejection, or cancellation.

The browser page remains responsive while the Worker runs, and unrelated app
UI work does not share the compiler's Wasm stack.

Security inspection uses compact parser facts, including dotted members and
object-pattern acquisitions, plus one source scan per module. It does not
export a full syntax tree with current compiler assets; the full-tree fallback
is retained only for older assets that lack the pattern facts.

Neutron retains classical persistence with compacting GC as its default.
Compiler throughput and stack-safety improvements do not switch existing
canisters to enhanced persistence or change their managed-memory schemas.
Use the compiler scale fixtures for performance investigations; a fixture's app
count is not a capacity guarantee for arbitrary source code.

The compiler artifact must expose:

```js
globalThis.NeutronMotokoReady
```

as a Promise. Browser Workers, the Node in-process loader, and the isolated
Node/Bun compiler service await it, verify the compiler API, and report a
bounded initialization failure. There is no polling initialization path.

## Compile Output

A successful compile returns the actor bytes and interfaces together with the
plans, inventories, diagnostics, and identities needed to verify installation.
`CompileResult` in `compile.ts` owns the exact result shape. Request generated
source when an investigation needs assembly evidence; do not maintain a second
generated-source inventory in documentation.

The deployment ID binds the target manifests, migrations, retirements,
capabilities, inventories, compiler, environment, installation identity, and
deployment nonce.

`compiled.wasm` is the raw actor output. Use
`prepareDeterministicWasmTransport` from `deployment_record.ts` for the exact
gzip bytes sent through either the inline or chunked management path. Its
encoder identifier and parameters are part of the build-record contract; do
not substitute ad hoc compression. Raw and transport hashes are different
byte-domain facts. Install and provisioning verification compare the live
canister module hash with SHA-256
of that deterministic gzip transport, while retaining the raw output identity
separately.

The format-1 deployment build record at
`/system/deployment-build-record.json` maps the ordered package set to these
compiler, compatibility, install, and hash facts. It is one record for the
complete actor, not one module hash per app. The GPL bridge and exact record
flow are documented in
[License And Deployment Records](./license-and-deployment-records.md#deployment-build-record-v1).

## Install Transaction

Browser and provisioner installers use the same current lifecycle.

### Prepare

- preflight the complete target app and resident inventory;
- compile against the committed predecessor;
- for a record-capable browser operation, create and expose the complete
  deployment build record and exact install transport before approval or
  dispatch;
- stage hashed Motoko modules and package/static assets;
- stage the same canonical deployment record with mutable assets;
- prepare bounded copy/clear and module-GC operations; and
- choose direct `install_code` or management chunk upload according to ingress
  size.

### Journal

The predecessor receives:

```text
kernel_install_begin_checked({
  journal,
  expected_deployment_id
})
```

The journal binds the target deployment, asset copies, clear prefixes, and
target app inventory. Exact replay is idempotent and is the causal recovery path
after a lost reply.

The deploy boundary checks the supplied predecessor inventory and requires an
exact complete deployment build record for record-capable predecessors before
upload or staging. `requiresCompleteDeploymentBuildRecord` in `install.ts`
defines the supported older bridge exception; a fresh provisioner path has no
installed predecessor. Do not use that compatibility exception for a new
installation workflow.

Journals bound asset copies, clear prefixes, and app removals. Use the
`KERNEL_INSTALL_MAX_*` constants in `install.ts` when planning a transaction.

### Reservations

If changed apps declare install reservations, the predecessor receives
`kernel_install_reservations_prepare`. Claims are inert until target commit and
ordinary reservation mutation remains frozen while the journal is pending.

### Install And Verify

The installer dispatches the new Wasm, waits for the target runtime, then
requires exact:

- deployment ID;
- the assembler ID selected by the compilation;
- compiler ID;
- app instance inventory and plan fingerprints;
- browser-origin/frame-security fields, surface-origin sidecar state, and
  capability-authority revision where the selected assembler provides them;
- managed-memory inventory.

Chunked Wasm upload is cleared after activation.

### Commit

The target receives:

```text
kernel_install_commit({ deployment_id })
    -> #committed | #blocked
```

Commit first checks:

- the actor is the named target deployment;
- the journal belongs to that deployment;
- the target inventory matches the active actor; and
- every changed backend reservation can finalize.

It then performs one atomic Motoko update:

- finalize reservations;
- promote app inventory and static assets;
- commit managed-memory retirement and module GC;
- commit capability-registry configuration;
- synchronize Certified Assets and certified routes;
- reconcile resident background entrypoints; and
- commit scheduler configuration.

If any step traps, the message rolls back. An already-completed exact replay
returns `#committed`; a mismatched or unresolved target returns `#blocked`.

The installer retries commit once after a transport failure. If it cannot
causally confirm completion, it leaves the journal pending and reports status
only as a diagnostic.

## Fresh Deployment Initialization

A fresh actor has no predecessor install transaction. The provisioner:

1. installs the complete compiled target;
2. initializes generic publication entropy;
3. seeds package/static runtime assets, including the certified browser-surface
   sidecar required by the selected assembler;
4. authorizes configured principals;
5. applies app-neutral local fixtures when selected; and
6. verifies runtime, access, module, certified entrypoint, and package
   inventory.

Compiled backend reservation defaults initialize synchronously from the actor
declarations. The provisioner does not interpret app IDs or private methods.

## Relevant Sources

- `packages/neutron-compiler/src/compile.ts`
- `packages/neutron-compiler/src/assemble.ts`
- `packages/neutron-compiler/src/install.ts`
- `packages/neutron-compiler/src/deployment_record.ts`
- `packages/neutron-compiler/src/package_decoder.ts`
- `packages/neutron-compiler/src/installation_context.ts`
- `packages/neutron-motoko-wasm/src/index.ts`
- `packages/neutron-motoko-wasm/compiler/compiler-worker.js`
- `packages/neutron-tools/src/schema.ts`
- `packages/neutron-tools/src/capabilities/`
- `apps/kernel/backend/install/`

For changes to these contracts, inspect the corresponding compiler tests for
assembly, dependencies, installation identity, package decoding, deployment
records, checked install/recovery, and predecessor compatibility. Run the
relevant suites through the workspace test runner; production memory changes
also require the migration evidence in
[Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md).
