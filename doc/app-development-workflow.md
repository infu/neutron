# App Development Workflow

[Back to the documentation index](./index.md)

This page describes the current workflow for authoring and packaging a regular
Neutron app. It focuses on the minimal `apps/hello/` example and the developer
scripts in `packages/neutron-scripts/`. The richer `apps/kitchensink/` example
uses the same workflow with multiple tiles and more backend methods. Kernel
bootstrap, install-time compilation, and package upload behavior are covered in
other documents.

Primary sources:

- `apps/hello/`
- `apps/kitchensink/`
- `apps/hello/backend/main.mo`
- `apps/hello/src/index.tsx`
- `apps/hello/build.ts`
- `apps/hello/test/package.test.ts`
- `apps/hello/package.json`
- `apps/hello/neutron.json`
- `apps/hello/README.md`
- `packages/neutron-design-system/`
- `packages/neutron-scripts/src/mogen.ts`
- `packages/neutron-scripts/src/validate.ts`
- `packages/neutron-scripts/src/mopack.ts`
- `packages/neutron-scripts/src/pack.ts`
- `packages/neutron-scripts/README.md`

## Implementation Facts

### App Backend Shape

A Neutron app backend source is a Motoko module under `backend/`. The source
file used for packaging is selected by the root `neutron.json` `src` field. In
the hello app, `src` is `main.mo`, so scripts read `apps/hello/backend/main.mo`.

The hello app uses canonical manifest format 3. `backend/memory/hello/v1.mo`
exports the stable `Mem` type and `init()` default, while `backend/main.mo`
imports that schema, defines `AppBackendEnvironment` with
`stable_memory : { hello : Memory.Mem }`, and exports
`public class Init(env : AppBackendEnvironment)`. An app that consumes trusted
network identity adds `installation : { network_id : Blob }` to its local
structural environment type; record width subtyping lets other apps ignore the
compiler-supplied field.

`env.installation.network_id` is compiler-owned public identity: 32 nonzero
bytes derived from the trusted deployment root-key SPKI DER and retained
immutably across state-preserving installs. It is not a secret, permission,
manifest field, browser value, or runtime-config setting. Apps may bind
network-scoped protocol objects to it, but cannot replace it. Fresh local
assembly requires the provisioner's trusted PocketIC root key; production
defaults only to the compiler-pinned IC mainnet root key. The assembled actor
must report exact runtime identity `neutron_actor_v25`; an actor outside the
current installation identity contract must be recreated with a destructive
reinstall.

The app module is not itself a canister actor. The package and compiler flow
later imports this module, creates persistent memory wrappers, instantiates `Init`,
and exposes selected methods through generated actor code.

The hello app release is `0.2.2`, stored as the packed top-level manifest value
`202` and displayed in its filename as `hello.v0.2.2.neutron`. App releases use
`major * 10_000 + minor * 100 + patch`; memory schema versions below are a
separate positive-integer lane. Browser-installed replacements must have a
strictly higher app release. Trusted local whole-canister provisioning may
redeploy an equal version during development, but neither path permits a
downgrade.

### Function Annotations Consumed By `mogen`

`packages/neutron-scripts/src/mogen.ts` scans `./backend/<src>` and rewrites the
root `neutron.json` `func` object. It looks for public functions matching this
shape:

```motoko
public func /*update*/hello_world(name : Text) : Text {
```

The annotation comment immediately after `public func` is significant:

| Source annotation        | Manifest effect                                         |
| ------------------------ | ------------------------------------------------------- |
| `/*update*/`             | Writes `"type": "update"`.                              |
| `/*query*/`              | Writes `"type": "query"`.                               |
| `/*internal*/`           | Writes `"type": "internal"`.                            |
| `/*internal:apps*/`      | Writes an internal function with `"expose": "apps"`.    |
| `/*query:unauthorized*/` | Kernel package only: writes `"type": "query"` and `"allow": "unauthorized"`. Ordinary app validation rejects it; declare `capabilities.public_ingress`. |

`mogen` also checks the function return type. A proper `async` return writes
`"async": true`, an `async*` computation writes `"async": "async*"`, and a
synchronous function writes `"async": false`. The generated type alias output
removes either asynchronous marker from the return type. The actor assembler
uses `await` only for `true` and `await*` for `"async*"`, avoiding an extra
commit and interleaving point for local asynchronous helper chains.

