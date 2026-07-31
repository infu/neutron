# Neutron App-Isolated vetKeys Capability

Status: the generic manifest/compiler/SDK, kernel memory/adapter/service,
source-bound browser broker, install disclosure, lifecycle UI, Settings, and
Mail consumer integration are implemented and release-validated. Disposable
installed-canister proofs cover cross-app isolation, lifecycle, browser-vector
compatibility, full snapshot restore, and the redaction boundary below.

Updated: 2026-07-18

## Outcome

Add one reusable kernel security subsystem that lets an installed Neutron app
reserve a small number of deterministic vetKey derivation slots. Each slot is
isolated by canister, installed app, declared slot, a fresh random
install-instance nonce, and generation. Apps receive public information and
browser-encrypted derived keys through bounded kernel APIs; they never receive
management-canister access, cycle control, raw namespace parameters, or another
app's slot.

A slot is **not key storage**. Stable memory contains authorization, namespace,
lifecycle, public-key cache, and bounded accounting metadata. The raw derived
key exists only after an authorized browser decrypts a vetKD response.

This must be a platform capability usable by many apps. Do not implement a
Mail-only bridge or relax the existing raw-actor/call/cycle bans.

## Hard Invariants

1. **No stored secret:** kernel/app stable state, Settings, audit, logs, and
   errors never contain a raw vetKey, client transport secret, derived
   symmetric key, or encrypted-key response.
2. **Cross-app isolation:** app A cannot list, guess, derive, enable, disable,
   rotate, retire, or reuse app B's slot through any supported path.
3. **No caller-selected namespace:** apps cannot choose app id, canister id,
   key id, curve, context, derivation input, slot nonce, cycles, management
   target, or raw method.
4. **Source and authorization binding:** browser operations derive app identity
   from a live registered endpoint and bind each challenge to the exact
   currently authorized Neutron principal. The slot key manager controls
   lifecycle changes but is not the only reader; payload app ids are never
   authority.
5. **No ambient private backend handle:** compiler-injected Motoko capability
   exposes status/public key only. Encrypted private-key derivation is a
   source-bound browser broker with a single-use originating-endpoint
   confirmation challenge.
6. **Durable, explicit lifecycle:** compatible upgrades preserve access;
   disable is reversible; retirement/uninstall are explicit and do not claim
   to erase keys already copied.
7. **Bounded cost:** slot count, pending challenges, request sizes, concurrency,
   reply sizes, attached cycles, and the low-cycle reserve are kernel-controlled;
   derivation has no time-window request limit.
8. **No silent environment downgrade:** production uses `key_1`; local/test
   uses `test_key_1`; a production failure never falls back.
9. **Post-await revalidation:** source session, exact requesting authorized
   principal, declaration, slot, lifecycle manager, generation, status, and
   challenge are checked again before an encrypted result is
   delivered.
10. **Honest security claim:** isolation is enforced by Neutron's audited
    kernel/compiler. An active controller/kernel/app upgrade can replace code
    and is outside this capability's confidentiality guarantee.

## Research And Capability Boundary

ICP vetKeys derive a deterministic key from calling canister, context, and
input. A threshold of nodes encrypts the result to a client transport public
key, and only the browser possessing the transport secret can recover/verify
the raw key.

Ordinary Neutron apps still cannot call vetKD directly:

- `backend_calls` rejects management principal `aaaaa-aa`;
- ordinary apps cannot attach the cycles required by `vetkd_derive_key`;
- compiler policy bans direct actors/raw calls/cycle primitives;
- the trusted management interface lacks vetKD methods.

The implemented capability keeps those restrictions. Only the kernel
management adapter may call
`vetkd_public_key`, `vetkd_derive_key`, and `raw_rand` for this subsystem.

Primary references:

- <https://docs.internetcomputer.org/concepts/vetkeys/>
- <https://docs.internetcomputer.org/references/ic-interface-spec/management-canister/>
- <https://github.com/dfinity/vetkeys>
- <https://github.com/dfinity/examples/tree/master/rust/vetkeys/basic_ibe>

## Manifest Contract

`vetkeys` is a sibling app capability:

```json
{
  "capabilities": {
    "vetkeys": {
      "description": "Recover the key used for private Mail",
      "slots": [
        {
          "id": "mailbox",
          "purpose": "Encrypt and decrypt private Mail"
        }
      ]
    }
  },
  "init_arg": ["memory_mail", "app_capabilities", "app_dependencies"]
}
```

