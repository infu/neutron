# Kernel Backend Runtime

Agent reference for the generated actor, persistent state, backend authority,
and checked self-upgrade. Use this document for invariants and source entry
points; derive method signatures, limits, and active release metadata from the
implementation before making a change.

## Source Of Truth

- `apps/kernel/backend/main.mo`: `Init`, service composition, Kernel methods,
  static HTTP policy, and `commitInstall`.
- `apps/kernel/neutron.json`: constructor inputs, managed-memory declarations,
  and the manifest-backed function surface.
- `packages/neutron-compiler/src/assemble.ts`: generated actor wrappers,
  authority checks, injected values, and runtime inventory.
- `apps/kernel/backend/install/{Service,Memory,Types,Limits}.mo`: journal,
  committed app identity, dispatch/recovery, and transaction admission.
- `apps/kernel/backend/memory/` and `apps/kernel/neutron.lock.json`: immutable
  schema and migration lineage.

`apps/kernel/backend/_neutron.mo` is generated evidence, not an editing target.
It represents its particular assembly, not the inventory of every deployed
Neutron. Regenerate it through the workspace workflow after changing source or
manifest declarations. See [Compiler And Actor Assembly](./compiler-and-actor-assembly.md).

To discover the current public surface rather than copying an API table:

```sh
jq '{init_arg, memory, func}' apps/kernel/neutron.json
rg 'kernel_runtime_info|NeutronCaller|is_authorized|persistent actor' \
  packages/neutron-compiler/src/assemble.ts
```

The manifest does not enumerate every compiler-owned protocol dispatcher.
Trace those through the assembler and the declaring app's capability plan.

## Module And Memory Contract

`main.mo` exports a module with an `Init` class, not the deployed actor. The
assembler owns the persistent actor, versioned memory wrappers, transient
service instances, Candid exposure, and installer initialization. `Init`
receives the declared managed-memory roots, generated deployment ID and app
inventory, and the canister principal.

Kernel state is not one interchangeable blob. The `kernel` root holds nested
service state; `kernel_activation` retains the ownership handoff; and
`kernel_cycle_calls` retains owner-confirmed financial requests and receipts.
Audit the complete manifest memory declaration before a release. Do not infer
the root list from constructor examples or a previous release note.

The released `kernel` v3-to-v4 migration adds separate custody signing state
and widens capability-registry entries while retaining the existing service
roots, assertion keys, and Region-backed certified assets. Its source,
predecessor schemas, and lock lineage are immutable history. A code-only
release restores the declared roots; a persistent type change requires a new
schema and explicit forward migration. New roots do not justify resetting
existing ones.

Managed roots are identified by `(owner app ID, local memory ID)`. The compiler
owns the collision-resistant physical namespace and canonical inventory order;
apps use their local logical IDs. A schema defines stable data independently
of mutable runtime modules. Runtime services consume that schema, never the
reverse. See [Managed Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md)
for retirement, consolidation, and supported predecessor checks.

## Owner And Controller Authority

`mem.core.authorized` is a flat set of equivalent owner credentials. It is not
a user, moderator, or role table. Every retained principal has the same Kernel
authority, including any deliberately authorized CLI or recovery identity.

The assembler inserts `NeutronKernel.is_authorized(NeutronCaller)` checks in
ordinary owner-facing query/update wrappers. Most `main.mo` methods rely on
those wrappers. Ordinary apps cannot request the Kernel-only
`allow: "unauthorized"` escape; public app protocols require
`public_ingress`. An opted-in paid-ingress handler has no ordinary owner
wrapper and needs a separate method if it also exposes an owner path.

Public Kernel entrypoints are narrow exceptions with their own contracts.
For example, recovery checks the actual caller with
`Principal.isController`, HTTP admission validates its route, and the HTTPS
transform accepts only the management principal. Inspect each exception's
wrapper and implementation rather than assuming that an unauthorized wrapper
means unrestricted mutation.

Actor initialization seeds the installer through `kernel_authorized_add`.
That helper ignores and removes anonymous authority, including anonymous
constructor identity encountered during upgrade. Removing an authorized
principal cannot remove the active caller through `kernel_authorized_rem`.

`backend/settings/Access.mo` separates IC controller management from Kernel
authorization. Controller changes preserve the retrieved controller list,
serialize mutations made through this service, reject anonymous principals,
and retain the canister itself as a controller so self-upgrades remain
possible. Controller-only recovery uses the synchronous replicated controller
check; list/status operations use the management canister asynchronously.

`backend/activation/Service.mo` implements the dispenser handoff:

- `#set` requires controller authority at the Kernel entrypoint, stores one
  token hash, and removes the setter's bootstrap Kernel authorization.
- `#use` verifies the bearer token and authorizes its actual non-anonymous
  caller. It does not accept a caller-supplied target principal.
- Authorizing the caller, deleting the secret hash, and marking consumption
  happen without an await. Exact retries have explicit already-completed
  results.

## Installation And Capability Authority

