# Kernel Capability Inventory

This document is the human-readable inventory of Kernel authority. The
executable source of truth is the closed catalog in
`packages/neutron-tools/src/capabilities/catalog.ts`, together with its
compiler projection and Kernel runtime services.

The tables below enumerate the authored and derived capability kinds implemented
by the catalog. Every runtime resource is installation-scoped; the executable
catalog, rather than a copied count in this guide, is authoritative.

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
| `chain_key_signing` | Sign domain-separated app assertions | Exact algorithm slots, 4 KiB assertion ceiling, cost and concurrency limits |
| `stable_store` | Durable app-installation key/value stores | Exact stores, schemas, entry/key/value/byte quotas, conditional writes |
| `https_outcalls` | Call exact external HTTPS URL prefixes | Closed methods/headers, request/response limits, transform, cycles, concurrency |
| `vetkeys` | Use app-isolated encrypted-key slots | Exact slots, browser derivation, attenuated backend public-key access, generation lifecycle |
| `scheduled_tasks` | Run exact backend methods on bounded schedules | At most two per app, actor-wide task admission, per-run backend-call ceiling |
| `preapproved_self_calls` | Let app UI call exact owner-authorized self methods without another prompt | Exact method/mode, live Candid, source and scope binding |
| `agent_entrypoints` | Expose exact resident-background tools and admit that resident to Kernel visual workspace tools | At most four entrypoints; exact resident role and endpoint binding; workspace control is invocation-free resident or direct-root only |
| `background_ui_requests` | Let a resident request exact Kernel dialog categories | Four closed categories; Kernel retains user interaction |
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

Current backend interfaces are:

- `deferred_timers`;
- `backend_calls`;
- `randomness`;
- `chain_key_signing`;
- `stable_store`;
- `https_outcalls`;
- `vetkeys_public`; and
- `certified_assets`.

`deferred_timers` is a structural Kernel service rather than an authored
capability declaration. It provides keyed, leading-edge, one-shot timers:
arming an existing key returns the existing due time instead of moving it.
Delays are at least 10 seconds and timers are AppScope-bound and finite.

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
- authored POST and derived read mounts share the 16-mount aggregate limit; and
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

One app may declare at most 64 install defaults and one target actor at most
2,048. The assembler also rejects an exact duplicate default reservation scope
claimed across apps.

The Kernel also supports explicit later owner changes. Both paths produce the
same reservation records and broker checks.

## Public Protocol Surfaces

The three public mechanisms are deliberately separate:

| Surface | Use |
| --- | --- |
| `public_ingress` | Public Candid query/update protocols on compiler-created physical methods |
| `http_routes` | Bounded HTTP `POST` requests that dispatch to exact internal synchronous handlers |
| `certified_read_routes` | Compiler-derived certified `GET`/`HEAD` serving from closed collections |

`http_routes` cannot serve arbitrary app-authored responses. Its mount fixes
location, maximum path/body/response, forwarded headers, rate, replay budget,
and handler. The Kernel owns Host admission and reserved paths.

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
a query. Acquire and disconnect remain protected operations. The actor-wide
declaration capacity is 256 records.

## Browser Wallet Capability

`ethereum_provider` declares up to eight chains and a subset of the closed
method set. Transaction use requires account access. A focused tile and owner
activation create a short-lived source-bound session.

Discovery is EIP-6963 only. If several browser wallets announce themselves,
the Kernel asks the owner to choose and binds that provider object to the
session. Names and reverse-DNS strings are display hints, not trust.

## Browser Device Permissions

`browser_permissions` is a frontend-only declaration. API 1 maps at most 16
declared tile IDs to `camera`, `microphone`, or both. The compiler rejects an
unknown tile ID, and trays and backgrounds cannot receive this declaration.

Approval lets the exact tile ask the browser for the selected feature; it does
not start capture or override browser and operating-system permission. The
Kernel intersects a certified, Host-bound Permissions Policy with the iframe's
exact-origin `allow` value. The tile then calls browser APIs such as
`navigator.mediaDevices.getUserMedia()` directly. Media bytes, streams, browser
prompts, and prompt decisions do not pass through or get audited by the Kernel
backend.

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

The capability registry is also a kill switch and bounded audit surface. It
stores at most 64 runtime capability resources per app installation and 8,192
actor-wide. Audit is metadata-only; payloads, credentials, keys, assertions,
and certified bodies are not retained there.

Successful runtime capability toggles also advance the actor's capability
authority revision. The trusted frontend observes that revision together with
the deployment identity and invalidates every mounted app frame and transient
runtime grant when it changes.

## Scale And Admission

| Resource | Current bound |
| --- | ---: |
| Installed app instances including Kernel | 256 |
| App removals per install commit | 64 |
| Resident backgrounds | 32 |
| Scheduled tasks actor-wide | 64 |
| Scheduled tasks per app | 2 |
| Runtime capability resources per app | 64 |
| Runtime capability resources actor-wide | 8,192 |
| Browser-permission tile declarations per app | 16 |
| Browser-surface certification units per deployment | 1,024 |
| Connection provider records actor-wide | 256 |
| Declared vetKey slots actor-wide | 128 |
| Backend-call install defaults actor-wide | 2,048 |

Compiler, backend install, and frontend runtime enforce the app and resident
limits. Packages with no tiles are valid headless apps and consume no tile or
resident slot unless they separately declare a background.

Certified Assets, stable store, HTTPS outcalls, public ingress, backend calls,
vetKeys, and signing have additional per-scope and global physical admission.
Install review rejects an aggregate target that exceeds those bounds.

## Qualification Status

The source-owned Certified Assets release runner installs five generated
neutral scopes. It runs 12 operational cases once on fresh canisters,
including actor-wide admission and cross-scope isolation, and keeps
implementation-level corruption, retirement, one-over, upgrade, hostile HTTP,
and browser checks in fixed gates rather than public app methods.

Its private PocketIC timeline has two explicit phases. With automatic progress
off, it normalizes to the fixed historical start
`1735689600000000000` ns and first commits the 256-entry bounded physical
sample in 16 batches. At eight receipts it advances exactly 24 hours plus 1 ns
and reclaims them in one page, then proves the 257th entry fails without state
drift. It next normalizes forward to host wall time, enables automatic
progress, and records exact raw-query/gateway pairs during the gateway phase
before the Chromium CORS check.

The deterministic candidate binding is input identity, not evidence. The
runner emits a receipt only after pass; the pass-only validator rejects a
missing, stale, malformed, incomplete, or source-mismatched receipt. Absent or
stale is not qualified.

The receipt does not establish cycle cost, proof size, allocator behavior, or
upgrade safety at the 100,000-entry production ceiling. The separate 100,001
manifest rejection proves only the schema/admission ceiling.

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

Do not add an app identity branch, policy DSL, arbitrary callback, raw Kernel
handle, or alternate compatibility path.
