# Testing And Verification

[Back to the documentation index](./index.md)

Neutron separates fast contract tests, browser tests, provisioned replica
tests, and production qualification evidence. A passing unit test proves the
tested contract; it does not turn an unmeasured production boundary into a
release claim.

## Fast Checks

Run the repository baseline from the root:

```sh
npm test
npm run typecheck
npm run security:check
```

`npm test` runs the workspace unit suites. The main layers are:

| Layer | What it checks |
| --- | --- |
| `packages/neutron-tools` | Format-3 manifest validation, package decoding, capability normalization and fingerprints, API-1 private-port self calls, generic tool attachments, repository records, runtime configuration, and helper APIs |
| `packages/neutron-motoko-capabilities` | The Motoko capability types and their bounded public surface |
| `packages/neutron-motoko-wasm` | Browser compiler initialization and compiler-package behavior |
| `packages/neutron-security` | Motoko source-policy fixtures |
| `packages/neutron-compiler` | Package preparation, `neutron_actor_v25` assembly, memory planning, capability projection, fresh compiler isolation, install journals, chunked Wasm installation, and atomic commit behavior |
| `packages/neutron-provision` | Format-3 deployment configs, schema-3 private sessions, PocketIC supervision, IC create/adopt/reinstall flows, exact production artifact pins, local path-only archives, fleet deployment, and recovery |
| `apps/kernel` | Authorization, consent, MessagePort routing, self-call binary binding, capability services, install state, certified HTTP, Settings, workspaces, trays, connections, browser wallets, Agent Mode, and runtime invalidation |
| App workspaces | Each app's manifest, backend, frontend, exposed tools, package shape, and app-specific protocol behavior |
| Support workspaces | Dispenser, update-source, and repository generation/publication contracts |

Run a focused suite while developing:

```sh
npm --workspace neutron-tools test
npm --workspace neutron-compiler test
npm --workspace neutron-provision test
npm --workspace neutron-kernel test
npm --workspace neutron-wagyu test
```

Package an app before testing its install path:

```sh
npm --workspace neutron-wagyu run package
```

The root `validate` and `package` scripts cover the checked-in app set. Tests
should not depend on generated archives being present unless the test creates
them or its command explicitly runs packaging first.

## Contract Assertions

### Packages, manifests, and assembly

The current package contract is:

- a flat MessagePack map from safe relative paths to gzip-compressed bytes;
- manifest format 3;
- a separately versioned managed-memory lock;
- bounded archive, entry, decompression, path, and module-hash checks;
- at most 255 ordinary apps plus the Kernel; and
- exact assembler identity `neutron_actor_v25`.

Compiler tests cover headless packages, typed app dependencies, managed-memory
migrations and retirement, capability quotas, physical method names, scheduled
callbacks, public ingress, browser compiler inspection/final-emission
isolation, static assets, and package conflicts.

Install tests cover:

1. `kernel_install_begin_checked`;
2. optional reservation preparation;
3. one-call or chunked management installation;
4. runtime/deployment verification;
5. `kernel_install_commit`;
6. exact retry after an ambiguous commit reply; and
7. abort and cleanup paths that leave active metadata unchanged.

The commit result is closed to `#committed` or `#blocked`. Reservation readiness
is checked before the atomic metadata, memory-retirement, capability, and asset
transition.

### Kernel-app transport

Transport tests assert that operational traffic uses a source-bound
`MessagePort`. Window messages are limited to the probe, ready, and connect
handshake that transfers the port. There is no operational Window fallback.

The tests cover:

- endpoint identity, role, installation UID, generation, and origin binding;
- replacement, navigation, logout, and uninstall invalidation;
- closed JSON request, response, progress, and tool envelopes;
- canonical `canister.schema` and `canister.call_dialog` actions;
- live tool discovery instead of app-specific Kernel schemas;
- private API-1 self-call sidecars for nested and repeated `vec nat8` values;
- exact Candid-path binding, byte/depth/element limits, and transferables; and
- the separate generic tool-attachment protocol.

