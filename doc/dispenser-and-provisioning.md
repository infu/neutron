# Dispenser And Provisioning

[Documentation index](./index.md).

Use this reference when changing the hosted Dispenser, its starter payload, or
ownership activation. The Dispenser creates new Neutrons; it does not upgrade
existing installations. Existing registrations, paid operations, starter
bindings, and installed Neutron state are durable production data.

## Source Map

| Contract | Authoritative source |
| --- | --- |
| Paid provisioning and starter state | `support/dispenser/mo/main.mo` |
| Browser credential persistence and account derivation | `support/dispenser/src/provisioning.ts` |
| Payment polling and automatic resume | `support/dispenser/src/index.tsx` |
| Ordered starter selection | `support/dispenser/starter-packages.json`, `support/dispenser/starter.ts` |
| Atomic upload and file commitment | `support/dispenser/starter_payload.ts`, `support/dispenser/starter_file_commitment.ts` |
| Production deployment and placement | `support/dispenser/production_deploy.ts`, `support/dispenser/deployment_target.ts` |
| Local deployment and funding | `support/dispenser/local_deploy.ts`, `support/dispenser/local_fund.ts` |
| Activation and controller checks | `apps/kernel/backend/activation/Service.mo`, `apps/kernel/backend/settings/Access.mo`, `apps/kernel/backend/main.mo` |
| Activation handoff | `apps/kernel/src/bootstrap.ts`, `apps/kernel/src/activation_handoff.ts`, `apps/kernel/src/reducer/activation.ts` |

Read current payment thresholds, polling intervals, upload bounds, archive
versions, and deployment receipts from these sources instead of treating this
page as a release inventory.

## Production Deployment Boundary

The public SushiOS frontend is a certified asset canister built against the
Dispenser backend principal. The backend serves the protocol, not a second
copy of the UI. The deployment mapping is
`support/dispenser/.icp/data/mappings/ic.ids.json`; production deployment rejects
extra, missing, malformed, or duplicate mappings and proves that the selected
operator identity controls the mapped canisters.

The established production service identities are:

| Role | Principal |
| --- | --- |
| Public frontend | `2h7je-aiaaa-aaaay-aacra-cai` |
| Dispenser backend | `2o4cy-waaaa-aaaay-aacqq-cai` |
| Configured child target subnet | `re2t4-faa75-v3vhk-kdmdr-uyrkl-aik2l-ixd6u-p3fyr-zlfkc-6c5af-zae` |

Verify them against the deployment mapping and target constant before an
operation; obtain live controllers and module hashes through deployment
preflight rather than from this document.

The operator entrypoints are:

```sh
# Initial empty-backend installation, starter upload, and frontend deployment.
npm --workspace dispenser run production:deploy

# Frontend-only deployment.
npm --workspace dispenser run production:frontend:deploy
```

The full command refuses an implicit replacement of a non-empty backend with
different Wasm. Backend changes require a separately reviewed state-preserving
upgrade and any necessary migration. Do not use reinstall or replacement state
to bypass an incompatible production schema.

The ignored `.neutron/dispenser-production.json` receipt records the selected
canisters, module hashes, controller, target subnet, starter identity, package
pins, and file commitment. It is operational evidence, not configuration to
copy into documentation. Child placement is an immutable constructor argument:
production supplies the reviewed constant in `deployment_target.ts`; local
deployment supplies the Application subnet from the verified PocketIC session.
Both paths verify the installed target as well as the module hash. The backend
has no user-selected placement or subnet failover.

