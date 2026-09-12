# Repository And Build Topology

[Back to the documentation index](./index.md).

Use this reference to locate the owner of a build or deployment change. Keep
package construction, fresh provisioning, and state-preserving in-product
updates separate. Read workspace scripts and deployment configs for the current
command inventory and package selection.

## Monorepo layout

The root `package.json` is private and owns the npm workspaces, shared lockfile,
cross-workspace checks, and developer commands.

- `apps/kernel/` contains the React operating-system UI, Motoko kernel backend,
  package build, generated complete-actor source, and Kernel tests.
- `apps/*/` contains first-party Neutron application packages. Each app owns a
  `neutron.json` and its package workflow. Source layout and test scripts vary
  by app; inspect its manifest and workspace `package.json`.
- `../ntmux/` is the separate sibling Ntmux workspace. It owns the Ntmux app,
  TypeScript protocol and CLI packages, native daemon/platform packages,
  deployment config, and tests. Its workspace scripts are separate from this
  repository's root checks.
- `packages/neutron-tools/` contains shared manifest, runtime, URL, schema, and
  browser/package utilities.
- `packages/neutron-scripts/` owns manifest generation, Motoko dependency
  packing, package validation, and `.neutron` archive construction.
- `packages/neutron-security/` performs the static Motoko policy checks used by
  packaging and compilation.
- `packages/neutron-compiler/` decodes packages, plans package installation,
  assembles and compiles the complete actor, prepares certified assets, and
  supplies checked in-canister install helpers.
- `packages/neutron-motoko-wasm/` and
  `packages/neutron-motoko-capabilities/` provide the vendored compiler and
  capability/runtime support consumed by the compiler and tests.
- `packages/neutron-cli/` is a production-context compile-only CLI. It can turn
  explicit package files into explicit Wasm and Candid outputs; it does not
  deploy canisters or synthesize a local PocketIC identity.
- `packages/neutron-provision/` is the only production or local provisioning
  system. It owns archive-only format-3 configs, schema-3 sessions, local
  archive-identity derivation, production/release pin validation, IC
  creation and destructive reinstall, PocketIC supervision, local fleet reset,
  authorization, fixture setup, asset seeding, and verification. It does not
  build app workspaces or execute app scripts.
- `packages/neutron-design-system/` is the shared scoped app UI system.
- `support/dispenser/` is the user-facing support dispenser product, not a
  developer-local Neutron deployment mechanism.
- `support/repository/` is the static `neutron-repo-v1` example provider and
  deterministic resource generator.
- `packages/neutron-provision/src/local_fixtures.ts`,
  `local_chain_fixtures.ts`, and the provisioner-owned `assets/` directory hold
  the app-neutral local fixture logic and pinned fixture inputs.
- `support/update-source/` is the reference developer-owned certified update
  source and supplies assets for the provision-owned local fixture.
- `support/marketplace/` owns the Marketplace protocol and production catalog
  publisher invoked by `npm run updates:publish`.
- `support/feedback/` owns the shared Feedback protocol. These support canisters
  are separate from the app backends assembled into a user's Neutron.

The root workspaces are `packages/*`, `apps/*`, and `support/*`. The shared
`icblast` client is installed from its public npm package rather than linked to
a sibling checkout. npm remains the dependency installer and owns the one
`package-lock.json`; Bun runs migrated TypeScript scripts and tests. Rust
components retain their own Cargo manifests and locked builds.

## TypeScript and test boundaries

The shared TypeScript baseline is:

- `tsconfig.base.json` for strict common compiler options;
- `tsconfig.bun.json` for Bun/Node scripts and tests;
- `tsconfig.browser.json` for browser code without server globals;
- workspace-specific `tsconfig.json` files; and
- root `tsconfig.json` as the project-reference entrypoint.

Run `npm run typecheck` for the complete referenced TypeScript graph. Root
`npm run test:unit` runs an explicit list of workspace suites; adding a
workspace or a new test script does not automatically add it to the root suite.
Inspect root and workspace scripts to select complete checks for a change. Run
the sibling workspace's scripts for Ntmux. Browser tests are separate because
they need a live local Neutron and Chromium.