See [Kernel-App Communication](./kernel-app-communication.md).

### Certified Assets and authored POST routes

Three version lanes must remain distinct in tests and documentation:

- `capabilities.certified_assets.api = 2` versions the typed storage
  declaration and backend handle;
- authored `capabilities.http_routes.api = 1` contains only bounded mutating
  `POST` handlers; and
- IC HTTP response certification version 2 protects public certified reads.

There is no authored HTTP-route API 2. The compiler synthesizes
`certified_read_routes` from the three generic collection kinds:
`publication`, `immutable_blob`, and `mutable_blob`.

Unit and Motoko fixtures cover:

- closed collection declarations, normalized mounts, quotas, and plan
  fingerprints;
- publication allocation/staging and randomized locators;
- immutable content-addressed blobs;
- mutable exact-path and keyed CAS blobs;
- ordered staging, replay receipts, atomic batches, conditional deletion, and
  lifecycle cleanup;
- fixed Host-bound and portable response policies;
- certified `404`, `GET`/`HEAD`, ranges, digest, cache, and CORS behavior;
- runtime enable/disable authority;
- API-1 POST request bounds, header filtering, idempotency, replay, rate,
  lifecycle, and cycle admission; and
- structural presence of supported-certificate-version metadata in the final
  Wasm.

The repository contains a source-owned release runner, a pass-only receipt
schema and validator, a neutral synthetic actor, and a deterministic candidate
binding. The binding identifies exact inputs and is not evidence. It covers
five neutral scopes and 12 operational cases run once on fresh canisters,
including the actor-wide cross-scope cases and separate privileged gates.

The isolated PocketIC timeline starts from a private bootstrap, keeps automatic
progress off, and explicitly normalizes to the fixed historical start
`1735689600000000000` ns. The physical phase runs first and commits 256
one-byte entries in 16 batches. At the eight-receipt boundary it advances 24
hours plus 1 ns and reclaims the receipts in one bounded page before proving
the 257th write fails without state drift. Only then does it normalize forward
to host wall time, enable automatic progress, collect exact raw-query/gateway
pairs, and run the gateway and Chromium phases.

The runner emits a receipt only after pass. Validation fails closed unless the
receipt, runner, candidate binding, compiler, assembler, generated manifests,
implementation sources, and qualified raw and transport Wasm all match the
current checkout; absent or stale is not qualified.

This receipt is bounded release-regression evidence. It does not establish
cycle cost, proof size, allocator behavior, or upgrade safety at the
100,000-entry production ceiling. The separate 100,001 declaration rejection
proves only the schema/admission ceiling.

The normal release command has an absolute three-minute wall-clock ceiling and
owns a private process group and temporary directory. Its normal timeout stops
PocketIC descendants and removes that state; the emergency hard-stop still
guarantees descendant termination but may leave the isolated temporary
directory for later operating-system cleanup.

