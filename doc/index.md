# Neutron Agent Reference

Use this directory to locate implementation owners, understand invariants, and
choose the correct change and verification workflow. Source code is the final
authority. Read repository `AGENTS.md` before acting on production state or
release artifacts.

Keep these docs durable: cite source paths and symbols, not line numbers. Read
active versions, package names, resource limits, deployment state, and script
inventories from their owners instead of copying snapshots here. Retain exact
identifiers where they define a stable protocol, schema, API, fixed migration
boundary, or immutable compatibility artifact. Separate implemented behavior
from planned work and record test results with their candidate evidence rather
than maintaining passing-test counts in architecture docs. Put active plans
and TODO files in gitignored `tmp/`.

Neutron is a user-owned operating-system canister. The Kernel is its replaceable
trust root. Ordinary apps are packages assembled into the same actor, but they
receive authority only through a closed manifest, a canonical capability plan,
compiler-projected handles or registrations, and runtime checks bound to the
exact app installation.

```text
package manifest
    -> canonical CapabilityPlan
    -> owner review
    -> compiler projection
    -> AppScope-bound runtime enforcement
```

The literal `kernel` package is the only app identity the Core special-cases.
Adding an ordinary app that uses existing primitives must not require a Kernel,
compiler, shared-tools, or provisioner source change.

## Current Contract At A Glance

- One human owner operates one Neutron; controllers remain recovery and
  deployment authority.
- One generated Motoko actor contains the Kernel and all installed app
  backends.
- Every ordinary app instance is identified by `AppScope = (app_id,
  installation_uid)`, its capability-plan fingerprint, deployment identity,
  and browser-origin authority.
- App packages use manifest format 3. Apps may be tile-based, resident,
  backend-only, or otherwise headless. A tray is valid only with a resident
  background.
- Installation and resident-resource bounds are validated by the shared
  capability planner and runtime. Read their current limits from source before
  changing admission or app declarations.
- Public mutating HTTP routes use `http_routes` API 1 and bounded `POST`
  handlers. Certified read routes are synthesized from Certified Assets
  collections; apps do not author a second route protocol.
- Certified Assets has three closed collection kinds: `publication`,
  `immutable_blob`, and `mutable_blob`.
- App operational messaging uses a source-bound private `MessagePort`.
  `window.postMessage` is used only for the ready/probe/port-transfer
  handshake.
- Ordinary app surfaces use installation-owned, per-surface origins when their
  package carries the generated readiness marker. Camera and microphone remain
  default-deny and may be delegated only to exact declared tiles; media stays
  in the browser and does not pass through the Kernel backend.
- Self calls use one API-1 value model. Nested `Uint8Array` values travel as
  transferable sidecars and are bound to live Candid `vec nat8` leaves.
- Provisioning accepts deployment config format 3 and provision journal schema
  3. PocketIC offers the app-neutral `minimal` and
  `full_protocol_fixtures` environments.

## Start Here

