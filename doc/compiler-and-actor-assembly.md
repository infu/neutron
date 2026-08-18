# Compiler And Actor Assembly

The Neutron compiler turns one Kernel package plus ordinary app packages into
one Motoko actor and one install plan. It is both a build system and a security
boundary.

```text
bounded packages + prior runtime/stable state + trusted installation context
    -> normalized manifests
    -> dependency, memory, capability, and surface plans
    -> generated actor source
    -> fresh Motoko compilation
    -> Wasm + Candid + stable signature + install inventory
```

The current assembler identity is exactly:

```text
neutron_actor_v25
```

The installer requires that exact identity.

## Inputs

Assembly consumes:

- the Kernel package;
- zero to 255 ordinary app packages;
- each package's format-3 manifest, Motoko source, and static assets;
- prior manifests, stable signature, managed-memory inventory, and module paths
  for an update;
- an exact deployment nonce;
- the vetKey environment;
- trusted installation identity for a fresh actor; and
- compiler and package decoder limits.

The total target is at most 256 app instances including Kernel. At most 32 may
declare resident backgrounds and at most 64 scheduled tasks may exist
actor-wide.

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

An actor without the current installation-identity and assembler contract is
not a valid update predecessor for this compiler. That rule applies to
explicitly unsupported development state; it is not permission to replace a
supported production Neutron through a destructive reinstall. Before releasing
a changed contract, the release must retain or add a state-preserving path from
every production predecessor it continues to support.

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

The generated actor contains:

- the Kernel backend services;
- every target app backend module;
- compiler-created app scopes and runtime inventory;
- versioned backend environments;
- typed app-dependency handles;
- physical public and app-call dispatchers;
- managed-memory modules and migrations;
- capability registrations and compiled declarations;
- install and runtime identity methods; and
- one stable-signature declaration.

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

The backend environment is one typed record generated for the exact app. It may
contain selected interfaces such as:

- `deferred_timers`;
- `backend_calls`;
- `randomness`;
- `chain_key_signing`;
- `stable_store`;
- `https_outcalls`;
- `vetkeys_public`; and
- `certified_assets`.

Each field captures the app's `AppScope` and closed declaration. A backend
cannot ask for an interface it did not select or construct one for another
scope.

Install-reviewed backend-call reservation defaults are part of the
`backend_calls` declaration. A pristine actor can materialize all compiled
defaults synchronously. An incremental update prepares changed claims through
the predecessor before installing the target. Target assembly admits at most
64 defaults per app and 2,048 actor-wide, and rejects the same exact default
scope claimed across apps. It also admits at most 128 declared vetKey slots
actor-wide.

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

It derives frontend runtime admission counts and injects them into the actor.
The backend and trusted frontend independently enforce 256 total app instances
and 32 resident frames before activation/mounting.

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

The compiler artifact must expose:

```js
globalThis.NeutronMotokoReady
```

as a Promise. Browser Workers, the Node in-process loader, and the isolated
Node/Bun compiler service await it, verify the compiler API, and report a
bounded initialization failure. There is no polling initialization path.

## Compile Output

A successful compile returns:

- raw actor Wasm;
- generated Candid;
- stable signature;
- diagnostics and compatibility diagnostics;
- dependency and migration plans;
- managed-memory retirement and inventory;
- canonical capability plans and fingerprints;
- app-instance inventory;
- deployment and compiler IDs;
- retained module paths; and
- optional generated actor source for diagnostics/evidence.

The deployment ID binds the target manifests, migrations, retirements,
capabilities, inventories, compiler, environment, installation identity, and
deployment nonce.

`compiled.wasm` is the raw actor output. The shared transport helper gzip
compresses it as `fflate@0.8.3:default-level:mtime=0` and returns the exact
bytes that the installer sends through either the inline or chunked management
path. Raw and transport hashes are different byte-domain facts. Install and
provisioning verification compares the live canister module hash with SHA-256
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

The deploy boundary checks the installed Kernel registry before any upload or
staging. A predecessor at version 307 or later requires an exact complete
deployment build record. Only a pre-v307 bridge predecessor or a fresh
provisioner path with no installed Kernel may omit it.

One journal admits at most 4,000 asset copies and 128 clear prefixes. One commit
may remove at most 64 apps.

### Reservations

If changed apps declare install reservations, the predecessor receives
`kernel_install_reservations_prepare`. Claims are inert until target commit and
ordinary reservation mutation remains frozen while the journal is pending.

### Install And Verify

The installer dispatches the new Wasm, waits for the target runtime, then
requires exact:

- deployment ID;
- assembler ID `neutron_actor_v25`;
- compiler ID;
- app instance inventory and plan fingerprints;
- browser-origin/frame-security fields; and
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
3. seeds package/static runtime assets;
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
- `packages/neutron-compiler/src/package_decoder.ts`
- `packages/neutron-compiler/src/installation_context.ts`
- `packages/neutron-motoko-wasm/src/index.ts`
- `packages/neutron-motoko-wasm/compiler/compiler-worker.js`
- `packages/neutron-tools/src/schema.ts`
- `packages/neutron-tools/src/capabilities/`
- `apps/kernel/backend/install/`