The manifest declaration always enables only the source-bound browser policy.
`app_capabilities` is required in `init_arg` only when that app backend consumes
the optional public-only `VetKeysPublic` record. A frontend-only consumer may
omit the constructor resource; declaring a slot must not force an unused
backend handle.

App description/purpose are bounded untrusted explanation. Trusted install UI
separately explains:

- declaration grants no usable key until a focused-tile reservation;
- an enabled app can request its slot key encrypted to its browser;
- compatible app updates inherit enabled slot access;
- derivation spends canister cycles;
- disabling blocks future supported recovery but cannot erase browser-held
  keys;
- app code can intentionally disclose keys from its own slots.

Kernel-owned V1 limits:

- 1-4 declared slots per app, 128 reserved slots per canister;
- lowercase app-style slot ids, 1-40 ASCII characters;
- one current plus at most one previous generation per slot;
- no app-selected limits and no batch derivation;
- one derivation in flight per app, four per canister;
- no time-window derivation counter; pending and in-flight bounds prevent
  unbounded concurrent work without throttling sequential authorized use;
- exact 48-byte transport public key;
- at most 8 pending challenges/app and 64/canister, each expiring after 60
  seconds;
- fixed bounded management replies and public-key cache entries.

One slot generation is one deterministic root/IBE identity. It is not an
app-selected unbounded key namespace. Apps derive reviewed local subkeys or
wrap random per-record keys in the browser.

## Namespace Construction

Textual app id is not enough: the same id can be reinstalled, and a full
canister reinstall can reset counters. On first reservation the kernel obtains
a fresh 32-byte `namespace_nonce` from `raw_rand`. Compatible upgrades retain
it; committed uninstall/reinstall gets a different nonce.

Define one canonical length-prefixed encoding and golden vectors. The kernel
constructs:

```text
context = SHA-256(
  LP("neutron.vetkeys.slot-context.v1") ||
  LP(self_canister_principal_bytes) ||
  LP(installed_app_id_utf8) ||
  LP(slot_id_utf8) ||
  LP(namespace_nonce[32]) ||
  u64be(generation)
)

fixed_derivation_input = SHA-256(
  LP("neutron.vetkeys.slot-identity.v1") || context
)
```

`LP` uses an exact documented fixed-width big-endian length. The management
request fixes `canister_id = null`, so vetKD also binds the actual calling
Neutron canister. Apps receive public key, fixed derivation input, generation,
suite, environment key name, and fingerprint; they never submit or override
the derivation inputs.

Isolation relies on all layers:

- browser source binding supplies installed app id;
- compiler-generated public capability captures app id;
- slot lookup keys by captured app id + declared slot;
- random nonce separates installed instances;
- generation separates rotations;
- management call implicitly scopes the Neutron canister;
- every operation rechecks current declaration/reservation/status;
- raw management and cycle operations remain unavailable to ordinary apps;
- listings/errors never reveal whether a guessed id belongs to another app.

## Source-Bound Browser Broker

Private, non-discoverable kernel actions omit `appId`:

```text
vetkeys.request
vetkeys.list
vetkeys.publicKey
vetkeys.derive.begin
vetkeys.derive.approve
```

`request` opens kernel-owned focused-tile consent for `reserve`, `enable`,
`disable`, `rotate`, `retire`, or key-manager transfer. `list` and `publicKey`
return only the source app's bounded public summaries.

### Single-use derive handshake

1. A registered tile or resident creates a fresh ephemeral transport key pair
   and random request nonce.
2. It calls `vetkeys.derive.begin` with declared slot id, generation, 48-byte
   transport public key, and request nonce.
3. Kernel derives source app/endpoint/session, resolves exact slot uid, hashes
   the transport public key, and creates an in-memory challenge bound to:

   ```text
   challenge_id
   installed_app_instance / namespace slot_uid
   slot_id + generation
   requester endpoint object + session id
   SHA-256(transport_public_key)
   request nonce
   exact requesting authorized principal
   expiry
   unused state
   ```

4. The exact originating tile or resident presents its opaque challenge id
   through `vetkeys.derive.approve`. This confirmation is automatic application
   work: it requires neither focus/transient activation nor a second app-owned
   permission prompt.
5. Kernel validates that the confirmer is the original live endpoint object and
   session, the exact still-authorized requesting principal, declaration,
   enabled slot/generation, expiry, request hash, concurrency, and cycle
   floor.
