# Neutron App Developer Guide

[Back to the documentation index](./index.md)

This guide is for developers building third-party `.neutron` app packages. It
explains the practical path from a local app source tree to a package that can
be installed into a user's Neutron canister.

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
15. [Validate, Build, And Package](#validate-build-and-package)
16. [Run Locally](#run-locally)
17. [Install Into A Local Neutron Canister](#install-into-a-local-neutron-canister)
18. [Test Your App](#test-your-app)
19. [Security And Trust Rules](#security-and-trust-rules)
20. [Package Contents](#package-contents)
21. [Current Limitations](#current-limitations)
22. [Reference Files](#reference-files)

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

The current minimal working example is `apps/hello/`. The richer
`apps/kitchensink/` example shows a navigable workbench, companion tile, and
resident-backed tray, plus frontend form state, typed calls, same-app
message-bus tools, shared durable state, long scrollable content, and live
kernel-derived JSON schema display. It also imports the shared
`neutron-design-system` SCSS package and is the current design reference. Until
the app-template CLI is published, new app projects should start by copying the
`apps/hello` shape and use `apps/kitchensink` as a feature reference.

## Prerequisites

Install repository dependencies from the repository root:

```sh
npm install
```

For local replica/browser testing on NixOS, enter the repository flake shell:

```sh
nix develop
```

The shell provides Bun, Node/npm, curl, git, and Chromium on Linux. It also sets
the Playwright browser variables used by the current local tests:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=<nix chromium>
PLAYWRIGHT_CHROMIUM_ARGS=--js-flags=--stack-size=16384
```

The flake passes that V8 stack setting to the Chromium process used by
Playwright through `launchOptions.args`. Browser Motoko compilation separately
executes in a dedicated Worker rather than on the page thread; the presence of
the Chromium launch setting does not imply that compilation runs in the page.

Package construction uses Mops to resolve `mops sources`. Local canister
deployment itself is owned by `neutron-provision`; it uses the pinned PocketIC
binary directly and does not require `icp` or icp-cli project state. Neutron
compiles Motoko with its bundled Wasm compiler, so an unrelated `moc` found on
the shell `PATH` is not used for app compilation. The repo uses npm workspaces
and Bun-run TypeScript scripts, with the root `package-lock.json` as the
dependency install source of truth.

## Create Or Copy An App Project

Today, the practical starting point is:

```sh
cp -R apps/hello apps/my_app
```

Then update:

- `apps/my_app/package.json`
- `apps/my_app/neutron.json`
- `apps/my_app/backend/main.mo`
- `apps/my_app/src/index.tsx`
- any files under `apps/my_app/public/`

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

The polished generator is not built yet. The roadmap item is to publish an
app-developer package with a bundled kernel package artifact, template
generator, and one-command local install flow.

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
  neutron.lock.json
  package.json
  test/
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

`neutron.lock.json` is created by the first managed-memory package build. The
manifest is format 3; the independently versioned memory lock remains format
2. Do not write the lock by hand, and do commit it with the app's source.

`dist/`, `.mops/`, `.neutron`, `node_modules/`, and TypeScript build
info are ignored generated/local artifacts.

## Write The Motoko Backend

The backend source is a Motoko module, not an actor. The manifest `src` field
selects the file under `backend/`; in the hello app this is `backend/main.mo`.

New apps use the latest pinned `mo:core` package. Choose collections by their
semantics: Core `Map` for keyed state, `Set` for unique membership, `List` for a
growable random-access vector, and `Queue` for FIFO state. Keep immutable arrays
for Candid vectors, fixed snapshots, static catalogs, and indexed fixed-size
data; do not replace every array mechanically.

```toml
[dependencies]
core = "https://github.com/dfinity/motoko-core#v2.6.0"
```

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

| Annotation               | Meaning                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `/*update*/`             | Expose an authenticated update method.                       |
| `/*query*/`              | Expose an authenticated query method.                        |
| `/*internal*/`           | Generate an internal wrapper only.                           |
| `/*internal:apps*/`      | Export a private internal function to declared app consumers. |
| `/*query:unauthorized*/` | Kernel package only. Ordinary apps are rejected and must declare `capabilities.public_ingress`. |

The annotation comment must appear directly between `public func` and the
method name. Generated method names are limited to 128 ASCII characters and
must start with a letter or underscore, followed only by letters, digits, or
underscores:

```motoko
public func /*update*/set_name(name : Text) : Text { ... }
```

> **Tip: use `async*` for local asynchronous call chains.** If one local
> backend function calls another asynchronous local function, return
> `async* T` and call it with `await*`. This executes local layers inline and
> avoids adding commit and interleaving points merely to move between helper
> functions. Keep ordinary `await` for the real shared actor or management
> canister call where suspension is unavoidable.

```motoko
func fetchRemoteName(service : actor { read : shared () -> async Text }) : async* Text {
  await service.read();
};

public func /*update*/refresh_name(
  service : actor { read : shared () -> async Text }
) : async* Text {
  let name = await* fetchRemoteName(service);
  mem.name := name;
  name;
};
```

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

`protocol` and `id` each use lowercase letters, digits, and underscores, start
with a letter, and are at most 63 characters; their combined `protocol:id`
resource is at most 64 characters. Each byte limit is 1 through 1,048,576.
Query routes omit `max_calls_per_hour`, `max_calls_per_caller_per_hour`, and
`required_cycles` and may choose `caller` as `any`, `authenticated`, or
`canister`; query `authenticated` means
every non-anonymous principal, not only Neutron owners. Every update declares
a shared rate from 1 through 3,600 and may add
`max_calls_per_caller_per_hour` from 1 through that rate. The optional caller
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
`@neutron-org/tools` when generating a client or backend reservation. One
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
1,200,000-cycle ingress-reception base and 260,000-cycle self-handler base are
attributed to the receiving app instead.

Set the route floor as a static protocol-version fact, not a caller-selected
quote. It must cover all irreversible work, including at least the receiver's
current 13-node 5,000,000-cycle update execution bases, conservative measured
handler instructions, and storage of the maximum admitted payload for the
protocol's promised retention horizon.
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

The frontend is ordinary browser code bundled into `dist/web/`. The hello app
uses React, TypeScript, Bun, and esbuild:

```ts
// apps/hello/build.ts
entryPoints: ["./src/index.tsx"];
outfile: "./dist/web/main.js";
platform: "browser";
```

Static files from `public/` are copied into `dist/web/`. Keep app frontends
browser-safe: do not rely on Node/Bun globals at runtime.

Installed apps are served under:

```text
/app/<app-id>/<tile-path>
```

The kernel loads each opened app tile in a credentialless iframe. A package can
declare multiple frontend tiles in `neutron.json`:

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
workspace classes from inside an app. The design-system rules are dark-only,
gradient-free, scoped under `.nt-app`, and capped at `5px` radius. Kitchen Sink
shows the current reference implementation for forms, typed calls, schema
display, warning/danger states, and resize-heavy text surfaces. See
[Neutron Design System](./design-system.md).

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
- `callDialog(method, args, timeout)`, which asks the kernel to show an
  approval dialog and then make the call with the currently authenticated
  kernel identity.

For methods on your app backend, use the Neutron canister id from
`loadNeutronCanisterId()`. Installed app methods are methods on the user's
combined Neutron canister, not on a separate app canister.

`callDialog()` arguments should be a JSON array matching the Candid argument
order. Apps send JSON-compatible values only: no `undefined`, `NaN`, `BigInt`,
functions, cycles, class instances, `Uint8Array`, Candid text, Candid encoded
bytes, package-provided schemas, or identities. For current generated app
wrappers, no-argument methods use `[null]`, single-argument methods use
`["value"]`, and multi-parameter Motoko methods use one tuple argument such as
`[["Ada", "ada@example.test", "Notes", true]]`. `Int` and `Nat` values use
icblast's JSON form, currently strings such as `"42"`.

The kernel derives method schemas from the installed canister interface with
icblast and uses that trusted interface to convert approved JSON arguments into
Candid calls. App builds also write `dist/schema.json` with the same
wrapper-accurate method schemas for local tests, package inspection, and app
developer tooling. The kernel does not trust that package file at runtime.

These helpers now call `canister.schema` and `canister.call_dialog` through the
same frontend message bus used by app tools. There is no direct app-facing
canister `call` action.

### Preapprove Exact Self Calls

An app may let its own registered tile, tray, and background endpoints call
selected owner-authorized query and update methods without a per-call dialog.
Declare a versioned object containing a unique list of exact method names:

```json
{
  "capabilities": {
    "preapproved_self_calls": {
      "api": 1,
      "methods": [
        "read_profile",
        "refresh_profile"
      ]
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

This capability changes frontend consent only. The generated backend wrapper
keeps its normal owner-authorization assertion, and no Motoko capability handle
is injected. See
[App Method Access And Call Consent](./app-method-access-and-call-consent.md)
for the complete policy.

### Use A Browser Ethereum Provider

Browser extensions do not inject providers into Neutron's opaque app iframes.
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
the returned provider-shaped proxy:

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

Without a dedicated capability the background is credentialless with an opaque
origin. Choose `dedicated_resident_origin` for a credentialless ephemeral
dedicated origin, such as when a Worker needs same-origin script loading, or
choose `persistent_browser_storage` for ordinary persistent origin storage.
Those capabilities are mutually exclusive. Their exact manifest shapes,
certified initial-document binding, browser checks, rotation, and subresource
policy are specified in
[Dedicated Resident Origins](./kernel-http-v2-and-certified-assets.md#dedicated-resident-origins).

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

Call your own background from a tile:

```ts
import { callTool, loadTileContext } from "neutron-tools/app";

const appId = loadTileContext().app!;
const result = await callTool({
  target: `app:${appId}:background`,
  name: "notes_search",
  arguments: { query: "roadmap" },
});
```

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

Use `createMsgBusClient()` to list installed apps, live endpoints, and allowed
tools. Same-app calls are allowed by default. Cross-app tool listing or calls
show a kernel-owned approval dialog and require a one-call or session grant.
Arguments are JSON objects and schemas use JSON Schema draft-07. Tool metadata
is treated as untrusted when shown to users or agents.

Keep tile-only control methods out of other apps' and agents' live catalogs by
adding `annotations: { "neutron:visibility": "same_app" }`. The kernel filters
discovery and rejects direct cross-app invocation; handlers should still
validate the caller role when a control is tile-only.

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
      "categories": [
        "frontend_tool",
        "signed_canister_call",
        "backend_access"
      ]
    }
  }
}
```

`agent_entrypoints.entrypoints` may contain up to four exact resident tool
names. It is an install disclosure, not a grant. The owner enables one exact
entrypoint in a kernel danger dialog. A turn then starts only when the app's
focused tile calls that entrypoint during transient user activation.

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
not copy caller, root, or Agent Mode fields into your schema. A nested handler
that uses a global bus for a permission-bearing request fails closed with
`SCOPED_CONTEXT_REQUIRED`. Ordinary work outside a routed handler can still use
`createMsgBusClient()`. Long-running handlers should also observe
`context.signal`; the kernel aborts it when the owner stops the root. Treat it
as cancellation of future work, not rollback of a remote call already sent.

`context.agentMode` is true for every handler in the kernel-attested turn and
false otherwise. Use it only for a narrow app-owned policy; it is not a
substitute for normal kernel permission checks or caller validation.

Only the approved root agent handler receives `context.agentConsent`. Register
its private decision and cancellation callbacks for the dynamic extent of the
turn. They are kernel control messages on the existing private bus and are not
discoverable tools. Called apps must not implement an approval tool or expect
to receive challenge ids.

`background_ui_requests.categories` lists which normal owner-dialog classes a
resident may request outside Agent Mode. It does not preapprove them. Omit
classes the background does not need.

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
or open a missing one without a dialog when the request comes from the currently
focused tile with transient user activation. A focused open tray has a narrower
shortcut: during transient user activation it may open or reuse only a tile of
its own app. Opening another app's tile retains kernel consent. These are
user-visible navigation operations; they do not grant cross-app tools, backend
methods, identities, or canister calls. Background processes and non-focused
surfaces require the normal consent path.

If no matching tile is open, the kernel shows one trusted Open Tile dialog
unless a focused tile is handling the activated click or a focused tray is
using the activated same-app shortcut. Approval is once-only and opens exactly
one installed tile; there is no "allow for session" option. Omit `workspace` to
use the active workspace. A supplied workspace must be the active workspace;
apps cannot switch workspaces, and `reuseExisting: false` cannot force a
duplicate. App-driven navigation is throttled to one new tile per 20 seconds and
one focus change per two seconds, and kernel workspace capacities still apply.

`view` is an optional navigation token matching
`^[a-z][a-z0-9_/-]{0,63}$`. It carries no payload and no authority. A target
tile opts in by handling it:

```ts
import { onTileViewRequest } from "neutron-tools/app";

const stop = onTileViewRequest((view) => {
  if (view === "create") showBlankEditor();
});
```

### Copy From A Tile

Sandboxed app frames must not call `navigator.clipboard` directly. Ask the
trusted kernel page to copy through the existing private message bus action:

```tsx
import { copyToClipboard } from "neutron-tools/app";

<button type="button" onClick={() => void copyToClipboard(value)}>
  Copy
</button>
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

Use view requests only to select visible UI. Never save, delete, sign, make a
backend call, or otherwise cause a persistent side effect merely because a
view token arrived. Perform those actions through normal controls and consent
paths. Unsubscribe with the returned `stop` function when the handler's UI
lifecycle ends.

Tiles remain credentialless opaque frames. A background uses the compiled
opaque, credentialless-ephemeral dedicated, or persistent dedicated mode
described in
[Dedicated Resident Origins](./kernel-http-v2-and-certified-assets.md#dedicated-resident-origins).
The kernel transfers a private `MessagePort` to each registered frame and
derives caller identity from that registration. A background iframe may create
a dedicated worker for WebGPU or other heavy work; do not use a service worker
as the resident lifecycle primitive.

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
Only a badge from `0` through `9999`, or `null`, is accepted; `0` and `null`
clear it. Updating the badge cannot notify, focus, open, move, or otherwise
change shell UI. The tray declaration itself adds no permission.

Clicking the kernel-rendered toolbar button containing the app-provided icon
mounts `tray.html` in a fresh, credentialless, script-only sandbox. The
transient endpoint is
`app:<appId>:tray:instance:<instanceId>` and disappears when the popover closes,
so fetch state from the resident process on every mount. Calls from the tray to
its own background use the normal same-app message bus without approval. A tray
does not inherit tile-only privileges. From a focused click, it may open or
reuse a tile of the same app without a dialog; opening another app's tile keeps
the normal kernel consent flow.

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
  "capabilities": {
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

`requestConnection()` opens a kernel-owned consent dialog and authorization
window. The provider returns to the single root callback page, and the kernel
backend exchanges and stores the credential. `listConnections()` returns only
redacted summaries. `listConnections(provider)`,
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
installation-isolated threshold key; `https_outcalls` makes paid requests beneath exact external HTTPS
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
      "reservation_scopes": ["principal"],
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
One app may declare at most 64 install defaults and the complete target at most
2,048; exact duplicate default scopes across apps are rejected.

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

That Wallet example is for reviewed preset ledgers. For a user-supplied custom
ledger, request separate `exact` scopes for `icrc1_metadata`,
`icrc1_balance_of`, `icrc1_fee`, and `icrc1_transfer` instead of whole-principal
access.

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

Use `call_batch` for concurrency. It accepts at most the manifest cap and never
more than 20 calls. The kernel creates all remote futures before its first
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
request field or runtime request counter. The broker permits only one in-flight
request per installation and four across Neutron and refuses dispatch below
its cycle reserve. The captured
installation scope is checked before and after the await, so a retained handle
cannot outlive its authority. Use the returned value as a seed and expand it
locally when one operation needs many random draws.

### Sign App Assertions With A Chain Key (Development V1)

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
      "slots": [{
        "id": "receipts",
        "algorithm": "ecdsa_secp256k1",
        "purpose": "Sign application receipt assertions",
        "max_assertion_bytes": 4096
      }]
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
plaintext secrets. Future value-moving transaction adapters require separate,
one-shot owner confirmation; this install grant never supplies that consent.
An external verifier can still assign high-impact authority to a signed
assertion, so constrain assertion semantics and verifier policy. See
[App-Isolated Chain-Key Assertion Signing
V1](./app-isolated-chain-key-signing.md) for exact bounds and byte encoding.

### Use Stable Store (Development V1)

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
      "stores": [{
        "id": "notes",
        "purpose": "Keep revision-safe notes",
        "schema_version": 1,
        "max_entries": 128,
        "max_key_bytes": 64,
        "max_value_bytes": 4096,
        "max_bytes": 262144
      }]
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

### Use HTTPS Outcalls (Development V1)

Declare exact external URL prefixes and select the scoped backend leaf. V1 is
replicated GET/HEAD/POST only, strips every response header, and has no
confidentiality from subnet replicas:

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
      "endpoints": [{
        "id": "example",
        "url_prefix": "https://example.com/",
        "methods": ["get", "head"],
        "request_headers": ["accept"],
        "max_request_bytes": 4096,
        "max_response_bytes": 32768,
        "transform": "strip_headers"
      }]
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

Runtime `path` is a canonical relative suffix capped at 1,024 UTF-8 bytes and
64 segments; query pairs are structured and percent-encoded by the kernel. The
app cannot replace the declared scheme,
host, port, prefix, transform, replication mode, response ceiling, or attached
cycle amount. Header values must be printable ASCII and are capped at 4,096 bytes
each and 16 KiB in aggregate. GET/HEAD require an empty body and no key. POST requires a 16–64
character idempotency key, but the remote service must actually deduplicate it;
Neutron never retries or promises exactly-once execution.

There is no hourly call or cycle budget. Request/reply ceilings are 64 KiB/512
KiB; endpoint/app/global concurrency, a 50-billion-cycle per-call quote cap,
and a 250-billion-cycle reserve apply. Authority loss after the await
suppresses response bytes but cannot undo a remote POST.

Do not put secrets in URL parameters, headers, or bodies: replicated HTTPS
outcalls are visible to subnet replicas. PocketIC may not provide an HTTPS
adapter, and mainnet calls can still fail for cycles, upstream availability,
timeout, or response-consensus reasons. Use an injected adapter for deterministic
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
  public func receive_hook(
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

`max_request_bytes`, `max_response_bytes`, and `max_calls_per_hour` are closed
install-time ceilings: request and reply are 1–65,536 bytes, rate is
1–240/hour, and no app can exceed 240 accepted POSTs/hour or 8 MiB of possible
replay replies across all its mounts. `forward_headers` contains at most eight
unique lowercase names. The kernel never forwards Host, framing, cookies,
upgrade/certification fields, or the raw `Idempotency-Key`. Each forwarded
value is at most 4,096 bytes and may appear only once. Cookie/Set-Cookie,
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

Declare one to four named key slots when browser code needs a durable,
app-isolated vetKD namespace:

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

Keys are 1-40 characters, delays are 10 seconds through 30 days, and at most
eight keys may be active for one app installation. `status(key)` reports
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

Intervals range from 10 seconds through 30 days. Fast callbacks are a
high-authority install choice: they can repeatedly spend instructions and their
per-run backend-call budget, so use the slowest cadence and smallest budget
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
  taskCapabilities : TaskCapabilities,
) : async* () {
  ignore await* refreshDueState(taskCapabilities.backend_calls);
};
```

The target must belong to the declaring app and use `async*`. When the app
declares `backend_calls`, the exact `task_capabilities` resource shown above is
required; otherwise the target takes no injected resources. A fresh record,
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
overview's cycles-used value uses the current low-side 13-node
rates: one cycle per instruction, 5,000,000 cycles per measured update
execution, 1,200,000 cycles of ingress reception per authorized or
direct-authenticated-ingress update, and
260,000 cycles per brokered call or measured timer/handler self-call in
addition to net explicit transfers. Paid canister public updates omit the
ingress fee because their sender pays it; direct authenticated ingress records
it. It formats the result to four
decimal places in `TC`; variable byte fees, callback bases, shared global-timer
dispatch, storage, and compute allocation remain excluded.

## Validate, Build, And Package

Run app scripts from the app directory because the current script paths are
relative to that directory:

```sh
cd apps/my_app
npm test
npm run package
```

The hello app package script is the current model:

```json
"package": "npm run validate && npm run build && npm run mopack && npm run schema && npm run package:metadata && bun ../../packages/neutron-scripts/src/pack.ts"
```

The steps are:

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
   replaces `dist/legal` with the verified package record, concise application
   notice, governing license, and derived third-party notices. With
   `update_source`, it writes the exact generated Complete App Source gzip bytes
   outside `dist`, at
   `<app>/.neutron/sources/<sha256>.source.v1.msgpack.gz`, and records the
   source canister's certified HTTPS URL. Embedded mode retains the bounded
   source snapshot and bulk legal files inside the package instead.
7. `pack.ts`
   gzip-compresses every file under `dist/`, MessagePack-encodes them, and
   writes `<id>.v<major>.<minor>.<patch>.neutron`.

For an NSAL 1.1 release, this tooling includes the exact `LICENSE.APP` text. For
an inspectable use-only release, it includes the exact `LICENSE.APP.USE` text.
Both include required third-party notices and identify exact Complete App
Source; the use-only source offer grants inspection, not modification or
redistribution. For a normal source-discoverable release, the provider's
update-source publisher uploads the source artifact; the installed canister
receives the license, notices, and record but not the source bytes. This is a
package and publisher responsibility, not a requirement for a Sovereign User
to publish on GitHub, operate a source host, or hand-author hashes,
combined-Wasm identities, or deployment records. Private browser assembly
remains private.

Because `build` runs `mogen`, backend annotation changes can rewrite
`neutron.json` after the first validation step. After changing method
annotations, run either:

```sh
npm run build && npm run validate
```

or:

```sh
npm test
```

before publishing or installing the package.

For hello, the output is:

```text
apps/hello/hello.v0.2.4.neutron
```

### Release A Source-Discoverable Update

Use the single
[Maintainer Release Workflow](./package-updates.md#maintainer-release-workflow)
for the version bump, package build, production source publication,
verification, and optional Dispenser starter update. This guide does not
duplicate those release commands.

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
  --package apps/kernel/kernel.v0.3.12.neutron \
  --package apps/my_app/my_app.v0.1.0.neutron \
  --wasm-out /tmp/neutron.wasm \
  --candid-out /tmp/neutron.did
```

Packages with id `kernel` are kernel replacement packages. They are allowed,
but they are not ordinary apps: installing one rewrites root assets and replaces
the kernel manifest used to assemble the user's Neutron actor.

## Test Your App

Use fast package-level tests first:

```sh
cd apps/my_app
npm test
npm run package
```

The sample app tests check that:

- `neutron.json` validates;
- the declared methods are present;
- the apps declare the expected launcher tile metadata;
- the generated Candid aliases can produce an app-usable JSON Schema through
  icblast.

These package tests are fast checks around source and metadata. They do not
build the final `.neutron` archive unless the app test explicitly invokes the
package script.

Run the repository unit suite from the root before changing shared packages:

```sh
npm test
```

Run the full local browser install flow:

```sh
nix develop -c npm run test:e2e:local:fresh
```

That command first performs the provisioner's whole-canister local reinstall,
then signs in, exercises installed apps and the reviewed browser package flow,
approves a typed call, and rejects malformed app requests. The normal suite
resolves the canister and gateway only from `local.ndeploy.session.json`.
`NEUTRON_E2E_WITH_II` enables the real local Internet Identity path.

## Security And Trust Rules

Neutron treats third-party packages as untrusted input.

Current enforced rules include:

- manifest validation through the shared schema;
- package path validation during install;
- Motoko file path hash verification for packaged `mo/<hash>.mo` files;
- browser/kernel protocol payload validation with JSON Schema;
- kernel-side method schema derivation through icblast before approved calls.

Current important gaps:

- packaging reports dangerous text findings; install compilation hard-rejects
  non-whitelisted dangerous AST findings for ordinary apps;
- package signatures and publisher identity are not implemented;
- browser updates require a strictly higher app release version; trusted local
  whole-canister provisioning may redeploy the same version, while every path
  rejects downgrades;
- persistent cross-app grants and browser resource quotas are still follow-up
  work; current frontend grants are one-call or session scoped;
- package publisher signatures remain separate from the implemented memory
  ownership and schema-hash checks.

Do not ask users to trust package-provided schemas. Apps can use schemas for
their own UI rendering, but the kernel must derive and validate schemas itself
before making calls.

## Package Contents

A `.neutron` file is a MessagePack map. Each key is a relative path from
`dist/`, and each value is gzip-compressed file bytes.

Typical paths for an app with one browser tile and managed memory are:

```text
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

- There is no published app-template generator yet. Copy `apps/hello` for now.
- The production-context compile-only CLI exists as source under
  `packages/neutron-cli`. Trusted local `neutron_actor_v25` compilation and
  deployment are owned by the format-3 provisioner because it authenticates
  the PocketIC root context. A trusted package workflow must emit the archive
  before the provisioner can consume it.
- Apps may own multiple managed memory roots. Their manifest ids are local to
  the app; the compiler gives every stable field and schema/migration alias an
  owner-and-local-id physical name.
- Ordinary apps cannot set `allow`; expose public Candid protocols through
  `capabilities.public_ingress`. `allow: "unauthorized"` is kernel-only and
  `allow: "any"` is rejected everywhere.
- App package signing, publisher trust roots, and install policy are not
  implemented.
- Migration functions are intentionally synchronous and bounded; large data
  changes need a compatible schema or an app-specific online transition.
- Persistent cross-app grants, resource quotas, and browser feature gating are
  not implemented; current grants last for one call or the page session.
- Browser install error-state coverage exists as a follow-up, even though the
  happy path is covered by Playwright.
- Some developer scripts are still repo-relative. The roadmap is to remove
  assumptions that app authors know this repository layout.

## Reference Files

- [App Development Workflow](./app-development-workflow.md)
- [Neutron Design System](./design-system.md)
- [App Package Format](./app-package-format.md)
- [Managed Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md)
- [Backend App Dependencies](./backend-app-dependencies.md)
- [Kernel-App Communication](./kernel-app-communication.md)
- [Compiler And Actor Assembly](./compiler-and-actor-assembly.md)
- [Bootstrap, Local Development, And Deployment](./bootstrap-local-development-and-deployment.md)
- [Testing And Verification](./testing-and-verification.md)
- `apps/hello/`
- `apps/kitchensink/`
- `packages/neutron-design-system/`
- `packages/neutron-tools/src/app.ts`
- `packages/neutron-tools/src/schema.ts`
- `packages/neutron-scripts/src/mogen.ts`
- `packages/neutron-scripts/src/mopack.ts`
- `packages/neutron-scripts/src/pack.ts`
- `packages/neutron-cli/src/index.ts`
- `packages/neutron-compiler/src/assemble.ts`
- `packages/neutron-compiler/src/install.ts`
