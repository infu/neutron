# Neutron App Developer Guide

[Back to the documentation index](./index.md)

Use this guide when creating or changing a `.neutron` app. It records authoring
contracts and repository workflows for coding agents. Read `AGENTS.md` before
editing production apps; installed state and released memory lineage are durable.

Resolve implementation details from these sources instead of copying release
snapshots into documentation:

| Question | Source of truth |
| --- | --- |
| Manifest fields, app identity, and release encoding | `packages/neutron-tools/src/schema.ts`, `app_ids.ts`, and `version.ts` |
| SDK helpers and message contracts | `packages/neutron-tools/src/app.ts` and `protocol.ts` |
| Backend capability types | `packages/neutron-motoko-capabilities/src/lib.mo` |
| Packaging and generated metadata | `packages/neutron-scripts/src/` and the app's `package.json` |
| Install validation and actor generation | `packages/neutron-compiler/src/install.ts` and `assemble.ts` |
| Runtime authority and frame behavior | `apps/kernel/src/expose.ts`, `frame_context.ts`, and `app_frame_security.ts` |
| Build, test, and deployment commands | Root/workspace `package.json`, `flake.nix`, and `packages/neutron-provision/src/` |

Examples below use illustrative app IDs, schema versions, and limits. They do
not identify the latest release or authorize new Kernel policy limits. Check
[planned deprecations](./deprecated.md) before choosing a compatibility API.

## Table Of Contents

