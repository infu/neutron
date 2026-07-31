# Dispenser And Provisioning

[Back to the documentation index](./index.md).

This page documents the hosted production dispenser. The dispenser creates a
new Neutron without authenticating the user at the dispenser origin. It uses a
browser-generated signing identity for payment/provisioning and a separate
one-time activation code to authorize the Internet Identity principal that is
later produced at the new Neutron origin.

The product shown by this page is **SushiOS**, the developer-preview
distribution assembled from the Kernel and a selected app set. **Neutron
Kernel** is the lower-level operating kernel inside that distribution. The
frontend deliberately presents those as separate title, kernel subtitle, and
distribution label rather than treating SushiOS and the Kernel as synonyms.

The frontend, starter upload, and handoff surfaces also have an isolated
deployment path against the repository's supervised PocketIC. Child placement
is a trusted backend install argument: the production deployer supplies the
reviewed production subnet, while the local deployer supplies the Application
subnet recorded by the running PocketIC platform. See
[Local Dispenser Test Deployment](#local-dispenser-test-deployment) below.

Primary sources:

- `support/dispenser/mo/main.mo`
- `support/dispenser/mo/lib/{IC,ICPL,cmc,ledger,neutron}.mo`
- `support/dispenser/src/index.tsx`
- `support/dispenser/src/provisioning.ts`
- `support/dispenser/test/`
- `apps/kernel/backend/activation/Service.mo`
- `apps/kernel/backend/memory/activation/v1.mo`
- `apps/kernel/backend/main.mo`
- `apps/kernel/src/activation_handoff.ts`
- `apps/kernel/src/reducer/activation.ts`
- `apps/kernel/src/reducer/auth.ts`

## Current Production Deployment

The split production deployment, last verified on 2026-07-30, is:

| Component | Principal or value |
| --- | --- |
| Public SushiOS frontend | `2h7je-aiaaa-aaaay-aacra-cai` |
| Public URL | `https://2h7je-aiaaa-aaaay-aacra-cai.icp0.io/` |
| Dispenser backend | `2o4cy-waaaa-aaaay-aacqq-cai` |
| Backend/frontend subnet | `re2t4-faa75-v3vhk-kdmdr-uyrkl-aik2l-ixd6u-p3fyr-zlfkc-6c5af-zae` |
| New-Neutron target subnet | `re2t4-faa75-v3vhk-kdmdr-uyrkl-aik2l-ixd6u-p3fyr-zlfkc-6c5af-zae` |
| Controller identity principal | `tvmgi-3iusw-snug4-h6pw4-et2k4-hiodt-xbqux-5wifj-ckxeb-fd76z-7qe` |
| Current starter deployment | Read from the backend's certified `starter()` query |
| Production update source | `233tv-xiaaa-aaaay-aacta-cai` |

The frontend is a certified asset canister bound at build time to the backend
principal. Users open the frontend; the backend has no user-facing HTML. The
single deployment mapping source is the operator's
`support/dispenser/.icp/data/mappings/ic.ids.json`; production deployment
rejects extra, missing, malformed, or duplicate canister mappings.

The repository starter selection and current archive filenames live only in
`support/dispenser/starter-packages.json`; changing release tables are not
copied into this document. The live starter can intentionally trail the
production update source, in which case a newly provisioned Neutron discovers
the newer packages in Settings. When maintainers want new Neutrons to begin
with the newer bytes, they use the single
[package-update release workflow](./package-updates.md#maintainer-release-workflow)
to publish and stage one coherent version/digest set.

Production maintenance uses the `dispenser-mainnet` ICP CLI identity by
default:

```sh
# Initial empty-backend install, starter upload, and frontend deployment.
npm --workspace dispenser run production:deploy

# Rebuild and deploy only the public frontend.
npm --workspace dispenser run production:frontend:deploy
```

Both commands first prove that the selected identity controls the exact
mapped canisters. The full deployment command refuses to replace a non-empty
backend whose module hash differs; a backend upgrade therefore requires a
separately reviewed explicit operation rather than an implicit install mode.
The ignored mode-0600 receipt at `.neutron/dispenser-production.json` records
canister/module hashes, controller, subnet label, starter identity, and exact
package pins. Normal starter replacement and postflight commands are kept in
the canonical package-update workflow linked above.

## End-To-End Flow

The normal hosted flow is:

1. On first load, the dispenser frontend creates a random Ed25519 identity and
   an independent random 32-byte activation code.
2. It synchronously saves the private identity and activation code in
   origin-scoped `localStorage` before displaying a payment address.
3. It derives an ICP ledger account owned by the dispenser canister, using the
   generated principal as the subaccount, and displays that same account in
   canonical ICRC-1 text and legacy 64-hex formats.
4. The frontend polls the ICP ledger every 10 seconds.
5. Once the account holds at least `2 ICP`, the frontend automatically
   calls `provision(SHA-256(activation_code))` as the saved Ed25519 identity.
6. The dispenser transfers the account balance, less the current ledger fee,
   to the CMC, creates the canister, installs Neutron, assigns temporary
   controllers, seeds assets, initializes publication entropy, and arms the
   activation hash.
7. The dispenser removes its kernel authorization and IC controller authority.
8. The frontend produces
   `https://<neutron-id>.icp0.io/#activate=<activation-code>`, optionally with
   the repository setup fields in the same fragment.
9. Neutron removes and temporarily stores the fragment before starting
   Internet Identity. After login, an otherwise-unauthorized principal submits
   the code once.
10. A successful `#use` atomically authorizes that Neutron-origin principal and
    destroys the stored activation hash.

The generated Ed25519 identity is only a provisioning credential. It is not
authorized in the resulting Neutron and is not an IC controller. Internet
Identity is used only after the user opens the newly created Neutron.

## Browser Provisioning Identity And Local Persistence

`loadOrCreateProvisioningSecrets()` generates two independent 32-byte random
values with Web Crypto:

- an Ed25519 seed passed to `Ed25519KeyIdentity.generate`; and
- a one-time activation value encoded as canonical unpadded base64url.

The persisted record is versioned and namespaced by the runtime dispenser
canister id (the production backend id on the hosted deployment):

```text
neutron.dispenser.provisioning.v1:<dispenser-canister-id>
```

It contains `identity.toJSON()` and `activationToken`. A reload reconstructs
the exact private identity and exact activation code, so it derives the same
ledger account, can resume the same backend registration, and reproduces the
same activation link. If parsing or key reconstruction fails, the record is
left untouched and provisioning stops; silently generating a replacement
would make a funded account unreachable.

This persistence is intentional but is not a hardware-backed wallet:

- any script executing at the dispenser origin can read the record;
- clearing site data, switching browser profiles, or losing that profile
  before activation loses the provisioning credential and code; and
- the activation link is a bearer credential until it is consumed.

The dispenser backend receives only the SHA-256 activation hash. The raw code
leaves the dispenser origin only in the activation link and, after
authentication, in the one-time `#use` call to the new Neutron.

## Deposit Address And Balance Polling

The deposit account is derived from:

- owner principal: the dispenser backend canister; and
- subaccount: `SubAccount.fromPrincipal(generated_identity_principal)`.

This matches `support/dispenser/mo/main.mo`, which derives the same subaccount
from `caller`. The browser queries the production ICP ledger's
`account_balance` method with its saved signing identity. It never asks the
dispenser to attest to a browser-provided address.

The UI defaults to canonical ICRC-1 account text and provides a **Legacy**
switch for the 64-character ICP account identifier. ICRC text represents an
account as its owner principal plus a non-default subaccount; the canonical
codec collapses a missing or all-zero subaccount to the owner principal alone.
The principal-derived dispenser subaccount is passed through DFINITY's official
ICRC account codec. Both displayed strings identify the same ledger account,
so a user chooses the format their wallet accepts rather than funding both.

Both frontend and backend enforce `200_000_000 e8s`. Provisioning starts
automatically when that threshold is observed. If a durable phase already
exists after a refresh, the frontend automatically attempts to resume it once;
the Resume button remains available after a transient error.

The UI asks for one transfer of any amount at or above 2 ICP. The protocol
actually checks the account's cumulative balance, so an earlier smaller
deposit is not ignored. Once provisioning begins, the amount is fixed: the
backend queries the ledger's current transfer fee and sends `balance - fee` to
the
[official Cycles Minting Canister](https://docs.internetcomputer.org/references/system-canisters/#cycles-minting-canister-cmc).
The CMC burns the ICP, converts its value at the protocol exchange rate, and
uses the resulting cycles to create and fund the Neutron. There is no change
output, partial conversion, refund of an intentional overpayment, or later
sweep of ICP sent after the transfer amount was fixed.

## Dispenser API And Durable State Machine

The browser-facing backend surface is deliberately small:

```motoko
status() : async ProvisioningStatus
find() : async ?Principal
provision(activationHash : Blob) : async Result<Principal, Text>
```

All three calls are keyed by the actual signed caller. `find()` returns a
canister only after provisioning is complete. `status()` exposes the durable
phase and the canister id when one is known.

After a caller's deposit is observed, the durable registration binds that
caller to its 32-byte activation hash and to the exact committed starter
revision captured before the balance query. A retry with another hash fails.
An unfunded call creates no durable registration. Only one transient
`provision` execution may run for a caller at a time.

The durable phases are:

| Phase              | Durable fact                                                                        |
| ------------------ | ----------------------------------------------------------------------------------- |
| `awaiting_payment` | No ledger transfer is prepared; this can be the implicit status of an unfunded caller or a bound retry after a definite transfer rejection. |
| `transferring`     | Amount, current fee, and `created_at_time` are fixed.                               |
| `notifying_cmc`    | The successful ledger block index is fixed.                                         |
| `created`          | The empty Neutron canister id is known.                                             |
| `installed`        | Starter Wasm is installed.                                                          |
| `controlled`       | Temporary controllers are dispenser plus Neutron itself.                            |
| `assets_seeded`    | Starter assets, `/pkg/id.json`, and the canister-bound runtime config were written, and publication entropy is ready. |
| `activated`        | The activation hash is armed and the dispenser is no longer kernel-authorized.      |
| `complete`         | The dispenser is no longer an IC controller.                                        |

Each completed external effect advances the registration before the next
effect. The important retry cases are:

- the ledger transfer stores `created_at_time`, accepts `#TxDuplicate`, and
  resumes from `duplicate_of`, preventing a second transfer;
- `#Processing` from the CMC retains the block index for later notification;
- a lost install reply is accepted only when the new canister's `module_hash`
  equals the bound starter Wasm digest;
- starter asset writes can be replayed from their first chunks;
- `#set` is idempotent for the same controller and hash; and
- before final self-removal, the dispenser reads `canister_info`. If an earlier
  `update_settings` committed but its response was lost, the observed
  controller list lets the dispenser mark the registration complete without
  attempting an update it is no longer authorized to make.

The atomic starter record also carries the compiler-derived, deduplicated set
of fixed principals named by backend-call install reservations. Method-only
reservations carry no target. After the CMC creates the paid canister and before
the first raw install call, the dispenser rejects a created principal in that
set; otherwise the Kernel constructor would reject an impossible self-target
reservation.

Every commit allocates a monotonic starter revision and freezes the Wasm,
runtime-config template, file records, chunks, and metadata into one immutable
value. Provisioning captures that value before its first balance `await`,
stores it together with `#transferring` before sending ICP, and never rereads
the controller's current starter during later phases. A controller can
therefore publish the next starter without making an in-flight registration
install one revision and seed files from another. Once bound assets, runtime
configuration, and publication entropy have been seeded, the registration
keeps the revision but releases the heavy payload reference.

## Creation, Installation, And Authority Retirement

The backend uses:

- ICP ledger `ryjl3-tyaaa-aaaaa-aaaba-cai`;
- CMC `rkp4c-7iaaa-aaaaa-aaaca-cai`; and
- management canister `aaaaa-aa`.

It transfers ICP with memo `1_095_062_083` and asks
`notify_create_canister` to create a canister initially controlled by the
dispenser. The request uses `subnet_type = null`,
`subnet_selection = ?#Subnet({ subnet = targetSubnet })`, and
`settings = null`. `targetSubnet` is fixed when the backend is installed.
The production deployment command supplies the reviewed `re2t4…-zae`
principal recorded above, so every production child Neutron is explicitly
requested on the same subnet as the dispenser deployment. This is one
operator-reviewed global placement policy, not a user-selectable target or a
multi-subnet/failover strategy.
See the ICP documentation's
[subnet-selection guide](https://docs.internetcomputer.org/guides/canister-management/subnet-selection/)
for the platform-level request this backend uses.

The dispenser installs the configured starter Wasm with `#install`. The
generated kernel initially authorizes the installer, which is the dispenser in
this path. The dispenser then sets controllers to:

```text
[dispenser, neutron]
```

This allows asset seeding and gives Neutron the self-controller authority
required by its upgrade model. After all starter files, `/pkg/id.json`, and
`/system/runtime-config.json` are written, the dispenser calls
`kernel_activation(#set(hash))`. Successful `#set` removes the setter from the
kernel authorization set in that same Neutron message. The dispenser then
changes controllers to:

```text
[neutron]
```

Thus “the dispenser deletes itself” means it removes both forms of authority
from the new Neutron. The shared dispenser service is not deleted, and its
caller-to-registration record is retained so the saved browser identity can
recover the completed Neutron URL.

## The One Activation Endpoint

The kernel exposes one reviewed unauthenticated update entrypoint:

```motoko
kernel_activation({
  #set : Blob;
  #use : Blob;
})
```

`#set(hash)`:

- requires a non-anonymous caller that is currently an actual IC controller;
- accepts exactly 32 bytes;
- can arm a fresh Neutron only once;
- is idempotent only for the same setter and hash; and
- removes that setter from kernel authorization when the hash is stored.

Controller verification is performed inside the kernel after a management
canister status call. It is not delegated to the public wrapper or to a
caller-supplied principal.

`#use(code)`:

- is available to a non-anonymous caller even when not yet authorized;
- accepts exactly 32 bytes and compares `SHA-256(code)` with the stored hash;
- derives the principal only from the authenticated message caller;
- adds that caller to the normal kernel authorization set; and
- clears the hash and setter and marks activation consumed.

The successful `#use` branch has no `await`. Authorization and activation
deletion therefore commit atomically or roll back together. Later callers
cannot reuse the code; the already-authorized successful caller receives only
an idempotent `#already_authorized` result.

Activation state is a separate managed-memory root,
`kernel_activation` version 1. Keeping it outside kernel memory v3 avoids
silently changing the established kernel stable signature.

## Neutron Frontend Handoff

The activation code is placed only in a URL fragment. Query-string fields named
`repo`, `manifest`, `digest`, or `activate`, including case variants, are
removed and rejected.

Before importing Internet Identity, agents, or React, the kernel bootstrap:

1. validates that the fragment has exactly one canonical 32-byte `activate`
   value and either all or none of the repository fields;
2. writes the activation value to same-tab `sessionStorage`;
3. removes the fragment with `history.replaceState`; and
4. fails closed and rolls back retained handoffs if storage or address-bar
   cleanup fails.

After Internet Identity login, the frontend first checks
`kernel_check_authorized`. If unauthorized and a pending activation exists, it
deletes the session copy and submits `#use` exactly once. If the update response
is ambiguous, it queries authorization rather than replaying the bearer. The
original dispenser tab can reproduce the link from local storage if the first
attempt definitely did not activate the Neutron.

Repository selection remains browser-only. An optional `repo`, `manifest`, and
`digest` travel in the same fragment, but none enters the dispenser backend or
changes the provisioning authority. See
[Repository Setup Manifests](./repository-setup-manifests.md).

## Starter Payload Administration

The current committed starter is one controller-managed dispenser value. A
SushiOS starter may contain the Kernel plus a preassembled set of application
packages. Those applications are already present in the installed actor and
registry when the new canister first boots; this is separate from the
owner-reviewed repository setup flow.

The ordered package selection lives in
`support/dispenser/starter-packages.json`. Each entry binds an expected package
id to one repository-contained `.neutron` archive. The first entry must be the
Kernel, package ids and paths must be unique, and the compiler validates the
complete dependency graph before any dispenser state changes.

The local and production staging commands, required ordering with source
publication, and postflight are maintained only in
[App Package Updates: Maintainer Release Workflow](./package-updates.md#maintainer-release-workflow).
Staging changes only future canisters created by the Dispenser; it does not
reinstall or modify existing Neutrons. The starter loader checks each
configured ID against the authoritative manifest inside its archive, derives
exact byte length and SHA-256 pins, compiles the complete ordered set once, and
refuses dependency or role mismatches before contacting the Dispenser.

The controller uploader splits a large compiled Wasm across bounded ingress
messages and stages all Wasm chunks, files, file chunks, and the runtime
template separately from the active payload. `commit_starter_upload` verifies
the expected counts, byte length, and Wasm SHA-256 before publishing the whole
payload together. An interrupted or invalid upload therefore leaves the
previous starter active. The public `starter()` query exposes the committed
revision, deployment id, ordered package ids, Wasm digest and size, and asset
counts for postflight verification.

`begin_starter_upload` returns a monotonic upload epoch. Every chunk/file add
and the final commit must present that epoch, so a delayed message from an
abandoned upload cannot mutate a later staging session.

The atomic maintenance methods are:

- `begin_starter_upload`
- `add_starter_wasm_chunk`
- `add_starter_file`
- `add_starter_file_chunk`
- `commit_starter_upload`

The runtime-config template contains text segments rather than a
browser-supplied principal. During provisioning the dispenser inserts the
created canister's actual principal between those segments, producing every
canister-bound field in `/system/runtime-config.json`.

Production intentionally records `update_source_origin: null`: on the IC the
Kernel derives the verified `https://<source-principal>.icp0.io` origin from
each package manifest. This does not disable the source. The local dispenser
instead binds the provision-owned PocketIC fixture origin because a loopback
origin cannot be derived from IC mainnet policy.

Each staged maintenance method checks the caller against the dispenser's actual
IC controller list using `canister_info`. There are no direct Wasm,
runtime-template, file, or chunk mutators. The public `canister_info` method is
used instead of `canister_status`, because the latter would require the
dispenser canister itself to be one of its own controllers.

The current Core `Map`/`List` registration and payload state is a fresh
deployment schema. It is not an in-place stable upgrade from the retired
legacy B-tree/vector dispenser. A production rollout must use an explicit
migration or an explicitly approved reinstall that accepts loss of the old
registry and staged payload.

## Local Dispenser Test Deployment

With the repository's supervised PocketIC already running, build and deploy
the isolated local dispenser surfaces with:

```sh
npm --workspace dispenser run local:deploy
```

The command compiles and installs the backend, stages the Kernel and every app
in `starter-packages.json`, builds a frontend bound to the local backend, and prints its
`http://<canister>.localhost:8000/` URL. Its canister ids are retained in the
ignored `.neutron/dispenser-local.json` state file while that PocketIC process
remains current.

Real ICP must not be sent to a local address. To simulate the payment, copy the
deposit account shown by the local UI and transfer at least two PocketIC test
ICP:

```sh
npm --workspace dispenser run local:fund -- <account>
```

The browser's normal ledger polling then sees the balance and follows the same
ledger path. The header reads **PocketIC test network** in this build; the
production build derives **Internet Computer** from its compile-time target.

`local_deploy.ts` installs the same backend Wasm with
`runtime.topology.subnetIds.Application` as its constructor argument. The CMC
therefore requests the Application subnet created by that exact supervised
PocketIC process rather than carrying a copied production or local subnet
principal. Both deployment paths query the installed backend's immutable
target and require it to match the expected subnet in addition to checking the
module hash. Old schema-1 local Dispenser state is ignored; the local command
creates and records a current backend rather than reusing an unattested one.

## Remaining Operational Limits

- There is no backup/export UI for the local provisioning private key or
  activation code.
- There is no registry removal, canister deletion, or ownership-transfer API.
- Every production creation is pinned to one reviewed production subnet.
  There is no user-selectable target, fallback, or multi-subnet routing policy.
- The starter uploader does not cross-check the live update source. The
  canonical [package-update workflow](./package-updates.md#maintainer-release-workflow)
  owns the required publish-before-stage ordering.
- A non-retriable CMC refund or invalid-transaction result needs operator/user
  handling; it cannot recreate the consumed payment.
- The source tests cover persistence, handoff validation, activation
  atomicity, generated authorization boundaries, compilation, and retry
  structure. A mainnet end-to-end payment/create/activate qualification remains
  a release requirement.