6. Kernel atomically marks the challenge consumed and acquires dispatch
   concurrency before the first await.
7. Trusted adapter calls `vetkd_derive_key` with kernel-owned parameters/cycles.
8. After await, kernel rechecks consumed challenge, requester endpoint/session,
   the exact requesting principal's authorization, lifecycle-manager/binding
   stability, declaration, slot/generation/status, environment, and reply bounds.
9. It delivers the encrypted VetKey only to the original still-live requester
   endpoint. Closure/reload/replacement, authorization removal, identity change,
   disable/retire/suspend, lifecycle-manager change, or any mismatch discards
   the result.
10. Requester verifies/decrypts locally, destroys the transport secret, and
    keeps the raw key only in volatile memory.

Challenges never enter stable memory or audit payloads. Begin/approve are
private and absent from tool discovery. A target app may recover while handling
a delegated or Agent tool call because the kernel's permission for that
cross-app tool invocation is the consent boundary; no app- or model-specific
vetKeys grant exists. Tray cannot begin or approve. A background confirms only
its own challenge and cannot confirm one created by a tile or another resident.

This handshake proves source/authorization/session policy in the supported
runtime. It cannot stop a malicious approved app version from asking for and
leaking its own slot key.

### Backend public-only capability

Some app backends must publish a slot's public encryption information. The
compiler may inject only:

```motoko
public type VetKeysPublic = {
  canister_principal : Principal;
  slot : (Text) -> ?VetKeySlotSummary;
  public_key : ({ slot : Text; generation : Nat64 }) ->
    async* VetKeyPublicResult;
};
```

There is no backend `derive`, transport-key argument, raw context/input, key
selection, management actor, or cycle function. `public_key` fixes
`canister_id = null`, uses the kernel namespace, and caches/coalesces its public
result. A public app endpoint can therefore expose encryption material without
ever obtaining the private root.

## Trusted Backend Adapter And Errors

Only the kernel adapter selects:

- `bls12_381_g2`;
- `key_1` in production or `test_key_1` in local/test;
- context/fixed input;
- `canister_id = null`;
- platform-derived cycle cost plus trusted headroom;
- request/reply size expectations.

Use a platform cost primitive when available; otherwise use a trusted versioned
kernel constant with headroom. Unused cycles are refunded. Validate the exact
requesting principal remains authorized, reject the Neutron canister principal
itself even though it is internally authorized, and validate slot, shape,
finite concurrency, and a configured canister cycle floor before dispatch.
Record lifetime derivation and approximate cycle totals immediately before
dispatch even when management later rejects because it may spend cycles.

Closed errors:

```text
not_declared
not_reserved
manifest_suspended
disabled
generation_unavailable
invalid_request
challenge_expired
challenge_consumed
busy
low_cycles
key_unavailable
management_failure
source_gone
owner_required
```

A guessed cross-app slot returns the same coarse missing response. Never return
raw management reject text, stack, key bytes, or detailed cryptographic errors.

## Stable Kernel Model

The sole preproduction kernel memory v2 schema contains the vetKeys registry
inside the same `kernel` record as every other persistent subsystem:

```text
VetKeyMemoryV1 {
  next_slot_uid
  slots_by_uid
  slot_index_by_app_and_id
  bounded retired tombstones and coarse audit
}

VetKeySlot {
  slot_uid
  app_id
  slot_id
  namespace_nonce[32]
  key_holder
  status: enabled | disabled | manifest_suspended
  current_generation
  next_generation
  generations[<=2]
  created_at/by
  updated_at/by
  last_used_at
  lifetime derivation and approximate cycle-spend totals
}

VetKeyGeneration {
  generation
  status: current | previous
  namespace_version
  key_name
  cached_public_key?
  public_fingerprint?
  created_at/by
}
```

Only public keys/fingerprints, namespace metadata, status, counters, and bounded
administrative facts persist. Validate indexes during initialization and tests.
Pending browser challenges and encrypted derivation results are runtime only.

## Lifecycle

- **Reserve:** focused owner consent, `raw_rand` nonce, current generation 1,
  exact reserving principal becomes the lifecycle key manager, public key may
  be cached.
- **Compatible upgrade:** same installed app/slot retains nonce and generations.
  Upgrade UI states that the new package inherits decryption power. Package
  hash/version is not a key boundary.
