# App-Isolated vetKeys

[Back to the documentation index](./index.md)

Neutron exposes the IC management canister's vetKD interface through one
kernel-owned capability for installed apps. An app declares a small set of
named slots, then uses source-bound browser APIs to reserve and recover a slot
key. An app backend may optionally receive a public-information-only handle.
Ordinary app code never receives the management canister actor, attached-cycle
control, raw namespace inputs, or another app's slot. The management canister
does not store an ordinary private key for Neutron: vetKD derives and encrypts
key material using the IC's threshold-cryptography protocol.

A slot is a durable namespace and policy record, not a stored private key. The
kernel persists a random namespace nonce, lifecycle state, public-key cache,
fingerprints, bounded counters, and audit facts. A derived private key is sent
by vetKD encrypted to an ephemeral browser transport key and exists in raw form
only after the browser decrypts and verifies that response.

Use this contract when implementing an app that consumes vetKeys or changing
the Kernel broker, namespace, or lifecycle machinery. Validate changes against
the relevant backend, browser, and consuming-app tests; documentation is not
release qualification. See the [testing guide](./testing-and-verification.md).

## Declare Slots

`capabilities.vetkeys` is a closed manifest object with an app-authored
description and a nonempty set of named slots:

```json
{
  "capabilities": {
    "vetkeys": {
      "api": 1,
      "description": "Encrypt and decrypt private Mail on demand in this browser",
      "slots": [
        {
          "id": "mailbox",
          "purpose": "Encrypt and decrypt private Mail"
        }
      ]
    }
  }
}
```

Slot ids are unique within the app. Use the capability catalog's validation for
identifier syntax, text normalization, and declaration bounds rather than
copying those rules into an app. Descriptions and purposes are shown as
unverified app text. Installation separately displays kernel-owned
warnings about browser recovery, cycle use, compatible updates, disabling,
and the app's ability to disclose a key from its own slot. A declaration does
not reserve a slot or derive a key.

An app that only uses the browser SDK omits a backend interface selection. If
its Motoko backend must publish public encryption information, it explicitly
selects the attenuated interface in addition to declaring the slots above:

```json
{
  "backend": {
    "capabilities": {
      "vetkeys_public": { "api": 1 }
    }
  }
}
```

The backend imports the reviewed leaf type and declares only the structural
environment field it consumes:

```motoko
import NeutronCapabilities "mo:neutron-capabilities";

public type AppBackendEnvironment = {
  capabilities : {
    vetkeys_public : NeutronCapabilities.VetKeysPublicV1;
  };
};

public class Init(env : AppBackendEnvironment) {
  let vetkeys = env.capabilities.vetkeys_public;
  // Use vetkeys.slot(...) and await* vetkeys.public_key(...).
};
```

The compiler asks the kernel to bind this handle to the installed app's exact
`AppScope { app_id; installation_uid }`; app-authored text never selects that
scope. The handle exposes slot status and public key material only, including
the kernel-computed public `derivation_input`; there is no private derive
method, transport-key parameter, raw namespace context or nonce, app-selected
derivation input, key-name selector, management actor, or cycle function.
`mo:neutron-capabilities` exports public types only; it cannot create a handle
or choose an app scope.

## Browser SDK Flow

The app SDK exports:

- `requestVetKeys()` for `reserve`, `enable`, `disable`, `rotate`,
  `retireGeneration`, `transfer`, and `retireSlot` decisions;
- `listVetKeys()` for the source app's reserved-slot summaries;
- `getVetKeyPublicKey()` for one declared generation's public encryption
  information;
- `deriveVetKey()` to begin one single-use encrypted-key request; and
- `approveVetKeyDerivation()` for the exact originating endpoint to confirm
  its own challenge as part of that protocol.

App identity is intentionally absent from every SDK request. The kernel derives
it from the registered message-bus endpoint and checks the current installed
app version after asynchronous work. Supplying an app id through a generic
signed call does not provide an alternative route. The management canister is
always rejected. For the Neutron canister, the trusted registry permits only a
live source app's own non-internal method under ordinary user consent; kernel
methods, another app's methods, and Agent Mode self-calls are rejected.