An `AppScope` binds an app ID to a Kernel-assigned installation UID. The
compiler creates scoped handles from declarations; ordinary apps do not
receive a Kernel service object or choose a foreign scope. Backend functions
exported to other apps use separately declared typed handles. See
[Backend App Dependencies](./backend-app-dependencies.md).

`install/Memory.mo` supplies `scopeActive` and `deploymentCommitted`. Services
use these checks in addition to their declaration and runtime enable state.
Loading target declarations during actor construction does not commit them.
In an activated target with a pending journal, all ordinary app scopes remain
inactive until checked commit, including scopes whose release version and
capability fingerprint appear unchanged. The predecessor remains usable until
activation; aborting a staged install does not retire its usable credentials.

Ordinary upgrades retain committed installation identity. Uninstall followed
by reinstall creates a new UID. `install/Service.mo` allocates new identities
from canister-version lanes and reissues pending identities in `markDispatched`
in the same message as the dispatch marker. For predecessors implementing this
contract, restoring a pre-dispatch snapshot cannot reuse identity already
activated on a discarded branch. `install/BrowserOrigin.mo` derives browser
identity from the committed installation facts. Do not substitute a frontend
app name or release version for those facts.

`backend/capabilities/Registry.mo` owns generic enable state, runtime leases,
and bounded outcome summaries. Specialized services retain their own typed
request validation, reservations, financial admission, and lifecycle. An
operation suspended at an await captures authority and rechecks it before
releasing sensitive results. Disable followed by re-enable does not revive a
lease captured under the old epoch. A successful owner toggle also advances
the actor-local capability-authority revision; the frontend uses that revision
together with the deployment ID to invalidate frame authority.

Revocation cannot reverse a completed remote call, paid management operation,
or committed handler mutation. Callers must preserve durable operation IDs and
treat explicit unknown/revoked-after-dispatch results as potentially completed
work. Do not automatically retry a non-idempotent operation under a new ID.

## Durable Operations And Service Boundaries

Consult [Kernel Capability Inventory](./kernel-capability-inventory.md) for
capability contracts and declaration entry points. These distinctions matter
when changing runtime composition:

- Backend-call reservations are installed authority; recurring financial
  allowances belong to the broker. Owner-confirmed one-time cycle calls use
  `backend/owner_cycle_calls/` and their separate durable root. Their request
  identity includes the installation and caller request ID. Response evidence
  is retained before post-dispatch delivery checks; status or replay must not
  attach cycles again. Ordinary app backends receive no handle to this route.
- Scheduled tasks use the generic registry as their enable authority and
  recreate native timers from declarations. Each run has a fresh invocation
  lease. Declaration-free deferred timers are one-shot, installation-scoped,
  transient across upgrades, and invoke synchronous callbacks; they are not
  a durable scheduler or a raw Motoko timer capability.
- Public Candid ingress and HTTP POST updates use separate outer admission
  messages and compiler-bound self-only handler messages. Route binding,
  fingerprint, and authority epoch are rechecked at dispatch; public Candid
  ingress captures the actual IC caller outside its request payload.
  A handler trap rolls back its own message, not admission already committed
  by the outer message.
- HTTP POST uses a durable idempotency record and handler-visible request
  digest. Exact completed retries replay; changed inputs conflict; pending or
  unknown operations do not redispatch. Disabling a route also denies replay.
  A later outer revocation can withhold a reply after the mutation committed.
- A paid public-ingress route accepts its required cycle floor before later
  bounded admission checks. Optional supplemental cycle requests are accepted
  only after handler mutation and authority revalidation, so they cannot fund
  irreversible work atomically. The floor must cover that work. Direct
  authenticated ingress accepts no attached cycles.
- HTTPS outcalls use the trusted adapter and fixed transform. They execute as
  non-replicated requests and provide no cross-node content-integrity
  guarantee. Revocation can suppress response delivery but cannot undo a
  remote POST side effect.

Read exact bounds in the relevant service and `Types.mo` before choosing a
request size or pagination policy. The existing production bounds are not
authorization to add new policy restrictions; follow `AGENTS.md` before
changing that behavior.

Key custody also has distinct identity contracts. Assertion signing binds the
installation scope; Wallet custody v2 binds the canister, app ID, slot,
algorithm, and trusted key name, so its account identity survives an app
reinstall while live capability authority does not. These are separate
namespaces and grants, not fallback key paths. See
[App-Isolated Chain-Key Signing](./app-isolated-chain-key-signing.md).
Key recovery does not restore deleted app memory and is not an application
upgrade or migration strategy.

For storage and encryption changes, use
[App-Isolated Stable Store](./app-isolated-stable-store.md) and
[App-Isolated vetKeys](./app-isolated-vetkeys.md). Configuration cleanup occurs
at checked install commit. In particular, removing a declaration, disabling a
resource, and uninstalling an installation have different retention semantics;
do not collapse them into one cleanup operation.

## Static Assets And HTTP