- **Manifest removal:** set `manifest_suspended` at committed install; retain
  recoverability metadata. Re-adding requires explicit Enable.
- **Disable:** reversible block on public-key/derive operations. It cannot erase
  a key already in memory.
- **Enable:** exact lifecycle key manager focused consent restores an otherwise
  compatible disabled slot.
- **Rotate:** create new current generation; old current becomes previous. A
  third is rejected until previous retirement. "Previous" is policy, not a
  cryptographic decrypt-only primitive.
- **Retire generation:** permanently disables supported future derivation for
  that generation after destructive confirmation. It does not erase browser
  copies, snapshots, or keys a controller already obtained.
- **Key-manager transfer:** current exact manager approves the new principal.
  This moves lifecycle authority only: it does not rotate key material or
  change which currently authorized Neutron principals can derive retained
  generations. Adding an authorized principal grants retained access.
- **Uninstall:** retire all slots only at successful install-journal commit.
  Abort preserves them. Reinstall gets a fresh nonce and cannot recover the old
  installed instance.
- **Full canister replacement:** without restored v1 slot state, new random
  nonces cannot derive old slots. Snapshot/restore must preserve kernel and app
  state consistently.

## Kernel UI, Settings, And Audit

Reservation copy must say, in substance:

> This app can recover this slot's private key in its live browser session.
> The key is threshold-derived and returned encrypted; Neutron does not store
> it. Recovery spends canister cycles. Compatible app updates inherit access.
> Every principal currently authorized for this Neutron can explicitly recover
> the same retained key generations.
> Disable stops future supported recovery but cannot erase a key already held
> by a browser.

Settings groups slots by installed app and shows:

- slot id/purpose and enabled/disabled/suspended state;
- exact lifecycle key manager and the fact that all currently authorized
  Neutron principals may recover;
- current/previous generation and shortened public fingerprint;
- production/test key name;
- created, updated, and last-used times;
- recent derivation count and approximate cycle spend;
- Enable, Disable, Rotate, Transfer key manager, and permanently Retire actions.

Audit stores bounded app, slot uid/id, generation, action, actor, time, and
coarse outcome. Never record namespace nonce, fixed input, transport public key
or hash, encrypted output, raw key, app plaintext, or raw reject.

## Implementation Surfaces

Inside `apps/kernel/`:

- trusted vetKD/raw-rand management types and adapter;
- the vetKeys fields in immutable kernel memory v2;
- slot memory/service/lifecycle/rate/cycle logic;
- install declaration configuration, journal commit/abort, and uninstall;
- public-only app capability constructor;
- source-bound frontend actions and single-use challenge service;
- permission disclosure/dialog, Settings, audit projection, and tests.

Shared platform surfaces now implemented outside `apps/`:

- `packages/neutron-tools`: manifest types/schema/normalization, JSON schema,
  source-bound SDK methods, validation, and tests;
- `packages/neutron-compiler`: recognize any backend capability, generate the
  optional `vetkeys` field, configure declarations, and preserve app-id
  capture/raw-call bans;
- relevant repository docs and package-format/security references.

The generic capability now compiles through these shared paths. Mail uses it
without a Mail-only raw-management route. Keep shared package, compiler,
kernel, and consuming-app tests together when changing the contract.

## Implementation Gates

### Gate 0 — Scope and contracts

- [x] Authorize and implement the required package/compiler files.
- [x] Complete the release freeze for manifest schema, namespace vectors,
      public info, browser handshake, closed errors, limits, lifecycle, and
      security copy.

### Gate 1 — Kernel state and adapter

- [x] Add vetKeys to the sole memory v2 baseline with invariant tests.
- [x] Add raw-rand/vetKD adapter, environment key selection, cycle brokerage,
      caching, bounds, and closed errors.
- [x] Add slot reserve/configure/enable/disable/rotate/retire/transfer/uninstall
      service with post-await checks.

### Gate 2 — Source-bound product surface

- [x] Add manifest/compiler/public capability integration.
- [x] Add begin/approve single-use originating-endpoint derive handshake and
      endpoint routing.
- [x] Add install/update disclosures, Settings, audit, and SDK.

### Gate 3 — Adversarial fixtures

- [x] Install two fixture apps with identical slot ids and prove different
      public roots plus complete cross-app denial.
- [x] Prove lifecycle, cost, race, migration, redaction, and browser-library
      vectors below.
- [x] Freeze capability behavior before Mail's private-message release gate.