| Goal | Document |
| --- | --- |
| Understand runtime ownership | [Product Model And Runtime Boundaries](./product-model-and-user-story.md) |
| Understand the trust boundary | [Security Model](./security-model.md) |
| Build an app | [App Developer Guide](./app-developer-guide.md) |
| Understand the package | [App Package Format](./app-package-format.md) |
| Understand capabilities | [Kernel Capability Inventory](./kernel-capability-inventory.md) |
| Understand compilation and installation | [Compiler And Actor Assembly](./compiler-and-actor-assembly.md) |
| Understand license, package, build, and module records | [License And Deployment Records](./license-and-deployment-records.md) |
| Understand browser messaging | [Kernel-App Message Bus](./kernel-app-communication.md) |
| Publish certified content | [Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md) |
| Release app updates | [App Package Updates](./package-updates.md#maintainer-release-workflow) |
| Provision or recover deployment state | [Unified Provisioning System](./provisioning-system.md) |

## Architecture

- [Repository And Build Topology](./repository-and-build-topology.md) maps the
  monorepo and generated outputs.
- [Kernel Backend Runtime](./kernel-backend-runtime.md) explains the Motoko
  services assembled into every Neutron.
- [Kernel Frontend Runtime](./kernel-frontend-runtime.md) explains the trusted
  shell, workspaces, endpoint registration, and broker surfaces.
- [Compiler And Actor Assembly](./compiler-and-actor-assembly.md) covers
  projection, method naming, stable memory, browser compilation, and the
  install transaction.
- [Candid Interface Evolution](./candid-interface-evolution.md) describes
  state-preserving interface changes.
- [Managed Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md)
  describes schema locks, migration graphs, retirement, and deletion.
- [License And Deployment Records](./license-and-deployment-records.md) records
  package-information and deployment-record contracts, source evidence, and
  immutable predecessor compatibility.

## App Development

- [App Developer Guide](./app-developer-guide.md) is the task-oriented entry
  point.
- [Deprecated Compatibility Paths](./deprecated.md) records planned removals
  and the replacements new and existing apps should adopt.
- [App Package Format](./app-package-format.md) is the manifest and archive
  reference.
- [App Development Workflow](./app-development-workflow.md) covers build,
  package, install, and iteration.
- [Backend App Dependencies](./backend-app-dependencies.md) covers typed calls
  between installed app backends.
- [App Method Access And Call Consent](./app-method-access-and-call-consent.md)
  covers authorized methods, public ingress, and consent.
- [App Tray](./app-tray.md) covers tray declarations and private tray actions.
- [App And Agent Install Offers](./app-install-offers.md) covers install offers
  without granting an app installation authority.
- [Package Updates](./package-updates.md) is the canonical version-bump,
  packaging, provider-hosted source publication, verification, simultaneous
  one-click Kernel/app cutover, and optional starter release workflow, followed
  by the update protocol reference.

## Capabilities And Data

- [Kernel Capability Inventory](./kernel-capability-inventory.md) lists declared
  and derived authority.
- [Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md)
  defines the three certified collection kinds and their fixed read policy.
- [Asset Storage And HTTP Serving](./asset-storage-and-http-serving.md)
  distinguishes package assets, staging, certified app records, and public
  ingress.
- [App-Isolated Stable Store](./app-isolated-stable-store.md) covers bounded
  durable key/value stores.
- [App-Isolated vetKeys](./app-isolated-vetkeys.md) covers encrypted-key slots
  and generation rotation.
- [App-Isolated Chain-Key Signing](./app-isolated-chain-key-signing.md) covers
  domain-separated threshold signing.

## Deployment And Operations

- [Unified Provisioning System](./provisioning-system.md) is the canonical
  provisioner contract.
- [Local Development And Deployment](./bootstrap-local-development-and-deployment.md)
  is the PocketIC workflow.
- [Production Provisioning](./production-provisioning.md) covers IC creation,
  adoption, recovery boundaries, and deployment evidence.
- [Dispenser And Provisioning](./dispenser-and-provisioning.md) describes the
  product bootstrap path.
- [Repository Setup Manifests](./repository-setup-manifests.md) defines
  repository-delivered setup data.
- [Testing And Verification](./testing-and-verification.md) lists the release
  and security gates.
- [Playwright](./playwright.md) covers browser automation in local development.

## Product And App Contracts

- [Product Model And Runtime Boundaries](./product-model-and-user-story.md) explains
  the owner, apps, and lifecycle.
- [Neutron Design System](./design-system.md) defines trusted-shell and app UI
  conventions.
- [Developer Tooling Boundaries](./developer-experience-roadmap.md) maps workflow
  ownership and source discovery.
- [Open Questions And Design Gaps](./open-questions-and-design-gaps.md) records
  unresolved design work; it is not a description of current authority.
- [Feedback Implementation Contract](./feedback-plan.md) covers private
  submissions, scoped identities, moderator authority, discussions, unread
  state, and agent tools.
- [EVM Wallet And Consumer Apps](./evm-wallet.md) describes the separate wallet,
  custody lifecycle, shared client, IC bridge, Kitchen Sink and Uniswap flows.
  [Transaction decoder packs](../apps/evm_wallet/src/decoders/README.md) explains
  extensible protocol presentation, import provenance and readable Activity.
  The [research](./evm-wallet-research.md) records design choices.
  [Uniswap V4 and liquidity](./uniswap-v4-liquidity.md) records contract research,
  browser position discovery and durable UI/Agent execution.
- [Curve swaps and liquidity](../apps/curve/README.md) documents the Ethereum
  Wallet integration, supported pools, durable execution and qualification.
- [Aave lending and borrowing](../apps/aave/README.md) documents market positions,
  collateral and debt management through EVM Wallet.
- [Hyperliquid perpetuals](../apps/hyperliquid/README.md) covers browser trading,
  Agent chart/orderbook tools, and Ethereum/Arbitrum USDC transfers.

## Repository Map

```text
apps/
  kernel/                 trusted frontend and backend Kernel
  */                      ordinary first-party apps
packages/
  neutron-tools/          protocol, app SDK, Kernel-side helpers, schemas
  neutron-compiler/       package preparation, actor assembly, installation
  neutron-motoko-wasm/    isolated browser/Node Motoko compiler service
  neutron-provision/      PocketIC and IC deployment pipeline
  neutron-motoko-capabilities/
                          public Motoko capability leaf types
support/
  dispenser/              product bootstrap service
  update-source/          package publication infrastructure
  marketplace/            catalog, repository access, and production publisher
  feedback/               private support protocol
doc/                      architecture and operational contracts
```

Generated files are outputs, not independent design authorities. Change the
source manifest, catalog, compiler template, or service that owns a contract,
then regenerate its actor, Candid, registry, archive, or evidence output.
