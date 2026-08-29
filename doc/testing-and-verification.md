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
npm run license:check
```

Run all four as separate repository gates. In particular, `npm test` does not
imply the type, security, or license checks, and the license check validates the
declared application-license boundary independently of the test suites.

`npm test` runs the workspace unit suites. The main layers are:

| Layer | What it checks |
| --- | --- |
| `packages/neutron-tools` | Format-3 manifest validation, package decoding, capability normalization and fingerprints, API-1 private-port self calls, generic tool attachments, repository records, runtime configuration, and helper APIs |
| `packages/neutron-motoko-capabilities` | The Motoko capability types and their bounded public surface |
| `packages/neutron-motoko-wasm` | Browser compiler initialization and compiler-package behavior |
| `packages/neutron-security` | Motoko source-policy fixtures |
| `packages/neutron-compiler` | Package preparation, active and predecessor-compatible assembly, memory planning, capability and browser-surface projection, fresh compiler isolation, install journals, chunked Wasm installation, and atomic commit behavior |
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
- an exact assembler identity selected and recorded by the compiler.

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

Within the message-bus protocol, transport tests assert that operational
traffic uses a source-bound `MessagePort`. Window messages are limited to the
probe, ready, and connect handshake that transfers the port. There is no
operational Window fallback. The persistent-origin cleanup qualification has a
separate, source- and origin-bound iframe result delivered by Window messaging;
that cleanup result is not operational message-bus traffic.

The tests cover:

- endpoint identity, role, installation UID, generation, and origin binding;
- replacement, navigation, logout, and uninstall invalidation;
- closed JSON request, response, progress, cancellation, and tool envelopes,
  including cancellation by the matching port and request ID and release of a
  cancelled local request ID for reuse;
- universally available compatibility names `canister.schema` and
  `canister.call_dialog`, plus
  anonymous-discovery `canister.schema_v2` and prepared
  `canister.call_dialog_v2` actions;
- canonical v2 argument review and dispatch, plus unit-level construction of
  complete prepared arguments for Agent consent; installed Blast qualification
  separately binds a nested challenge to its requester and allow/deny decision
  without asserting the challenge action payload;
- quoted and escape-safe trusted display of arbitrary Candid method names;
- live tool discovery instead of app-specific Kernel schemas;
- direct-root-only exact installed-artifact tools, including closed schemas,
  cancellation, metadata-only audit, revision and cursor binding, and rejection
  before asset I/O for unscoped or delegated-child calls;
- private API-1 self-call sidecars for nested and repeated `vec nat8` values;
- exact Candid-path binding, byte/depth/element limits, and transferables; and
- the separate generic tool-attachment protocol.

See [Kernel-App Communication](./kernel-app-communication.md).

Installed-artifact service tests use injected list/read and app-binding
adapters. They cover ordinary app subtree confinement, Kernel build-inventory
mapping, content-addressed Motoko closure traversal, shared dependencies and
repeated roots, missing or corrupt required roots, absent historical roots,
literal-search pagination, UTF-8 chunk boundaries, binary and oversized-file
handling, opaque cursor misuse, cancellation, and target-local cache and
revision invalidation. Package-generation tests bind the Kernel inventory to
the exact packaged files, cover inline inspection of package-owned
HTTP-internal system documents, and exclude runtime-generated and
content-addressed artifacts handled by the runtime catalog. These tests
exercise the bounded frontend inspection functions and installed-path mapping.
They do not claim to recover original workspace source or inspect generated
Wasm as source text.

### Browser surfaces and media

For release evidence, run the standalone Chromium qualification from the
repository root inside the locked flake environment and record the browser
identity output with the pass result:

```sh
nix develop -c bash -lc '
  set -euo pipefail
  "$PLAYWRIGHT_CHROMIUM_EXECUTABLE" --version
  npm run test:browser-media
'
```

Setting `PLAYWRIGHT_CHROMIUM_EXECUTABLE` outside that pinned environment is
useful for local diagnosis but is not release qualification by itself. The
qualification proves browser behavior for explicit camera/microphone delegation
and denial, child-document policy narrowing, Kernel `frame-ancestors`
containment, passive package-response replay, and the persistent-origin
predecessor/current transition. That transition registers a predecessor
Service Worker, writes IndexedDB, closes the old client, loads the reserved
cleanup iframe, and proves that the successor keeps its data while receiving no
controller or registrations. It also proves that current HTTP-served Service
Worker and SharedWorker entrypoints are denied while same-origin dedicated
Workers remain available. Request-destination qualification does not establish
denial of blob-backed SharedWorkers; those remain nonce-origin-confined and lose
cross-install reach when that nonce rotates.
The test intentionally does not require synchronous destruction of the
already-running predecessor worker context, which browser APIs do not provide.
Unit and integration fixtures separately cover manifest normalization, exact
tile binding, installation-derived origins, credentialless fallback,
Host/path/destination admission, CSP and Permissions Policy headers, certified
surface variants, sidecar lifecycle, and frame invalidation.

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

For each Kernel release candidate, freeze, check, and qualify the exact
candidate from the repository root, in that order:

```sh
npm --workspace neutron-kernel run certified-assets:candidate-binding:write
npm --workspace neutron-kernel run certified-assets:candidate-binding
npm --workspace neutron-kernel run certified-assets:qualify
```

The write command updates the deterministic candidate binding, the check
command requires that binding to match the current checkout, and the
qualification command runs the release boundary and emits the pass-only
receipt. Kernel unit tests also reject a stale checked binding, but that does
not replace this explicit release sequence. App packaging and the repository
baseline do not run `certified-assets:qualify` transitively.

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

The `certified-assets:qualify` command has an absolute three-minute wall-clock
ceiling and owns a private process group and temporary directory. Its normal
timeout stops PocketIC descendants and removes that state; the emergency
hard-stop still guarantees descendant termination but may leave the isolated
temporary directory for later operating-system cleanup.

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
NEUTRON_E2E_WITH_II=1 npm run test:e2e:package-updates
npm run test:e2e:package-updates:fresh
npm run test:browser-media
```

The `:fresh` commands run the format-3 provisioner's destructive local
`reinstall` first. The non-fresh commands use the canister IDs and gateway from
`local.ndeploy.session.json`. The package-update spec intentionally skips when
`NEUTRON_E2E_WITH_II` is not `1`, so an unprefixed non-fresh success is not
evidence that the spec ran. Use the explicit prefix above; the `:fresh` script
sets it itself.

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

The standalone browser-media command is a focused qualification runner rather
than a Playwright spec in the normal E2E suite.

The browser Motoko compiler runs in a dedicated Worker. Each compile operation
starts from a fresh worker service; within that operation the inspection
compiler is disposed before a fresh final-emission compiler is created. Tests
should reproduce compiler problems against that lifecycle rather than assuming
page-thread state.

App-owned Playwright suites may have additional prerequisites and evidence
contracts. Read the app's local E2E README before running those suites.

Blast releases require a separate installed qualification that root `npm test`
does not run. Package the current Kernel and Agent candidates, then run Blast's
complete release gate:

```sh
npm --workspace neutron-kernel run package
npm --workspace neutron-agent run package
npm --workspace neutron-blast run verify:release
```

`verify:release` packages and tests Blast, then installs the current packaged
Kernel, Agent, and Blast candidates with its qualification-only driver in a
fresh private PocketIC and exercises the installed browser boundary.

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