See [Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md#qualification-status).

### Browser wallets and connections

Ethereum provider tests use EIP-6963 discovery only. They cover provider
announcements, owner choice when multiple wallets are available, focused
user-activated session creation, exact declared chains and methods, request
limits, result validation, endpoint invalidation, and session cleanup.

Connections tests keep provider metadata and credential encoding in trusted
Kernel drivers. A manifest declares only the provider ID and requested scopes.
Tests cover the reviewed OpenRouter driver, exact `(AppScope, provider)`
credential ownership, origin checks, callback state, revocation, and endpoint
invalidation.

### Provisioning

Provisioner tests use deployment config format 3 and one private schema-3
session per exact config. PocketIC configs may name rebuildable local archives
by path. IC configs require exact package identity, SHA-256, byte length, app
ID, and version, plus pinned deployment evidence.

Coverage includes:

- supervised PocketIC ownership, attachment, topology, gateway, and root key;
- one compilation reused across an ordered local fleet;
- local authorization, deterministic fixtures, and browser URL discovery;
- IC canister creation, controller transitions, adoption, reinstall, and
  immutable-payload recovery;
- per-config and deployer-wide locking; and
- cache reuse only when every bound input still matches.

See [Provisioning System](./provisioning-system.md).

## Browser And Local Replica Coverage

Playwright is configured in `playwright.config.ts`. On NixOS, enter the flake
shell so the suite uses its Chromium binary and launch arguments:

```sh
nix develop
npm run test:e2e
```

Focused root commands are:

```sh
npm run test:e2e:local
npm run test:e2e:local:ii
npm run test:e2e:local:fresh
npm run test:e2e:kitchensink
npm run test:e2e:kitchensink:fresh
npm run test:e2e:package-updates
npm run test:e2e:package-updates:fresh
```

The `:fresh` commands run the format-3 provisioner's destructive local
`reinstall` first. The non-fresh commands use the canister IDs and gateway from
`local.ndeploy.session.json`.

Current browser specs exercise:

- logged-out and locally authenticated Kernel startup;
- local Internet Identity when explicitly enabled;
- authorization and the unauthorized-owner screen;
- public static assets and multi-chunk asset reconstruction;
- launcher, workspace, fullscreen, tray, and Settings behavior;
- browser package selection, compilation, review, install, and typed calls;
- package-update discovery and review UI;
- Kitchen Sink layout and capability interactions;
- Files lifecycle, Wallet ledgers, Contacts integration, and Gemma background
  behavior;
- Motoko compiler worker startup and isolation; and
- malformed app requests and permission-dialog containment.

The browser Motoko compiler runs in a dedicated Worker. Each compile operation
starts from a fresh worker service; within that operation the inspection
compiler is disposed before a fresh final-emission compiler is created. Tests
should reproduce compiler problems against that lifecycle rather than assuming
page-thread state.

App-owned Playwright suites may have additional prerequisites and evidence
contracts. Read the app's local E2E README before running those suites.

Files keeps its self-contained inline-worker Chromium check outside normal
packaging:

```sh
npm --workspace neutron-vfs run release:browser
```

That command starts a temporary loopback harness, reports the result to
stdout, and writes no package input or browser-evidence artifact. Neither
`npm --workspace neutron-vfs run package` nor `npm run build:all` launches it.
Use `npm --workspace neutron-vfs run test:browser-release` for the focused test
wrapper.

## Evidence Discipline

Keep these claims separate:

- a unit fixture proves a bounded function or source contract;
- a Playwright test proves behavior in its recorded browser/replica setup;
- a PocketIC run proves only that pinned local environment;
- a live-network smoke proves only the exercised path; and
- production qualification requires complete measurements bound to the exact
  implementation, package lock, synthetic actor, and final assembled Wasm.

Do not infer certification, cycle cost, maximum-state safety, or upgrade safety
from source inspection alone. Do not use app-specific fixtures as proof of a
generic Kernel capability unless the generic contract and adversarial
boundaries are exercised directly.

## Remaining Priorities

- Retain and validate a current Certified Assets qualification receipt for each
  release candidate; rerun whenever its candidate or runner binding changes.
- Add more live-replica coverage for maximum-state certified responses,
  allocator churn, retries, upgrade continuity, and browser verification.
- Broaden browser-install failure coverage for compile errors, rejection,
  rollback, duplicate app IDs, and progress recovery.
- Exercise the complete paid production Dispenser path, including ambiguous
  replies and controller retirement.
- Continue cross-app isolation tests for capabilities whose unit fixtures do
  not yet cross a real canister/browser boundary.

## Relevant Sources

- `package.json`
- `playwright.config.ts`
- `test/e2e/`
- `packages/neutron-tools/test/`
- `packages/neutron-compiler/test/`
- `packages/neutron-provision/test/`
- `apps/kernel/test/`
- `apps/kernel/evidence/certified_assets_candidate_binding.ts`
- `apps/kernel/evidence/qualification/`
- `packages/neutron-tools/src/certified_assets_qualification.ts`
