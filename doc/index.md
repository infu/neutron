# Neutron Documentation

This directory describes the current Neutron architecture. Source code is the
final authority; these documents explain the contracts that the compiler,
Kernel, app SDK, and provisioner enforce together.

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
- The supported inventory is 256 installed app instances including Kernel, at
  most 64 app removals in one install commit, and at most 32 resident
  backgrounds.
- Public mutating HTTP routes use `http_routes` API 1 and bounded `POST`
  handlers. Certified read routes are synthesized from Certified Assets
  collections; apps do not author a second route protocol.
- Certified Assets has three closed collection kinds: `publication`,
  `immutable_blob`, and `mutable_blob`.
- App operational messaging uses a source-bound private `MessagePort`.
  `window.postMessage` is used only for the ready/probe/port-transfer
  handshake.
- Self calls use one API-1 value model. Nested `Uint8Array` values travel as
  transferable sidecars and are bound to live Candid `vec nat8` leaves.
- Provisioning accepts deployment config format 3 and provision journal schema
  3. PocketIC offers the app-neutral `minimal` and
  `full_protocol_fixtures` environments.

## Start Here

| Goal | Document |
| --- | --- |
| Understand the product | [Product Model And User Story](./product-model-and-user-story.md) |
| Understand the trust boundary | [Security Model](./security-model.md) |
| Build an app | [App Developer Guide](./app-developer-guide.md) |
| Understand the package | [App Package Format](./app-package-format.md) |
| Understand capabilities | [Kernel Capability Inventory](./kernel-capability-inventory.md) |
| Understand compilation and installation | [Compiler And Actor Assembly](./compiler-and-actor-assembly.md) |
| Understand browser messaging | [Kernel-App Message Bus](./kernel-app-communication.md) |
| Publish certified content | [Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md) |
| Release app updates | [App Package Updates](./package-updates.md#maintainer-release-workflow) |
| Run or reinstall a Neutron | [Unified Provisioning System](./provisioning-system.md) |

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

## App Development

- [App Developer Guide](./app-developer-guide.md) is the task-oriented entry
  point.
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
  packaging, update-source publication, verification, and optional starter
  release workflow, followed by the update protocol reference.

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
  adoption, destructive reinstall, and deployment evidence.
- [Dispenser And Provisioning](./dispenser-and-provisioning.md) describes the
  product bootstrap path.
- [Repository Setup Manifests](./repository-setup-manifests.md) defines
  repository-delivered setup data.
- [Testing And Verification](./testing-and-verification.md) lists the release
  and security gates.
- [Playwright](./playwright.md) covers browser automation in local development.

## Product And UI

- [Product Model And User Story](./product-model-and-user-story.md) explains
  the owner, apps, and lifecycle.
- [Neutron Design System](./design-system.md) defines trusted-shell and app UI
  conventions.
- [Developer Experience Roadmap](./developer-experience-roadmap.md) records
  remaining workflow improvements.
- [Open Questions And Design Gaps](./open-questions-and-design-gaps.md) records
  unresolved design work; it is not a description of current authority.

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
doc/                      architecture and operational contracts
```

Generated files are outputs, not independent design authorities. Change the
source manifest, catalog, compiler template, or service that owns a contract,
then regenerate its actor, Candid, registry, archive, or evidence output.
