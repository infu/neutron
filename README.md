# Neutron kernel

**Personal cloud computer**

Decentralised, user-customizable, user-controlled, community-driven kernel for operating
systems running on ICP.

Neutron is meant to be fully open. A user owns a Neutron canister, can install
apps into it, and can deliberately replace the kernel with any `.neutron`
kernel package they choose. Forking the kernel, changing the operating system
rules, and installing that fork is an intended option, not an exception.

Backend is in Motoko.

Documentation: http://ntron.net code: devs

## Build commands

Run repository commands from the repository root:

```sh
npm run build
npm run package
npm run repository:generate
```

`build` runs the independent workspace builds. `package` runs each production
app's complete packaging workflow and creates its `.neutron` archive.
`repository:generate` consumes the packaged Hello and Kitchen Sink archives and
generates the static example repository's Motoko resources. The generator is a
separate phase because it cannot run before those archives exist.

To run all three phases in dependency order:

```sh
npm run build:all
```

App package scripts include their own app build, so `build:all` deliberately
repeats that app-local stage while also covering independent workspace builds.
It generates the repository source but does not compile or deploy the example
repository canister. Browser and end-to-end tests are separate test commands;
`build:all` does not launch Playwright.

## Design principles

- Kernel is replacable by users.
- Kernel only provides capabilities and security, no system apps - no Sherlocking.
- All apps are equal.
- Kernel is what makes apps work on different distros
- Distros are packs of apps + kernel, later customizations/themes

## Documentation

Start with the [documentation index](doc/index.md) for the current architecture,
core contracts, repository map, and suggested reading paths.

### Foundations And Architecture

- [Product Model And User Story](doc/product-model-and-user-story.md) explains what a user-owned Neutron is and how ownership, apps, and the replaceable Kernel fit together.
- [Security Model](doc/security-model.md) defines the trust boundary, app isolation model, capabilities, authorization, and recovery authority.
- [Repository And Build Topology](doc/repository-and-build-topology.md) maps the monorepo, package pipeline, generated outputs, and component ownership.
- [Compiler And Actor Assembly](doc/compiler-and-actor-assembly.md) explains how the Kernel and app packages become one checked Motoko actor and install plan.
- [Kernel Backend Runtime](doc/kernel-backend-runtime.md) documents the Motoko services, authorization, static assets, HTTP entrypoints, and self-upgrade path.
- [Kernel Frontend Runtime](doc/kernel-frontend-runtime.md) documents the trusted React shell, workspaces, authentication, dialogs, endpoints, and brokers.
- [Kernel-App Message Bus](doc/kernel-app-communication.md) defines the private `MessagePort` protocol connecting the Kernel, tiles, trays, and resident backgrounds.

### App Development

- [App Developer Guide](doc/app-developer-guide.md) is the practical starting point for building a third-party `.neutron` app.
- [App Development Workflow](doc/app-development-workflow.md) covers the local build, package, install, and iteration loop used by regular apps.
- [App Package Format](doc/app-package-format.md) specifies the format-3 manifest, archive layout, modules, assets, and validation rules.
- [Backend App Dependencies](doc/backend-app-dependencies.md) explains typed, install-time composition between app backends inside the generated actor.
- [App Method Access And Call Consent](doc/app-method-access-and-call-consent.md) separates canister-level method access from trusted-UI consent for calls.
- [App Tray](doc/app-tray.md) defines tray declarations, resident-background requirements, badges, and private tray actions.
- [App And Agent Install Offers](doc/app-install-offers.md) explains how apps and agents may present packages without gaining installation authority.
- [Evolving Candid Interfaces](doc/candid-interface-evolution.md) gives compatibility rules for independently upgraded Candid services and clients.
- [Managed Memory Migrations And Uninstall](doc/memory-migrations-and-uninstall.md) covers durable schemas, migration graphs, retirement, and safe data removal.
- [Neutron Design System](doc/design-system.md) describes the shared UI package and conventions for consistent app frontends.

### Capabilities, Data, And HTTP

- [Kernel Capability Inventory](doc/kernel-capability-inventory.md) lists every authored and derived capability and its runtime projection.
- [Asset Storage And HTTP Serving](doc/asset-storage-and-http-serving.md) explains package assets, staging, certified records, public routes, and serving behavior.
- [Certified HTTP And Certified Assets](doc/kernel-http-v2-and-certified-assets.md) defines app-scoped certified collections and their fixed public-read policies.
- [App-Isolated Stable Store](doc/app-isolated-stable-store.md) documents the development implementation of bounded, installation-scoped durable binary storage.
- [App-Isolated vetKeys](doc/app-isolated-vetkeys.md) explains the implemented key-slot contract, browser recovery, lifecycle state, and remaining release gates.
- [App-Isolated Chain-Key Signing](doc/app-isolated-chain-key-signing.md) documents development-stage domain-separated assertion signing without exposing raw threshold authority.

### Deployment, Releases, And Operations

- [Unified Provisioning System](doc/provisioning-system.md) is the canonical contract for local and production creation, reinstall, verification, and recovery.
- [Local Development And Deployment](doc/bootstrap-local-development-and-deployment.md) is the PocketIC setup and deployment runbook.
- [Production Provisioning](doc/production-provisioning.md) covers IC creation, adoption, destructive reinstall, controller handling, and deployment evidence.
- [Dispenser And Provisioning](doc/dispenser-and-provisioning.md) documents the developer-preview SushiOS bootstrap, payment, provisioning, and one-time activation handoff.
- [Repository Setup Manifests](doc/repository-setup-manifests.md) defines repository-delivered setup offers without creating a marketplace or automatic install path.
- [App Package Updates](doc/package-updates.md) is the canonical version-bump, packaging, publication, verification, and owner-reviewed update workflow.
- [Testing And Verification](doc/testing-and-verification.md) describes fast checks, browser tests, replica tests, and production qualification evidence.
- [Playwright](doc/playwright.md) explains repeatable local browser tests and explicitly enabled interactive investigation.

### Planning

- [Developer Experience Roadmap](doc/developer-experience-roadmap.md) records workflow improvements still planned for Kernel, app, and integration developers.
- [Open Questions And Design Gaps](doc/open-questions-and-design-gaps.md) collects unresolved cross-cutting questions and is not a statement of current authority.
