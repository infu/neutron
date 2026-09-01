# Product Model And User Story

Neutron is a personal operating system deployed as one Internet Computer
canister. The user owns the canister, chooses its apps, reviews their authority,
and can replace the Kernel without turning app publishers into canister
operators.

The product is designed to feel like an ordinary app workspace. Cryptography,
certification, app-installation identity, cycle accounting, and revocation are
platform work under that interface, not terminology every app must expose.

## Product Principles

1. **The user owns the computer.** The Neutron canister and its state are not a
   hosted account in an app publisher's service.
2. **Kernel is the operating-system trust root.** It owns authentication,
   installation, capability review, runtime mediation, browser isolation,
   certification, and recovery surfaces.
3. **Apps are ordinary packages.** They do not gain special Core behavior from
   their name or from being first-party.
4. **The owner may trust a provider app.** An exact installed Wallet or other
   provider may own domain semantics and decide how to use its own declared
   authority. Kernel still isolates it as an ordinary app and never imports its
   data model into platform policy.
5. **Authority is explicit and finite.** A package can use only closed
   primitives declared in its manifest and approved for its exact
   installation.
6. **One actor is still modular.** Kernel and app backends compile into one
   Motoko actor, while compiler-created scopes and handles preserve app
   boundaries.
7. **Normal UI comes first.** Security detail belongs in install review,
   Settings, diagnostics, or help unless the user must act on it.

## The Neutron

A Neutron contains:

- the Kernel backend and trusted browser shell;
- installed app backends;
- app package assets and generated Candid/runtime metadata;
- app-isolated stable memory and Kernel-owned broker state;
- certified static and app-published HTTP state;
- an app registry and canonical capability plans; and
- the user's authorization, workspaces, settings, and recovery state.

The compiler assembles these parts into one actor. The canister remains the
management, payment, upgrade, and public-network identity.

The compiler also derives a 32-byte public network ID from the trusted
deployment root key. Apps may use it to distinguish local and production
networks, but it grants no authority.

## Roles

### Owner

The owner:

- authenticates to the trusted Kernel shell;
- installs, updates, enables, disables, and removes apps;
- reviews capability changes;
- grants runtime permissions such as a provider connection or browser-wallet
  session;
- uses app tiles, trays, notifications, and agent workflows; and
- manages authorized principals and recovery choices.

Neutron currently models one human owner. Multiple authenticated principals may
be authorized as that owner, but there is no multi-user role hierarchy.

### Controller

A canister controller has management-plane power: changing code, settings, or
controllers. Controllers are recovery and deployment actors, not ordinary app
users. A controller principal is not implicitly an authorized UI owner.

### App Publisher

A publisher builds and publishes or serves exact package bytes through a
repository or update source. Current source-update provenance is not a
publisher signature. The package may propose capabilities and updates, but the
publisher does not become a controller and cannot silently widen an installed
app's authority. For a source-discoverable production app, the provider also
hosts the package-bound Complete App Source object once. Installing, upgrading,
or privately compiling that package does not make the Sovereign User a source
publisher and does not disclose the user's selected package set or combined
Wasm.

Agent inspection of exact installed artifacts helps the owner evaluate provider
code and detect suspicious use of authority. It remains defense in depth:
installed frontend bundles may be minified, transformed or unretained build
material may be unavailable, and review cannot prove runtime semantics. Closed
capabilities, source-bound identity, exact one-shot decisions, bounded values,
and retry reconciliation remain enforcement boundaries.

### App

An app is a manifest, backend source, assets, memory declarations, and optional
frontend surfaces. It may be:

- one or more disposable tiles;
- a resident background;
- a tray surface attached to that resident;
- backend-only;
- a combination of those; or
- fully headless.

Every newly added app ID receives a unique `installation_uid`. Updating that
same ID retains its `AppScope`; removing and later re-adding it allocates a new
UID and therefore new authority.

An owner-trusted provider is still an app in this model. For example, Wallet
may interpret ICRC metadata, decimals, fees, accounts, allowances, and Agent
spending policy for its own tools. That trust does not let Wallet select Kernel
identity, bypass AppScope isolation, access another app's memory, or turn ICRC
into a Core concept. Another asset standard may use another Wallet app with an
analogous app-level contract.