## Root build phases

The root build is split into explicit source-build, app-package, and repository
generation phases:

```sh
npm run build
npm run package
npm run repository:generate
```

`npm run build` fans out only to workspaces that expose an independent `build`
script. App builds create browser output and generated metadata, but do not
create `.neutron` archives. `npm run package` runs the complete production app
package workflows and produces those archives. `npm run repository:generate`
then reads the archives declared in `support/repository/repository.json`,
validates their contents, and writes
`support/repository/mo/GeneratedRepository.mo`.

The repository generator intentionally exposes `generate`, not a workspace
`build` lifecycle. This keeps the generic workspace fan-out valid on a clean
checkout where ignored package archives do not exist yet. Run the complete
ordered pipeline with:

```sh
npm run build:all
```

The app package commands include their own app builds, so this comprehensive
pipeline repeats those app-local builds after the independent workspace build
phase. Browser and end-to-end suites remain separate test commands;
`build:all` does not launch Playwright. Repository Wasm compilation remains
the separate `neutron-example-repository` `build:wasm` command.

## Package construction

Applications follow one target-neutral package contract. A typical package
script runs these stages:

1. `validate` checks the closed `neutron.json` schema and static backend policy.
2. `build` creates the frontend and regenerates manifest function metadata.
3. `mopack` resolves `mops sources`, rewrites backend imports, hashes Motoko
   modules, and writes the packaged backend graph.
4. `pack` MessagePack-encodes the complete `dist/` tree with individually gzip
   compressed entries and names the archive from its app id and release.

Kernel uses the same single `package` command. It has one browser entrypoint and
does not compile a gateway, identity provider, local flag, or canister ID into
the archive. No build writes a local/production marker. Package loading
rejects an archive containing the removed `.neutron-build.json` marker. Packing
a non-Kernel app adds the shared browser-surface-origin metadata; keep it under
the shared packer's ownership. See [Planned Deprecations](./deprecated.md) for
older app-origin compatibility paths.

Common stored paths are:

| Generated artifact | Producer | Purpose |
| --- | --- | --- |
| `dist/web/**` | each app's frontend build | package browser assets |
| `dist/mo/<sha256>.mo` | `neutron-scripts/src/mopack.ts` | shared content-addressed Motoko modules |
| `dist/neutron.json` | `mopack.ts` | packaged manifest with its hashed backend entry |
| `<id>.v<release>.neutron` | `neutron-scripts/src/pack.ts` | universal package archive |
| `apps/kernel/backend/_neutron.mo` | Kernel assembly build | generated complete-actor source used by Kernel build checks |
| `support/repository/mo/GeneratedRepository.mo` | repository generator | deterministic certified repository resources |
| requested Wasm/Candid output paths | `neutron-cli compile` | explicit compile-only artifacts |
| `.neutron/cache/compiled/**` | `neutron-provision` | verified local complete-actor compile cache |
| deployment config or optional artifact-set JSON | trusted package/release workflow | local archive paths or a closed set of exact release pins |
| `.neutron/provision/**` | `neutron-provision` | temporary binary payload for one active paid IC operation |

Build and test output such as `dist/`, `.neutron/`, Playwright reports, and test
results is generated state and is ignored where appropriate. Canister identity
is recorded in the config's `.ndeploy.session.json`, not in a separate mapping
directory.

## Artifact preparation and compile cache

Workspace dependency discovery, Mogen, frontend compilation, generated-file
cleanup, Motoko packing, and archive construction belong to the trusted
package/release workflow. Provision configuration has no workspace path, build
command, or hook. The canonical PocketIC inline set contains a kernel path and
an ordered app-path list; developers do not maintain SHA-256, byte length, id,
or version fields. IC inline sets and external release artifact sets retain
complete `{path, sha256, bytes, id, version}` pins.

