# Kernel Capability Inventory

Use this reference to locate capability declarations, authority boundaries, and
lifecycle enforcement before changing an app or Kernel. The tables summarize
intent; exact schemas, APIs, supported methods, and bounds belong to source.

| Concern | Source entry point |
| --- | --- |
| Declared/derived IDs, schemas, normalization, and backend interface selection | `packages/neutron-tools/src/capabilities/catalog.ts` |
| Canonical reviewed authority and fingerprints | `packages/neutron-tools/src/capabilities/plan.ts` |
| Runtime resource projection | `packages/neutron-tools/src/capabilities/runtime.ts` |
| Compiler delivery, registration, and aggregate admission | `packages/neutron-compiler/src/assemble.ts` |
| App-facing Motoko types | `packages/neutron-motoko-capabilities/src/lib.mo` |
| Scope identity, toggles, and metadata-only audit | `apps/kernel/backend/capabilities/`; install scope lifecycle in `apps/kernel/backend/install/` |
| Broker behavior | The corresponding service directory in `apps/kernel/backend/`; frontend routing in `apps/kernel/src/expose.ts` |

Runtime authorization is installation-scoped. Some data or key identities have
explicit retention rules across installations; do not infer their lifecycle
from AppScope alone.

```text
manifest declaration or structural fact
    -> normalized catalog entry
    -> canonical plan + fingerprint
    -> compiler handle/registration
    -> live AppScope-bound resource
```

## Vocabulary

| Term | Meaning |
| --- | --- |
| Declared | Selected explicitly in `manifest.capabilities` |
| Derived | Produced from functions, memory, dependencies, endpoints, or another closed declaration |
| AppScope | Exact `(app_id, installation_uid)` authority lifetime |
| Resource ID | Canonical app-local identifier for one independently controlled capability resource |
| Plan fingerprint | SHA-256 binding of the canonical plan reviewed and compiled for the installation |
| Declaration grant | Authority activated by the approved install |
| Owner runtime grant | A declared facility that also requires a later owner action |
| Structural registration | Compiler-created authority implied by package structure |
| Live recheck | Broker checks current scope, enablement, and revocation before and after asynchronous work |

App code never authors a capability implementation. It selects a closed schema
and finite bounds.

## Declared Capabilities

| ID | Purpose | Main boundary |
| --- | --- | --- |
| `backend_calls` | Call reserved remote canisters and methods, optionally transferring bounded cycles | Exact reservations, per-call/day cycles, concurrency, transport bounds, post-`await` lease checks |
| `randomness` | Obtain 32 bytes of consensus randomness | Bounded concurrency, low-cycle reserve, no raw management handle |
| `chain_key_signing` | Sign domain-separated app assertions | Exact algorithm slots, bounded assertion size, cost and concurrency limits |
| `wallet_custody_signing` | Owner-trusted wallet exact-digest secp256k1 signing | Namespace-v2 durable Neutron/app-ID/slot key identity, live installation authority, exact 32-byte digest, shared signing resources and runtime revocation |
| `stable_store` | Durable app-installation key/value stores | Exact stores, schemas, entry/key/value/byte quotas, conditional writes |
| `https_outcalls` | Call exact external HTTPS URL prefixes | Closed methods/headers, request/response limits, transform, cycles, concurrency |
| `vetkeys` | Use app-isolated encrypted-key slots | Exact slots, browser derivation, attenuated backend public-key access, generation lifecycle |
| `scheduled_tasks` | Run exact backend methods on bounded schedules | Per-app and actor-wide task admission, per-run backend-call ceiling |
| `preapproved_self_calls` | Let app UI call exact owner-authorized self methods without another prompt | Exact method/mode, live Candid, source and scope binding |
| `frontend_tools` | Let app surfaces call exact tools on named installed apps using install approval | Exact app IDs/tool names, current installation plan and endpoint checks; provider confirmation and private audiences remain separate |
| `agent_entrypoints` | Expose exact resident-background tools and admit that resident to Kernel visual workspace tools | Exact declared entrypoints, resident role and endpoint binding; workspace control is invocation-free resident or direct-root only |
| `background_ui_requests` | Let a resident request exact Kernel dialog categories | Closed dialog categories; Kernel retains user interaction |
| `ethereum_provider` | Use exact EIP-1193 methods on exact chains | Focused owner activation, EIP-6963 provider selection, bounded session |
| `connections` | Connect a resident background to exact trusted providers/scopes | Provider catalog/adapter, PKCE, one credential per `(AppScope, provider)` |
| `browser_permissions` | Let exact tiles request selected browser device features directly | API 1, exact declared tile IDs, closed camera/microphone set, certified child policy plus iframe delegation, browser-controlled prompt |
| `persistent_browser_storage` | Give one resident an installation-dedicated persistent origin | Exact background surface, nonce/epoch rotation, certified initial document |
| `dedicated_resident_origin` | Give one resident a credentialless ephemeral dedicated origin | Exact background surface and one current origin binding |
| `public_ingress` | Expose bounded public Candid protocol routes | Compiler-bound route and handler, caller policy, body/rate/cycle limits |
| `http_routes` | Expose bounded public mutating HTTP `POST` handlers | API 1 only, exact mount, app-host/shared-path policy, rate/replay/body/header bounds |
| `certified_assets` | Store and publish records through three fixed certified collection kinds | API 2 declaration schema, app-scoped handle, collection/entry/byte/stage/batch/receipt limits |