That provider model is intended for operational balances delegated to the
owner's trusted apps and live agents. It is not a promise that assets remain
safe from a malicious installed Wallet package, and it does not yet provide
standing unattended spend budgets.

### Kernel And Provisioner

The Kernel enforces runtime policy. The compiler converts reviewed declarations
into exact code and registrations. The provisioner creates or reinstalls the
canister and verifies the deployed result. None of these layers is an
app-specific orchestration service.

## User Lifecycle

### 1. Create Or Recover A Neutron

Production creation selects exact packages, payment, subnet, controllers, and
deployment evidence. The provisioner compiles the target actor, creates the
canister, uploads the Wasm, initializes the fresh Kernel, seeds certified
runtime assets, authorizes the owner, and verifies the resulting module,
runtime, access, and browser entrypoint.

An existing canister may be adopted only after live verification. A destructive
reinstall preserves its verified controller set and records a new deployment
receipt.

Local development uses the same package/compiler/install model on PocketIC.

### 2. Sign In

The owner authenticates through the Kernel. The trusted shell binds the
principal, current authorization, canister, root key, and runtime before
exposing app surfaces.

Local development uses the pinned PocketIC identity fixture and local
authorization path; it does not require production Internet Identity.

### 3. Install An App

The Kernel obtains the exact `.neutron` package and prepares it under bounded
decode rules. The manifest is normalized into a canonical capability plan.

The review screen presents meaningful changes:

- backend canister-call authority;
- external HTTPS endpoints;
- stable stores, keys, timers, and scheduled work;
- public protocol and HTTP routes;
- certified publication/storage quotas;
- browser-wallet methods and chains;
- provider connections;
- camera or microphone access for exact tiles;
- persistent or dedicated resident origins;
- typed app dependencies; and
- memory migrations or retirement.

Approval authorizes the compiled target plan, not future package behavior. The
browser may compile while review is open, but approval remains unavailable until
compilation succeeds; install then verifies the target actor before commit.

### 4. Use Apps

Tiles are disposable interactive views. Resident backgrounds may refresh data,
maintain app services, expose declared tools, or drive tray state. Trays are
small private views opened by the trusted shell.

The browser message bus uses private ports, so apps use the SDK without
receiving direct access to Kernel stores or other frames. Backend capability
handles are injected directly into the generated actor and scoped to the exact
installation.

An approved tile that declares camera or microphone access calls the browser's
media APIs directly. The Kernel supplies only the certified child policy and
exact iframe delegation; it does not proxy the stream, run a media session, or
replace the browser's permission prompt and device indicators.

Apps can call their own backend with native nested binary values. User review
shows binary path, size, and digest instead of rendering arbitrary bytes.

An exact app tool may opt into one provider-owned decision. Kernel first
authenticates the requesting and provider endpoints and validates the tool
input. The provider resident must then call its one-use
`presentUserInterface()` callback before preparing an effect. Kernel opens or
focuses that provider's exact tile and routes a bounded opaque request only to
its private foreground tool. The provider tile prepares authoritative facts,
renders its own modal, and performs or rejects the operation. Kernel does not
render a dialog or interpret the provider's domain fields. A session grant
cannot replace the decision, which resumes only that call.

Wallet keeps the public `wallet_fund_v1` contract for existing cross-app Swap
callers and uses this route for human funding. One Wallet decision accepts
either a direct ICRC-1 transfer or an exact short-lived ICRC-2 allowance; a
pull-based Swap then executes `icrc2_transfer_from` through its own reviewed
authority without another owner prompt. Wallet, not Kernel, owns token
metadata, formatting, fee and spender meaning, durable idempotency, approval
enumeration, and revocation. Kernel retains the old raw-review callback only as
a compatibility lane for already-published providers such as Wallet 0.3.6.

### 5. Connect External Authority

Some capabilities require an owner action after installation:

- reserving a remote canister/method for backend calls;
- authorizing a reviewed provider connection;
- starting a focused browser-wallet session;
- consenting to a one-off app backend call; or
- enabling an app capability in Settings.

A provider-mediated operation is different from a generic app backend call.
The owner has already chosen to trust the exact provider package and receives
one provider-owned per-operation decision in that app's tile. For autonomous
work, Wallet exposes a separate direct-root tool which shares its checked
prepare/execute core but opens no Wallet or Kernel UI. Kernel makes that tool
visible only to the active live depth-zero root and rejects human or nested
agent calls before provider dispatch. Agent Mode still requires the owner to
enable an exact agent version and start each root turn from its focused tile
with transient user activation; it does not yet create an unattended
background principal or standing spend authority.

Install-time backend reservation defaults may be approved with the package and
materialized by the compiled target. The UI also supports later explicit
changes where the capability allows them.

### 6. Update

An update is prepared against the currently installed actor. The Kernel shows
capability and migration differences, validates dependencies and stable
signatures, compiles a fresh target, and runs the journaled install transaction.

Both unchanged and updated app IDs retain their `AppScope`. An update binds the
existing scope to the new version, plan, deployment, and app generation and
reconciles changed resources. Browser-origin identity also remains stable
unless its resident security mode changes. Remove and re-add is the operation
that creates a new UID. A code replacement or capability change still
invalidates mounted frames and transient frontend grants even when the
underlying installation origin is retained. App-owned semantic work that cannot
be bounded inside the atomic commit remains the app's responsibility after
activation.

### 7. Disable Or Remove

Disabling a runtime capability changes the live registry and revocation epoch.
The broker checks that state on use and after asynchronous calls. A successful
toggle also changes the runtime capability-authority revision observed by the
trusted frontend, which tears down every app frame and transient grant before
reloading current authority.

Removing an app retires its:

- capability resources and reservations;
- scheduled work;
- resident endpoints and private browser authority;
- connection flows and credentials;
- certified storage scope;
- app registry and package assets; and
- managed memory according to the explicit retirement plan.

One deployment may remove at most 64 apps, so large inventory reductions are
performed through successive installs.

## App And Resource Scale

The supported target is hundreds of small apps without turning every app into
a resident browser process.

Current structural limits are:

| Resource | Limit |
| --- | ---: |
| Installed app instances, including Kernel | 256 |
| Ordinary packages in a deployment config | 255 |
| App removals in one install commit | 64 |
| Resident backgrounds | 32 |
| Scheduled tasks actor-wide | 64 |
| Connections `(AppScope, provider)` actor-wide | 256 |

Tile-only, backend-only, and headless apps consume no resident-frame slot.
Capabilities have additional per-app and global quotas based on their physical
cost.

## Local Product Environments

PocketIC has two app-neutral profiles:

- `minimal` runs the Neutron platform, local authentication, update source, and
  the infrastructure required to deploy and use ordinary apps.
- `full_protocol_fixtures` additionally runs the chain, ledger, index, minter,
  and funding fixtures used by protocol-heavy development.

A config may declare up to 16 named Neutron nodes. All nodes receive the same
ordered package set and authorization policy. The profile is environment data,
not a hidden choice based on an installed app.

## Product Boundaries

Neutron deliberately does not provide:

- arbitrary app-authored Kernel policy or HTTP response configuration;
- a plugin system inside the Kernel;
- ambient cross-app browser access;
- app-selected OAuth endpoints or wallet brands;
- an app-specific provisioning hook;
- unlimited background processes, timers, storage, or public ingress;
- a guarantee that certified absence means an app-level record is terminal; or
- transparent migration of unsupported preproduction deployment state.

Product inventories such as starter packages are declarative product data.
They are not Kernel allowlists and do not change ordinary app authority.

## Related Documents

- [Security Model](./security-model.md)
- [App Package Format](./app-package-format.md)
- [Kernel Capability Inventory](./kernel-capability-inventory.md)
- [Compiler And Actor Assembly](./compiler-and-actor-assembly.md)
- [Unified Provisioning System](./provisioning-system.md)
