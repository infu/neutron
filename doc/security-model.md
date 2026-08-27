# Security Model

Neutron is a user-owned operating-system canister. The Kernel is the trusted
policy and mediation layer; ordinary apps are untrusted packages assembled into
the same actor and rendered in isolated browser endpoints.

The central rule is:

```text
closed manifest
    -> canonical CapabilityPlan
    -> exact compiler-projected handle or registration
    -> AppScope-bound runtime policy
```

The literal `kernel` package is the only app identity the Core may
special-case. Ordinary app IDs, methods, protocols, and data models are not
Kernel policy.

## Security Goals

Neutron aims to ensure that:

- only the owner can grant or exercise owner authority;
- controllers retain explicit recovery and deployment power;
- an app cannot exceed the authority shown during installation;
- one app installation cannot use another installation's storage, routes,
  credentials, memory, browser endpoint, or runtime leases;
- updating an app advances its runtime generation and reconciles changed
  authority, while removal retires its scope;
- untrusted package bytes and browser messages cannot select Kernel code,
  policy, headers, certification expressions, or raw system routes;
- failed or interrupted installs do not leave a partially promoted runtime;
- public HTTP responses can be verified against the canister certificate; and
- all potentially expensive or persistent facilities have finite admission and
  runtime limits.

Neutron does not claim that ordinary app code is benign. The system confines
such code to reviewed platform primitives and explicit owner decisions.

## Threat Model

Treat the following as attacker-controlled:

- every ordinary app manifest, Motoko source, static asset, display string,
  package archive, and update package;
- app iframe messages, transferred values, binary attachments, and timing;
- public HTTP requests, Host headers, route bodies, and callback parameters;
- remote canister replies, HTTPS responses, OAuth responses, and browser-wallet
  metadata;
- stale browser frames and replies that arrive after an install, logout,
  revocation, or authority rotation;
- interrupted deployment operations and lost update replies; and
- malformed local or remote package/config/session files.

Trusted components are narrower:

- the reviewed Kernel frontend and backend;
- the compiler and closed capability catalog used for the target deployment;
- the public Motoko capability leaf types;
- provider adapters explicitly shipped with the Kernel;
- the provisioner and its verified deployment evidence;
- the IC root of trust, or the pinned PocketIC root key for local development;
  and
- explicit owner and controller actions.

## Owner, Principals, And Controllers

The product has one human owner. The Kernel maintains the authorized-owner
principal set used by trusted UI and app-call policy. Canister controllers are a
separate management-plane authority: they can change code or settings and must
be treated as fully trusted recovery/deployment actors.

An authenticated principal is not automatically the owner. The trusted shell
binds authorization to the current login and rechecks it at sensitive
boundaries. Controller operations validate current management state and do not
infer owner authority from a browser session.

## App Installation Identity

Backend and frontend authority is attached to the exact installation:

```text
AppScope = {
  app_id;
  installation_uid;
}
```

The runtime additionally binds the app version, capability-plan fingerprint,
deployment ID, browser-origin nonce, browser-origin authority epoch, and
resident-frame security mode.

Updating an existing app ID retains its `AppScope`. Commit binds that scope to
the new version, capability plan, deployment, and app generation and reconciles
changed resources. The browser-origin nonce and authority epoch also remain
stable unless the resident security mode changes. Removing and later re-adding
the app allocates a new UID; stale frames, credentials, reservations, tasks,
collection leases, and backend handles from the removed scope cannot become
authority for it.

The compiler derives a public 32-byte network identity from the exact trusted
root-key SPKI bytes using the `neutron.network-id.v1` domain. This is identity,
not a bearer capability.

## Manifest And Capability Boundary

The manifest selects closed capabilities and finite parameters. It cannot
provide executable callbacks, arbitrary policy expressions, certification
expressions, response headers, OAuth endpoints, provider token formats, or raw
Kernel routes.

The canonical capability plan records:

- declared authority;
- structural authority derived from functions, memory, dependencies, and
  frontend endpoints;
- exact resource identifiers and quotas;
- delivery mode: backend environment, frontend endpoint, invocation, or
  compiler registration; and
- the fingerprint bound into installation and runtime state.