Injected wrapper arguments are declared with a block comment inside the
parameter list. For example, kernel functions use comments such as
`/*caller*/` and `/*caller,this*/`. `mogen` records the comma-separated comment
values as the manifest `arg` array and excludes the annotated trailing
parameters from the generated input type. This is how a function can receive
generated values such as `caller` or `this` while keeping the Candid request
type limited to the caller-supplied arguments.

A synchronous `caller: "canister"` public-ingress update handler may opt into
an invocation-scoped supplemental-cycle request value with
`/*public_ingress_cycles*/`. When the same handler also needs its caller,
`/*caller,public_ingress_cycles*/` before the two trailing parameters produces
the canonical ordered manifest value
`["caller", "public_ingress_cycles"]`. Every route targeting the opting-in
handler must be a canister update. The value is not placed in the app's
constructor environment or injected into any query, authenticated-ingress
handler, or unrelated method. The opt-in also makes the function route-only:
the compiler omits its ordinary owner-authorized actor wrapper. Use a separate
method over shared internal logic if the app needs an owner call too.

For a paid route, `required_cycles` is accepted before later admission and
must cover every irreversible path. The scoped value's `available()` subtracts
amounts already requested; `request(amount)` accumulates and traps beyond the
remainder without directly accepting cycles. The outer dispatcher attempts the
total only after the handler mutation commits and the live authority/completion
checks succeed, so supplemental payment is best-effort, non-atomic, and unsafe
as payment for work already retained. Unaccepted surplus is refunded.

The parser is regex-based, not Motoko AST-based. The inspected implementation
expects the annotation comment to appear directly between `public func` and the
function name.

### Generated Input And Output Type Aliases

`mogen` also rewrites a generated block inside the backend source:

```motoko
/*---NEUTRON GENERATED BEGIN---*/

public type hello_world_Input = (name : Text);
public type hello_world_Output = Text;

/*---NEUTRON GENERATED END---*/
```

For every annotated function, the generated actor wrapper expects
`<function>_Input` and `<function>_Output` aliases in the app module. The input
alias is built from the function parameters that remain after any injected
argument comment. The output alias is built from the function return type, with
`async` stripped when present.

The aliases always mirror the real authored method signature. A Motoko `Blob`
is ordinary Candid `vec nat8`; it can be a direct parameter or result, or
appear multiple times inside records, options, variants, and vectors. Mogen
does not extract a blob into a separate transport argument, remove a final
blob, synthesize a `{ value; body }` response, or consult
`preapproved_self_calls` to change the ABI. Only parameters named by the
explicit injected-argument comment are omitted.

For example:

```motoko
public type SaveRequest = {
  title : Text;
  originals : [Blob];
  preview : ?Blob;
};

public func /*update*/save(request : SaveRequest) : SaveResult { ... }
```

generates `save_Input = (request : SaveRequest)` unchanged. The browser uses
`Uint8Array` for each blob leaf. Trusted runtime code validates and meters the
complete value against live Candid; generated package schemas are inspection
artifacts rather than binary authority.

If the generated markers already exist, `mogen` replaces the content between
them. If they do not exist, it inserts a new generated block before the last
closing brace in the backend source. The script writes both files in place:
`backend/<src>` and `neutron.json`.

Apps must not postprocess this generated block to alter wrapper signatures.
When a generator cannot represent an authored public type, fix the shared
generator/schema tooling or expose an explicit concrete public type. An
app-local alias-repair script creates a second ABI interpretation and is not a
supported packaging extension.

### Stable Memory Declaration And Versioning

The hello manifest declares one persistent memory namespace:

```json
"memory": {
  "hello": {
    "version": 1,
    "schemas": {
      "1": { "src": "memory/hello/v1.mo" }
    },
    "migrations": []
  }
}
```

The assembler derives `env.stable_memory.hello` from this active root. Ordinary
apps do not declare `init_arg`; the kernel manifest is the only positional
constructor exception. If an app also declares backend dependencies, the same
exact environment gains an `app_calls` group. Long-lived broker handles appear
only when the app explicitly selects them under `backend.capabilities`.