Lifecycle changes must start in the focused app tile and pass a kernel-owned
consent dialog. Reservation obtains a fresh 32-byte nonce and makes the
approving authorized principal the slot's lifecycle manager, represented by
the `key_holder` field. That role controls reserve, enable, disable, rotate,
transfer, and retirement; it is not a private-key reader role. Every currently
authorized Neutron principal may derive the slot's enabled retained
generations.

Private recovery is a source-bound protocol with no second user decision:

1. A live tile or resident background creates a fresh vetKeys transport key
   pair and 32-byte request nonce, then calls `deriveVetKey()`. Its 48-byte
   transport public key is sent to the kernel; the transport secret stays in
   requesting browser code, preferably a dedicated worker.
2. The SDK reports one opaque challenge through `onChallenge`. The exact
   originating endpoint immediately calls `approveVetKeyDerivation()` with
   that id. This is an automatic protocol confirmation, despite the historical
   API name; it needs neither focus, transient user activation, nor an extra
   consent dialog.
3. The kernel verifies that the confirmer is the same endpoint object and
   session under the same authorized principal and installed app version. The
   challenge is also bound to the app, slot uid/id, generation,
   transport-public-key hash, and expiry. The request nonce is shape-checked
   protocol material but is not an additional backend namespace input.
4. The kernel consumes the challenge, dispatches one bounded derivation, and
   returns the 192-byte encrypted key only to the original, still-live endpoint
   session.
5. The browser verifies/decrypts the encrypted key and discards the transport
   secret. Applications keep a usable key handle in worker memory and may also
   retain a bounded encrypted browser cache as described below; the kernel does
   not require lock/unlock UI.

Tray pages cannot begin or confirm derivation. A tile or resident confirms only
its own challenge. A delegated tool call that already passed the kernel's
ordinary cross-app tool permission may cause the target app's resident to
derive internally; vetKeys adds no model-, provider-, or agent-specific
plaintext consent. Closing or reloading the requester, replacing the app
version, changing the authorized principal or relevant slot state, expiring
the challenge, or changing its binding makes the request fail closed.

`isVetKeysError()` recognizes the closed app-facing error codes. Apps should
handle them as state transitions or retry guidance and must not parse error
messages. The kernel does not forward management reject text or key material in
errors.

### Reusing a browser-recovered secret

`kernel_vetkeys_derive` dispatches a paid management-canister call. Apps must
not repeat it merely because a tab, tile, or background resident reloaded.
An app that declares `persistent_browser_storage` may use
`neutron-tools/browser_secret_cache` on its installation-dedicated background
origin. The helper stores only authenticated ciphertext plus a structured-cloned
non-extractable AES-256-GCM wrapping key. Entries have exact caller-supplied
binding data, a fixed non-sliding expiry, and an origin-wide record bound. Use
the helper's exported lifetime and capacity constants. IndexedDB denial,
corruption, or expiry is a cache miss, never a weaker crypto path or a retry
loop.

The consuming app remains responsible for the semantic binding. Before restore
it queries the live slot summary and accepts only an enabled current or retained
previous generation with the expected generation, key name, and non-null public
fingerprint. The cache's authenticated binding and payload together must cover
the installed instance, slot, generation, suite, public material, and the
application-specific secret context, including browser-origin authority where
applicable. Validate cached public material against the fresh fingerprint and
verify that the recovered key is cryptographically consistent with its public
key and derivation identity. Ciphertext authentication alone does not establish
that the key is still authorized. Public-key material may be cached with the
secret so `kernel_vetkeys_public_key` is also avoided on a valid hit. A genuine
miss is coalesced across same-origin tabs before one fresh derivation.

The cache is an optimization and a defense against plaintext browser-profile
inspection, not a new same-origin trust boundary. Code executing on that app
origin can ask WebCrypto to use the non-extractable wrapping key. Disable,
logout, retirement, and uninstall prevent or clear supported live use when
observed, but cannot promise physical browser/OS erasure of an already cached
record; its fixed expiry and origin rotation bound later honest reuse.

