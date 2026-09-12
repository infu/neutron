# App-Isolated Chain-Key Signing

This document records the authority and lifecycle contracts for assertion
signing and Wallet custody signing. Use the linked source for exact public
types, validation bounds, environment key names, and executable checks. Do not
infer deployment status or release qualification from this document.

## Source map

| Concern | Authority |
| --- | --- |
| Manifest declarations and combined slot bounds | [Capability catalog](../packages/neutron-tools/src/capabilities/catalog.ts) |
| Backend leaf types | [Motoko capabilities](../packages/neutron-motoko-capabilities/src/lib.mo) |
| Environment key configuration and scoped injection | [Compiler assembly](../packages/neutron-compiler/src/assemble.ts) |
| Namespace encoding and authority fingerprints | [Namespace](../apps/kernel/backend/chain_key_signing/Namespace.mo) |
| Admission, caching, normalization, and revocation | [Signing engine](../apps/kernel/backend/chain_key_signing/Service.mo) |
| Management calls, dynamic cost quotes, and failure classification | [Adapter](../apps/kernel/backend/chain_key_signing/Adapter.mo) |
| Custody leaf over the shared engine | [Custody service](../apps/kernel/backend/wallet_custody_signing/Service.mo) |

## Assertion authority

`chain_key_signing` signs bounded, domain-separated app assertions. The app
chooses a declared slot and assertion bytes. Kernel controls the threshold key
name, derivation path, app/install namespace, hashing, cycle attachment,
normalization, and revocation checks. The leaf exposes `public_key(slot)` and
`sign_assertion({slot; assertion})`; it exposes no raw digest operation, child
derivation path, management actor, BIP341 auxiliary input, or retry mechanism.

Installing this capability grants assertion authority, not one-shot transaction
consent. An external verifier can still interpret an assertion as permission
for a high-impact action. App protocols must constrain those semantics and
must not describe capability approval as transaction approval.

Raw Wallet custody is a separate explicit capability described below. Provider
review, direct-root agent authority, and public tool routing have their own
[call-consent contract](./app-method-access-and-call-consent.md). Neither
ordinary tool permission nor assertion signing implicitly grants custody.

## Manifest contract

Declare the requested slots and separately select the backend leaf:

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
          "id": "receipt_assertions",
          "algorithm": "ecdsa_secp256k1",
          "purpose": "Sign receipt assertions",
          "max_assertion_bytes": 512
        }
      ]
    }
  }
}
```

The declaration is closed: unknown fields are rejected. Slot IDs are validated
and unique within a capability declaration. Assertion slots support
`ecdsa_secp256k1`, `schnorr_bip340secp256k1`, and `schnorr_ed25519`.
`max_assertion_bytes` is a per-slot byte bound. Consult the capability catalog
for accepted IDs, purpose lengths, and per-app/global ceilings; assertion and
custody slots share the aggregate signing inventory.

`purpose` is untrusted display text. Escape it for display and exclude it from
key derivation, signing domains, and authority fingerprints. Editing purpose
text must not rotate keys or reset owner-disabled state.

Declaring authority alone does not inject the leaf. Backend selection injects
the specific `env.capabilities.chain_key_signing` type for that app scope, not
a universal Kernel capability object.

## Exact namespace and byte format

The namespace is cryptographic authority. These protocol encodings must stay
stable for the named namespace version:

```text
LP(x)  = u32be(byte_length(x)) || x
H(xs)  = SHA256(LP(xs[0]) || LP(xs[1]) || ...)
U64(n) = unsigned 8-byte big-endian n
```

Every part, including domain strings and integer encodings, is length-prefixed.
Lengths count bytes, not Unicode scalar values.

Assertion namespace version 1 is:

```text
namespace = H(
  "neutron.chain-key-signing.key.v1",
  U64(fresh_kernel_install_epoch),
  neutron_canister_principal_blob,
  UTF8(app_id),
  U64(app_installation_uid),
  UTF8(slot_id),
  UTF8(algorithm),
  UTF8(trusted_resolved_key_name),
  "neutron_app_assertion_v1"
)

signing_domain = H(
  "neutron.chain-key-signing.assertion-domain.v1",
  namespace,
  "neutron_app_assertion_v1"
)