The `certified_assets` API number versions its typed storage declaration and
handle. It is not an authored HTTP route protocol. Certified read routes are
derived separately.

## Derived Capabilities

| ID | Derived from | Authority |
| --- | --- | --- |
| `stable_memory` | Active memory declarations | Exact stable roots delivered to the owning backend |
| `memory_lifecycle` | Memory schemas, migrations, and retirement | Ordered migration and commit-time retirement plan |
| `app_calls` | Typed app dependencies | Exact functions on exact installed provider apps |
| `backend_environment` | Selected backend interfaces | Exact versioned capability fields in the backend environment |
| `certified_read_routes` | Certified Assets collection mounts and kinds | Fixed GET/HEAD policy, route reservation, enablement, and certified absence |
| `function_resources` | Function `arg` resources | Exact Kernel-owned values injected into exact methods |
| `app_exports` | Internal functions exposed to apps | Exact inter-app callable methods and modes |
| `tile_endpoints` | Declared tiles | Exact disposable tile paths; omitted for headless apps |
| `background_endpoint` | Declared resident background | Exact path and resident-frame security mode |
| `tray_endpoint` | Declared tray | Exact private tray path |

## Backend Environment

An app receives only interfaces selected by
`backend.capabilities`. Public leaf types live in
`packages/neutron-motoko-capabilities`.

Read `BACKEND_CAPABILITY_INTERFACES` in the catalog for the selectable IDs
and API versions. Selection is delivery, not declaration: each selected broker
must have its independently valid capability declaration. The attenuated
`vetkeys_public` backend leaf corresponds to the browser `vetkeys` declaration;
`certified_assets` uses API 2 for both declaration and leaf.

`deferred_timers` is a structural Kernel service rather than an authored
capability declaration. It provides keyed, leading-edge, one-shot timers:
arming an existing key returns the existing due time instead of moving it.
Timers are AppScope-bound and finite. The scheduler owns delay and admission
limits; inspect `apps/kernel/backend/scheduler/` before changing them.

The environment is compiler-created. App source cannot construct a broader
handle, substitute an AppScope, or reach a Kernel service object.

## Certified Assets And Read Routes

`certified_assets` has three collection kinds:

| Kind | Locator and writes | Synthesized read authority |
| --- | --- | --- |
| `publication` | Kernel-allocated opaque publication ID plus a caller-supplied, Kernel-validated safe filename; staged create and conditional delete | Exact Neutron Host; `GET` and `HEAD`; bounded range support |
| `immutable_blob` | Exact body SHA-256 beneath a declared prefix; create if absent, no replacement while present, exact conditional delete | Canister gateway; full-body `GET` |
| `mutable_blob` | 32-byte key beneath a prefix or one exact path; CAS create/replace/delete | Canister gateway; full-body `GET` |

The authored collection contains only its ID, logical mount ID, kind, optional
kind-appropriate path location, and optional object limit. Scope-wide limits
are fields of the enclosing `certified_assets` declaration. Kind determines
path derivation, mutation, body source, presentation, headers, cache, CORS,
methods, certification expression, and absence.