## Namespace And Isolation

For namespace version 1 the kernel hashes a canonical encoding of:

- a fixed domain string;
- the current Neutron canister principal;
- installed app id;
- the compiler-bound installation uid;
- declared slot id;
- the slot's random 32-byte installation nonce; and
- the generation number.

In the context encoding, every domain/principal/app/slot/nonce byte string has
a four-byte unsigned big-endian length prefix; the installation uid and
generation are unsigned 64-bit big-endian. The fixed derivation input hashes a
length-prefixed identity domain followed by the raw 32-byte context hash; the
context hash itself is not length-prefixed a second time. The public-key
management call uses
`canister_id = null`, and vetKD also binds the actual calling Neutron canister.

Consequently, equal slot names in two apps, two Neutron canisters, two app
install instances, or two generations do not select the same supported
namespace. Apps cannot submit a context, derivation input, nonce, key id,
curve, canister id, cycle amount, or management target. The kernel fixes the
suite to `bls12_381_g2` and validates fixed reply sizes.

Isolation is enforced by the compiler-generated app capture, browser endpoint
and authorized-principal binding, stable `(AppScope, slot id)` index,
never-reused slot uid, and pre/post-await checks. A guessed slot in another app
is not listed or addressable through the app-facing APIs. The lifecycle manager
does not narrow which equivalent authorized owner credential may derive.

Treat the namespace encoding in `Namespace.mo` as durable key identity.
Changing its domains, inputs, order, or encoding changes the recovered key;
do not use such a change to repair or refactor an existing generation.

## Lifecycle And Recovery

- **Reserve:** creates generation 1 with a new random namespace nonce. A
  repeated reserve by the same lifecycle manager returns the existing slot;
  another principal cannot take over its lifecycle implicitly.
- **Compatible app update:** preserves the nonce and generations. The updated
  app inherits access; package version or hash is not a key boundary.
- **Manifest removal:** suspends the retained slot when the install journal
  commits. Re-adding the declaration does not silently enable it.
- **Disable / enable:** blocks or restores future recovery through supported
  APIs. Only the lifecycle manager can change the slot.
- **Rotate:** creates a new current generation and keeps at most one previous
  generation. A third generation is rejected until the previous generation is
  retired.
- **Transfer:** changes the lifecycle manager. It does not change derivation
  access: every currently authorized Neutron principal may recover enabled
  retained generations.
- **Retire generation / slot:** permanently removes future supported access to
  that retained namespace. Its lifecycle manager may still retire a suspended
  slot.
- **Uninstall:** retires the app's slots only when the deployment journal
  commits. Abort preserves them. A later reinstall receives a new nonce and
  slot uid.

The Kernel's managed memory stores this lifecycle state. Resolve its active
schema and supported migrations from `apps/kernel/neutron.json`; preserve
released schema history. Stable upgrade or snapshot recovery must
preserve the slot registry and the consuming app's ciphertext together.
Restoring only ciphertext, restoring a pre-retirement snapshot, or moving data
to a different canister principal has different consequences and must not be
described as key erasure. Disable, retirement, uninstall, and loss of current
slot state cannot erase a key already copied by a browser,
controller-provided frontend, app version, backup, or earlier snapshot.

Settings exposes lifecycle administration and public metadata, including
`key_holder`, retained generations, and approximate usage. Its bounded audit
projection records coarse app/slot/generation/action/actor/time and outcome
facts. Neither surface is a key export or a complete permanent event log.

## Environment, Cost, And Bounds

The compile environment is part of the generated actor:

- production selects `key_1`;
- local development selects `test_key_1`;
- there is no fallback between them.

The compile-only CLI is production-only and defaults to the
compiler-pinned mainnet context.
Local compilation and installation must use the provisioner because only its
verified PocketIC attachment can supply the exact trusted root context.
Provisioner targets bind the compiler-owned setting automatically:
`pocketic` selects local and `ic` selects production. The setting also selects
the chain-key-signing map; it is one actor-wide threshold-key environment
switch, not a vetKD-only option. Do not change an existing deployment's
environment as a recovery technique: vetKey generations retain their key name
and a mismatch fails closed.