Current release evidence (2026-07-16): normal local kernel archive
`2ebc4e900be19e998a8ea3eee3bfa77b531bc3b11b6d5b4215586e7714e66317`
passes 213 Bun tests with 1,870 assertions and all nine Motoko suites. The
fixture suite passes 38 tests with 243 assertions. The installed isolation and
redaction proof created two apps with the same declared slot id, observed
distinct roots, rejected all nine cross-app injected operations in both
directions, passed current and previous official browser vectors, and scanned
complete canister snapshots, logs, Settings, audit, browser persistence,
console, and errors for forbidden secrets and application plaintext.

The installed lifecycle proof covered compatible update, manifest suspension
and explicit re-enable, two-generation rotation and retirement, uninstall
journal abort and commit, fresh reinstall isolation, and exact 192 MiB full
snapshot restore. A restored numeric slot uid may recur after state rollback,
but a discarded reinstall branch never reused its cryptographic root or public
derivation input. The redaction report explicitly records the honest boundary:
transient public transport material and the encrypted response can remain in
live Wasm call residue until collection; transport secrets, request nonces,
challenge ids, derived private keys, and app plaintext were absent from every
forbidden surface.

## Required Test Matrix

- Two apps with identical slot names produce different public keys.
- App A cannot list, guess, derive, approve, enable, disable, rotate, retire, or
  transfer app B's slot.
- App id supplied in any payload is ignored/rejected; source endpoint wins.
- Compatible update preserves nonce/public key and visibly inherits access.
- Manifest removal suspends; reinstall uses a new nonce; uninstall abort
  preserves; commit retires; full reinstall cannot accidentally reuse context.
- Current+previous rotation works; third generation is blocked until retirement.
- Unauthorized or removed principal, requesting-principal change, Neutron
  canister self-call, source replacement, requester closure, tile closure,
  expiry, duplicate approval, altered transport key/hash, altered generation,
  and changed status all fail closed. An authorized non-manager derives, while
  its lifecycle mutations remain denied.
- Disable/retire/suspend/key-manager transfer during management await discards
  the result after await.
- Pending challenge counts, expiry cleanup, one/app and four/global
  concurrency, and cycle floor remain bounded; no temporal dispatch counter
  exists.
- Invalid transport length and low cycles spend no derivation cycles;
  dispatched management rejects may still spend attached cycles.
- Public-key calls cache/coalesce and never select a remote canister or fallback
  key.
- Production refuses `test_key_1`; local/test never implies production safety.
- The pinned official browser library decrypts/verifies golden encrypted-key
  responses for current and previous generations.
- No raw/derived private key, encrypted key response, caller transport key or
  hash, per-request challenge nonce, app plaintext, or raw reject appears in
  stable memory, Settings, audit, logs, or errors. The slot's internal
  `namespace_nonce` and fixed derivation input are intentional stable namespace
  metadata; public-key info intentionally returns the computed public
  `derivation_input`, public key, and fingerprint. Those permitted values still
  do not belong in audit entries or logs.
  The disposable installed gate is
  `npm --workspace neutron-vetkeys-fixture run prove:redaction`; its report
  explicitly separates forbidden persistence from unavoidable live-Wasm
  transit residue and records the raw adapter-reject observability boundary.
- The sole kernel memory v2 baseline initializes an empty valid slot registry;
  discarded preproduction schemas are reinstalled rather than migrated.
- Existing backend-call, scheduler, install-journal, source-binding, tray, and
  Agent Mode tests remain green.

## Release Acceptance

- The schema/compiler/runtime expose one generic capability, not an app
  exception.
- Namespace golden vectors bind canister + app + random install instance + slot
  + generation, with no caller-selected derivation input.
- Only a live source-bound challenge for the exact currently authorized
  requesting principal, confirmed by its exact originating tile or resident,
  can dispatch a derivation; the result reaches only that original requester
  session. Recovery needs no focus gesture or second app-owned consent.
- Ordinary app backends can obtain public information but have no private
  derive/cycle/management handle.
- Every count, byte, pending item, call, reply, concurrency, and cycle
  path is bounded and tested.
- Upgrade, suspension, disable, rotation, retirement, transfer, uninstall
  commit/abort, reinstall, and full restore behavior are explicit and tested.
- Settings/audit disclose authority and cost without key material.
- Active-controller/app-code limitations are documented and no UI promises
  cryptographic erasure or absolute node/controller secrecy.