1. [What You Are Building](#what-you-are-building)
2. [Prerequisites](#prerequisites)
3. [Create Or Copy An App Project](#create-or-copy-an-app-project)
4. [Project Layout](#project-layout)
5. [Write The Motoko Backend](#write-the-motoko-backend)
6. [Expose Backend Methods](#expose-backend-methods)
7. [Compose App Backends](#compose-app-backends)
8. [Write The Frontend](#write-the-frontend)
9. [Use The Shared Design System](#use-the-shared-design-system)
10. [Call The Kernel From The App](#call-the-kernel-from-the-app)
11. [Add A Resident Background Process](#add-a-resident-background-process)
12. [Add An App Tray](#add-an-app-tray)
13. [Use External Connections](#use-external-connections)
14. [Use Backend Capabilities](#use-backend-capabilities)
15. [Run Scheduled Backend Work](#run-scheduled-backend-work)
16. [Validate, Build, And Package](#validate-build-and-package)
17. [Run Locally](#run-locally)
18. [Install Into A Local Neutron Canister](#install-into-a-local-neutron-canister)
19. [Test Your App](#test-your-app)
20. [Security And Trust Rules](#security-and-trust-rules)
21. [Package Contents](#package-contents)
22. [Current Limitations](#current-limitations)
23. [References](#references)

## What You Are Building

A Neutron app is a package installed into a user's Neutron canister. It is not
a separate canister. The app package contributes:

- a Motoko backend module under `backend/`;
- optional browser frontend assets under `dist/web/`;
- a `neutron.json` manifest that names the app, its backend source, exposed
  methods, memory namespaces, optional launcher tiles and resident background,
  optional app tray, external connection declarations, descriptions, and
  version;
- hashed Motoko modules under `dist/mo/`;
- a final `<id>.v<major>.<minor>.<patch>.neutron` package.

When a user installs the package, the Kernel combines the already-installed
Kernel and apps with your app module, compiles one Motoko actor, uploads any
frontend assets, and upgrades the user's Neutron canister.

Every Neutron canister has one human owner; it is not a shared multi-user
workspace. App data, resident state, files, connections, and settings in that
canister belong to that owner. The owner may use multiple authorized principals
for recovery identities or trusted tools, but they all address the same owner
state. Do not build user lists, roles, invitations, or per-user partitions
around those principals. Technical dispenser/self principals may also exist
for provisioning and canister management, but they are not app users.

Use `apps/hello/` as a minimal source template and `apps/kitchensink/` for
multi-surface, message-bus, capability, and shared design-system examples.
Copy Hello only with the cleanup procedure below: its released identity and
memory history must not become a new app's lineage.

## Prerequisites

Install repository dependencies from the repository root:

```sh
npm install
```

For local replica/browser testing on NixOS, enter the repository flake shell:

```sh
nix develop
```

The shell configures the runtime tools and Playwright browser. Read `flake.nix`
and `playwright.config.ts` for executable selection and launch arguments; do
not duplicate those environment defaults in an app. Browser Motoko compilation
executes in a dedicated Worker rather than on the page thread.

Package construction uses Mops to resolve `mops sources`. Local canister
deployment itself is owned by `neutron-provision`; it uses the pinned PocketIC
binary directly and does not require `icp` or icp-cli project state. Neutron
compiles Motoko with its bundled Wasm compiler, so an unrelated `moc` found on
the shell `PATH` is not used for app compilation. The repo uses npm workspaces
and Bun-run TypeScript scripts, with the root `package-lock.json` as the
dependency install source of truth.

## Create Or Copy An App Project

The tracked example is already a released app, and a working checkout can also
contain ignored build outputs. Run this sequence only against the newly copied
destination, before making app-specific changes:

```sh
cp -R apps/hello apps/my_app
rm -rf apps/my_app/.mops apps/my_app/.neutron apps/my_app/dist \
  apps/my_app/node_modules
rm -f apps/my_app/*.neutron apps/my_app/neutron.lock.json \
  apps/my_app/*.tsbuildinfo apps/my_app/.DS_Store
rm -f apps/my_app/test/memory_release.test.ts
mv apps/my_app/backend/memory/hello \
  apps/my_app/backend/memory/my_app
```

The removed lock, archives, and TypeScript archive-transition test belong to
Hello's immutable release history; do not rename or reuse them for a new app.
This cleanup is valid only for a new package id that has never been released.
For a successor of an existing app, preserve its lock, released schemas and
migrations, version lineage, archives, and predecessor fixtures.
Then update:

- `package.json`: workspace name and app metadata, governing license, and test
  scripts;
- `neutron.json`: app identity, first release version, memory ids and schema
  paths, surfaces, capabilities, and update-source choice;
- `backend/main.mo` and `backend/memory/my_app/`: module names, managed-memory
  fields, defaults, and app methods;
- `src/`, `public/`, `README.md`, and `NOTICE`: all app-facing names, content,
  assets, copyright information, and license notice;
- the repository application-license classification and `LICENSES.md`: add the
  new workspace under its selected governing license;
- the repository test, validation, packaging, and TypeScript project lists:
  enroll the new workspace because these root gates do not discover it
  automatically;
- tracked package archives and fixtures: retain only the exact new-app release
  evidence required by its tests; keep disposable archives and scratch work in
  the ignored repository-root `tmp/` directory;
- `test/package.test.ts` and `test/memory_release.test.mo`: replace every
  Hello-specific assertion and keep a clean-initialization and retained-root
  test appropriate to the new schema.

Finish the rename by reviewing every remaining template reference:

```sh
rg -ni 'hello' apps/my_app
```

After resolving those references and changing the workspace name, run
`npm install` again from the repository root so the root `package-lock.json`
records the new workspace before its first build or test.

For a new app, default `package.json` `license` to
`LicenseRef-Neutron-Sovereign-Application-Use-License-1.0` and replace the copied
`NOTICE` with the matching application notice. Choose
`LicenseRef-Neutron-Sovereign-Application-License-1.1` only deliberately when
recipients may modify and share the app. The metadata step supplies the shared
repository license text; do not copy, shorten, or paraphrase it into the app.

Do not inherit the example's `update_source` by accident. Set it to the
distribution channel's operated source only when the app will be published
there; otherwise omit it for manual updates. See
[License And Deployment Records](./license-and-deployment-records.md) and
[App Package Updates](./package-updates.md). Never relabel an already published
package in place; a license change requires a higher app release.

Use a package id that passes the manifest and installer rules:

- lower-case letters and digits, with only single underscores between non-empty segments;
- 4 to 30 characters;
- no leading, trailing, or repeated underscores, so `__` remains compiler-owned;
- not `kernel`;
- stable over the package lifetime, because install paths use it.

The manifest `name` is also validated: use 3 to 20 ASCII letters, digits, or
spaces. Unknown top-level manifest properties are rejected.

Start a new app at release `0.1.0`, stored as top-level manifest
`"version": 100`. App releases use
`major * 10_000 + minor * 100 + patch`, with `minor` and `patch` limited to
0-99. The package and UI display the semantic form, such as
`my_app.v0.1.0.neutron`. Memory schema versions and capability API versions are
separate integer lanes. See [App Package Format](./app-package-format.md) for
the complete version and upgrade contract.

Use the repository copy-and-clean workflow; do not assume that the compile CLI
also generates app projects.

## Project Layout

A minimal app project follows this layout:

```text
apps/my_app/
  backend/
    main.mo
    memory/
      my_app/
        v1.mo
  public/
    index.html
    static/icon.png
  src/
    index.tsx
  build.ts
  mops.toml
  neutron.json
  neutron.lock.json              # generated by the first managed-memory build
  NOTICE
  package.json
  test/
    memory_release.test.mo
    package.test.ts
```

The build/package scripts create generated outputs:

```text
apps/my_app/dist/
  web/
    index.html
    main.js
    static/icon.png
  mo/
    <sha256>.mo
  neutron.json
  neutron.lock.json

apps/my_app/my_app.v0.1.0.neutron
```

After the copied template lock is removed, `neutron.lock.json` is created by the
first managed-memory package build. The manifest is format 3; the independently
versioned memory lock remains format 2. Do not write the lock by hand, and do
commit it with the app's source.

`dist/`, `.mops/`, `.neutron`, `node_modules/`, and TypeScript build
info are ignored generated/local artifacts.

## Write The Motoko Backend

The backend source is a Motoko module, not an actor. The manifest `src` field
selects the file under `backend/`; in the hello app this is `backend/main.mo`.

New apps use the repository's pinned `mo:core` package rather than selecting a
separate floating revision. Choose collections by their semantics: Core `Map`
for keyed state, `Set` for unique membership, `List` for a growable
random-access vector, and `Queue` for FIFO state. Keep immutable arrays for
Candid vectors, fixed snapshots, static catalogs, and indexed fixed-size data;
do not replace every array mechanically.

Format-3 apps put persistent types and clean-install defaults in immutable
schema modules. The app module imports the current schema and provides
one exact structural `AppBackendEnvironment` plus
`public class Init(env : AppBackendEnvironment)` with the methods wrapped into
the combined actor. Apps with no backend resources use `Init()`.

Example:

```motoko
// backend/memory/my_app/v1.mo
// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
module {
  public type Mem = {
    var name : Text;
  };

  public func init() : Mem {
    { var name = "Neutron" };
  };
}
```

Schema modules are the source of truth for historical stable data. They may
import pinned Motoko packages such as `mo:core/Map`, but they cannot use a
relative import, including app-local `Types.mo` or runtime services. Define all
app-owned records and variants in the version file, while using package-owned
collection types directly. Runtime modules import the current schema, never the
reverse. `mopack` enforces the package-only boundary for every schema version.

A packaged schema has separate `hash` and `entry` fields. `hash` is the
comment-stripped schema file itself before imports are rewritten and is the
immutable lineage identity. `entry` is the executable module after package
imports have been rewritten to content hashes. Imported package contents can
therefore change the executable entry without changing the schema identity;
the compiler still checks the resulting stable types. Pin every package used by
a schema so rebuilding a historical version remains deterministic.

```motoko
// backend/main.mo
import Memory "./memory/my_app/v1";

module {
  public type AppBackendEnvironment = {
    stable_memory : { my_app : Memory.Mem };
  };

  public class Init(env : AppBackendEnvironment) {
    let mem = env.stable_memory.my_app;

    public func /*update*/hello_world(name : Text) : Text {
      let previous = mem.name;
      mem.name := name;
      previous;
    };
  };

  /*---NEUTRON GENERATED BEGIN---*/
  /* generated by npm run mogen */
  /*---NEUTRON GENERATED END---*/
}
```

For the first version, declare the schema source and an empty migration list in
`neutron.json`:

```json
{
  "format": 3,
  "memory": {
    "my_app": {
      "version": 1,
      "schemas": {
        "1": {
          "src": "memory/my_app/v1.mo"
        }
      },
      "migrations": []
    }
  }
}
```

When v2 changes the persistent type, keep v1 immutable, add `v2.mo`, and add a
forward edge module:

```json
{
  "memory": {
    "my_app": {
      "version": 2,
      "schemas": {
        "1": { "src": "memory/my_app/v1.mo" },
        "2": { "src": "memory/my_app/v2.mo" }
      },
      "migrations": [
        {
          "from": 1,
          "to": 2,
          "src": "memory/my_app/v1_to_v2.mo"
        }
      ]
    }
  }
}
```

The edge exports the fixed synchronous function
`migrate(old : V1.Mem) : V2.Mem`. A v3 package that supports installation over
v1 must still carry v1, v2, v3, and one unique path from each supported start
version to v3. `mopack` packages every declared root even when the latest app
module no longer imports it, then verifies the append-only
`neutron.lock.json` lineage.

Neutron selects exactly one path from the installed version to the target,
composes those edges into one native Motoko migration expression, and checks the
old and new `.most` stable signatures before upload. A clean install calls only
the target schema's `init()`; it never replays historical migrations. Keep
migrations bounded and synchronous, keep schema imports package-only, and test
every advertised start version. Migration edge modules are different: they
should import their immutable source and target schemas so the compiler checks
both sides, and they may use the same collection package APIs to transform
state.

The complete copyable workflow, including v1-to-v3 upgrades, direct repair
edges, lock handling, retirement, uninstall, and app-specific test requirements,
is in [Managed Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md).

## Expose Backend Methods

Expose methods by annotating public methods inside `Init`. `mogen` scans
`backend/<src>` and rewrites both `neutron.json` and the generated type alias
block.

Supported annotations:

| Annotation               | Meaning                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `/*update*/`             | Expose an authenticated update method.                                                          |
| `/*query*/`              | Expose an authenticated query method.                                                           |
| `/*internal*/`           | Generate an internal wrapper only.                                                              |
| `/*internal:apps*/`      | Export a private internal function to declared app consumers.                                   |
| `/*query:unauthorized*/` | Kernel package only. Ordinary apps are rejected and must declare `capabilities.public_ingress`. |

The annotation comment must appear directly between `public func` and the
method name. Generated method names are limited to 128 ASCII characters and
must start with a letter or underscore, followed only by letters, digits, or
underscores:

```motoko
public func /*update*/set_name(name : Text) : Text { ... }
```

Use `async*` for local asynchronous call chains. If one local backend function
calls another asynchronous local function, return `async* T` and call it with
`await*`. This executes local layers inline and avoids adding commit and
interleaving points merely to move between helpers. Use the approved backend
capability for remote calls, as shown under [Use Backend
Capabilities](#use-backend-capabilities); the broker owns the real shared-call
`await` where suspension is unavoidable.

`await*` is not itself a commit point. If the computation traps before reaching
a regular `await`, its changes roll back to the preceding real commit boundary.
`mogen` recognizes the `async*` return and generates an `await*` actor wrapper.

`mogen` generates aliases such as:

```motoko
public type set_name_Input = (name : Text);
public type set_name_Output = Text;
```

Those aliases are consumed by the generated Neutron actor wrapper. `mogen` also
rewrites the manifest `func` map, so do not edit `func` or the generated block
by hand; run:

```sh
npm run mogen
```

If a method needs generated wrapper arguments, put a block comment inside the
parameter list. This is used by the kernel for values such as `caller` and
`this`. Ordinary apps may request `caller`, their own active `memory_<id>`, or
the exact invocation-scoped resources permitted for a declared handler. In
particular, a paid canister public-ingress handler may opt into
`public_ingress_cycles`; when it also requests the caller, the canonical
ordered list is `["caller", "public_ingress_cycles"]`. The cycles handle is
not part of the app-wide backend environment. Prefer receiving memory once
through `Init`. Raw module helpers, actor self, foreign memory, dependency
records, provider `Init` instances, and unknown generated identifiers are
rejected.

`allow: "unauthorized"` is reserved for reviewed whole-Neutron kernel
entrypoints. `allow: "any"` is rejected, as is any `allow` field on an internal
function. Packaging or installing an ordinary app with either direct
public-access form fails; declare a public-ingress route instead.

Every ordinary public app method becomes part of the same generated Candid
service for the user's Neutron canister, but its manifest name is local to the
app. A paid public-ingress handler that requests `public_ingress_cycles` is
route-only and is the exception: it has no ordinary owner-authorized actor
wrapper or direct-client endpoint. The assembler emits other ordinary-app
methods as
`app_<app-id>__<logical-method>`; kernel methods remain unmangled. Canonical app
ids cannot contain or produce `__`, so the separator identifies the app
boundary exactly. Two apps may therefore use the same logical
method name. App
frontends continue to pass logical names to source-bound self-call tools, which
the kernel translates before Candid validation and dispatch. An authorized
direct client uses the physical ordinary-method name. Public clients and
inter-canister protocols must use a declared public-ingress dispatcher instead.
The compiler emits no global friendly aliases.

### Expose a public Candid protocol

Declare public receiving authority separately from the handler function:

```json
{
  "capabilities": {
    "public_ingress": {
      "api": 1,
      "routes": [
        {
          "protocol": "example_v1",
          "id": "submit",
          "handler": "example_submit",
          "mode": "update",
          "caller": "canister",
          "max_request_bytes": 8192,
          "max_response_bytes": 4096,
          "max_calls_per_hour": 120,
          "max_calls_per_caller_per_hour": 12,
          "required_cycles": 250000000
        }
      ]
    }
  },
  "func": {
    "example_submit": {
      "type": "update",
      "async": false,
      "arg": ["caller", "public_ingress_cycles"]
    }
  }
}
```

The handler remains a synchronous `/*query*/` or `/*update*/` function with no
`allow` or `expose`; its mode must match the route. A paid canister update
handler may opt into the invocation-scoped `PublicIngressCyclesV1` value with
`/*public_ingress_cycles*/`. When it also needs the caller, use one generated
argument annotation before both trailing parameters:
`/*caller,public_ingress_cycles*/ caller : Principal, ingressCycles :
PublicIngressCyclesV1`. This produces the example's ordered
`["caller", "public_ingress_cycles"]` manifest list. Every route targeting an
opting-in handler must be a synchronous `caller: "canister"` update. No query,
direct authenticated handler, unrelated method, or app constructor receives
that cycles value.

Opting in also makes the function route-only: the compiler omits its ordinary
owner-authorized actor wrapper, so it is callable only through the paid
public-ingress dispatcher. If an app also needs an owner-authorized entrypoint,
declare a separate method over shared internal logic. A handler that omits
`public_ingress_cycles` keeps the ordinary wrapper behavior.

`protocol` and `id` each use lowercase letters, digits, and underscores and
start with a letter. Validate resource names and byte/rate bounds against
`packages/neutron-tools/src/capabilities/catalog.ts` instead of copying its
limits into app code.
Query routes omit `max_calls_per_hour`, `max_calls_per_caller_per_hour`, and
`required_cycles` and may choose `caller` as `any`, `authenticated`, or
`canister`; query `authenticated` means
every non-anonymous principal, not only Neutron owners. Every update declares
a shared rate and may add `max_calls_per_caller_per_hour` no greater than that
rate. The optional caller
window is keyed by the real ingress principal and is checked before shared
capacity; omission preserves shared-only behavior. Every update chooses one
class.
`caller: "authenticated"` is direct IC ingress: it forbids `required_cycles`
and accepts only a self-authenticating principal, rejecting anonymous and
canister principals. `caller: "canister"` is inter-canister traffic and
requires positive `required_cycles`. Its attached payment proves only
immediate canister-mediated transport, not a trusted remote Neutron, app,
owner, or original user.

The compiler emits one physical method per app, protocol, and mode:

```text
app_<app-id>__<protocol>_<query|update>
```

All route ids for that protocol/mode share the dispatcher. Call it with the
stable `mo:neutron-capabilities` wire:

```motoko
type PublicIngressRequestV1 = { method : Text; payload : Blob };
type PublicIngressResultV1 = {
  #ok : Blob;
  #err : {
    #bad_request; #not_found; #too_large; #unauthorized; #rate_limited;
    #busy; #low_cycles; #revoked; #revoked_after_dispatch; #handler_failed
  };
};
```

Encode `payload` as Candid for the exact handler input and decode an `#ok`
blob as the exact handler output. Use
`physicalPublicIngressMethodName(appId, protocol, mode)` from
`neutron-tools` when generating a client or backend reservation. One
exact reservation for that physical method covers every route id sharing the
dispatcher. It grants outbound call authority only; the recipient still
enforces its declared byte/rate/concurrency limits, lifecycle, per-route
Settings toggle, cycle reserve, and update `required_cycles` floor.

For a `caller: "canister"` update route, attach at least its versioned
`required_cycles`. That field is a required floor, not the route's total price
or execution cap. An underpayment traps before acceptance. Once the exact route
and floor are valid, the kernel accepts and attributes the floor before
payload, reserve, concurrency, or rate admission, so those later rejections
retain it.

The handler-scoped cycles value's `available()` returns the captured
still-unaccepted surplus minus amounts already requested. `request(amount)`
adds to the cumulative logical request and traps if it exceeds that remainder;
neither operation accepts cycles. The outer dispatcher attempts the accumulated
amount only after the synchronous handler self-call commits its app mutation
and the live route, lease, fingerprint, authority epoch, and persisted
completion still validate. Supplemental acceptance is therefore best-effort
and not atomic with that mutation, cannot roll it back, and must never be
treated as guaranteed payment for work already performed or state already
retained. Set `required_cycles` high enough to cover every irreversible path;
use a supplemental request only for opportunistic recovery. Unaccepted surplus
is refunded. App code still cannot invoke a raw accept primitive. A direct
authenticated update attaches no cycles and receives no cycles argument; its
ingress-reception and self-handler costs are attributed to the receiving app
instead. Read the Kernel's public-ingress accounting implementation for the
cost constants used by the deployed successor.

Set the route floor as a static protocol-version fact, not a caller-selected
quote. It must cover all irreversible work, including the receiver's execution
costs, conservative measured handler instructions, and storage of the maximum
admitted payload for the protocol's promised retention horizon.
The [IC cycle-cost reference](https://docs.internetcomputer.org/references/cycle-costs/)
is authoritative for storage and message rates. Keep margin for decoding,
indexes, metadata, and future variance. The sender separately pays the IC
inter-canister request/response base and size-dependent transmission charges;
those charges are not part of the cycles retained by the recipient.

Update ingress persists admission before a compiler-generated self-call. A
`#revoked_after_dispatch` result means the handler may have committed before
authority was revoked, so protocols should use an idempotency key or reconcile
with a read. The complete admission, lifecycle, and first-party examples are in
[Kernel Capability Inventory](./kernel-capability-inventory.md#public-protocol-surfaces).

## Compose App Backends

App memory is private and cannot be injected into another app. Compose backend
features through explicitly exported domain functions instead. A provider marks
an `Init` method with `/*internal:apps*/`; a consumer declares the provider,
minimum version, and exact functions under `dependencies`. The compiler derives
only those functions in `AppBackendEnvironment.app_calls`; the consumer defines
the matching structural Motoko type locally.

Dependencies are required install-time authority. Provider version
`>= min_version` is accepted while all requested functions remain exposed and
type-compatible. Later provider releases must preserve exported functions
compatibly; breaking APIs use new names. Nested acyclic chains are supported,
cycles are rejected, and providers cannot be uninstalled while consumers remain.

See [Backend App Dependencies](./backend-app-dependencies.md) for complete
provider and consumer examples, limits, lifecycle behavior, and testing rules.

## Write The Frontend

The frontend is ordinary browser code bundled into `dist/web/`. Read
`apps/hello/build.ts` for a complete browser bundle and static-asset build.

Static files from `public/` are copied into `dist/web/`. Keep app frontends
browser-safe: do not rely on Node/Bun globals at runtime.

Installed apps are served under:

```text
/app/<app-id>/<tile-path>
```

The kernel loads each opened app tile in a sandboxed iframe. Ordinary app
packages produced by the current packer carry a browser-surface readiness
marker, so the browser-surface-origin Kernel gives
each declared tile an origin derived from the installation nonce and exact
`tile:<id>` surface key. The frame uses
`sandbox="allow-scripts allow-same-origin"`, while certified Host/path and
`frame-ancestors` policy keeps that origin confined to the app's asset subtree
and the Kernel parent. A browser that cannot prove credentialless originful
framing falls back to a script-only opaque sandbox. Historical archives without
the marker remain on that legacy opaque path until a current package update is
installed; the compatibility decision does not depend on an app id or version.
The Kernel binds each private message port to the registered source window and,
for an originful frame, its exact expected origin. Do not navigate an app frame
to another website; use the supported navigation flows for external content.

**Planned deprecations:** new apps should use installation-owned browser-surface
origins. We plan to remove both Kernel-host app-content serving and the separate
opaque app-frame compatibility path after the required migrations and browser
support decisions. See [Deprecated Compatibility Paths](./deprecated.md) for
replacement guidance, the external-call and Wallet API deprecations, and the
update-certification requirement. Current behavior remains in place; no removal
date is set.

A package can declare multiple frontend tiles in `neutron.json`:

```json
"tiles": [
  {
    "id": "main",
    "title": "Hello",
    "path": "index.html",
    "icon": "static/icon.png"
  }
]
```

If `tiles` is omitted or empty, the package is headless and keeps `tiles: []`;
the compiler does not synthesize `main` or require `web/index.html`. When tiles
are declared, their paths are relative to `dist/web/` and must not contain a
leading slash, backslash, empty segment, `.`, or `..`.

The app should interact with the kernel only through the `neutron-tools/app`
helper API.

### Request Camera Or Microphone From A Tile

Browser device access is default-deny. Declare each exact tile and the closed
set of features it may request:

```json
{
  "capabilities": {
    "browser_permissions": {
      "api": 1,
      "tiles": [
        {
          "id": "main",
          "features": ["camera", "microphone"]
        }
      ]
    }
  }
}
```

Only `camera` and `microphone` are accepted, and every listed id must match a
declared tile. The install or update review shows the exact tile-feature
mapping. Installing the declaration allows that open tile to ask the browser;
it does not start capture, guarantee browser approval, or grant the feature to
another tile, a tray, or a background.

Use the ordinary browser API directly from the tile, normally in response to a
user action:

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: true,
});

// Attach stream to local media elements or a peer connection.
// Stop every acquired track when the call or tile lifecycle ends.
for (const track of stream.getTracks()) track.stop();
```

The Kernel narrows the iframe `allow` attribute to the declared features and
that tile's exact installation origin; its certified Permissions Policy limits
them to the app document itself. The browser owns the device prompt, indicator,
and site settings. Media bytes stay in the frontend browser APIs: there is no
Kernel backend media session, lease, stream proxy, or app-facing capture call.

### Form Actions Inside App Frames

App frames do not enable native form submission. The browser can block it
before React's `onSubmit` handler runs, so `event.preventDefault()` there is
not sufficient. Use explicit `type="button"` controls with local action
handlers. An accessible `div role="form"` can group the inputs without
starting a browser submission.

If retaining a native `<form>` for constraint validation, call
`reportValidity()` from the button handler and intercept implicit Enter
submission in single-line inputs. Preserve required-field and numeric
validation when replacing a form. Textarea Enter must retain its intended
newline behavior, and composing text must not trigger an action. Reuse the
same busy/in-flight guard for mouse and keyboard actions.

Test these controls inside an actual iframe with the app's sandbox flags and
without `allow-forms`. A top-level browser fixture does not reproduce this
failure. Cover clicks, Enter, invalid inputs and repeated activation, and
assert that no blocked-form console error or document navigation occurs.

## Use The Shared Design System

Apps can import the shared dark UI system from the workspace package:

```scss
@use "neutron-design-system/styles.scss";

@layer nt.tokens, nt.base, nt.layout, nt.components, nt.utilities, app;

@layer app {
  .nt-app.my-app {
    --nt-accent: #8adf9d;
  }
}
```

Then put `nt-app` on the app root:

```html
<main class="nt-app nt-app--fill my-app">
  <section class="nt-panel">
    <h1 class="nt-title">My app</h1>
    <button class="nt-button">Review in kernel</button>
  </section>
</main>
```

Use app-prefixed classes for local layout and composition. Do not style kernel
workspace classes from inside an app. Reuse the scoped components and tokens
instead of duplicating their color, spacing, radius, or interaction values.
Read [Neutron Design System](./design-system.md) and
`packages/neutron-design-system/` for the styling contract; use Kitchen Sink
for integrated examples.

## Call The Kernel From The App

Use the lightweight app entrypoint:

```ts
import {
  createCanisterClient,
  loadNeutronCanisterId,
  loadTileContext,
} from "neutron-tools/app";
```

The normal pattern is:

```ts
const canisterId = await loadNeutronCanisterId();
const client = createCanisterClient(canisterId);
const tile = loadTileContext();

const schema = await client.methodSchema("hello_world", 10);
const result = await client.callDialog("hello_world", ["John"]);
```

`loadNeutronCanisterId()` derives and validates the canister id from a dedicated
app hostname, falling back to `/pkg/id.json` for same-host proxy environments.
`loadTileContext()` reads the
tile query parameters `{ app, tile, instance, workspace }` for app UI
convenience; it is not a security identity. `createCanisterClient()`
validates the id and returns:

- `methodSchema(method, timeout)`, which asks the kernel for the
  kernel-derived icblast JSON Schema for the method;
- `callDialog(method, args, timeout)`, the global convenience route for ordinary
  code when the app has no live routed invocation. It uses the kernel's
  signed-call policy and currently authenticated identity and requests owner
  approval when needed.

Inside an exposed tool handler, use the supplied `context.kernel` client for
nested requests that Agent Mode permits. Only that client carries the
kernel-created invocation provenance needed to apply Agent Mode policy; scope is
required context, not permission by itself.

For methods on your app backend, use the Neutron canister id from
`loadNeutronCanisterId()`. Installed app methods are methods on the user's
combined Neutron canister, not on a separate app canister.

`callDialog()` arguments are an array matching the Candid argument order. For
an external target, the generic dialog route accepts JSON-compatible values
only: no `undefined`, `NaN`, `BigInt`, functions, cycles, class instances,
`Uint8Array`, Candid text, Candid-encoded bytes, package-provided schemas, or
identities. For the current Neutron canister, the SDK instead selects the
private API-1 self-call transport. That route accepts `Uint8Array` as canonical
bytes and `ArrayBuffer` as an input convenience wherever the live Candid type
is `blob` or `vec nat8`.

For generated app wrappers, no-argument methods use `[null]`, single-argument
methods use `["value"]`, and multi-parameter Motoko methods use one tuple
argument such as `[["Ada", "ada@example.test", "Notes", true]]`. On both the
external and private self-call routes, `Int` and `Nat` use ICBlast's lossless
JSON form, such as the decimal string `"42"`.

The kernel derives method schemas from the installed canister interface with
icblast and uses that trusted interface to convert approved JSON arguments into
Candid calls. App builds also write `dist/schema.json` with the same
wrapper-accurate method schemas for local tests, package inspection, and app
developer tooling. The kernel does not trust that package file at runtime.

For external canisters, ordinary global helpers inspect the live Kernel tool
descriptors, prefer `canister.schema_v2` and `canister.call_dialog_v2`, and use
the unversioned compatibility names only when the v2 descriptor is absent.
Invocation-scoped code does not fall back: it must use the v2 tool through
`context.kernel` or fail closed when that tool is unavailable. Calls to the
app's own Neutron use the private attachment-aware self-call transport. There
is no direct app-facing canister `call` action. See
[App Method Access And Call Consent](./app-method-access-and-call-consent.md#calling-any-other-app-method)
for its versioned privacy and compatibility contract.

### Preapprove Exact Self Calls

An app may let its own registered tile, tray, and background endpoints call
selected owner-authorized query and update methods without a per-call dialog.
Declare a versioned object containing a unique list of exact method names:

```json
{
  "capabilities": {
    "preapproved_self_calls": {
      "api": 1,
      "methods": ["read_profile", "refresh_profile"]
    }
  }
}
```

Every entry must resolve to an `authorized` query or update owned by the same
app. Public, internal, missing, duplicate, malformed, and wildcard entries are
rejected. Installation shows every exact method and its query/update type.

Use the type-specific helpers:

```ts
import { querySelf, updateSelf } from "neutron-tools/app";

const profile = await querySelf("read_profile", [null]);
const refreshed = await updateSelf("refresh_profile", [null]);
```

The kernel derives the source app from its registered endpoint, checks the
installed capability and expected method type, validates live Candid arguments,
fixes the target to the current Neutron canister, and signs with the current
owner identity. An unlisted method must use `callCanisterDialog()` or another
kernel-owned approval flow.

Inside an exposed tool handler, prefer the scoped `context.kernel.querySelf()`
and `context.kernel.updateSelf()` helpers. They inherit that exact request's
cancellation signal. Cancellation cannot retract an update after dispatch, so
the Kernel reports an unknown outcome instead of inviting an unsafe retry.

This capability changes frontend consent only. The generated backend wrapper
keeps its normal owner-authorization assertion, and no Motoko capability handle
is injected. See
[App Method Access And Call Consent](./app-method-access-and-call-consent.md)
for the complete policy.

Listing a state-changing method is an explicit trust decision for every live
tile, tray, and background endpoint of that app. It does not let another app
invoke the method directly. A provider can call its own declared backend method
after its domain-specific confirmation without a second Kernel backend-call
dialog. A cross-app caller must use the provider's declared tool; the provider
alone converts that approved request into its own backend update. For payment
flows, use durable preparation and resume APIs rather than legacy transfers;
see [Deprecated Compatibility Paths](./deprecated.md).

### Route HTTP Through The Optional Browser Extension

An app can use the optional [Neutron extension](../support/extension/README.md)
when a service does not accept requests from the app's browser origin. The
request travels through browser-local Kernel code to the extension, then
directly to the service. It does not use a canister HTTP outcall.

```ts
import { browserExtension } from "neutron-tools/app";

let route = await browserExtension.status();
if (!route.available) {
  // Show the extension install instructions for this feature.
} else {
  if (!route.paired || !route.granted) {
    route = await browserExtension.request({
      reason: "Connect to the selected model provider",
    });
  }
  if (route.paired && route.granted) {
    const response = await browserExtension.fetch(serviceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: abortController.signal,
    });
    // Standard Response: status, headers, json(), or streamed body reads.
  }
}
```

There is no manifest declaration or install-time dependency. Request the route
when the owner enables a feature that needs it. The extension remembers the
accepted Neutron origin; the Kernel remembers a route grant bound to the owner
principal, app ID, and installation UID in this browser. Neither has an expiry.
Compatible app updates retain that installation grant; uninstall/reinstall
requires a new one.
The owner revokes app access in Kernel Settings and accepted Neutron origins
in the extension's settings. Browser-profile deletion or uninstalling the
extension also removes its local data.

`fetch()` never requests permission implicitly. It uses the app's existing
grant, supports cancellation and response streaming, and sends explicit
authorization headers when provided. The extension omits ambient browser
cookies. Large bodies cross the existing message bus in chunks. The Kernel
derives the requesting app from its registered private endpoint; apps cannot
claim another app's grant. Normal frontend and resident endpoints can use the
route. Tool and Agent Mode approvals retain their existing authority rules.

Inside an exposed tool handler, use `browserExtensionForTool(context)` from
`neutron-tools/app`. It has the same methods and preserves that tool's private
invocation authority and cancellation. This lets the existing root/normal
permission policy decide a first route grant without passing agent credentials
through app arguments.

### Use A Browser Ethereum Provider

Browser extensions do not reliably inject providers into Neutron's isolated
app iframes.
Declare the exact chains and EIP-1193 methods the tile needs instead:

```json
{
  "capabilities": {
    "ethereum_provider": {
      "api": 1,
      "chains": [1],
      "methods": [
        "eth_requestAccounts",
        "eth_chainId",
        "eth_sendTransaction",
        "eth_getTransactionReceipt"
      ]
    }
  }
}
```

Start the connection directly from a user click in the focused tile, then use
the returned provider-shaped proxy. Begin before awaiting quotes or other slow
network work so the click's transient activation is still available:

```ts
import { connectEthereumProvider } from "neutron-tools/app";

const connection = await connectEthereumProvider();
try {
  const accounts = await connection.provider.request({
    method: "eth_requestAccounts",
  });
  // Request only methods and chains declared in the installed manifest.
} finally {
  await connection.close();
}
```

The kernel discovers wallets only through EIP-6963 and keeps the selected
provider in the top-level page. It has no injected-provider fallback and does
not prefer a wallet by brand. When more than one provider is announced, the
Kernel asks the owner to choose one for the session.

The proxy session is bound to this tile endpoint, app version, owner, chains,
methods, and selected provider. Do not store the session or proxy. Background
processes and Agent Mode cannot use it, and starting it outside a focused,
transiently activated click fails closed. The selected wallet remains
responsible for account and transaction confirmation.

While the session is active, apps may repeat account checks, retry network
switches, request transactions, and poll receipts without cumulative call or
prompt quotas. Requests still use the declared methods and chains, and
in-flight concurrency remains bounded. A rejected wallet prompt does not
consume a one-time Kernel permission.

## Add A Resident Background Process

Declare one optional process in `neutron.json`:

```json
{
  "description": "Notes with resident search",
  "background": {
    "path": "service.html",
    "description": "Resident note index and tool host"
  },
  "capabilities": {
    "persistent_browser_storage": {
      "api": 1,
      "surface": "background"
    }
  }
}
```

The package must include `dist/web/service.html`. Build its script as a separate
browser entrypoint. The kernel mounts one hidden background iframe for the app
while the user is logged in and authorized. It stays mounted across workspace
switches and tile close/reopen, and reloads when the app version or background
path changes.

An ordinary background follows the tile browser-surface policy above, with its
own installation/surface origin and the same browser compatibility conditions.
The
`dedicated_resident_origin` capability selects the specialized credentialless
ephemeral resident contract, while `persistent_browser_storage` selects the
persistent resident contract. Those capabilities are mutually exclusive. Their
exact manifest shapes, certified initial-document binding, browser checks,
rotation, and subresource policy are specified in
[Dedicated Resident Origins](./kernel-http-v2-and-certified-assets.md#dedicated-resident-origins).

A background iframe may create a dedicated worker for WebGPU or other heavy
work. Do not use a service worker as the resident lifecycle primitive.

Expose methods from a tile, tray, or background entrypoint:

```ts
import { exposeTool } from "neutron-tools/app";

exposeTool(
  "notes_search",
  {
    title: "Search Notes",
    description: "Search the resident note index.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
  },
  async ({ query }, { caller }) => ({ matches: [] }),
);
```

`context.caller` is supplied by Kernel from the registered calling endpoint.
It includes `endpoint`, `appId`, `role`, `sessionId` when connected, and
`installationUid`: a canonical positive Nat64 decimal string. The installation
UID stays the same across tile reloads and compatible upgrades, but changes on
uninstall/reinstall. Providers can key durable commands by
`(caller.appId, caller.installationUid, requestId)` without tying replay to a
temporary endpoint or session. The field is optional in the SDK for older
Kernels; providers that require installation-scoped command identity must reject
new effects when it is absent. Never obtain this identity from tool arguments.
Provider presentation preserves the original caller's installation identity;
direct-root Agent calls identify the calling root resident. Attachment tools
receive the same validated installation field.

Call your own background from a tile:

```ts
import { callTool, loadTileContext } from "neutron-tools/app";

const appId = loadTileContext().app!;
const controller = new AbortController();
const result = await callTool(
  {
    target: `app:${appId}:background`,
    name: "notes_search",
    arguments: { query: "roadmap" },
  },
  {
    signal: controller.signal,
    timeout: 45,
    onProgress: (value) => renderProgress(value),
  },
);
```

`timeout` is the caller's timeout in seconds; omitting it uses the SDK default.
The signal and timeout cancel that exact ordinary message-bus request
cooperatively. They do not roll back a remote effect that was already sent.

For resident-owned mutable state, keep the resident process or backend as the
single authority. After a successful mutation, publish only its monotonic
revision; every open tile can then re-fetch its own view immediately:

```ts
// Resident process, after the authoritative write succeeds.
import { publishAppStateChange } from "neutron-tools/app";

await publishAppStateChange("notes", result.revision);
```

```ts
// Tile startup.
import { onAppStateChange } from "neutron-tools/app";

const unsubscribe = onAppStateChange("notes", ({ revision }) => {
  void refreshFromResident(revision);
});
```

Topics are app-local and the kernel derives the app namespace from the live
sender; an app cannot publish into another app. Revisions are non-negative
decimal strings on the wire so Motoko `Nat` values remain exact. Treat the
event as invalidation, not state transfer: compare revisions, fetch the
authoritative snapshot, reject older responses, and keep a slow polling or
reconnect refresh as fallback. Notification failure must never turn a
successful mutation into an apparent write failure.

Use the global `createMsgBusClient()` for ordinary work outside a routed tool
handler to list installed apps, live endpoints, and allowed tools. Same-app
calls are allowed by default. Outside Agent Mode, ordinary cross-app tool
listing or calls show a kernel-owned approval dialog and require a one-call or
session grant. A direct `provider_once` call is the exception described below:
it bypasses that preliminary prompt and grant. Inside a routed handler, use
`context.kernel`; nested Agent Mode policy applies only to that scoped request.
Arguments are JSON objects and schemas use JSON Schema draft-07. Tool metadata
is treated as untrusted when shown to users or agents.

Tool-schema `pattern` strings must also pass the SDK's existing metadata
validator: grouped expressions and backreferences are unsupported. Use simple
character-class patterns and retain additional semantic checks in the handler
(for example, an even number of hexadecimal digits). Exercise real
`exposeTool` registration in tests; a mock that only stores handlers can miss
a schema rejection that stops the resident process from starting.

Keep tile-only control methods out of other apps' and agents' live catalogs by
adding `annotations: { "neutron:visibility": "same_app" }`. The kernel filters
discovery and rejects direct cross-app invocation; handlers should still
validate the caller role when a control is tile-only.

### Let A Trusted Provider Present One Decision

Use `provider_once` when a trusted provider app must own one informed,
domain-specific decision for a cross-app operation. Keep the public tool name
and schema stable for callers. Outside Agent Mode, have its resident handler
present the provider's own foreground UI before preparing or executing any effect:

```ts
exposeTool(
  "wallet_fund_v1",
  {
    title: "Fund a swap",
    description: "Open Wallet to review and execute one funding operation.",
    inputSchema: walletFundingInputSchema,
    outputSchema: fundingResultSchema,
    annotations: {
      "neutron:consent": "provider_once",
      "neutron:effects": ["network", "write", "user_visible_ui"],
      "neutron:audit": "metadata_only",
    },
  },
  async (request, context) => {
    if (!context.presentUserInterface) {
      throw new Error("Provider UI is unavailable on this Kernel");
    }
    validateFundingCallerAndRequest(request, context.caller);
    return context.presentUserInterface({
      tileId: "wallet",
      tool: "wallet_funding_present_v1",
      arguments: request,
    });
  },
);
```

The schema and validation names above stand for the provider's own closed,
bounded contracts; they are not SDK helpers. The named foreground tool is
private to the same installation and declares its exact audience:

```ts
exposeTool(
  "wallet_funding_present_v1",
  {
    title: "Review Wallet funding",
    description: "Show and decide one exact transfer or allowance.",
    inputSchema: walletFundingInputSchema,
    outputSchema: fundingResultSchema,
    annotations: {
      "neutron:visibility": "same_app",
      "neutron:audience": "foreground_tile",
      "neutron:effects": ["write", "network", "user_visible_ui"],
      "neutron:audit": "metadata_only",
    },
  },
  async (request, context) => {
    if (context.audience !== "foreground_tile") {
      throw new Error("Foreground Wallet authority is required");
    }
    const prepared = await prepareExactFunding(
      request,
      context.caller,
      context.kernel,
    );
    return showWalletFundingModal(prepared, context);
  },
);
```

Kernel treats the request and result as schema-validated opaque JSON. It opens
or focuses the exact provider tile, attests `context.caller` and
`context.audience`, and displays no provider-domain dialog.

An exact live tile, tray, or ordinary background endpoint may start this public
flow without source-frame focus or transient activation. That permission only
presents the provider: the action in the provider's UI remains the one user
decision. `foreground_tile` attests that Kernel routed the private call to the
exact selected provider tile; it is not a continuing browser-focus capability.
Focus or workspace selection may move while the exact endpoint session remains
live. The selected provider tile must remain mounted until private dispatch;
Kernel neither blurs the provider nor refocuses the caller when the interaction
settles.

For every provider flow:

- outside Agent Mode, feature-detect and consume `presentUserInterface()` before
  preparation or execution; during Agent Mode, prepare an exact review and await
  `requestApproval(review)` before execution. Use only Kernel-attested caller
  and audience facts;
- keep request/result schemas closed and bounded; the attested tile may use
  exact preapproved methods to prepare immutable non-value-moving review state
  and persist terminal rejection, while only the affirmative action may
  dispatch a
  value-moving execute method; and
- observe cancellation and use durable request identity, because cancellation
  cannot undo a remote update already dispatched.

The callback does not require `background_ui_requests`; it belongs to the
source-bound invocation. Exact and wildcard grants cannot replace the one
provider-owned decision.

A Swap caller should use the exact stable target and versioned tool name rather
than first listing another app's tools:

```ts
const funding = await callTool({
  target: "app:wallet:background",
  name: "wallet_fund_v1",
  arguments: fundingRequest,
});
```

Do not rely on wildcard payment grants. A provider that supports Agent Mode
must use `context.requestApproval(review)` during an active Agent invocation.
It submits the complete bounded operation review
to the root Agent's permission judge. Await its fresh decision before executing
that exact operation through `context.kernel`. Kernel binds the callback to the
original caller, provider, and live invocation; approval has no persistence and
cancellation invalidates it. The preliminary tool-access prompt is skipped, but
a standing tool grant does not replace this review. `presentUserInterface()` is
absent during Agent Mode, and the callbacks share one use.

Check the provider's contract before using its public tool in Agent Mode. A
human-only provider tool can require `presentUserInterface()` and provide a
separate restricted root-Agent tool; the Wallet example above follows that
pattern. SDKs that predate and ignore the provider-UI marker expose only
`requestApproval()` and retain the generic Kernel raw-JSON owner review.

The complete protocol, security invariants, and Wallet funding contract live in
[App Method Access And Call Consent](./app-method-access-and-call-consent.md#provider-mediated-one-shot-tools),
[Kernel-App Communication](./kernel-app-communication.md#provider-mediated-one-shot-consent),
and [Wallet](../apps/wallet/README.md#app-funding-contract).

An existing separate direct-root tool remains compatible. It may share the
provider's validated prepare/execute core and keep its restricted audience:

```ts
exposeTool(
  "wallet_fund_root_v1",
  {
    title: "Fund an app as the root agent",
    description: "Execute one exact Wallet funding operation without UI.",
    inputSchema: walletFundingInputSchema,
    outputSchema: fundingResultSchema,
    annotations: {
      "neutron:visibility": "same_app",
      "neutron:audience": "agent_root",
      "neutron:effects": ["write", "network"],
      "neutron:audit": "metadata_only",
    },
  },
  async (request, context) => {
    if (context.audience !== "agent_root") {
      throw new Error("Root-agent authority is required");
    }
    return prepareAndExecuteExactFunding(request, context);
  },
);
```

Kernel exposes and dispatches an `agent_root` tool only to the active live
depth-zero root invocation and injects that audience into the handler. Human
callers and nested agents are rejected before provider dispatch. The root tool
shows neither Wallet nor Kernel UI, but it uses the same validation, durable
command, exact preapproved self calls, and reconciliation logic as the human
path.

### Declare An Agent Entrypoint

An agent app can request a session-only Agent Mode grant for exact background
tools:

```json
{
  "background": {
    "path": "service.html",
    "description": "Resident agent runtime"
  },
  "capabilities": {
    "agent_entrypoints": {
      "api": 1,
      "entrypoints": ["agent_run"]
    },
    "background_ui_requests": {
      "api": 1,
      "categories": ["frontend_tool", "signed_canister_call", "backend_access"]
    }
  }
}
```

`agent_entrypoints.entrypoints` may contain up to four exact resident tool
names. It is an install disclosure, not a grant. The owner enables one exact
entrypoint in a kernel danger dialog from a focused tile during transient user
activation. A turn then starts only when a live tile in that app installation
calls the exact granted entrypoint; the existing grant removes any per-turn
browser-focus, transient-activation, or owner-dialog requirement.

Inside every tool handler, use the supplied `context.kernel` client for calls
that may be nested under another app or agent invocation:

```ts
exposeTool("agent_run", options, async (args, context) => {
  const endpoints = await context.kernel.listEndpoints();
  return context.kernel.callTool({
    target: "app:files:background",
    name: "read",
    arguments: { path: String(args.path) },
  });
});
```

The scoped client carries kernel-created provenance outside tool arguments. Do
not copy caller, root, or Agent Mode fields into your schema. During an active
invocation, any permission-bearing request made through a global helper or bus
fails closed with `SCOPED_CONTEXT_REQUIRED` and opens no owner UI. This includes
module-level `createCanisterClient(neutronId).callDialog()` back into the same
Neutron, not only external or cross-app requests. Ordinary work when the app has
no active routed invocation can still use the global helpers and their normal
owner-consent flow.

Scoping does not make an interactive same-Neutron self-dialog delegable: that
attempt fails with `USER_INTERACTION_REQUIRED`. For same-Neutron work during a
handler, use `context.kernel.querySelf()` or `context.kernel.updateSelf()` only
for an exact preapproved method; otherwise let the owner initiate the dialog
after the invocation ends. For a nested signed call to an external canister, use
the scoped route:

```ts
const result = await context.kernel.callTool({
  target: "kernel",
  name: "canister.call_dialog_v2",
  arguments: { canister, method, args },
});
```

Do not create a global canister client inside the handler. Long-running handlers
should also observe
`context.signal`; the kernel aborts it when the owner stops the root. Treat it
as cancellation of future work, not rollback of a remote call already sent.

`context.agentMode` is true for every handler in the kernel-attested turn and
false otherwise. Use it only for a narrow app-owned policy; it is not a
substitute for normal kernel permission checks or caller validation.

For nested Agent work, call the provider's public `provider_once` tool through
`context.kernel`. The provider uses `requestApproval(review)` to obtain a fresh
root Agent decision for the exact prepared operation, then executes only after
approval. It must not attempt human presentation or treat `agentMode` alone as
approval. A separate `same_app` + `agent_root` tool remains restricted to the
active depth-zero root; human callers and nested agent invocations are rejected
before target dispatch. Do not expose an ordinary public bypass or branch
around Wallet review based only on caller-supplied data.

Only the approved root agent handler receives `context.agentConsent`. Register
its private decision and cancellation callbacks for the dynamic extent of the
turn. They are kernel control messages on the existing private bus and are not
discoverable tools. Called apps must not implement an approval tool or expect
to receive challenge ids.

`background_ui_requests.categories` lists which normal owner-dialog classes a
resident may request outside Agent Mode. It does not preapprove them. Omit
classes the background does not need.

Enabling Agent Mode does not let the resident originate a root without a live
tile. A root starts through a live tile in the enabled Agent installation and
the exact granted entrypoint, but does not require browser focus or transient
user activation. A trusted provider may execute without additional owner
dialogs only inside that live, bounded invocation; its authority ends with the
root or Agent Mode session.

### Focus Or Open Another App Tile

Use the existing kernel message bus when one app needs to take the user to an
installed app tile:

```ts
import { openAppTile } from "neutron-tools/app";

await openAppTile({
  appId: "contacts",
  tileId: "contacts",
  reuseExisting: true,
  view: "create",
});
```

The kernel always searches the current workspace for the exact app/tile pair
and reuses it before opening another instance. It may focus that instance
or open a missing one without a Kernel dialog for any live direct app endpoint,
including a tile, tray, or resident background. This is intentional navigation
authority for installed apps: it can change the visible workspace, but it does
not grant cross-app tools, backend methods, identities, canister calls, or the
right to accept another app's decision UI. Install only apps whose UI behavior
you trust; a malicious app could otherwise interrupt the owner by repeatedly
opening or focusing tiles.

No preliminary permission request or session grant is needed. Omit `workspace`
to use the active workspace. A supplied workspace must be the active workspace;
apps cannot switch workspaces, and `reuseExisting: false` cannot force a
duplicate. This compatibility route has no navigation cooldown. Kernel
workspace capacities still apply to every caller.

`view` is an optional navigation token matching
`^[a-z][a-z0-9_/-]{0,63}$`. It carries no payload and no authority. A target
tile opts in by handling it:

```ts
import { onTileViewRequest } from "neutron-tools/app";

const stop = onTileViewRequest((view) => {
  if (view === "create") showBlankEditor();
});
```

Use view requests only to select visible UI. Never save, delete, sign, make a
backend call, or otherwise cause a persistent side effect merely because a
view token arrived. Perform those actions through normal controls and consent
paths. Unsubscribe with the returned `stop` function when the handler's UI
lifecycle ends.

### Let A Resident Agent Arrange The Workspace

The Kernel also exposes two discoverable tools for agents that need to present
and arrange app UI:

- `workspace.inspect` returns the active and exposed workspaces, their exact
  tile instance ids and app/tile identities, focus, the expanded instance, and
  the split tree with split ids, orientations, and ratios.
- `workspace.control` performs exactly one `open`, `focus`, `close`, `place`,
  `resize`, `move`, `switch`, `expand`, or `restore` operation and returns the
  resulting workspace snapshot.

`open` may select an exposed workspace and place a new or reused tile relative
to an exact tile instance. `place` rearranges an instance within one workspace,
`resize` changes one reported split, and `move` transfers an instance to an
exposed workspace without activating that workspace. `open`, `switch`,
`focus`, and `expand` bring their target workspace into view.
`expand` uses the same transient expanded-tile state as the tile-header
control; `restore` returns to the unchanged split layout. The optional `view`
token on `open` uses the same
`neutron:tile:view` delivery as `workspace.open_tile`.

These tools are admitted from a live resident background whose installed app
declares a non-empty `agent_entrypoints` capability. This is bound to the
declaration, not to a hard-coded Agent app id. An invocation-free resident call
may use them without enabling Agent Mode. When the call carries Agent Mode
invocation provenance, only the live depth-zero root is admitted; delegated
descendants are not. There is no owner dialog or navigation cooldown. Existing
workspace exposure, tile validity, and capacity checks still apply.

The older `workspace.open_tile` tool and `openAppTile()` helper remain the
generic compatibility surface for tiles, trays, and backgrounds. They keep
their active-workspace and exact-reuse behavior; apps should not copy workspace
mutation logic or create a second layout model around them.

Activating a different workspace—by `open`, `switch`, `focus`, or `expand`—disconnects the initiating tile's Kernel endpoint when its
workspace becomes inactive. If the current Agent turn is bound to that
endpoint, it can end before the initiating tile receives the tool response.
Prefer `move` without activation while preparing UI, and change the visible
workspace only when the owner should be taken there immediately.

### Copy From A Tile

Sandboxed app frames must not call `navigator.clipboard` directly. Ask the
trusted kernel page to copy through the existing private message bus action:

```tsx
import { copyToClipboard } from "neutron-tools/app";

<button type="button" onClick={() => void copyToClipboard(value)}>
  Copy
</button>;
```

Call `copyToClipboard()` directly in the click handler, before any `await` or
timer. The kernel accepts only a bounded string from the exact focused tile
while the browser reports transient user activation. Background processes,
unfocused tiles, and delegated agent invocations are rejected. A successful
write produces the kernel's top-right `Copied to clipboard` toast.

Clipboard access needs no manifest capability and shows no approval dialog.
It grants one user-initiated write, not clipboard read access. Handle the
returned promise when the control needs a local error state; browser or kernel
policy failures reject it.

## Add An App Tray

Declare one top-level tray only when the app also declares an ordinary resident
background:

```json
{
  "background": { "path": "service.html" },
  "tray": {
    "title": "Mailbox",
    "path": "tray.html",
    "icon": "static/mailbox-tray.svg"
  }
}
```

The background owns long-lived state and may call `setTrayState({ badge: 4 })`.
The SDK validates the bounded numeric badge; `0` and `null` clear it.
Updating the badge cannot notify, focus, open, move, or otherwise
change shell UI. The tray declaration itself adds no permission.

Clicking the kernel-rendered toolbar button containing the app-provided icon
mounts `tray.html` in a fresh frame using the ordinary browser-surface policy
above, including its package-readiness and browser compatibility conditions.
The tray receives its own installation/surface origin when that policy permits
originful framing. A tray never receives camera or microphone delegation, because `browser_permissions`
names exact tiles only. The transient endpoint is
`app:<appId>:tray:instance:<instanceId>` and disappears when the popover closes,
so fetch state from the resident process on every mount. Calls from the tray to
its own background use the normal same-app message bus without approval. A tray
does not inherit tile-only privileges. Any live direct tray endpoint may open or
reuse an installed tile without a Kernel dialog. Navigation remains in the
active workspace, always reuses the exact app/tile instance, and observes the
normal tile-capacity bounds.

See [App Tray](./app-tray.md) for the complete package, lifecycle, geometry,
SDK, and security contract. Kitchen Sink is the reference for a quiet initial
tray, optional badge updates, transient mounting, same-app resident tools,
revision invalidations, and dismissal; it does not demonstrate tray-originated
tile navigation.

## Use External Connections

Connections let a resident process request a kernel-approved external service
without implementing its own popup or OAuth callback. Declare the exact
provider contract in `neutron.json`:

```json
{
  "background": {
    "path": "service.html",
    "description": "Resident connection service"
  },
  "capabilities": {
    "background_ui_requests": {
      "api": 1,
      "categories": ["connection"]
    },
    "connections": {
      "api": 1,
      "providers": [
        {
          "provider": "openrouter",
          "scopes": []
        }
      ]
    }
  }
}
```

Only a registered live background endpoint can use the private Connections
API. A tile should call one of its background's ordinary app methods. The
background can use:

```ts
import {
  acquireConnectionCredential,
  disconnectConnection,
  listConnections,
  requestConnection,
} from "neutron-tools/app";

const connection = await requestConnection({
  provider: "openrouter",
});
const sensitive = await acquireConnectionCredential(connection.provider);
```

The `connection` background UI category discloses that the resident may request
this owner interaction; it does not preapprove a connection. Without that
category, `requestConnection()` for a new or missing connection fails with
`OWNER_REQUIRED`. Connection creation is unavailable during Agent Mode and must
begin from ordinary owner interaction.

`requestConnection()` returns the existing matching connection when one is
already active. For a new or missing connection, it opens a kernel-owned
consent dialog and authorization window. The provider returns to the single
root callback page, and the kernel backend exchanges and stores the credential.
`listConnections()` returns only redacted summaries. `listConnections(provider)`,
`acquireConnectionCredential(provider)`, and
`disconnectConnection(provider)` select the exact declared provider; there is
at most one credential per app installation and provider. Keep an acquired
credential in runtime memory and erase references on disconnect. These actions
are private protocol operations, not discoverable message-bus tools, so an
agent or another app cannot enumerate or call them.

Third-party manifests cannot provide authorization, token, API, or callback
URLs. The installed Kernel provider catalog owns those values, the supported
scopes, and the reviewed provider adapter.

## Use Backend Capabilities

Every ordinary backend receives at most one exact `AppBackendEnvironment`.
Active memory and declared app dependencies automatically produce its
`stable_memory` and `app_calls` groups. Privileged long-lived broker handles are
different: declare their authority under `capabilities`, then select only the
interfaces the backend consumes under `backend.capabilities`. The resulting
`capabilities` group contains exactly those fields.

`backend_calls` lets an app call only owner-approved canisters and methods;
`randomness` provides bounded consensus entropy without management-canister
access; `chain_key_signing` signs bounded app assertions under an
installation-isolated threshold key; `wallet_custody_signing` separately grants
exact-digest secp256k1 signing to an owner-trusted wallet; `https_outcalls` makes paid requests beneath exact external HTTPS
prefixes; `certified_assets` publishes bounded certified route bodies; and
`vetkeys_public` optionally gives an app backend public information for its own
declared key slots. Frontend-only declarations such as
`preapproved_self_calls.methods` are stored in the canonical registry plan and
do not produce a backend field. `http_routes` POST handlers are exact
compiler-bound functions rather than long-lived capability fields; their
request/reply types still come from `mo:neutron-capabilities`.

Declare backend-call authority and select its V1 interface:

```json
{
  "backend": {
    "capabilities": {
      "backend_calls": { "api": 1 }
    }
  },
  "capabilities": {
    "backend_calls": {
      "api": 1,
      "description": "Connect to owner-approved ICRC ledger canisters",
      "reservation_scopes": ["principal", "exact"],
      "max_concurrency": 20,
      "max_cycles_per_call": 0,
      "max_cycles_per_day": 0
    }
  }
}
```

An app with a fixed reviewed target can add `install_reservations` using the
same `exact`, `principal`, or `method` scope objects accepted by
`requestBackendCallReservations`. Accepting the installation creates those
listed grants. The runtime request remains available for grants omitted from
the package, added later by the user, or restored after revocation.
Per-app and whole-installation default counts are bounded by the capability
catalog; exact duplicate default scopes across apps are rejected.

Use the reviewed leaf types from the type-only `neutron-capabilities` Mops
package, while keeping the aggregate local and exact:

```motoko
import NeutronCapabilities "mo:neutron-capabilities";

public type AppBackendEnvironment = {
  capabilities : {
    backend_calls : NeutronCapabilities.BackendCallsV1;
  };
};

public class Init(env : AppBackendEnvironment) {
  let backendCalls = env.capabilities.backend_calls;
  public func readFee(ledger : Principal) : async* NeutronCapabilities.BackendCallResultV1 {
    await* backendCalls.call({
      canister = ledger;
      method = "icrc1_fee";
      args = to_candid ();
      cycles = 0;
    });
  };
};
```

The shared package exports types, not a universal capability object, factories,
installation scopes, or authority. The assembler creates the matching
app-specific record and captures the immutable installation scope inside every
closure. App code never receives its app id as authority, kernel memory, an
actor constructor, or the raw-call primitive. Every call checks the current
reservation and the exact generic Settings kill switch, so revocation affects a
retained handle immediately. An awaiting operation captures an actor-local
registry epoch before dispatch: disabling and then re-enabling the resource
cannot revive that old operation. If a remote update was already dispatched,
Neutron suppresses its reply and reports an unknown outcome rather than
claiming that the mutation was cancelled.

From a tile or resident frame, ask the trusted kernel UI to apply one batch of
reservation changes. An optional same-app call runs after the batch succeeds:

```ts
import { requestBackendCallReservations } from "neutron-tools/app";

await requestBackendCallReservations({
  actions: [
    {
      kind: "reserve",
      scope: { kind: "principal", principal: reviewedPresetLedgerPrincipal },
    },
    {
      kind: "release",
      scope: { kind: "principal", principal: oldReviewedPresetLedgerPrincipal },
    },
  ],
  call: {
    method: "wallet_set_ledgers",
    args: [[reviewedPresetLedgerPrincipal]],
  },
});
```

The two principal actions above illustrate batch mechanics. Derive the full
desired scope set from the operation's dependencies and preserve scopes needed
by other enabled features when releasing old grants. Wallet's
`apps/wallet/src/reservations.ts` (`desiredWalletReservationScopes` and
`reservationActions`) is a concrete implementation. Keep permission changes in
the explicit configuration flow; a read must not create a surprise persistent
access prompt.

The global helper above is for ordinary work outside a routed handler and uses
the persistent-access owner dialog. During a routed Agent Mode invocation, an
eligible action-only change must instead call the `backend_calls.request`
Kernel tool through `context.kernel`; the agent decision then applies only to
that scoped request. The scoped generic route does not accept the optional
post-grant call, and the attachment-aware global helper does not inherit a
handler invocation.

Supported reservation modes are `exact` (one method on one principal),
`principal` (all current and future methods on one principal), and `method`
(one method name on any non-system principal). An app may request only modes in
its installed manifest. Approval is persistent until revoked, capability
removal, or uninstall. A batch is all-or-nothing and cannot contain the same
scope twice. `backend_calls.list` exposes only the source app's own
reservations; remove one by sending a `release` action through
`backend_calls.request`.

Every backend-call request includes `cycles`. Use `0` unless the destination
protocol explicitly accepts a cycle transfer; for a public-ingress update,
attach at least that route's versioned `required_cycles`. The manifest's required
`max_cycles_per_call` is a gross attachment ceiling; `max_cycles_per_day` is a
UTC-day financial ceiling over finalized charges plus unresolved gross calls.
The kernel observes each refund and reopens that dispatch day's budget. These
limits do not count requests: zero-cycle calls remain governed by reservation,
byte, scheduled-task, and concurrency bounds. The kernel is the only component
that owns `with cycles`; direct cycle and raw-call primitives remain rejected
from app source.

Cross-Neutron protocols are sender-push-and-pay. Mail sends the envelope and
the recipient's declared floor in one outbound call; a social-network
poster fans out paid updates to the intended recipient Neutrons. Do not make
every recipient periodically poll other canisters for new work. This keeps
discovery and fanout cost with the party initiating the write and lets each
recipient declare a base for its bounded receive/storage contract.

Use `call_batch` for concurrency within the manifest and broker caps. The
kernel creates all remote futures before its first
ordinary `await`; app orchestration should use `async*` and `await*` so internal
calls do not add actor self-messages.

### Use Consensus Randomness

Do not import `mo:base/Random` or `mo:core/Random`. Both hide a paid
management-canister `raw_rand` call, and neither is an approved module
exception. Declare the scoped backend capability instead:

```json
{
  "backend": {
    "capabilities": {
      "randomness": { "api": 1 }
    }
  },
  "capabilities": {
    "randomness": { "api": 1 }
  }
}
```

The app defines only the structural field it consumes, using the shared V1 leaf
type:

```motoko
import NeutronCapabilities "mo:neutron-capabilities";

public type AppBackendEnvironment = {
  capabilities : {
    randomness : NeutronCapabilities.RandomnessV1;
  };
};

public class Init(env : AppBackendEnvironment) {
  let randomness = env.capabilities.randomness;
};
```

Each successful call returns exactly 32 fresh bytes. There is no fixed-hour
request field or runtime request counter. The broker bounds installation/global
concurrency and refuses dispatch below its cycle reserve; read
`apps/kernel/backend/randomness/Service.mo` for those resource constants. The
captured installation scope is checked before and after the await, so a retained handle
cannot outlive its authority. Use the returned value as a seed and expand it
locally when one operation needs many random draws.

### Sign App Assertions With A Chain Key V1

Use `chain_key_signing` only for bounded app assertions. It is not a raw-digest
or transaction-signing API. Declare exact slots and select the leaf explicitly:

```json
{
  "backend": {
    "capabilities": {
      "chain_key_signing": { "api": 1 }
    }
  },
  "capabilities": {
    "chain_key_signing": {
      "api": 1,
      "slots": [
        {
          "id": "receipts",
          "algorithm": "ecdsa_secp256k1",
          "purpose": "Sign application receipt assertions",
          "max_assertion_bytes": 4096
        }
      ]
    }
  }
}
```

Define only the selected field and use `await*`:

```motoko
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";

public type AppBackendEnvironment = {
  capabilities : { chain_key_signing : Caps.ChainKeySigningV1 };
};

public class Init(env : AppBackendEnvironment) {
  let signing = env.capabilities.chain_key_signing;

  public func /*update*/receipt_public_key()
    : async* Caps.ChainKeyPublicKeyResultV1 {
    await* signing.public_key("receipts");
  };

  public func /*update*/sign_receipt(receipt : Text)
    : async* Caps.ChainKeySignatureResultV1 {
    await* signing.sign_assertion({
      slot = "receipts";
      assertion = Text.encodeUtf8(receipt);
    });
  };
};
```

Neutron fixes the production/local threshold-key name, one-component
app/install derivation path, assertion domain, SHA-256 digest, cycle amount,
per-call cost ceiling, concurrency, and retry policy. There is no hourly
assertion or cycle budget. Do not hash the assertion first: pass the
original bounded bytes so the kernel can bind them to the frozen
`neutron_app_assertion_v1` format. A successful result includes the exact
slot/algorithm/domain/format evidence and computed digest. Verify signatures
against the returned normalized key using the declared algorithm.

Handle `#outcome_unknown` as final for that attempt; do not retry it
automatically. Local assembly supports ECDSA `dfx_test_key` only, so a local
Schnorr slot honestly returns `#key_unavailable`. Assertions are visible to
subnet replicas during replicated canister execution and must not contain
plaintext secrets. Assertion signing grants no raw-digest or transaction-signing
authority. Wallet custody signing is a separate owner-trust grant: its app owns
the protocol semantics and operation review before using its exact backend
method.
An external verifier can still assign high-impact authority to a signed
assertion, so constrain assertion semantics and verifier policy. See
[App-Isolated Chain-Key Assertion Signing
V1](./app-isolated-chain-key-signing.md) for exact bounds and byte encoding.

### Use Wallet Custody Signing V1

A wallet backend can explicitly select `wallet_custody_signing : { api: 1 }`
and declare custody slots with `id`, `algorithm: "ecdsa_secp256k1"`, and
`purpose`. It receives `Caps.WalletCustodySigningV1`, whose methods are
`public_key(slot)` and `sign_digest({slot; digest})`. The digest must be exactly
32 bytes and is signed unchanged. The custody key namespace is separate from
assertion signing, including when both capabilities declare the same slot ID.

This is an explicit custody grant: the owner trusts the installed wallet to
validate transactions, messages, and permits and to present the intended
operation. Kernel does not inspect EVM semantics. Do not expose the raw leaf
as an unreviewed public frontend tool. Use wallet-owned provider presentation,
closed protocol requests, and durable caller-bound commands. Direct-root Agent
requests use their separate attested tool family. An ambiguous signing outcome
is not permission to repeat signing.

Compatible upgrades, disable/re-enable, and reinstalling the same app ID and
slot in the same Neutron retain the custody key. Runtime handles and cached
authority remain installation-scoped and must be reacquired. Changing the
canister, app ID, slot, algorithm, or threshold key changes the namespace; no
private-key export exists. See `buildDurableCustody` in
`apps/kernel/backend/chain_key_signing/Namespace.mo` and the [custody contract and
lifecycle](./app-isolated-chain-key-signing.md#wallet-custody-signing-v1) for the
manifest, exact namespace encoding, trust model, and shared resource accounting.

### Use Stable Store V1

Use `stable_store` for bounded dynamic binary records whose schema is owned by
the app and can migrate lazily. It is different from typed managed memory and
does not expose raw stable memory or a Region:

```json
{
  "backend": {
    "capabilities": {
      "stable_store": { "api": 1 }
    }
  },
  "capabilities": {
    "stable_store": {
      "api": 1,
      "stores": [
        {
          "id": "notes",
          "purpose": "Keep revision-safe notes",
          "schema_version": 1,
          "max_entries": 128,
          "max_key_bytes": 64,
          "max_value_bytes": 4096,
          "max_bytes": 262144
        }
      ]
    }
  }
}
```

Select only the leaf your backend needs:

```motoko
import Caps "mo:neutron-capabilities";

type AppBackendEnvironment = {
  capabilities : { stable_store : Caps.StableStoreV1 };
};

public class Init(env : AppBackendEnvironment) {
  let store = env.capabilities.stable_store;

  public func /*query*/read_note(key : Blob) : Caps.StableStoreGetResultV1 {
    store.get({ store = "notes"; key });
  };

  public func /*update*/create_note(key : Blob, value : Blob)
    : Caps.StableStorePutResultV1 {
    store.put({
      store = "notes";
      key;
      value;
      condition = #if_absent;
    });
  };
};
```

For edits, first read the entry revision and send
`#if_revision(entry.revision)`. This is **compare-and-swap (CAS)**: if you read
revision 7 but another editor creates revision 8 before your update, your
revision-7 write returns `#conflict` instead of erasing revision 8. Delete has
the same protection through `expected_revision = ?entry.revision`.

`list` walks a binary prefix through bounded live pages. Preserve its complete
cursor; it binds the current namespace uid, prefix, and exclusive last key but
is not a stable-memory pointer. Each page is current when read, not a snapshot
of the whole scan. The returned entry schema versions let the app rewrite old
records one page at a time with CAS. `clear_page` deletes only a bounded prefix
page; repeat while `more` is true.

A narrowed store may report `over_quota`. Reads, list, usage, delete,
clear-page, and target-valid non-growing replacements remain available, but inserts
or growth fail until usage fits. Disable does not erase; removal or uninstall
does, and reinstall receives a fresh namespace. Values are plaintext
replicated canister state—not encrypted and not certified HTTP content. See
[App-Isolated Stable Store V1](./app-isolated-stable-store.md) for exact types,
limits, lifecycle, migration rules, and release gates.

### Use HTTPS Outcalls V1

Declare exact external URL prefixes and select the scoped backend leaf. V1 uses
single-node GET/HEAD/POST only, strips every response header, and has no
response-consensus or confidentiality guarantee:

```json
{
  "backend": {
    "capabilities": {
      "https_outcalls": { "api": 1 }
    }
  },
  "capabilities": {
    "https_outcalls": {
      "api": 1,
      "endpoints": [
        {
          "id": "example",
          "url_prefix": "https://example.com/",
          "methods": ["get", "head"],
          "request_headers": ["accept"],
          "max_request_bytes": 4096,
          "max_response_bytes": 32768,
          "transform": "strip_headers"
        }
      ]
    }
  }
}
```

Define only the selected field and use `await*`:

```motoko
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";

public type AppBackendEnvironment = {
  capabilities : { https_outcalls : Caps.HttpsOutcallsV1 };
};

public class Init(env : AppBackendEnvironment) {
  let https = env.capabilities.https_outcalls;

  public func /*update*/exampleHead() : async* Caps.HttpsOutcallResultV1 {
    await* https.request({
      endpoint = "example";
      method = #head;
      path = "";
      query_params = [];
      headers = [{ name = "accept"; value = "text/html" }];
      body = Text.encodeUtf8("");
      idempotency_key = null;
    });
  };
};
```

Runtime `path` is a bounded canonical relative suffix; query pairs are
structured and percent-encoded by the kernel. The
app cannot replace the declared scheme,
host, port, prefix, fixed single-node mode, response ceiling, or attached
cycle amount. Header values must be printable ASCII and satisfy the broker's
per-value and aggregate bounds. GET/HEAD require an empty body and no key. POST requires a 16–64
character idempotency key, but the remote service must actually deduplicate it;
Neutron never retries or promises exactly-once execution.

There is no hourly call or cycle budget. Request/reply byte ceilings,
endpoint/app/global concurrency, per-call quote caps, and a cycle reserve apply.
Read the capability catalog and `apps/kernel/backend/https_outcalls/Service.mo`
for their exact values. Authority loss after the await
suppresses response bytes but cannot undo a remote POST.

Do not put secrets in URL parameters, headers, or bodies: HTTPS outcalls have
no confidentiality from subnet replicas. A selected node can forge a response,
so verify integrity separately whenever it matters. PocketIC may not provide an
HTTPS adapter, and mainnet calls can still fail for cycles, upstream availability,
or timeout. Use an injected adapter for deterministic
unit tests and keep a separate live-network smoke. The Kitchen Sink
`https_outcalls` page demonstrates this honest failure behavior against the
reserved Example Domain.

### Publish Certified Assets And Handle POST Routes

These are two separate manifest contracts:

- `capabilities.certified_assets.api = 2` is the typed storage declaration and
  backend-handle version. It offers the generic `publication`,
  `immutable_blob`, and `mutable_blob` collection kinds. The compiler
  synthesizes each public `certified_read_routes` mount, and the Kernel owns
  its paths, methods, headers, cache policy, certification expression, and
  certified absence.
- `capabilities.http_routes.api = 1` is the only authored HTTP route
  declaration. It contains bounded, mutating `POST` handlers.

Neither number is the IC certificate protocol version. Public certified reads
use IC HTTP response certification version 2, which the final Wasm advertises
in its metadata. Read the complete storage, route, staging, CAS, response, and
qualification contract in
[Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md).

Use `publication` for staged create-once text or attachments on the exact
Neutron Host, `immutable_blob` for content-addressed portable bytes, and
`mutable_blob` for portable exact-path or keyed bytes changed through CAS.

For a mutating endpoint, declare a POST-only `http_post_update_handler` mount
and one exact internal synchronous function. An app that only needs this POST
route omits `certified_assets`:

```json
{
  "capabilities": {
    "http_routes": {
      "api": 1,
      "mounts": [
        {
          "id": "receive",
          "surface": "app_host",
          "prefix": "/hooks/receive",
          "methods": ["POST"],
          "mode": "http_post_update_handler",
          "handler": "receive_hook",
          "max_request_bytes": 32768,
          "max_response_bytes": 8192,
          "max_calls_per_hour": 60,
          "forward_headers": ["authorization", "content-type"]
        }
      ]
    }
  },
  "func": {
    "receive_hook": { "type": "internal", "async": false }
  }
}
```

To place the POST on Neutron's ordinary Host instead, use
`"surface": "shared_app_path"` and omit `prefix`. The example mount id
`receive` then resolves to `/app/<app-id>/_route/receive`. Its handler,
idempotency, replay, rate, byte, header, and cycle boundaries are unchanged;
fixed restrictive response headers remain kernel-owned.

The handler's exact type comes from `mo:neutron-capabilities`:

```motoko
import NeutronCapabilities "mo:neutron-capabilities";
import Text "mo:core/Text";

public class Init() {
  public func /*internal*/receive_hook(
    request : NeutronCapabilities.HttpPostUpdateHandlerRequestV1
  ) : NeutronCapabilities.HttpPostUpdateHandlerResponseV1 {
    // Validate request.headers as untrusted app-protocol data, then mutate
    // app-owned state synchronously. There is no await or injected capability.
    {
      status = #accepted;
      content_type = "application/json; charset=utf-8";
      body = Text.encodeUtf8("{\"accepted\":true}");
    }
  };
};
```

The `/*internal*/` marker is required. The build derives the handler's `func`
metadata from that annotation; do not hand-author a conflicting function entry.

`max_request_bytes`, `max_response_bytes`, and `max_calls_per_hour` are closed
install-time ceilings with aggregate app and replay-storage bounds. Check
`packages/neutron-tools/src/capabilities/catalog.ts` when declaring them.
`forward_headers` contains bounded unique lowercase names. The kernel never
forwards Host, framing, cookies,
upgrade/certification fields, or the raw `Idempotency-Key`. Each forwarded
value is bounded and may appear only once. Cookie/Set-Cookie,
duplicate declared headers, and duplicate or non-`identity` Content-Encoding
reject the complete request rather than being silently stripped.

Every client POST must provide a unique 16–64-character ASCII
alphanumeric/underscore/hyphen `Idempotency-Key`. A matching duplicate within
one hour receives the exact stored completed status, content type, and body
without running the handler
again. Reusing a key for different handler-visible input is `409`; a pending or
unknown operation is never redispatched during that hour. Keep a key stable
while retrying one logical operation. The handler receives only its canonical
relative path, declared headers, bounded body, and a 32-byte digest of that key.

POST traffic is public and normally anonymous. Anonymous gateway callers
consume the declared mount, app, and global fixed-hour windows. A kernel-
authorized principal invoking `http_request_update` directly through Candid is
neither limited nor counted, but still passes route, replay/capacity,
concurrency, lifecycle, and cycle checks. `authorization` is merely
untrusted bytes unless your handler verifies an app-level signed token. Each
admitted call runs backend code and spends the Neutron owner's cycles. Runtime
disable denies all POSTs, including cached duplicates; exact re-enable can
replay a compatible completed result but never resumes pending work from an old
authority epoch. A transport failure or `503` is ambiguous because handler
state may have committed before authority changed while the outer update
resumed. Keep the same key: exact re-enable replays a cached completion, while
changed authority conflicts instead of executing it twice. There is no
separate per-handler instruction allowance below the IC update-message
limit, so keep handlers small and strictly bound their synchronous work. The
kernel measures broker and handler messages independently for that app's
exact-installation usage telemetry, which contributes to the Installed Apps
cycles-used summary.
POST replies are update-call results, not IC HTTP response certification
proofs. Treat a transport failure as ambiguous and recover through the
idempotency contract rather than trusting a query fallback.

Kernel broker failures are distinct from your handler response: pending is
425; changed input or outcome-unknown is 409; an exhausted external request
window is 429; busy, replay capacity, low cycles, or changed authority is 503;
and a handler failure is 500. V1 sends no
`Retry-After`. Keep the same key for pending, transport failure, or ambiguous
503. An outcome-unknown key will not run again during its retention window;
resolve the logical operation through your app protocol before choosing a new
key.

### Use App-Isolated vetKeys

Declare named key slots within the capability catalog's bounds when browser
code needs a durable, app-isolated vetKD namespace:

```json
{
  "capabilities": {
    "vetkeys": {
      "api": 1,
      "description": "Encrypt and decrypt private records on demand in this browser",
      "slots": [
        {
          "id": "records",
          "purpose": "Encrypt and decrypt private records"
        }
      ]
    }
  }
}
```

The declaration does not reserve or recover a key. From the focused app tile,
start a kernel-owned lifecycle decision with `requestVetKeys()`:

```ts
import { requestVetKeys } from "neutron-tools/app";

const result = await requestVetKeys({ action: "reserve", slot: "records" });
```

Use `listVetKeys()` and `getVetKeyPublicKey()` for the source app's bounded
public information. For private recovery, a live tile or resident starts
`deriveVetKey()` with a fresh 48-byte transport public key and 32-byte request
nonce. Its `onChallenge` callback must immediately confirm the opaque challenge
from that same endpoint:

```ts
const result = await deriveVetKey(request, {
  onChallenge({ challengeId }) {
    void approveVetKeyDerivation({ challengeId });
  },
});
```

Despite the historical API name, this is a source-bound protocol confirmation,
not an approval UI. It needs no focus, transient user activation, or extra user
decision. A tray cannot begin or confirm recovery. Any currently authorized
Neutron principal may derive enabled retained generations; the slot's
`key_holder` controls lifecycle changes only. A delegated tool call that has
already received the kernel's cross-app tool permission may recover inside the
target app without app-, agent-, provider-, or model-specific consent.

Keep the transport secret and any reusable recovered key handle in a dedicated
volatile worker, recover seamlessly on demand, and never put either value in
browser storage, logs, tool output, or app backend state. A lock/unlock control
is not a kernel requirement. SDK request payloads intentionally contain no app
id, namespace, key name, curve, canister id, derivation input, cycle amount, or
management target. Public-key and derive responses do include the
kernel-computed public `derivationInput`; it is not the private namespace nonce.

If the backend only stores ciphertext, omit a vetKeys backend selection. If it
must publish the slot's public encryption information, add the attenuated
interface alongside the existing `capabilities.vetkeys` declaration:

```json
{
  "backend": {
    "capabilities": {
      "vetkeys_public": { "api": 1 }
    }
  }
}
```

Then declare the public-only field in the one exact environment:

```motoko
import NeutronCapabilities "mo:neutron-capabilities";

public type AppBackendEnvironment = {
  capabilities : {
    vetkeys_public : NeutronCapabilities.VetKeysPublicV1;
  };
};

public class Init(env : AppBackendEnvironment) {
  let vetkeys = env.capabilities.vetkeys_public;
};
```

The backend handle cannot derive a private key or control management calls and
cycles. Compatible app updates inherit reserved slots; disable and retirement
block future supported recovery but cannot erase browser-held keys or restored
snapshots. Production compilation uses `key_1`; the PocketIC provision target
uses `test_key_1`, with no fallback. See [App-Isolated vetKeys](./app-isolated-vetkeys.md) before using
the capability, especially its lifecycle-manager, restore, limits, and threat
model sections.

### Coalesce Event Work With A Deferred Timer

Use `deferred_timers` when an ordinary update discovers work that should run
once after a short collection window. It is a leading-edge throttle, not a
recurring scheduler: the first arm fixes the deadline, and later arms of the
same key return `#already_armed` without moving it.

```json
{
  "backend": {
    "capabilities": {
      "deferred_timers": { "api": 1 }
    }
  }
}
```

```motoko
import NeutronCapabilities "mo:neutron-capabilities";

public type AppBackendEnvironment = {
  capabilities : {
    deferred_timers : NeutronCapabilities.DeferredTimersV1;
  };
};

public class Init(env : AppBackendEnvironment) {
  let deferredTimers = env.capabilities.deferred_timers;

  public func /*update*/acceptLike(request : Like) : async* () {
    persistVerifiedLike(request);
    ignore await* deferredTimers.arm({
      key = "seal_likes";
      delay_seconds = 60;
      callback = func() : () {
        sealPendingLikeBatch();
      };
    });
  };
};
```

Key, delay, and active-key bounds are fixed by the deferred-timer broker; read
`apps/kernel/backend/scheduler/Service.mo`. `status(key)` reports
`#waiting` or `#running`. There is no cancel, recurring call, raw timer id, or
`<system>` access. This selection needs no top-level capability declaration or
install permission because the kernel fixes those limits and exposes no
external-call authority. The callback is synchronous local work: it cannot
directly await, and this interface supplies no backend-call resource or
recurring operation. Keep it bounded and local. It is still measured against
the app's cycle usage.

Keep the queued work in managed memory before arming. Pending timers do not
survive an actor upgrade; a later event or ordinary recovery path must safely
arm durable unfinished work again. Use `scheduled_tasks` instead only when work
must begin without an event and continue while no app UI is open.

## Run Scheduled Backend Work

Use a manifest-declared scheduled task only when work must continue while no
tile or resident browser frame is open. The callback is part of the app's
Motoko module, but only the generated kernel scheduler receives timer authority:

Validate interval and per-run budget bounds against the capability catalog.
Fast callbacks are a high-authority install choice: they can repeatedly spend
instructions and their per-run backend-call budget, so use the slowest cadence and smallest budget
that satisfies the workflow.

```json
{
  "capabilities": {
    "backend_calls": {
      "api": 1,
      "description": "Refresh owner-approved ledger canisters on schedule",
      "reservation_scopes": ["principal"],
      "max_concurrency": 20,
      "max_cycles_per_call": 0,
      "max_cycles_per_day": 0
    },
    "scheduled_tasks": {
      "api": 1,
      "tasks": [
        {
          "id": "ledger_history",
          "method": "wallet_history_tick",
          "interval_seconds": 43200,
          "run_on_start": true,
          "max_backend_calls": 100
        }
      ]
    }
  },
  "func": {
    "wallet_history_tick": {
      "type": "internal",
      "async": "async*",
      "arg": ["task_capabilities"]
    }
  }
}
```

```motoko
import NeutronCapabilities "mo:neutron-capabilities";

type TaskCapabilities = {
  backend_calls : NeutronCapabilities.BackendCallsV1;
};

public func /*internal*/wallet_history_tick(
  (),
  /*task_capabilities*/ taskCapabilities : TaskCapabilities,
) : async* () {
  ignore await* refreshDueState(taskCapabilities.backend_calls);
};
```

The target must belong to the declaring app and use `async*`. When the app
declares `backend_calls`, the `/*task_capabilities*/` marker on the exact
injected record is required so the build derives the `task_capabilities`
function argument; otherwise the target takes no injected resources. A fresh record,
backend-call budget, and revocable lease are created for every run. Its
`max_backend_calls` counter is not
shared with the app's foreground capability or another scheduled task. A task
cannot create permissions: the injected capability still checks the app's
current owner-approved reservations, and scheduled work cannot open a kernel
approval dialog.

This invocation-scoped record is deliberately separate from
`AppBackendEnvironment`. A scheduled-only app declares `backend_calls` but does
not need to select `backend.capabilities.backend_calls`; selecting the
long-lived interface does not replace the callback's exact `task_capabilities`
argument. Retaining the record after the callback returns cannot extend its
authority. Disabling a task also revokes a currently running record; if
revocation happens after a remote update was dispatched, Neutron suppresses
the reply and reports that the remote outcome is unknown.

Timers themselves do not survive an actor upgrade. Neutron recreates all
compiled declarations on initialization and optionally performs the
`run_on_start` invocation. Make callbacks idempotent, persist checkpoints before
returning, guard domain-level stale continuations, and expect a reject or trap
to retry at the next interval. The kernel prevents two runs of the same task
from overlapping, while Settings lets the owner disable future runs. Scheduled
code consumes the owner's canister cycles even with the UI closed, so use the
longest practical interval and bounded work per invocation.

Settings shows this diagnostic feedback in the app's Installed Apps row, not
as a separate instructions section, capability, or rate limit. The compiler
samples call-context performance counter `1` around ordinary app updates,
scheduled callbacks, public-ingress update broker/handler messages, and HTTP
POST broker/handler messages. Queries are excluded. Nested canister execution
is excluded from the awaiting counter and is measured at its own generated
wrapper when one exists. A trap rolls back that message's final accounting
write. Raw totals remain tied to the exact app installation and separately
typed, including paid public-update cycles accepted by that app. Incoming
receipts are displayed separately and do not offset measured use. The
overview estimates usage from measured execution and explicit net transfers;
it is not a complete canister billing statement. Cost assumptions and display
format belong in `apps/kernel/backend/app_usage/Service.mo` and
`apps/kernel/src/settings/AppSettingsEntry.tsx`. Paid canister public updates
omit the ingress fee because their sender pays it; direct authenticated ingress
records it. Unmeasured transport, storage, allocation, and shared runtime costs
remain outside this estimate.

## Validate, Build, And Package

From the repository root, run the workspace's authoritative commands. npm
executes their relative script paths from the workspace directory:

```sh
npm --workspace <app-workspace-name> run package
npm --workspace <app-workspace-name> test
```

Read the app's `package.json` for the exact pipeline and test dependencies;
`apps/hello/package.json` supplies the template. Do not bypass a workspace's
complete package command by manually reconstructing its steps. The generated
artifact responsibilities are:

1. `validate`
   checks `neutron.json` against the shared schema.
2. `build`
   bundles `src/index.tsx` into `dist/web/main.js`, copies `public/`, and runs
   `mogen`.
3. `mogen`
   scans annotated Motoko methods, rewrites `neutron.json` `func`, and updates
   generated input/output aliases in the backend file.
4. `mopack`
   runs `mops sources`, walks Motoko imports, checks source for dangerous
   patterns, rewrites imports to content hashes, writes `dist/mo/<hash>.mo`,
   and writes `dist/neutron.json` with executable entry hashes plus source-only
   memory schema hashes. Automatic mode uses unmarked, provider-hosted HTTPS
   source delivery when the app has `update_source`. It adds the closed
   packaged-only `package_features: ["archive-only-legal-v1"]` installer marker
   only for a manual-only or explicitly embedded package; do not add that
   generated field to source `neutron.json`.
5. `schema`
   reads generated backend aliases and asks icblast to write
   `dist/schema.json` for every public app method.
6. `package:metadata`
   validates the app-root `NOTICE` against the license selected in
   `package.json`, then replaces `dist/legal` with the verified package record,
   application notice, governing license, and derived third-party notices. With
   `update_source`, it writes the exact generated Complete App Source gzip bytes
   outside `dist`, at
   `<app>/.neutron/sources/<sha256>.source.v1.msgpack.gz`, and records the
   source canister's certified HTTPS URL. Embedded mode retains the bounded
   source snapshot and bulk legal files inside the package instead.
7. `pack.ts`
   gzip-compresses every file under `dist/`, MessagePack-encodes them, and
   writes `<id>.v<major>.<minor>.<patch>.neutron`. For an ordinary app it also
   inserts the reserved
   `.neutron/browser-surface-origins.v1.json` package-generation marker. Do not
   author that path in `dist`; a collision is rejected.

For an NSAL 1.1 release, this tooling includes the exact `LICENSE.APP` text. For
an inspectable use-only release, it includes the exact `LICENSE.APP.USE` text.
Both include required third-party notices and identify exact Complete App
Source. The use-only license permits inspection, security review, and
verification; source availability does not grant modification or redistribution.
For a normal source-discoverable release, the provider's
update-source publisher uploads the source artifact; the installed canister
receives the license, notices, and record but not the source bytes. This is a
package and publisher responsibility, not a requirement for a Sovereign User
to publish on GitHub, operate a source host, or hand-author hashes,
combined-Wasm identities, or deployment records. Private browser assembly
remains private.

Because `build` runs `mogen`, backend annotation changes can rewrite
`neutron.json` after the first validation step. Validate the generated manifest
after changing method annotations:

```sh
npm --workspace <app-workspace-name> run build
npm --workspace <app-workspace-name> run validate
```

The app's release tests must also exercise the generated manifest; do not
assume every workspace's `npm test` has the same packaging behavior.

The output filename is derived from the app ID and release in its manifest:

```text
<app-directory>/<app-id>.v<major>.<minor>.<patch>.neutron
```

### Release A Source-Discoverable Update

Use the single
[Maintainer Release Workflow](./package-updates.md#maintainer-release-workflow)
for a SushiOS production version bump, package build, source publication,
verification, and optional Dispenser starter update. For an independently
operated source, use its
[generic publisher workflow](../support/update-source/README.md#generic-publisher-command).
An app that omits `update_source` remains manual-update-only and does not publish
through either source workflow. This guide does not duplicate those release
commands.

## Run Locally

Neutron has one local CLI deployment path. Start the supervised PocketIC server
from the repository root with your separately named format-3 config:

```sh
nix develop
npm run provision -- MY-APP.ndeploy.json serve
```

Package your app through its trusted workspace workflow, then list the Kernel
and app archive paths in the format-3 PocketIC config. Production IC configs
use exact pinned artifact records; the local development config intentionally
uses rebuildable paths. In a second terminal, perform the whole-canister
reinstall:

```sh
npm run provision -- MY-APP.ndeploy.json reinstall
npm run provision -- MY-APP.ndeploy.json status
```

`status` prints the labeled canisters and browser URLs. Their IDs are recorded
in `MY-APP.ndeploy.session.json`. Do not hardcode them in app source.
Frontends should continue to use `loadNeutronCanisterId()`.

To authorize an additional local browser or Internet Identity principal, use
the same config-bound provisioner session:

```sh
npm run provision -- MY-APP.ndeploy.json authorize <principal>
```

A later whole-canister reinstall starts with fresh Kernel authorization state,
so authorize that additional principal again afterward.

Re-running explicit format-3 `reinstall` is the app-development loop. It is
intentionally destructive and replaces every configured node with the exact
package set declared by the config. Package archives are target-neutral; the
provisioner binds the trusted local runtime environment during deployment.

The repository's root `local:start`, `local:status`, `local:deploy`, and
`local:authorize` aliases use `local.ndeploy.json`, which is a format-3
PocketIC config. Use a separately named format-3 config when your app needs a
different package set, node fleet, or authorization set.

## Install Into A Local Neutron Canister

Use the provisioner path above for ordinary development. When the product
behavior under test is Neutron's end-user installer, exercise the browser path:

1. Run the format-3 provisioner `reinstall` with a config that pins the kernel
   and any baseline apps.
2. Open the printed kernel URL.
3. Log in with local Internet Identity or the loopback-only test identity.
4. Open the tile launcher.
5. Under `Install app`, select File and choose your
   `<id>.v<major>.<minor>.<patch>.neutron`, or select URL and enter an HTTPS package URL whose
   server permits a cross-origin GET. Local loopback HTTP is also accepted.
6. Wait for browser compilation.
7. Approve the install dialog. The installed app's first tile opens in the
   current workspace when the package has launchable tiles.

This private browser workflow does not publish the archive, selected package
set, or generated Wasm to an update source or package registry, and it creates
no compliance record. Installed runtime and package assets have the anonymous
HTTP visibility documented in
[Asset Storage And HTTP Serving](./asset-storage-and-http-serving.md); that
automatic availability is not an intentional source publication and creates no
private-user distribution duty under the NPL or NSAL. Production update-source
publication is the separate maintainer workflow above.

There is no package-level developer CLI install or uninstall command. Browser
install/uninstall exists to test the reviewed product transaction, not as a
second provisioning system.

To compile package files without deploying:

```sh
bun packages/neutron-cli/src/index.ts compile \
  --package path/to/kernel.neutron \
  --package path/to/app.neutron \
  --wasm-out /tmp/neutron.wasm \
  --candid-out /tmp/neutron.did
```

Packages with id `kernel` are kernel replacement packages. They are allowed,
but they are not ordinary apps: installing one rewrites root assets and replaces
the kernel manifest used to assemble the user's Neutron actor.

## Test Your App

Run the app workspace's complete test command from the repository root:

```sh
npm --workspace <app-workspace-name> test
```

Verify the authored and generated manifest, exposed method schemas, package
metadata, clean initialization, and restoration of every managed-memory root.
Schema changes also require semantic tests from each supported released start
version. Use the source and memory tests under `apps/hello/test/` as templates,
then add checks for the app's actual behavior. Read the workspace scripts to
determine which tests build artifacts and which need an existing package.
Keep both the authoritative package command and every app-specific release
test in release qualification; packaging alone is not sufficient evidence.

Run the complete repository baseline from the root before release:

```sh
npm test
npm run typecheck
npm run security:check
npm run license:check
```

These are separate gates; the unit suite does not imply the type, security, or
application-license checks. See
[Testing And Verification](./testing-and-verification.md#fast-checks).

Run the full local browser install flow:

```sh
nix develop -c npm run test:e2e:local:fresh
```

That command performs the provisioner's destructive local reinstall before the
browser suite. Read `test/e2e/` and the root scripts for the exercised flows;
do not infer release coverage from the command name. The local suite resolves
the canister and gateway from the provisioner session. `NEUTRON_E2E_WITH_II`
selects the real local Internet Identity path.

## Security And Trust Rules

Neutron treats third-party packages as untrusted input.

Enforced boundaries include:

- manifest validation through the shared schema;
- package path validation during install;
- Motoko file path hash verification for packaged `mo/<hash>.mo` files;
- browser/kernel protocol payload validation with JSON Schema;
- kernel-side method schema derivation through icblast before approved calls;
- packaging reports dangerous text findings; install compilation hard-rejects
  non-whitelisted dangerous AST findings for ordinary apps;
- browser updates require a strictly higher app release version; explicit local
  whole-canister reinstall discards the old installed set and is not a
  production upgrade path;
- camera and microphone are gated by exact per-tile `browser_permissions`;
- frontend message-bus grants are one-call or session scoped, and a
  `provider_once` presentation accepts neither kind in place of its
  provider-owned per-operation decision.

Package hash checks, certified distribution, and memory lineage validation do
not constitute package publisher signatures. Do not treat an app's descriptive
author metadata as a signing identity. Read
[Deprecated Compatibility Paths](./deprecated.md) for retained behavior that
new apps must avoid.

Do not ask users to trust package-provided schemas. Apps can use schemas for
their own UI rendering, but the kernel must derive and validate schemas itself
before making calls.

A direct root agent may inspect the exact current installation through the
bounded `source.*` tools. That view is useful defense in depth but is installed
build output, not necessarily the complete repository: bundles may be minified,
retained Motoko is transformed, and generated, omitted, or binary content may
be unavailable. Review never replaces closed capabilities, Kernel-derived
endpoint and Agent provenance, exact amounts/accounts/expiry, post-`await`
rechecks, or durable retry safety. Updating the provider also invalidates the
old endpoint and Agent authority even if a prior review found no malicious
code.

## Package Contents

A `.neutron` file is a MessagePack map. Ordinary content keys are relative
paths from `dist/`, and each value is gzip-compressed file bytes. The packer
also inserts its reserved browser-surface generation marker for an ordinary
app; it is installer metadata, not an app-granted capability.

Typical paths for an app with one browser tile and managed memory are:

```text
.neutron/browser-surface-origins.v1.json
neutron.json
web/index.html
web/main.js
web/static/icon.png
mo/<sha256>.mo
neutron.lock.json
```

Headless apps may omit `web/` entirely. Apps without managed memory may omit
`neutron.lock.json`.

During install:

- the exact browser-surface marker makes a newly selected ordinary package
  eligible for installation-nonce tile, tray, and ordinary-background origins;
  a historical archive without it remains legacy opaque unless it declares
  `browser_permissions`, which inherently requires the new origin contract;
- present `web/*` assets become `/app/<id>/*`;
- `neutron.json` becomes `/app/<id>/pkg/neutron.json`;
- `mo/<sha256>.mo` becomes `/mo/<sha256>.mo`;
- mutable files, registry, Candid, and `/pkg/neutron.most` are staged under a
  deployment id and promoted only after the new actor reports that id;
- `/system/apps.json` contains a strict structural registry row, canonical
  capability plan, and verified plan fingerprint for every app.

Package paths must be relative, must not contain backslashes, must not contain
empty, `.`, or `..` segments, and Motoko package paths must match their content
hash.

## Current Limitations

- Use the copy-and-clean procedure for new apps; the compile CLI does not
  scaffold a project.
- The production-context compile-only CLI exists as source under
  `packages/neutron-cli`. Trusted local compilation and deployment are owned by
  the format-3 provisioner because it authenticates
  the PocketIC root context. A trusted package workflow must emit the archive
  before the provisioner can consume it.
- Ordinary apps cannot set `allow`; expose public Candid protocols through
  `capabilities.public_ingress`. `allow: "unauthorized"` is kernel-only and
  `allow: "any"` is rejected everywhere.
- App package publisher signatures and signing trust roots are not implemented.
  Installation still enforces the package, capability, and memory contracts.
- Migration functions are intentionally synchronous and bounded; large data
  changes need a compatible schema or an app-specific online transition.
- Cross-app tool grants do not persist across browser sessions. Browser media
  feature gating and browser-owned prompts are separate from message-bus
  grants.
- Developer scripts use repository workspace paths. Inspect their package
  scripts before moving an app outside this repository.

## References

- [App Development Workflow](./app-development-workflow.md)
- [Neutron Design System](./design-system.md)
- [App Package Format](./app-package-format.md)
- [Managed Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md)
- [Backend App Dependencies](./backend-app-dependencies.md)
- [Kernel-App Communication](./kernel-app-communication.md)
- [Compiler And Actor Assembly](./compiler-and-actor-assembly.md)
- [Bootstrap, Local Development, And Deployment](./bootstrap-local-development-and-deployment.md)
- [Testing And Verification](./testing-and-verification.md)
- `apps/hello/` minimal template workspace
- `apps/kitchensink/` feature-reference workspace
- `neutron-tools` and `neutron-tools/app` public SDK entrypoints
- `neutron-design-system` public UI package
