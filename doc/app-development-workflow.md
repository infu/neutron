# App Development Workflow

[Back to the documentation index](./index.md)

Use this page when changing an app's source, generated interface, package, or
local deployment. The [App Developer Guide](./app-developer-guide.md) explains
individual APIs; the owning source and workspace scripts define the executable
contract. Read `AGENTS.md` before changing production state or release bytes.

## Source Entry Points

| Concern | Source of truth |
| --- | --- |
| Workspace commands and dependencies | Root and app `package.json`, root lockfile |
| Minimal working package | `apps/hello/` |
| Capability and tool examples | `apps/kitchensink/` |
| Manifest validation | `packages/neutron-tools/src/validate_schema.ts` and the shared schemas |
| Annotated methods and aliases | `packages/neutron-scripts/src/mogen.ts` |
| Module packaging and memory lineage | `packages/neutron-scripts/src/mopack.ts` |
| Method inspection schemas | `packages/neutron-scripts/src/method_schema.ts` |
| License, notice, and offered source | `packages/neutron-scripts/src/package_metadata.ts` |
| Final archive and browser readiness marker | `packages/neutron-scripts/src/pack.ts` |
| Browser SDK and identity discovery | `packages/neutron-tools/src/app.ts` |
| Checked installation | `packages/neutron-compiler/src/install.ts` |