`kernel_static` uploads chunked assets and mutates their certification together.
Protected install metadata has additional mutation rules: generic static
commands cannot replace the committed deployment build record or overwrite
the dispatch marker. Registry/sidecar initialization is seed-once, with later
changes promoted through the checked journal. `kernel_static_query` is an
authenticated bounded key listing; overflow traps rather than silently
returning a partial inventory. Bodies are read through certified HTTP.

`certified_http.mo` owns static certification;
`certified_http_v2.mo` defines the closed certified-asset profiles. They share
a certified root while retaining separate route and storage authority.
Static lookup uses exact canonical keys, not a directory-to-index fallback.
Reserved certified routes never fall through to package assets. Only
allowlisted committed `/system/` metadata is public over HTTP.

`http_request` handles certified reads or bounded POST preflight.
`http_request_update` repeats admission and invokes the compiler-bound handler;
the preflight itself does not execute app code. The closed HTTP contracts,
streaming rules, Host binding, and origin restrictions are specified in
[Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md)
and [Asset Storage And HTTP Serving](./asset-storage-and-http-serving.md).

Ordinary app surface origins bind a declared tile, tray, or background to its
installation. Document responses bind the exact Host, iframe destination,
sandbox/CSP, Permissions Policy, and Kernel frame ancestry. Browser permission
headers are ceilings, not grants; the frontend must still delegate the exact
declared surface. The retained Kernel-host app response fallback remains
sandboxed, but new apps must use the replacement origin system described in
[Planned Deprecations](./deprecated.md).

## Checked Self-Upgrade And Recovery

Use [Package Updates](./package-updates.md) for release operations and
[Compiler And Actor Assembly](./compiler-and-actor-assembly.md) for preparation
and runtime verification. The backend transaction is:

1. Stage mutable assets separately from committed assets and upload
   content-addressed modules. `kernel_install_begin_checked` requires the exact
   running predecessor and records one journal with target inventory, copies,
   clears, and deployment identity. Exact replay recovers a lost begin reply.
2. Prepare changed backend-call reservations while the predecessor is live.
   They do not become active grants before target commit.
3. Dispatch inline or chunked management `#upgrade` for this canister. Both
   routes require the journal, write the protected dispatch marker, and use
   the selected Wasm memory-persistence mode. They bind the management request
   to the sending canister version and send an empty actor argument.
4. Observe the target through authenticated `kernel_runtime_info` and verify
   the complete compiled runtime contract before calling commit. A successful
   send does not prove activation. The `candid` argument on the inline method
   is not used by the management call; staged Candid is install metadata.
5. `commitInstall` checks the running target and reservation/storage readiness,
   then synchronously finalizes reservations, promotes inventory/assets,
   reconciles service state, retires managed roots, performs module cleanup,
   commits generic capabilities, and activates scheduler configuration.
   These changes share one Motoko update and roll back together if it traps.
   An exact completed replay returns `#committed`; an unready target is blocked.

The canister must retain self-controller authority for this path. Inline and
chunked installs are the same checked lifecycle, not separate upgrade modes.
Chunk uploads validate the journal and hashes again after management awaits;
the upload store is cleared through the installation/recovery workflow.

Before dispatch, abort can discard staging immediately. After dispatch, an
old actor must first await a successful self `canister_status` FIFO management
fence and then recheck the journal and running deployment. The new actor cannot
abort its own activated journal. An ambiguous fence failure leaves the
journal and marker intact. Seeing the old deployment still running is not
proof that the queued upgrade failed.

## Operational Accounting

`backend/settings/Service.mo` provides unit-explicit local runtime snapshots
without changing persistent memory. Its separate asynchronous management
snapshot supplies canister memory/status information; these surfaces do not
replace per-app attribution.

`backend/app_usage/Service.mo` attributes measured update execution to exact
installation scopes. Generated wrappers sample instructions around app update
work; queries are unmeasured. Traps roll back that message's samples. Remote
and self-handler work enters separately metered wrappers.

Outgoing cycle accounting distinguishes reservation, dispatch, cancellation,
and observed refunds. A known failure before dispatch unwinds its reservation;
uncertain dispatch may conservatively retain gross accounting. Incoming
accepted cycles remain separate from outgoing usage. Instruction/execution
totals saturate; cycle totals use unbounded `Nat`. These are bounded operational
projections, not payload logs or a complete IC bill. Derive display rates and
included fixed fees from the accounting/UI source, not documentation snapshots.

## Verification Entry Points

Use the test scripts in `apps/kernel/package.json`. Relevant implementation
fixtures live in `apps/kernel/test/motoko/`: schema migration, activation,
install service, capability registry, financial replay, HTTP/privacy, and
public-ingress tests cover distinct contracts. The Motoko runner supports
`MOTOKO_TEST` for selecting exact fixture filenames. Frontend install/recovery
tests additionally exercise the client-side transaction and observation rules.

For a runtime change, test the affected authority transition and failure path,
not only initialization or a successful request. For a release, preserve every
managed root and run the required release checks; focused service tests alone
do not prove compatibility with production predecessors.