The compiler projects only the interfaces named by that plan. Runtime brokers
also consult the live capability registry, so a handle alone is insufficient
after disablement or replacement.

The registry publishes an actor-local capability-authority revision through the
generated runtime identity. A successful toggle advances it. The trusted
frontend compares the revision together with the deployment identity, so a
toggle invalidates all mounted frames and transient grants, while a code
replacement cannot collide merely because a new actor's local counter starts
again.

Capability changes are staged with the install. Commit activates the target
plan and reconciles its resources; abort discards it. Removal retires the
scope, and a later re-addition receives a new one. Operations that cross an
`await` recheck their lease, endpoint, owner, and scope before publishing a
result or durable state.

## Package And Compiler Boundary

A `.neutron` archive is a bounded flat MessagePack map from safe relative
string paths to binary gzip members. The decoder rejects unknown shapes,
duplicate or dangerous paths, trailing bytes, multiple gzip members, and
raw/compressed/decoded size overflow.

The package manifest is format 3. Schema validation, closed-field
normalization, source scanning, dependency planning, memory planning, and
capability-plan construction happen before actor emission. App-authored Motoko
cannot import Kernel-private modules or inject physical symbols.

The browser compiler runs in a Worker. Inspection and final actor emission use
fresh compiler runtimes because the compiler owns process-global state. The
loader requires the compiler artifact's `NeutronMotokoReady` promise and fails
closed if initialization does not complete.

The generated actor must report the exact current assembler, compiler,
deployment, app-instance, capability, and managed-memory inventories expected
by the installer.

## Install And Upgrade Atomicity

The current install transaction is:

1. prepare and upload bounded modules and staged assets;
2. create a deployment-bound journal with
   `kernel_install_begin_checked`;
3. prepare changed backend-call reservations when the target needs them;
4. install the target Wasm, using chunked upload when required;
5. verify the new runtime identity and inventories; and
6. call `kernel_install_commit`.

`kernel_install_commit` returns `#committed` or `#blocked`. It checks reservation
readiness before mutation, then commits inventory, capability configuration,
certification, scheduler state, resident endpoints, static assets, and
managed-memory retirement in one Motoko update. A trap rolls back that update.

The client may replay exact begin, reservation, commit, or abort requests after
a lost reply. A missing query result is diagnostic information, not proof that
an unacknowledged update did not commit.

Stable-signature checks and explicit managed-memory migrations protect genuine
state-preserving upgrades. Retirement is synchronous with install commit;
large app-owned recertification or semantic repair is not hidden inside Kernel
upgrade hooks.

## Static Assets And Public HTTP

Package assets live in the Kernel static namespace and are separate from
app-authored Certified Assets records. Static upload, copy, clearing, module
garbage collection, and certification are install-journal operations.

Public routes are closed:

- `http_routes` API 1 provides bounded mutating `POST` handlers;
- `public_ingress` provides compiler-bound public Candid protocol routes; and
- Certified Assets collections synthesize their own fixed-policy read mounts.

Host parsing, gateway authority, reserved prefixes, route collisions, methods,
body sizes, forwarded headers, response sizes, rate limits, and replay storage
are Kernel policy. Apps do not receive a raw HTTP callback or certification
tree. `apps/kernel/backend/http_routes/GatewayAuthority.mo` is the single Motoko parser
and canonical constructor for IC and PocketIC authorities; each route surface
still applies its own exact allow policy, and raw/custom gateway denial remains
the caller's responsibility.

The same backend certifies installation-owned browser-surface responses. One
derived hostname is bound to one app installation and one declared tile, tray,
or ordinary background. That hostname may execute only the matching app's
asset subtree under the allowed request destinations; it cannot become a Kernel
document origin or load another app's executable assets.

## Certified Assets

Certified Assets exposes three kinds:

| Kind | Identity and mutation | Fixed public response |
| --- | --- | --- |
| `publication` | Kernel-allocated opaque publication identity; create once and conditionally delete | Host-bound `GET`/`HEAD`, bounded ranges, no-store, inline text or forced attachment |
| `immutable_blob` | Body SHA-256 beneath a declared prefix; create if absent, no replacement while present, exact conditional delete | Portable full-body `GET`, immutable cache, anonymous CORS |
| `mutable_blob` | A 32-byte key beneath a prefix or one exact path; revision/content-tag CAS | Portable full-body `GET`, revalidation cache, anonymous CORS |