Hello has released identity, license, and memory history. Copying its directory
does not create a clean app. Follow the
[new-project cleanup procedure](./app-developer-guide.md#create-or-copy-an-app-project)
before reusing it.

## Authoring Contract

The manifest's `src` selects the Motoko module under `backend/`. An ordinary
app is not an independent canister actor. When the compiler projects a backend
environment, the app exports `Init(env : AppBackendEnvironment)`;
environment-free apps export `Init()`. `createBackendEnvironment` and
`createModule` in `packages/neutron-compiler/src/assemble.ts` define that choice.
The compiler builds the combined actor and emits authorized public wrappers.

Persistent data belongs in declared managed-memory roots. Backend code imports
the active immutable schema and restores `env.stable_memory.<root>`. Declare
only the structural environment fields the app consumes. Capabilities and
backend dependencies supply additional compiler-owned fields; do not construct
replacement authority in app code.

When a backend environment is generated, an app that consumes
`env.installation.network_id` receives public deployment identity derived from
the trusted network root key. It is not a secret or a permission. Trusted local
network context comes from the provisioner; app manifests and browser
configuration cannot choose it. See
[Compiler And Actor Assembly](./compiler-and-actor-assembly.md).

### Function Annotations Consumed By `mogen`

Keep the annotation directly between `public func` and the method name:

```motoko
public func /*update*/hello_world(name : Text) : Text {
  // ...
};
```

| Annotation | Generated role |
| --- | --- |
| `/*update*/` | Owner-authorized update wrapper |
| `/*query*/` | Owner-authorized query wrapper |
| `/*internal*/` | Internal method |
| `/*internal:apps*/` | Internal method exported to declared backend dependencies |
| `/*query:unauthorized*/` | Kernel-only public entrypoint; ordinary apps use `public_ingress` |

The regex-based generator rewrites `neutron.json.func` and the
`NEUTRON GENERATED` alias block in the backend. It distinguishes synchronous,
`async`, and `async*` methods. Explicit injected-argument comments remove only
the named trailing parameters from the public input alias. Do not postprocess
generated aliases to invent a second ABI.

For paid public-ingress handlers, the supplemental-cycle argument is an exact
route-only opt-in. It does not grant a generic cycle primitive, and a
best-effort supplement is not payment assurance for committed work. Use the
[public-ingress contract](./app-method-access-and-call-consent.md) when changing
annotations or admission behavior.

Motoko `Blob` remains Candid `vec nat8`, including nested and multiple blob
leaves. Browser self calls use canonical `Uint8Array` leaves; the trusted
runtime binds and meters attachments against live Candid. Generated
`dist/schema.json` is an inspection artifact, not runtime authority.

## Preserve Memory Before Packaging

For a new app, declare an initial schema, its `Mem` type and `init()`, the
active version, and the complete memory declaration. For an existing app:

1. Identify every released memory root and its lock lineage.
2. Restore unchanged roots at their existing schema version.
3. For a schema change, add immutable successor schema and forward migration
   modules with one valid path from each supported installed version.
4. Test clean initialization and representative upgrades, including skipped
   releases.
5. Review and retain the generated `neutron.lock.json`.

App release versions and memory schema versions are independent. Checked
updates require higher package releases; fresh destructive provisioning has
different version semantics and is not a production upgrade mechanism.
[Managed Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md)
owns the migration and retirement contract.

## Frontend And Runtime Integration

Build browser assets into `dist/web/` and import app-facing helpers from
`neutron-tools/app`. Use document-relative assets and SDK URL helpers. Current
packaging adds the browser-surface readiness marker; test tiles, trays, and
backgrounds on their assigned app origins. New apps should not depend on the
[deprecated compatibility paths](./deprecated.md).

`loadNeutronCanisterId()` first resolves supported runtime URLs and falls back
to validated runtime metadata when needed. `loadTileContext()` exposes display
context; query parameters do not establish caller authority.
`createCanisterClient()` routes calls through the Kernel. App self calls use
the private self-call transport, while new external-canister integrations
should require the versioned tools. An exposed tool handler uses its supplied
`context.kernel` for nested requests so invocation provenance is retained.

Use [App Method Access And Call Consent](./app-method-access-and-call-consent.md)
for live-schema argument encoding, preapproval, cross-app authority, and
cancellation. A cancelled mutating call may already have committed; reconcile
its result before retrying.

Use `neutron-design-system` for shared style primitives and inspect
`apps/kitchensink/` for working integration patterns. The
[Design System](./design-system.md) documents composition and approval boundaries.
Read tokens and visual checks from the package instead of copying their
changing values into app documentation.

## Build And Verify

Read the app's current `package.json` before running its scripts. From the
repository root:

```sh
npm --workspace <app-workspace-name> run package
npm --workspace <app-workspace-name> test
```

The complete workspace package command owns ordering. Shared phases validate
the manifest, build the frontend, generate method metadata, package Motoko and
memory lineage, produce inspection schemas and legal/source records, and pack
the final archive. The exact app script may combine these phases differently.

Validation is not limited to a preliminary script: `mopack.ts` validates the
manifest it consumes after method generation, and package-metadata generation
also checks the source manifest. Do not infer missing validation merely from
the position of `validate` in a workspace script.

A frontend watcher does not necessarily regenerate backend aliases, package
modules, or archives. Inspect the watcher script and rebuild through the full
package command before installation. Review generated diffs; fix shared
generator defects in the owning tool rather than editing its output.

A successful package command does not imply all release tests ran. Inspect the
app's test scripts and cover managed memory, backend behavior, SDK/tool
contracts, and affected browser surfaces. Some test commands package first and
therefore mutate generated outputs. Keep scratch plans and TODO files in the
gitignored repository-root `tmp/` directory.

License and source packaging must use the shared workflow. New apps default to
`LICENSE.APP.USE`; an intentional sharing license uses `LICENSE.APP`.
Released packages retain their exact terms until an explicit higher release.
See [License And Deployment Records](./license-and-deployment-records.md).

## Local Provisioning And Production Release

The compile-only CLI exercises production-context assembly without deploying:

```sh
bun packages/neutron-cli/src/index.ts compile \
  --package path/to/kernel.neutron \
  --package path/to/app.neutron \
  --wasm-out /tmp/neutron.wasm \
  --candid-out /tmp/neutron.did
```

For a disposable local fleet, put packaged archives in a PocketIC deployment
config, run its supervised server, then run the explicit whole-canister
`reinstall` operation. The provisioner consumes archives; it does not build
workspaces. See [Local Development And Deployment](./bootstrap-local-development-and-deployment.md)
for commands and state-loss boundaries.

Use the checked browser transaction when testing app installation or upgrading
an existing Neutron. Production publication, exact-byte reconciliation,
required repeat-publication no-op, and optional Dispenser starter updates are
defined in [App Package Updates](./package-updates.md#maintainer-release-workflow).
Do not derive a production release procedure from the disposable local loop.