The compiler groups collections by mount and synthesizes one
`certified_read_routes` resource per group:

- publication mounts use host-bound `GET` and `HEAD`;
- blob mounts use portable gateway `GET`;
- one mount cannot mix publication and blob collections;
- authored POST and derived read mounts share one aggregate admission limit; and
- mount IDs cannot collide.

Apps never author certification expressions, response headers, route
authority, or raw tree keys.

See [Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md).

## Backend Call Reservations

`backend_calls` separates a declared broker from live remote targets.
Declarations specify which reservation shapes are allowed:

- exact principal and method;
- all methods on one principal; or
- one method across principals.

The manifest may include install-reviewed `install_reservations`. Those defaults
are compiled into the backend-call declaration. A pristine target materializes
them synchronously when all target scopes are active. An incremental install
prepares changed claims while the predecessor is still running, then the target
commit finalizes them before publishing any other install state.

Install defaults have per-app and actor-wide bounds. The assembler rejects an
exact duplicate default reservation scope claimed across apps.

The Kernel also supports explicit later owner changes. Both paths produce the
same reservation records and broker checks.

An app can request an exceptional cycle transfer with
`requestOneTimeCycleCall`. Kernel presents an owner confirmation showing
the exact app, destination, method, cycle amount and estimated remaining
balance. The owner must acknowledge the warning for each request, including
requests originating from root agents. Acceptance dispatches that call; it
does not grant an allowance or change the app's per-call or daily budget.
Existing backend declarations, reservations and installation checks still apply.

The request contains a 16-byte hexadecimal `requestId`, `canister`, `method`,
raw Candid `argsHex`, decimal `cyclesAtoms`, and optional `allowPartial`.
The latter approves an upper amount that can decrease at dispatch to retain
the configured operating reserve plus the call cost. Exact amounts reject if
they no longer fit. `quoteOneTimeCycleCall` previews this calculation without
spending; `getOneTimeCycleCallStatus` and paginated `listOneTimeCycleCalls`
read retained outcomes. Frontend tools pass their `context.kernel` to these
SDK helpers. Reusing an ID returns the saved result, including an unresolved
dispatch; it never sends the call again. Applications must decode the remote
reply before describing a protocol-specific success.

## Public Protocol Surfaces

The three public mechanisms are deliberately separate:

| Surface | Use |
| --- | --- |
| `public_ingress` | Public Candid query/update protocols on compiler-created physical methods |
| `http_routes` | Bounded HTTP `POST` requests that dispatch to exact internal synchronous handlers |
| `certified_read_routes` | Compiler-derived certified `GET`/`HEAD` serving from closed collections |

`http_routes` lets a declared handler return a bounded body and an allowed
content type. It does not give the app arbitrary HTTP headers or certification
policy. The mount fixes location, request/response bounds, forwarded headers,
rate, replay budget, and handler. The Kernel owns Host admission and reserved
paths.

`public_ingress` binds protocol, logical route ID, handler, mode, caller class,
body limits, required cycles, and update rate into the generated actor. An
ordinary function declaration cannot use Kernel's unauthorized-call escape.

## Connections

Connections declarations contain only:

```json
{
  "api": 1,
  "providers": [
    { "provider": "openrouter", "scopes": [] }
  ]
}
```

The trusted provider catalog validates IDs and supported scopes. A typed
backend adapter owns provider-specific authorization and exchange protocol.
The generic frontend and backend brokers own AppScope, owner, resident,
callback, TTL, PKCE, credential storage, cycle accounting, and revocation.
Declaring Connections requires a resident background.

`apps/kernel/connections/providers.json` is the sole rich provider descriptor.
It generates the frontend and Motoko catalogs plus the minimal
`connection-providers.json` support metadata installed at
`/pkg/connection-providers.json`. That certified metadata contains only its
schema and provider/scope pairs.

There is no public connection ID or app-authored provider endpoint. Listing is
a query. Acquire and disconnect remain protected operations. Declarations have
per-app and actor-wide admission bounds.

## Browser Wallet Capability

`ethereum_provider` declares a bounded list of chains and a subset of the
closed method set. Transaction use requires account access. A focused tile and
owner activation create a short-lived source-bound session.