Collection kind derives locator, path, mutation, body source, allowed method,
headers, cache, CORS, certification expression, and certified absence.
For an immutable blob, immutable describes the digest-bound bytes while the
record is present. An app may delete the exact current revision and content
tag, but it cannot replace the record; recreating the same digest can only
publish the same bytes. Privileged scope retirement also retains Kernel-owned
bounded cleanup.

Every handle captures `AppScope` and declared collections. An app authors a
logical mount ID, but cannot choose a raw URL or public path, Host,
certification-tree key, response header, another app, or another installation.
Writes use bounded ordered stages, incremental SHA-256, conditional atomic
batches, replay-stable idempotency outcomes, generations, and finite
maintenance. Terminal stage receipts and filled delete lanes are reclaimed
after their reconciliation window.

Opaque publication paths use a persistent Kernel-generated random salt and
never-reused generations. A fresh deployment initializes that entropy through
the idempotent `kernel_publication_entropy_initialize` call. Concurrent calls
converge on the first stored value.

Certified absence proves only that the exact object is absent from the
certified tree. It is not app-level deletion authority. Destructive remote
cleanup still requires a positive semantic tombstone or equivalent terminal
proof defined by the app protocol.

See [Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md).

## Browser Isolation And Message Transport

Tiles, trays, and resident backgrounds are separate registered endpoints.
Registration binds the exact iframe `Window`, role, app installation, endpoint
path, session, origin mode, and current authority.

`window.postMessage` is used only to authenticate the parent/child ready probe
and transfer a `MessagePort`. Operational requests, replies, progress, state
invalidation, self calls, tool calls, and binary data travel only through that
private port.

The Kernel rejects messages from an unregistered source, wrong role, stale
session, replaced app, mismatched port, or inactive invocation. It captures the
binding before asynchronous work and checks it again before effects or reply.

An ordinary package built by the current packer carries the generic
`.neutron/browser-surface-origins.v1.json` readiness marker. The checked install
records eligible apps in the certified surface-origin sidecar. Each tile ID,
tray, and ordinary background then receives a distinct hostname derived from
the installation nonce and its surface key. Supported frames are credentialless
and use `sandbox="allow-scripts allow-same-origin"`; the backend binds their Host,
path, request destination, CSP, and `frame-ancestors` policy. A browser that
cannot establish credentialless originful framing falls back before navigation
to `sandbox="allow-scripts"`, an opaque origin, and no browser-feature
delegation. Historical packages without readiness evidence retain that same
opaque compatibility policy.

Camera and microphone are denied by default. `browser_permissions` may delegate
only those closed features to exact adopted tile IDs through the certified
Permissions Policy and iframe `allow` intersection. The tile uses browser media
APIs directly; the Kernel backend never receives the stream or mediates a media
session. Trays, backgrounds, cross-origin descendants, other browser features,
and opaque fallbacks receive no delegation.

Disposable tile and tray frames are not persistent authorities. Resident
backgrounds additionally use one of the declared security modes:

- opaque credentialless;
- installation-dedicated credentialless ephemeral; or
- installation-dedicated persistent storage.

Dedicated authorities include a random nonce and authority epoch. Rotation
invalidates prior origins. The exact initial document and subresource policy
are Kernel-controlled and certified. Credentialless-ephemeral residents may
still have browser storage APIs inside their ephemeral credential partition;
they never fall back to the persistent mode.

## Self Calls And Binary Values

Apps call their own backend through `querySelf`, `updateSelf`, or
`callSelfDialog`. A post-grant same-app call in
`requestBackendCallReservations` uses the same private API-1 transport; the
generic JSON-only backend tool accepts actions only. Live Candid is
authoritative for method existence, mode, argument count, type graph, and every
binary leaf.