digest = H(
  "neutron.chain-key-signing.assertion.v1",
  signing_domain,
  assertion
)
```

The management derivation path is `[namespace]`: one opaque 32-byte component.
Only the 32-byte digest is signed. Apps cannot append derivation components or
select another app/install identity. Purpose text is absent.

The canister principal separates Neutrons. A fresh Kernel installation epoch
and app installation UID separate assertion keys across full Neutron
reinstalls and app uninstall/reinstall, respectively. Slot, algorithm,
resolved key name, and fixed assertion tags prevent cross-slot,
cross-algorithm, cross-environment, and cross-format key reuse. A compatible
upgrade preserves the installation identity; it must not create a new epoch
or UID merely to release code.

## Key configuration and normalization

The compiler selects key configuration for the authenticated deployment
environment. Apps cannot supply threshold key names. Consult compiler assembly
for the supported environment/algorithm map rather than copying its current
key names into app logic. An unavailable key or algorithm returns
`#key_unavailable`; there is no fallback to another algorithm or environment.

Kernel validates response encodings and normalizes public keys:

- ECDSA secp256k1: compressed SEC1, 33 bytes.
- BIP340 secp256k1: x-only, 32 bytes, obtained from the validated compressed
  SEC1 response.
- Ed25519: 32 bytes.

The management chain code is checked for its expected length and discarded.
The returned `key_fingerprint` is a domain-separated SHA-256 value over the
algorithm and normalized public key. It supports identity comparison, not
signature verification. Successful signatures are checked for the raw
64-byte encoding before return; this structural check does not replace a
verifier's cryptographic verification.

Assertion responses include the resolved slot, algorithm, signing domain, and
message format. Public-key responses also report the namespace version. Read
the exported `ChainKeySigningV1` types for the exact records and error variants;
avoid maintaining a second type definition in this document.

## Admission, cycles, and unknown outcomes

Before yielding, signing checks source scope, slot declaration, assertion size,
runtime enablement, configured key, dynamic management-call cost, remaining
cycle reserve, and shared concurrency. Both public-key fetches and signatures
consume the shared in-flight resources. The service defines the current
per-slot, per-installation, and global bounds and signing cost ceiling.

Cost quotes come from system primitives, not a copied fee table. Attached
cycles can be spent even when dispatch fails or the result becomes unusable.
The broker records actual charges after refunds where observable; an
unobservable post-dispatch adapter failure conservatively retains the gross
reservation. There is no hourly attempt counter or temporal signing budget.

A validated public key is cached against the namespace and exact authority
fingerprint. Cache access still checks live authority. Purpose edits do not
invalidate the identity; authority changes invalidate incompatible cache
entries.

The adapter classifies `#system_unknown` and `#canister_error` signing rejects
as `#outcome_unknown`. An unexpected adapter failure after dispatch is also
ambiguous. Kernel returns no guessed signature and never retries automatically.
Other management failures return `#management_failure` without raw reject
details.

`#outcome_unknown` takes precedence over simultaneous post-dispatch revocation.
Neither result returns signature bytes, but ambiguity means a signature may
already have been generated. Callers must not interpret either failure as
proof that no signing occurred or blindly repeat an ambiguous request.

## Lifecycle, revocation, privacy, and audit

Each runtime resource is keyed by `(AppScope, capability kind, slot ID)`.
Dispatch captures a registry lease. After an await, Kernel rechecks current
scope, exact declaration/identity fingerprints, and lease epoch. Changed
authority suppresses returned bytes with `#revoked_after_dispatch`; it cannot
undo a management call or recover its cycle cost.

An unchanged authority preserves owner-disabled state and compatible cached
keys across upgrades. Configuration commit removes stale cache entries; a
failed install leaves the old scope intact. Successful uninstall revokes the
scope and removes its capability/cache and audit state. Assertion keys rotate
on reinstall; custody identity has a different lifetime, described below.

The broker does not persist assertions, digests, signatures, or raw management
rejects. Its state holds declaration/identity fingerprints and public-key
cache; generic audit holds bounded operation/outcome accounting and timestamps.
App code may have its own persistence and disclosure behavior.

Assertions originate in replicated canister execution and are not confidential
from subnet replicas. Threshold custody and app isolation do not provide
secret canister computation.

## Wallet Custody Signing V1

`wallet_custody_signing` is an explicit custody grant to an installed wallet
app. The API version is 1; its stable app-ID key namespace is version 2. These
are separate version domains.