Discovery is EIP-6963 only. If several browser wallets announce themselves,
the Kernel asks the owner to choose and binds that provider object to the
session. Names and reverse-DNS strings are display hints, not trust.

## Browser Device Permissions

`browser_permissions` is a frontend-only declaration. API 1 maps exact
declared tile IDs to `camera`, `microphone`, or both. The compiler rejects an
unknown tile ID, and trays and backgrounds cannot receive this declaration.

Approval lets the exact tile ask the browser for the selected feature; it does
not start capture or override browser and operating-system permission. The
Kernel intersects a certified, Host-bound Permissions Policy with the iframe's
exact-origin `allow` value. The tile then calls browser APIs such as
`navigator.mediaDevices.getUserMedia()` directly. Media bytes, streams, browser
prompts, and prompt decisions do not pass through or get audited by the Kernel
backend.

For app-frame compatibility paths and migration requirements, see
[Deprecated interfaces](./deprecated.md). A declaration alone does not prove
that the browser is running an exact-origin frame.

## Capability Lifecycle

All catalog entries use the staged-installation lifecycle:

1. normalize and fingerprint the target plan;
2. show the owner its exact authority or structural change;
3. stage compiler registrations and runtime declarations;
4. activate them only in the successful install commit;
5. retain unchanged exact resources when allowed;
6. rotate or replace authority when the installation changes;
7. disable through the live registry where supported; and
8. purge the removed scope on uninstall.

The capability registry is also a kill switch and bounded audit surface, with
per-installation and actor-wide admission. Audit is metadata-only; payloads,
credentials, keys, assertions, and certified bodies are not retained there.

Successful runtime capability toggles also advance the actor's capability
authority revision. The trusted frontend observes that revision together with
the deployment identity and invalidates every mounted app frame and transient
runtime grant when it changes.

## Scale And Admission

Admission has several layers: declaration shape and per-app limits in the
catalog; aggregate target checks in the assembler; install transaction limits;
and runtime actual-usage/concurrency checks in each broker. Changing one layer
alone can create a manifest that packages successfully but cannot install or
operate. Inspect matching frontend and backend constants before changing a
bound. Do not use this inventory as permission to introduce new restrictions;
follow `AGENTS.md` and agree their behavior with the user first.

Useful discovery from the repository root:

```sh
rg -n 'MAX_|MIN_|LIMIT' packages/neutron-tools/src/capabilities/catalog.ts apps/kernel/backend/install/Limits.mo apps/kernel/backend/capabilities/Registry.mo
rg -n 'admission|aggregate|limit exceeded' packages/neutron-compiler/src/assemble.ts
```

Packages with no tiles are valid headless apps. They consume no tile or
resident slot unless they separately declare the corresponding surface.

## Qualification Evidence

Qualification must bind the candidate's actual inputs. A generated candidate
binding identifies inputs; it is not evidence that tests ran or passed. For
Certified Assets, inspect `apps/kernel/package.json`'s `certified-assets:qualify`
workflow, the runner under `apps/kernel/evidence/qualification/`, and
`packages/neutron-tools/src/certified_assets_qualification.ts`. The validator
rejects absent, stale, malformed, incomplete, and source-mismatched receipts.

Do not copy runner timelines, case counts, sample sizes, or receipt hashes into
this reference. Read the checked-in runner and its qualification contract when
assessing coverage. A schema ceiling or bounded fixture is not proof of cycle
cost, proof size, allocator behavior, or upgrade safety at maximum production
state.

## Adding A Capability

A new platform primitive requires all of:

1. one closed catalog schema and normalization;
2. a canonical plan representation and fingerprint;
3. compiler projection or registration;
4. AppScope-bound runtime enforcement;
5. finite per-app and global admission;
6. live disable/revocation behavior, including after `await`;
7. lifecycle cleanup on replacement and uninstall;
8. bounded metadata-only audit;
9. owner-facing disclosure; and
10. tests at the exact limits and one over.

Keep new primitives in the closed catalog and reviewed broker boundary. Do not
add app-specific authority branches, a policy DSL, a raw Kernel handle, or an
alternate compatibility path. Existing app callbacks are valid only through
their explicitly supported typed interfaces.