The current pattern is:

1. Add `"format": 3` to the manifest.
2. Create `memory/<id>/v1.mo` with `public type Mem` and `public func init()`.
3. Declare that source under `memory.<id>.schemas` and set the current version.
4. Import the current schema in `main.mo`, define the exact
   `AppBackendEnvironment`, and read `env.stable_memory.<id>` in `Init`.
5. For each type change, add an immutable schema plus a forward migration module.
6. Package and commit the generated `neutron.lock.json`.

The actor keeps one version-tagged persistent root per active memory. For an
upgrade it selects one migration path, imports only those edges, and emits one
combined native migration expression. Direct v1-to-v3 installation therefore
works without installing v2 first. Fresh v3 installation calls v3 `init()`.

Use [Managed Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md)
for the complete v1, v2, and v3 manifest examples, migration module contract,
lineage-lock workflow, retirement rules, and release test checklist.

Memory remains private to its app. To compose Motoko backends, expose selected
domain functions with `/*internal:apps*/` and declare exact minimum-version
dependencies. See [Backend App Dependencies](./backend-app-dependencies.md).

### Frontend Build And `neutron-tools`

The hello frontend uses React, TypeScript, Bun, and esbuild.
`apps/hello/build.ts` bundles `src/index.tsx` to `dist/web/main.js`, enables
TSX through esbuild, targets the browser platform, minifies the bundle, and
copies `public/` into `dist/web/`.

The app frontend imports app-facing helpers from the lightweight
`neutron-tools/app` entrypoint:

```ts
import {
  createCanisterClient,
  loadNeutronCanisterId,
  loadTileContext,
} from "neutron-tools/app";
```

This keeps app bundles away from the kernel-only `expose` and action-schema
validation machinery in the main `neutron-tools` entrypoint.
`loadNeutronCanisterId()` reads `/pkg/id.json` and validates that the returned
`id` is shaped like a canister id. `loadTileContext()` reads the app/tile
query context for app UI convenience; the kernel does not trust those query
parameters as request identity. `createCanisterClient(id)` returns a generic
client with:

- `methodSchema(method)`, which requests the kernel-derived icblast JSON Schema
  for a method;
- `callDialog(method, args)`, which asks the kernel to show a user approval
  dialog before making the call. `args` is the top-level JSON array of Candid
  arguments described by the method schema.

The self-call example only hardcodes the app's own declared method name:

```ts
const id = await loadNeutronCanisterId();
const tile = loadTileContext();
const client = createCanisterClient(id);
await client.methodSchema("hello_world");
await client.callDialog("hello_world", ["John"]);
```

Apps do not send Candid text or package-provided schemas to the kernel. The
kernel derives schemas from the installed canister interface with icblast and
uses that same trusted interface when turning app-supplied JSON arguments into
Candid calls. App builds also emit `dist/schema.json` from the generated
Motoko aliases; use that file for local checks and package inspection, not as a
runtime trust source.

### Shared App Design System

App frontends can import `neutron-design-system/styles.scss` in their own SCSS
entrypoint. The package provides scoped `.nt-app` styles, dark-mode CSS
variables, layout primitives, forms, buttons, alerts, tables, and data display
classes. It has no dependency on React, the kernel, icblast, identity
libraries, or `neutron-tools`.

Kitchen Sink is the reference implementation. Its frontend imports the shared
SCSS and adds `ks-*` app composition classes around an edge-to-edge workbench
with compact left navigation. It keeps kernel-mediated call wording such as
`Review save in kernel` so app UI does not imitate the kernel-owned approval
dialog.

The design-system package tests compile the public SCSS entrypoint and enforce
the current visual policy: dark only, no gradients, radius capped at `5px`,
scoped selectors, and no remote fonts.

### Validate, Build, `mogen`, `mopack`, Add Metadata, And Pack

The hello package script is:

```json
"package": "npm run validate && npm run build && npm run mopack && npm run schema && npm run package:metadata && bun ../../packages/neutron-scripts/src/pack.ts"
```

The current order is:

1. `npm run validate`
   reads `./neutron.json`, validates it with
   `neutron-tools/src/validate_schema.js`, prints validation errors, and exits
   with code `1` on failure.
2. `npm run build`
   runs `bun build.ts && npm run mogen`. The first command builds
   `dist/web/`; the second regenerates `neutron.json` function metadata and
   backend input/output aliases from annotated Motoko functions.
3. `npm run mopack`
   reads `./neutron.json`, runs `mops sources`, walks dependencies from
   `./backend/<src>`, checks Motoko source for dangerous text and AST patterns,
   rewrites imports to content hashes, writes hash-named modules under
   `dist/mo/`, and writes `dist/neutron.json` with the generated `entry` hash.
   Automatic mode leaves packages with `update_source` unmarked for
   provider-hosted HTTPS source delivery. A manual-only or explicitly embedded
   package receives the generated
   `package_features: ["archive-only-legal-v1"]` marker. App authors leave that
   generated field out of source `neutron.json`.
4. `npm run schema`
   reads the generated Motoko input/output aliases and writes
   `dist/schema.json`, a wrapper-accurate JSON Schema artifact for each public
   app method.
5. `npm run package:metadata`
   generates and verifies the application notice, governing license,
   third-party notices, and package record under `dist/legal`. For an app with
   `update_source`, it also writes the exact generated Complete App Source gzip
   bytes to `<app>/.neutron/sources/<sha256>.source.v1.msgpack.gz` and records the
   update source's certified HTTPS URL. Embedded mode instead retains its
   source and bulk legal material inside the package.
6. `pack.ts`
   walks every file under `dist/`, gzips each file, MessagePack-encodes the flat
   path-to-bytes object, and writes
   `<id>.v<major>.<minor>.<patch>.neutron`.

The hello README documents the minimal developer command sequence as a root
`npm install`, then `npm run package` from `apps/hello`. `npm test` in the
hello workspace runs Bun tests for the manifest and hello method schema shape,
then validates the manifest with the shared package validator.

The app-local source artifact is publisher input, not an action for an end user.
The update-source publisher uploads it together with the package and release
pointer. Installing, upgrading, or compiling packages in a browser requires no
source publication by the Sovereign User.

### Releasing Package Updates