Loading a path-only PocketIC config retains only its relative declarations;
`serve`, `status`, and `authorize` do not stat, read, or hash those archives.
Local `reinstall` containment-resolves and reads each archive once, deriving
its exact bytes, digest, package identity, version, and kernel/app role. The
derived digest remains an internal input to the complete-actor cache,
operation fingerprint, and deployment receipt. Production/release preparation
instead verifies every declared pin. Unknown artifact-set fields, duplicate ids
or paths, archive drift during an operation, and symlink escapes fail closed.
Production create and nonce-stamped reinstall do not use the rebuildable local
compile cache. Caching changes work, never desired state.

## Compile and deployment boundaries

There are three deliberately separate consumers of package data:

- Kernel's browser installer uses `neutron-compiler` for reviewed,
  state-preserving app transactions inside an existing Neutron.
- `neutron-cli compile` performs an offline compile into caller-selected Wasm
  and Candid paths. It requires at least one `--package`, both output paths,
  and uses only the compiler-pinned production context. Its environment option,
  when present, accepts only `production`.
- `neutron-provision` derives exact identity for declared local archives or
  validates production/release pins, compiles the whole actor, installs or
  reinstalls it, restores certified assets, and verifies the running system.
  It never invokes a package build. Reinstall is destructive and is not an
  upgrade path for production Neutrons; preserve production state through the
  checked in-product transaction and explicit memory migrations.

The browser transaction is a product feature. It is not a substitute for local
provisioning. Local development has no per-app CLI install, uninstall, upgrade,
or unchanged no-op. It also has no offline local compile: only the attached
provisioner possesses the verified PocketIC root context required by the
compiler. The compiler selects the supported assembler generation from the
Kernel package; its retained predecessor path does not enable newer browser
origin declarations. See `packages/neutron-compiler/src/assemble.ts`.

Target differences enter only during complete actor compilation and final
runtime binding. The same `.neutron` bytes feed both targets. Once the final
canister ID is known, the provisioner writes the certified closed-schema
`/system/runtime-config.json`. The schema and target validation live in
`packages/neutron-tools/src/runtime_config.ts`. The record includes the exact
isolated-frame origin template and the explicit provision-owned local update-source origin. IC uses
`null` for “no origin override” and derives the standard `.icp0.io` origin from
each package's manifest source principal; Kernel validates the runtime record
before initializing browser network clients or frames.

The assembler separately compiles a trusted immutable
`installation.network_id` into the actor. Production derives it from the
compiler-pinned IC mainnet root-key SPKI DER; PocketIC derives it from the
exact status root key of the attached pinned instance. Runtime config,
manifests, and app scripts cannot supply it. Every local fleet node receives
the same network identity but its own canister-bound runtime config.

## Unified provisioning workflow

Production and local configs use the same entrypoint:

```sh
bun packages/neutron-provision/src/index.ts CONFIG.ndeploy.json create
bun packages/neutron-provision/src/index.ts CONFIG.ndeploy.json reinstall
bun packages/neutron-provision/src/index.ts CONFIG.ndeploy.json serve
bun packages/neutron-provision/src/index.ts CONFIG.ndeploy.json status
bun packages/neutron-provision/src/index.ts CONFIG.ndeploy.json authorize PRINCIPAL
```

`create` is IC-only. IC creation and destructive reinstall require `--execute`
to mutate and support `--yes` to skip the CLI prompt. The IC-only `adopt` command
records verified ownership of an existing canister without installing anything;
it accepts `--execute` but rejects `--yes`. See
[Production Provisioning](./production-provisioning.md) before using any IC
operation. PocketIC uses `serve`, `status`, an always-executing `reinstall`, and
`authorize`; `authorize` is rejected for IC configs.

The root local aliases are thin wrappers over the current
[`local.ndeploy.json`](../local.ndeploy.json):

```sh
npm run local:start
npm run local:deploy
npm run local:authorize -- PRINCIPAL
npm run local:status
```

`local:start` starts or attaches to one repository-wide checksum-pinned
PocketIC process, one persisted instance, its selected fixtures, and the fixed
browser gateway. `local:deploy` destructively reinstalls its configured
package set, `local:authorize` grants a principal on its deployed fleet, and
`local:status` verifies and reports the recorded runtime.