Starter publication and package publication are separate operations. The live
starter may intentionally trail available updates. Follow
[App Package Updates](./package-updates.md#maintainer-release-workflow) to
publish and verify a coherent package/source set before staging it for future
Neutrons. Do not infer the starter selection from all app directories or the
update catalog.

## Credential And Ownership Flow

1. The frontend generates an Ed25519 identity and an independent random
   32-byte activation code. It persists both before exposing a deposit account.
2. The ICP deposit account belongs to the Dispenser backend with a subaccount
   derived from that identity's principal. The backend derives it independently
   from the signed caller.
3. The frontend observes the ledger balance and calls
   `provision(SHA-256(activation_code))` when the configured minimum is met.
4. The backend binds a starter revision and transfer intent, converts the
   deposit through the CMC, creates a Neutron, installs the bound starter,
   seeds assets and runtime configuration, and initializes publication entropy.
5. The backend arms activation and retires both its Kernel authorization and
   its IC controller authority.
6. The frontend opens the created Neutron with the activation code in the URL
   fragment. Internet Identity login happens at that Neutron's origin.
7. A successful activation authorizes the actual authenticated caller and
   atomically consumes the code.

The browser-generated identity authorizes provisioning only. It is not an
owner or controller of the resulting Neutron. Do not reuse the Dispenser-origin
principal as the Neutron-origin Internet Identity principal.

The browser record is versioned and namespaced by the backend canister:

```text
neutron.dispenser.provisioning.v1:<dispenser-canister-id>
```

Reload must recover the same private identity and activation code. Malformed
stored credentials are left untouched and provisioning stops; silently
replacing them could strand a funded account. The raw activation code is a
bearer credential until consumed. Scripts at the Dispenser origin can read
local storage, and loss of that browser profile can lose the provisioning
credential. The backend receives only the activation hash.

## Deposit Semantics

Canonical ICRC account text and the legacy ICP hex account identifier represent
the same backend-owned, caller-derived account. Use the codecs in
`provisioning.ts`; do not independently concatenate account strings.

The backend checks cumulative balance, so smaller earlier deposits count.
Before the transfer, it queries the ledger fee and fixes `balance - fee` as the
amount sent to the CMC. The entire selected amount funds creation; there is no
change output, partial conversion, automatic overpayment refund, or later sweep
of additional deposits after the transfer intent was fixed.

Frontend polling and automatic resume are convenience behavior. The backend
registration is authoritative after a refresh or ambiguous result. `status()`
returns the caller's durable phase; `find()` returns a canister only after
provisioning completes; `provision(hash)` advances that same caller's operation.

## Durable State And Recovery

A paid registration binds the signed caller, activation hash, and exact
committed starter. An unfunded call creates no durable registration. A retry
with a different activation hash fails, and simultaneous executions for the
same caller are rejected.

| Phase | Durable fact |
| --- | --- |
| `awaiting_payment` | No transfer is prepared; may represent an unfunded caller or a retry after a definite ledger rejection. |
| `transferring` | Amount, fee, and `created_at_time` are fixed. |
| `notifying_cmc` | Successful ledger block index is fixed. |
| `created` | Empty Neutron canister id is known. |
| `installed` | Bound starter Wasm is installed. |
| `controlled` | Temporary controllers are Dispenser and Neutron itself. |
| `assets_seeded` | Assets, canister-bound runtime configuration, and publication entropy are ready. |
| `activated` | Activation is armed and Dispenser Kernel authorization is retired. |
| `complete` | Dispenser IC controller authority is retired. |

Preserve these recovery properties when changing the state machine:

- Capture the starter before the first balance `await` and persist the binding
  with the transfer intent before sending ICP. Later phases must not reread the
  mutable active starter.
- Reuse the prepared ledger timestamp and accept `TxDuplicate` through its
  original block index. A CMC `Processing` response retains that index.
- Reconcile an ambiguous install against the bound Wasm digest before issuing
  another install. Reject a created canister whose principal conflicts with a
  fixed backend-call reservation in the starter.
- Asset seeding can replay from first chunks. Retain the bound payload until
  assets, runtime configuration, and entropy are ready; then retain its revision
  while releasing the heavy payload reference.
- Activation `set` is idempotent for the same setter and hash.
- Reconcile final controller removal with `canister_info`: a committed removal
  can leave the Dispenser unable to repeat `update_settings`. Unexpected
  controller lists stop the handoff rather than being overwritten.

A non-retriable CMC refund or invalid transaction requires reconciliation;
restarting with a new registration is not a way to recreate consumed payment.

## Activation Contract

The backend installs the starter with `install`. The generated Kernel initially
authorizes the installer. During seeding, controllers are `[dispenser, neutron]`.
After seeding, `kernel_activation(#set(hash))` retires the setter's Kernel
authorization, and the Dispenser changes controllers to `[neutron]`.
The shared service and its caller-to-registration record remain available for
recovering the created Neutron URL.

`kernel_activation` is an entrypoint callable without existing Kernel
authorization, with separate authorization rules for its variants:

- `set` requires a non-anonymous actual IC controller, checked synchronously
  with `Principal.isController`. It accepts a 32-byte hash, arms a fresh
  activation once, and allows only an identical setter/hash retry.
- `use` requires a non-anonymous signed caller and a 32-byte code whose SHA-256
  matches the armed hash. It adds that caller to Kernel authorization, clears
  the hash and setter, and marks activation consumed without an `await`.

There is no partial commit between authorization and token consumption. A
consumed activation cannot be reused by another caller; an already-authorized
caller can receive the idempotent `already_authorized` result. Activation has
its own managed-memory root, `kernel_activation`; preserve its released schema
and migration lineage separately from the main Kernel root.

## Frontend Handoff

The activation code travels only in a URL fragment, optionally alongside the
repository setup fields. Reserved handoff fields in the query string are
rejected and removed. Before starting the authenticated application, bootstrap
validates the handoff, stores the activation in same-tab session storage, and
removes the fragment with `history.replaceState`. Storage or cleanup failures
stop startup and retire retained handoffs. A malformed fragment that was
successfully removed need not prevent ordinary login.

After login, the frontend checks authorization. For an unauthorized caller
with pending activation, it removes the session copy and submits `use` once.
An ambiguous update is reconciled by querying authorization rather than
blindly replaying the bearer. The original Dispenser tab can reconstruct the
activation link from its saved record.

Repository setup remains browser-only: its optional `repo`, `manifest`, and
`digest` fields neither enter the Dispenser backend nor change provisioning
authority. See [Repository Setup Manifests](./repository-setup-manifests.md).

## Atomic Starter Administration

The starter is a controller-managed complete actor and asset set. Apps in that
set are already installed at first boot, independently of later owner-reviewed
repository setup.

`starter-packages.json` declares one Kernel and an ordered app list. The loader
requires unique ids and repository-contained archive paths, checks each id
against the archive manifest, derives byte/digest pins, and validates the whole
dependency graph before contacting the backend.

Use the uploader in `starter_payload.ts`. `begin_starter_upload` returns a
monotonic epoch required by every Wasm/file/chunk write and final commit.
Delayed messages from an abandoned upload cannot mutate its successor.
`commit_starter_upload` verifies completeness, Wasm size and digest, and the
commitment covering file metadata and reconstructed contents before publishing
one immutable payload. A failed or interrupted upload leaves the old starter
active. The public `starter()` readback includes the revision, deployment id,
package ids, Wasm identity, asset counts, file commitment, and fixed
backend-call targets for postflight comparison.

Every maintenance method checks the actual IC controller list with
`canister_info`. There are no direct active-payload mutators. Keep controller
checks separate from the caller-keyed public provisioning API.

The runtime template is trusted deployment input. The backend inserts the
actual created principal into its text segments to bind
`/system/runtime-config.json`. Production uses `update_source_origin: null`,
which tells Kernel to derive the source origin from each manifest principal;
it does not disable updates. Local staging supplies the supervised fixture's
origin. Use the shared runtime-config helpers instead of constructing an
independent origin policy.

## Local Dispenser Test Deployment

Start the repository's supervised PocketIC through the root local provisioning
workflow, then run:

```sh
npm --workspace dispenser run local:deploy
```

This command reads `local.ndeploy.session.json`, verifies the runtime, deploys
or reuses an attested local backend, stages the configured starter, and builds
a frontend bound to it. The ignored `.neutron/dispenser-local.json` records
canisters for that runtime. Incompatible or unattested local state is not a
reason to reuse an old backend.

To simulate payment, select the legacy hex account display in the local UI:

```sh
npm --workspace dispenser run local:fund -- <64-character-ICP-account>
```

The helper accepts the legacy account identifier, not ICRC account text, and
uses test ICP in the verified local runtime. Do not send production ICP to a
local test account.

Tests live in `support/dispenser/test/` and Kernel activation/handoff suites.
Choose tests for the changed boundary; source-level retry tests do not prove a
live paid creation and activation flow. No local test or starter staging step
installs an update into an existing production Neutron.