The implementation bounds declarations, retained records, pending challenges,
challenge lifetime, concurrency, attached cycles, and the remaining cycle
reserve. Read current values from the capability catalog, browser broker, and
backend service/memory modules when changing or testing those limits. Apps
should handle typed failures instead of assuming a copied constant guarantees
that an operation can start. The repository's approval rules apply to changes
in these bounds.

A derivation has no fixed-hour request window. It may spend cycles even if
management rejects it; refunded cycles are subtracted from the approximate
lifetime spend record. Invalid shapes, insufficient cycles, or concurrency
rejection do not dispatch a derivation. Public keys are cached in stable slot
metadata and public/random management work also has bounded concurrency.

## Security Boundary

The supported protocol keeps the raw derived key out of canister stable memory,
audit, Settings, logs, and management-call arguments. Ciphertext, public keys,
fingerprints, the computed `derivation_input`, displayed lifecycle/routing
metadata, and usage counters are not secret. The random namespace nonce is a
different value: it persists only as internal kernel stable metadata and is
excluded from app browser/backend responses, retired tombstones, and audit.
Isolation does not rely on that nonce being an independently user-held secret.

This is not an absolute secrecy claim about every IC node, subnet, controller,
browser, or app:

- canister code, ciphertext, and stable metadata are replicated for IC
  execution; vetKeys protects the derived-key delivery path, not arbitrary
  canister state or metadata from the executing platform;
- vetKD confidentiality relies on the IC threshold-cryptography protocol and
  its trust assumptions; Neutron does not independently prove that a malicious
  threshold or platform cannot compromise it;
- an active controller can replace the kernel, app backend, or served frontend
  and capture future plaintext or browser-recovered keys;
- an approved or compromised app version can intentionally disclose keys from
  its own slots;
- a compromised browser, extension, worker environment, or owner session can
  read in-memory keys and plaintext after recovery or decryption; and
- copied keys, backups, and snapshots defeat claims of cryptographic erasure or
  forward secrecy.

The capability's concrete guarantee is narrower: under the running reviewed
kernel/compiler and supported APIs, the broker cannot address another app's
slot using an app-supplied identity, app backends receive no private derive
authority, recovery requires a currently authorized principal and confirmation
from the original registered endpoint/session, and no raw private key is stored
in a canister. Endpoint registration inherits the frame system's origin and
lifecycle assumptions: opaque compatibility frames do not provide the same
document-origin assurance as dedicated exact-origin frames. See
[planned compatibility removals](./deprecated.md). A consenting app may persist
only its own encrypted browser cache under the helper's bounds.
Removing a principal prevents later supported derivations but cannot make it
forget keys or plaintext it already obtained; rotate and migrate application
data when protecting future content from a removed credential.

## Source Entry Points

- [Capability catalog](../packages/neutron-tools/src/capabilities/catalog.ts):
  declarations, validation, and backend interface selection.
- [App SDK](../packages/neutron-tools/src/app.ts) and
  [browser broker](../apps/kernel/src/vetkeys/service.ts): request shapes,
  source/session binding, challenges, and typed failures.
- [Compiler assembly](../packages/neutron-compiler/src/assemble.ts): captured
  installation scope and environment configuration.
- [Backend service](../apps/kernel/backend/vetkeys/Service.mo),
  [namespace](../apps/kernel/backend/vetkeys/Namespace.mo), and
  [memory](../apps/kernel/backend/vetkeys/Memory.mo): lifecycle, stable key
  identity, dispatch, and current resource bounds.
- [Kernel manifest](../apps/kernel/neutron.json): active managed-memory roots
  and immutable schema/migration lineage.
- [Browser secret cache](../packages/neutron-tools/src/browser_secret_cache.ts)
  and [Mail cache integration](../apps/mail/src/vetkey_cache.ts): generic cache
  mechanics and a consuming app's authenticated key/lifecycle binding.