Another format-3 local config can attach its own session to the live supervisor
rather than starting a competing server. After a trusted package workflow
rewrites archives at the declared local paths, its direct `reinstall` command
derives their exact identity, compiles the complete actor once, then installs
or destructively reinstalls every node in the ordered config fleet. When there
is a current receipt, a changed module after an in-product update does not
prevent explicit local reset: the verified supervisor and recorded canister
identity determine the target. An in-progress reinstall still verifies the
module for every phase it resumes. It restores the complete configured package
set, applies a separately canister-bound runtime configuration, authorizes the
deterministic developer
plus the target's configured `authorized_principals` on every node, funds
provision-owned fixtures according to their fleet policy, and reports every
labeled browser URL. The format-3 `authorize` command adds and verifies a
temporary principal fleet-wide without changing the deployment receipt; the
next full reinstall resets each node to the developer plus the configured
desired-state list.

Format-3 `status` verifies the recorded PocketIC runtime and the
config-to-session binding, then reports its gateway and instance plus all
recorded labeled canisters and URLs. It does not call each fleet node; the
`authorize` command is the one that verifies every node's status, module hash,
and controllers.

Every writable format-3 config derives exactly one schema-3 session, even when
several configs share the repository-wide PocketIC supervisor. That file holds
runtime descriptor data, the sole ordered `localFleet` mapping for PocketIC,
permanent IC creation evidence when applicable, the latest verified
deployment, and at most one active operation. Fleet index zero is the
default node. A production operation may remain marked complete in
`active` while payload cleanup is pending; rerunning its executing command
finishes that cleanup. Production crash recovery uses a temporary binary
payload; completed operations do not retain archive JSON bundles.

## Certified asset boundary

Package preparation rewrites Kernel files to root/package paths, app files to
`/app/<id>/`, and shared Motoko modules to `/mo/<sha256>.mo`. Fresh provisioning
seeds the complete file set into the newly installed actor's static namespace;
it does not use an asset clear as an upgrade mechanism.

Identical files resolving to one final content-addressed path are deduplicated;
conflicting bytes for one path fail. Uploads may be scheduled concurrently, but
each `kernel_static` update carries exactly one file operation or one subsequent
chunk for that file. The implementation never puts multiple files in one update
call.

## Support package boundaries

The support canisters have their own product/protocol deployment lifecycles.
They do not replace `neutron-provision` for developer-local Neutrons. Local
browser and E2E helpers read the running canister, gateway, and PocketIC runtime from
the selected config's provision session, while deriving the deterministic
developer identity from that config's seed.

PocketIC fixture lifecycle is provisioner-owned. The `minimal` profile provides
local authentication, its lean NNS trust-root subnet, and the provision-owned
update source. `full_protocol_fixtures` additionally attaches the remaining
system subnets, starts persistent Bitcoin Core regtest and Anvil services, installs the pinned
ledger/index and native-minter fixtures, and funds them through their native
paths. The server synchronizes `support/update-source/assets` and records the
source canister in the session; each Neutron binds only that recorded origin.
The fixture's seeded contents come from that assets directory; read it rather
than assuming a release catalog exists. Its origin applies only to packages
that name its principal. This does not introduce a workspace deployment
command.

## Verification Boundaries

Use `packages/neutron-provision/test/` for config, journal, artifact, cache,
recovery, and fixture behavior. Select affected workspace checks from each
`package.json`; a successful build is not release-test evidence. Live fleet
verification must still perform management installation, asset restoration,
authorization, fixture funding, runtime-identity checks, and browser
verification on every configured node even when compilation is cached.

Production package changes follow [App Package Updates](./package-updates.md)
and [Memory Migrations](./memory-migrations-and-uninstall.md), including
versioning, state compatibility, atomic publication, and verified no-op
postflight. Publishing a catalog does not modify existing Neutrons or the
Dispenser starter.