The version bump, authoritative package build, tracked-reference update,
production source publication, idempotent postflight, and optional Dispenser
starter procedure are maintained only in
[App Package Updates: Maintainer Release Workflow](./package-updates.md#maintainer-release-workflow).
The update-source operator's permission and recovery reference remains in
[support/update-source/README.md](../support/update-source/README.md).

### Production Offline Compile And Local Provision

The compile-only CLI lets app developers exercise production-context package
compilation outside the kernel browser UI:

```sh
bun packages/neutron-cli/src/index.ts compile \
  --package apps/kernel/kernel.v0.3.6.neutron \
  --package apps/hello/hello.v0.2.2.neutron \
  --package apps/kitchensink/kitchensink.v0.3.2.neutron \
  --wasm-out /tmp/neutron.wasm \
  --candid-out /tmp/neutron.did
```

It cannot produce a trusted local actor. Local `neutron_actor_v25` compilation
requires the verified PocketIC root context and therefore occurs only inside
the provisioner flow below.

To run the app locally, package it first, place its archive declaration
(`path`) in a format-3 PocketIC inline artifact set, keep the supervised
PocketIC server running, and reinstall the configured whole-canister fleet:

```sh
# Terminal 1
npm run provision -- MY-APP.ndeploy.json serve

# Terminal 2
npm run provision -- MY-APP.ndeploy.json reinstall
npm run provision -- MY-APP.ndeploy.json status
```

This is the only local CLI deployment path. Packaging and provisioning are
separate: the provisioner derives and validates each declared archive and
performs a destructive whole-canister reinstall on every configured node, but
never runs a workspace package script. The root `local:deploy` alias runs this
flow with `local.ndeploy.json`. The browser installer remains available when
the behavior under test is Neutron's reviewed end-user package flow. A package
whose id is `kernel` is still an operating-system replacement rather than a
normal app.

### Hello App Example

The hello app is a minimal package with one backend method and one frontend
button that calls it through the kernel dialog flow.

- `neutron.json` declares `id: "hello"`, `name: "Hello"`, `version: 202`
  (`0.2.2`),
  `src: "main.mo"`, one `main` launcher tile, one update function
  `hello_world`, and one memory namespace `hello` at version `1`.
- `backend/main.mo` stores a mutable `name` value, exposes
  `hello_world(name : Text) : Text`, returns the previous value, and updates
  `env.stable_memory.hello` with the new value.
- `src/index.tsx` uses the generic `neutron-tools` canister client to request
  the kernel-derived schema for `hello_world`, reads tile context for display,
  then renders a button that asks for a kernel-mediated call to that method on
  the Neutron canister itself.
- `build.ts` creates `dist/web/`, `mopack.ts` creates `dist/mo/` and
  `dist/neutron.json`, and `pack.ts` creates `hello.v0.2.2.neutron`.

### Kitchen Sink App Example

The kitchen sink app is the richer app-developer reference. It follows the
same package structure and declares one navigable workbench tile plus one
shared-state companion tile. Backend methods cover form persistence, echo,
arithmetic, and counters. Its frontend requests live schemas, demonstrates
confirmed and preapproved self calls, exposes typed endpoint tools, and calls
the companion through the same-app message bus. Its capability lab also shows
how an exact `backend.capabilities` selection becomes one narrow Motoko leaf:
the chain-key page fetches the real installation-bound public key and signs one
fixed harmless assertion without exposing a key name, derivation path, raw
digest, transaction, or cycle primitive. See [App-Isolated Chain-Key Assertion
Signing V1](./app-isolated-chain-key-signing.md). The stable-store page uses a
second exact leaf to demonstrate binary-safe create-if-absent, load,
compare-and-swap update, two-record live prefix pagination, schema/revision
evidence, revision delete, usage, and bounded clear-page cleanup. See
[App-Isolated Stable Store V1](./app-isolated-stable-store.md).

## Inferred Design Intent

The workflow appears to make app backend authoring mostly source-driven:
developers write annotated Motoko methods in `backend/main.mo`, then `mogen`
derives the manifest function table and wrapper type aliases from that source.
The manifest remains the package contract, while annotations reduce the amount
of duplicated function metadata an app author has to maintain manually.

The memory version and immutable source-only schema hash are the installed lineage. The
planner rejects downgrades, changed active schema hashes, ownership changes,
missing paths, and ambiguous paths before dispatching an upgrade.

The frontend workflow appears intentionally conventional: build any browser app
into `dist/web/`, use `neutron-tools` for iframe-to-kernel messages, and keep
Motoko packaging in `dist/mo/` so the final `.neutron` package can contain both
frontend assets and backend modules.

## Open Questions And Developer Experience Gaps

- `npm run package` validates `neutron.json` before `mogen` rewrites it. The
  inspected hello script does not run validation again after generated function
  metadata is written.
- `mogen` uses a regular expression over source text. Formatting changes that
  still produce valid Motoko may fail to match the generator's expected shape.
- App package scripts call the shared TypeScript script entrypoints with Bun.
  The README now names the script roles, but the future app template should
  document the annotation format and expected package outputs in one place.
- `mogen` mutates both `backend/<src>` and `neutron.json` in place, but the
  workflow has no separate check command for detecting stale generated aliases
  or stale manifest function metadata.
- `npm run watch` in the hello app only starts the esbuild watcher. It does not
  rerun `mogen`, `mopack`, validation, or package creation.
- The hello README is minimal and does not describe required annotation format,
  persistent memory naming, generated artifacts, or expected outputs.
- The package test validates `neutron.json` and asserts the icblast JSON Schema
  shape for the hello method. A future app-template package should add
  generated-artifact freshness checks, full package-shape tests, and
  end-to-end app/package/CLI smoke coverage.
- The CLI foundation still needs a polished app-template command and a
  published package that includes a kernel package artifact for one-command
  local app development.
- `mopack` rejects dangerous Motoko findings in non-whitelisted modules after
  printing their source and AST diagnostics.
- Schema source files and migration roots must remain immutable. Schema package
  imports are permitted and excluded from the schema identity hash, while a
  migration edge remains locked with its packaged dependency closure.
