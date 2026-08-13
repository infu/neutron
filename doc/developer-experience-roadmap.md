# Developer Experience Roadmap

[Back to the documentation index](./index.md)

Neutron serves three developer groups:

- Kernel developers maintain the canister, browser shell, installer, and
  compiler integration.
- App developers build target-neutral `.neutron` packages.
- Integration developers operate PocketIC and browser suites.

The current workflow is intentionally narrow: package first, select archives
with a format-3 config, and use `neutron-provision` for the complete
deployment.

## Current Commands

Repository build phases:

```sh
npm run build
npm run package
npm run repository:generate

# Complete ordered pipeline
npm run build:all
```

The repository generator consumes packaged Hello and Kitchen Sink archives, so
it is not part of the independent workspace `build` fan-out. App `package`
scripts run their app-local build again as part of producing authoritative
archives.

Fast repository checks:

```sh
npm test
npm run typecheck
```

Local deployment:

```sh
# Terminal 1
npm run local:start

# Terminal 2
npm run local:deploy
npm run local:status
```

Another local config or fleet:

```sh
# Terminal 1
npm run provision -- CONFIG.ndeploy.json serve

# Terminal 2
npm run provision -- CONFIG.ndeploy.json reinstall
npm run provision -- CONFIG.ndeploy.json authorize PRINCIPAL
npm run provision -- CONFIG.ndeploy.json status
```

Browser tests:

```sh
npm run test:e2e:local
npm run test:e2e:local:ii
```

Production-context offline compile:

```sh
bun packages/neutron-cli/src/index.ts compile \
  --package apps/kernel/kernel.v0.3.6.neutron \
  --package apps/hello/hello.v0.2.1.neutron \
  --wasm-out /tmp/neutron.wasm \
  --candid-out /tmp/neutron.did
```

There is no developer CLI for per-app local install, uninstall, or bootstrap.
Those are reviewed product flows in the browser. Local provisioning always
installs the complete configured actor.

## Current Boundaries

- `packages/neutron-scripts` validates, builds, packs, and archives apps.
- `packages/neutron-compiler` prepares packages, assembles
  `neutron_actor_v25`, compiles it, and plans checked browser installs.
- `packages/neutron-provision` owns format-3 deployment config, schema-3
  journals, IC create/adopt/reinstall, the supervised PocketIC environment,
  fleet reinstall, authorization, fixtures, and verification.
- `packages/neutron-cli` is a filesystem adapter for production-context
  compilation only.

Provisioning consumes archives. It never discovers workspaces, runs package
scripts, or branches on app IDs. PocketIC path-only declarations make archive
rebuilds cheap; production declarations remain exactly pinned.

Each config owns one `CONFIG.ndeploy.session.json`. Local tools resolve the
gateway and ordered fleet from that journal. Package and compiler hashes bind
operations and cache entries, but are derived rather than hand-maintained for
the local path.

## Tooling

The repository keeps npm workspaces and the root lockfile as dependency truth.
Bun runs TypeScript scripts and unit tests. Browser bundles use the established
esbuild paths, and Playwright validates installed behavior.

On NixOS:

```sh
nix develop
```

Use Bun tests for pure package/compiler/state behavior and Playwright for real
browser behavior.

## Near-Term Priorities

1. Make package-to-declared-path plus one local reinstall the complete
   documented first-run path for an external app repository.
2. Improve package and compile-cache diagnostics without adding another
   deployment state format.
3. Add disposable format-3 test configs that attach to the shared PocketIC
   supervisor.
4. Expand browser coverage for install review, authorization, and interrupted
   reinstall recovery.
5. Publish the app template, manifest tooling, design system, and compiler
   helpers without repository-relative assumptions.
6. Keep packages target-neutral and installation identity explicit in compile
   and deployment receipts.

## Non-Goals

- Per-app developer deployment commands.
- icp-cli mappings as deployment state.
- Separate local and production package archives.
- App-specific provisioner hooks or profiles.
- More than one journal for a config.

See [Local Development And Deployment](./bootstrap-local-development-and-deployment.md),
[Provisioning System](./provisioning-system.md), and
[Testing And Verification](./testing-and-verification.md).