The API-1 value model accepts `Uint8Array` as canonical bytes and `ArrayBuffer`
as an input convenience. Nested and repeated byte values become immutable
transferable sidecars. Their paths are routing hints only: the Kernel must bind
each sidecar exactly once to a live Candid `vec nat8` position and must find one
sidecar for every present blob.

The trusted review surface never renders the bytes. It shows the exact Candid
path, byte length, and a transient SHA-256 digest. Raw Candid preflight meters
binary leaves independently before decode. Metadata, depth, element, binary
count, aggregate byte, allocation, concurrency, source, method, owner, and
AppScope limits all remain enforced.

## Agent Mode

Agent Mode is a generic, owner-controlled delegation role. It does not bypass
app manifests or Kernel brokers.

An agent invocation has a root identity, an exact registered capability path,
bounded progress and tool calls, cancellation, and a live source-bound
endpoint. The Kernel revalidates the invocation and its app authority around
every protected operation. User-interactive calls remain interactive and
cannot be silently converted into agent authority.

## Connections And Provider Drivers

An app may declare exact provider IDs and scopes only for its resident
background. The Kernel stores at most one current credential per
`(AppScope, provider)`.

Provider details are trusted platform drivers:

- the catalog owns display metadata, allowed scopes, and authorization origin;
- the adapter owns authorization URL construction, token endpoint, request
  encoding, and credential parsing; and
- the generic frontend broker owns source, scope, owner, callback, and
  lifecycle checks.

Ordinary apps cannot provide provider origins or exchange code. Flow IDs,
PKCE, TTLs, one-time completion, credential secrecy, cycle accounting, and
post-`await` declaration checks are Kernel-owned. Replacement, declaration
change, disconnect, or uninstall removes incompatible flows and credentials.
The Kernel package carries a minimal certified provider/scope support catalog;
the compiler validates the complete target plan against the incoming catalog
for a Kernel replacement or the installed catalog otherwise.

## Browser Wallets

Ethereum access uses EIP-6963 discovery only. A focused owner-activated tile
may start a session for exact manifest-declared chains and EIP-1193 methods.
One announced provider binds directly; multiple providers require a
Kernel-owned owner choice.

Provider name and reverse-DNS values are untrusted display hints. The selected
provider object, endpoint session, owner, app version, installation, plan
fingerprint, methods, chains, accounts, expiry, request counts, and concurrency
are bound into the Kernel session. The browser wallet remains responsible for
account, chain-switch, and transaction confirmation.

## vetKeys And Previous Generations

vetKey slots are installation-scoped and declaration-bound. Browser derivation,
backend public-key discovery, generation rotation, and retirement use distinct
attenuated interfaces. Rotation preserves the immediately previous generation
only for the bounded transition needed to read and re-encrypt existing data;
it does not make old authority current again.

## Provisioning Boundary

Production provisioning pins exact package archives and verifies config,
compiler output, module hash, controllers, runtime inventories, certified
browser entrypoint, root key, Registry subnet placement, node count, and
pricing evidence. Journals, immutable transaction payloads, process locks,
idempotent retries, and before/after observations prevent accidental reuse or
silent intent changes.

PocketIC uses the same package/compiler/install path with a pinned local root
key. Local inline archives are intentionally path-only developer inputs and are
resolved at reinstall. Optional chain and ledger fixtures are selected by an
app-neutral environment profile, never by an app ID or hook.

## Security Invariants

Changes must preserve all of the following:

- exact `AppScope`, installation UID, plan fingerprint, authority epoch, and
  source-bound endpoint checks;
- closed capability schemas, compiler projection, finite quotas, registry kill
  switches, and post-`await` revocation;
- stable-signature compatibility, explicit migrations, and commit-atomic
  retirement;
- journals, locks, immutable recovery payloads, retries, idempotency, and
  lost-reply recovery;
- production archive/module/config hashes, certificate and witness
  verification, and trusted root-key validation;
- decoder bounds for paths, sizes, nesting, gzip, Candid, JSON, and browser
  messages;
- random publication salt, never-reused generations, and positive semantic
  tombstones before destructive remote cleanup; and
- bounded previous-generation vetKey rotation safety.

If a proposed convenience bypasses one of these bindings, the convenience must
be redesigned rather than added as an alternate path.