The leaf accepts exactly a 32-byte digest and signs those bytes unchanged with
ECDSA secp256k1. It adds no assertion prefix or extra hash. An ordinary app can
request this capability; EVM Wallet has no special app-ID privilege.

```json
{
  "backend": {"capabilities": {"wallet_custody_signing": {"api": 1}}},
  "capabilities": {
    "wallet_custody_signing": {
      "api": 1,
      "slots": [{"id": "main", "algorithm": "ecdsa_secp256k1", "purpose": "Manage EVM account"}]
    }
  }
}
```

`WalletCustodySigningV1` exposes `public_key(slot)` and
`sign_digest({slot; digest})`. It returns compressed SEC1 public keys and raw
`r || s` signatures. The wallet validates its key/address binding and supplies
protocol encoding, signature verification, recovery parity, and low-S
normalization where required.

The installation decision permits signatures that can authorize asset
transfers, messages, permits, and other external actions. Kernel does not
decode the transaction or prove that a wallet's review UI matches its digest.
The wallet owns protocol validation, transaction review, caller-bound durable
commands, and recovery. A public tool should expose the reviewed protocol
operation; the backend leaf is not itself a public raw-digest tool.

Using the encodings defined above, custody namespace version 2 is:

```text
namespace = H(
  "neutron.wallet-custody-signing.key.v2",
  neutron_canister_principal_blob,
  UTF8(app_id),
  UTF8(slot_id),
  UTF8(algorithm),
  UTF8(trusted_resolved_key_name),
  "neutron_wallet_custody_digest_v2"
)
```

This namespace is the sole derivation-path component. App installation UID
and Kernel installation epoch are absent. Apps cannot choose another identity,
namespace version, path, or key name. Assertion keys and matching slot names
under another app ID remain separate.

Key identity and live authority have separate lifetimes. Compatible upgrades
and disabling a slot retain the account identity. Removing a slot or
uninstalling its app revokes current authority and clears live cache state;
in-flight calls still undergo revocation checks. Reinstalling the same app ID
and slot in the same Neutron can recover the same account after the normal
explicit custody grant, under the same algorithm and key configuration.

Uninstall still deletes app-owned wallet history, settings, and request
journals. It does not delete on-chain assets, positions, or permissions, and
recovering a key does not restore those local records. There is no seed/private
key export, cross-app identity reassignment, or recovery into another Neutron
canister. Full Neutron deletion or destructive reinstallation is outside this
app-uninstall contract.

Historical custody namespace version 1 derived a different, installation-bound
key. The current service directly selects namespace version 2; it does not
recover or move assets from a legacy account. A legacy account cache is not
evidence of access to the same signing key under the new namespace. Any work
supporting that predecessor must explicitly account for its key identity and
production data. Do not reuse an old fresh-account cutover recipe as a general
upgrade or silently discard state. Follow the
[memory and migration contract](./memory-migrations-and-uninstall.md).

Custody and assertion signing share the checked engine, aggregate inventory,
in-flight resources, dynamic cost admission, outgoing-cycle accounting, and
lease checks. Custody runtime enablement remains a separate resource kind.
Its errors use `ChainKeySigningErrorV1`, including the same no-retry ambiguity
and post-dispatch revocation semantics.

## Verification when changing signing

Use the [assertion service tests](../apps/kernel/test/motoko/chain_key_signing_service_test.mo),
[custody service tests](../apps/kernel/test/motoko/wallet_custody_signing_service_test.mo),
and [independent custody vectors](../apps/kernel/test/wallet_custody_signing.test.ts)
to check namespace separation, unchanged digest semantics, key normalization,
shared admission, cache binding, stale scopes, revocation, and unknown outcomes.
Manifest and compiler tests must also demonstrate that only the selected scoped
leaf is injected and that both signing kinds count against the shared bounds.

Changing namespace inputs, domain tags, or environment key configuration can
change account identity without changing a Motoko memory type. Treat those
changes as account compatibility work, not merely successful compilation.
Check supported installed schemas and actual key continuity alongside the
[production release workflow](./package-updates.md).

Deterministic adapters establish broker behavior; they do not prove management
key availability, live signature verification, or actual cycle spend. When
changing the management integration, qualify those behaviors in the intended
deployment environment and retain release evidence separately from this
contract. [Kitchen Sink](../apps/kitchensink/) provides an assertion integration
example; its demo is not a substitute for that qualification.
