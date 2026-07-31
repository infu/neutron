# App-Isolated Chain-Key Assertion Signing V1

Status: **development implementation** (2026-07-18). The manifest, compiler
selection, scoped Motoko leaf, kernel broker, and Kitchen Sink demonstration are
implemented. Deterministic adapter tests are the authority for the broker
boundary; real PocketIC/mainnet key and cycle-spend validation remains a release
gate.

## Decision

`chain_key_signing` signs bounded, domain-separated **app assertions**. It is
not a raw threshold-signing API and it is not a transaction-signing API. An app
may select a declared slot, fetch that slot's normalized public key, and submit
assertion bytes. The kernel owns everything else:

- the production or local threshold key name;
- the one-component derivation path;
- app/install namespacing and domain separation;
- hashing, signature dispatch, cycle attachment, and public-key normalization;
- concurrency, per-call cost admission, runtime revocation, and audit;
- ambiguous-outcome handling, including the decision never to retry.

This deliberately leaves no app-controlled key name, derivation path, raw
digest, cycle amount, BIP341 auxiliary value, or management-canister actor.
Future Bitcoin, EVM, Solana, or credential flows need typed protocol adapters.
Any adapter capable of moving value must require a one-shot, transaction-shaped
owner review immediately before signing; installing this assertion capability
must never preapprove one.

A signature is still authority-bearing evidence: an external verifier can
choose to interpret any assertion as permission for a high-impact action. App
developers must constrain assertion semantics, and verifiers must not treat the
install-time capability approval as Neutron's one-shot transaction consent.

The IC management interface is the transport authority for
[`ecdsa_public_key` / `sign_with_ecdsa` and `schnorr_public_key` /
`sign_with_schnorr`](https://docs.internetcomputer.org/references/ic-interface-spec/management-canister/).
Its ECDSA request accepts exactly a 32-byte hash, signatures are raw 64-byte
`r || s`, Schnorr supports BIP340-secp256k1 and Ed25519, and a Schnorr call has
optional BIP341 auxiliary data. Neutron narrows that larger interface as
specified below.

## Manifest contract

An ordinary app declares one through four slots and explicitly selects the
backend leaf:

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
          "max_assertion_bytes": 4096
        }
      ]
    }
  }
}
```

The declaration is closed. Slot ids match `^[a-z][a-z0-9_]{0,39}$` and are
unique within the app. The supported algorithm strings are:

- `ecdsa_secp256k1`
- `schnorr_bip340secp256k1`
- `schnorr_ed25519`

`purpose` is one through 160 Unicode scalar values of **untrusted display
text**. It is shown in install/Settings UI after normal escaping, but it is
excluded from key
derivation, signing-domain construction, or authority fingerprints. Editing
prose therefore neither rotates a key nor changes authority.

Hard declaration ceilings are four slots per app, 2,048 slots across the
assembled actor, and 4,096 assertion bytes. There is no authored or runtime
hourly assertion/cycle allowance. Concurrency, the fixed per-call quote
ceiling, and the low-cycle reserve remain safety boundaries.

Declaring the capability does not inject it. Selecting
`backend.capabilities.chain_key_signing` injects only
`env.capabilities.chain_key_signing : ChainKeySigningV1`. There is no universal
kernel capability object.

## Exact namespace and byte format

The namespace is cryptographic authority, not an authored string convention.
Let:

```text
LP(x)  = u32be(byte_length(x)) || x
H(xs)  = SHA256(LP(xs[0]) || LP(xs[1]) || ...)
U64(n) = unsigned 8-byte big-endian n
```

Every part, including fixed domain strings and integer encodings, is
length-prefixed. Lengths are byte lengths, not Unicode scalar counts.

For namespace version 1, the kernel constructs:

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

The fresh kernel-install epoch changes after a full Neutron reinstall. The app
scope contains both the canonical app id and its fresh installation uid, so an
app uninstall/reinstall also receives a new key namespace. The canister
principal prevents the same app/install values on another Neutron from
colliding. Slot id, algorithm, the kernel-resolved key name, and the fixed
app-assertion tag prevent cross-slot, cross-algorithm, cross-environment, and
cross-message-format key reuse.

The sole management derivation path is `[namespace]`: one opaque 32-byte
component. Apps cannot append child components or inspect a master derivation
path. `purpose` is absent. The assertion bytes are never sent directly to the
management interface; only the 32-byte `digest` is signed.

## Key configuration and normalization

Key selection is compiler/kernel configuration, not manifest authority:

| Environment | ECDSA secp256k1 | BIP340 secp256k1 | Ed25519 |
| --- | --- | --- | --- |
| Production | `key_1` | `key_1` | `key_1` |
| Local | `dfx_test_key` | unavailable | unavailable |

There is no fallback from an unavailable algorithm to another algorithm or from
a local key to a production name. A declared local Schnorr slot returns
`#key_unavailable`. The IC's local-chain guidance documents ECDSA test-key
configuration, while the current [Solana/Ed25519 chain-fusion guide explicitly
notes that local Ed25519 threshold signing is unavailable](https://docs.internetcomputer.org/guides/chain-fusion/solana/).

The compile-only CLI is production-only; its legacy-named
`--vetkeys-environment` option, when supplied, accepts only `production` and
selects this compiler-owned map as well as vetKD. A manual local compile is
rejected because it has no authenticated PocketIC root context. Provisioner
targets select the matching map automatically during whole-canister
deployment.

The management API returns a 33-byte SEC1 public key for ECDSA and BIP340 and a
32-byte key for Ed25519. Neutron's app-facing response is normalized and
validated as follows:

- ECDSA secp256k1: compressed SEC1, exactly 33 bytes;
- BIP340 secp256k1: x-only key, exactly 32 bytes (the validated SEC1 prefix is
  removed);
- Ed25519: exactly 32 bytes.

The management response's chain code is discarded. `key_fingerprint` is a
domain-separated SHA-256 value over the algorithm and normalized public key;
it is display/equality evidence, not a substitute for signature verification.
Every successful V1 ECDSA, BIP340, or Ed25519 signature is validated as exactly
64 raw bytes before it is returned.

## App-facing Motoko leaf

```motoko
public type ChainKeyAlgorithmV1 = {
  #ecdsa_secp256k1;
  #schnorr_bip340secp256k1;
  #schnorr_ed25519;
};

public type ChainKeyMessageFormatV1 = { #neutron_app_assertion_v1 };

public type ChainKeyPublicKeyV1 = {
  slot : Text;
  algorithm : ChainKeyAlgorithmV1;
  public_key : Blob;
  key_fingerprint : Blob;
  signing_domain : Blob;
  namespace_version : Nat;
  message_format : ChainKeyMessageFormatV1;
};

public type ChainKeySignatureV1 = {
  slot : Text;
  algorithm : ChainKeyAlgorithmV1;
  digest : Blob;
  signature : Blob;
  signing_domain : Blob;
  message_format : ChainKeyMessageFormatV1;
};

public type ChainKeySigningErrorV1 = {
  #invalid_request;
  #not_declared;
  #disabled;
  #busy;
  #cost_too_high;
  #low_cycles;
  #key_unavailable;
  #management_failure;
  #outcome_unknown;
  #source_gone;
  #revoked_after_dispatch;
};

public type ChainKeySigningV1 = {
  public_key : Text -> async* {
    #ok : ChainKeyPublicKeyV1;
    #err : ChainKeySigningErrorV1;
  };
  sign_assertion : {
    slot : Text;
    assertion : Blob;
  } -> async* {
    #ok : ChainKeySignatureV1;
    #err : ChainKeySigningErrorV1;
  };
};
```

`public_key` and `sign_assertion` both repeat source-scope, current
installation, exact slot declaration/fingerprint, algorithm/key configuration,
and generic runtime-toggle checks. A response echoes the resolved slot,
algorithm, signing domain, and message format so a verifier does not need to
guess which contract produced it.

## Admission, cycles, and unknown outcomes

Before any await, signing validates the assertion and declaration, quotes the
current management-call cost, and acquires concurrency. A quote above 50
billion cycles returns `#cost_too_high`, and at least 250 billion cycles must
remain after attachment. Current pricing must come from the system cost
primitive, not a copied constant; the [IC cycle-cost reference](https://docs.internetcomputer.org/references/cycle-costs/)
is informative but can change with subnet configuration and protocol releases.

Limits are one in-flight signature per slot, two per app installation, and four
globally. The broker has no anchored-hour attempt counter. Management dispatch
still spends attached cycles on rejects, timeouts, malformed responses,
consensus failures, revocation, or ambiguous outcomes; this is visible in
canister balance and app usage telemetry rather than enforced as a
temporal capability budget.

Public-key dispatch has no hourly counter. A validated normalized public key is cached inside
the slot state; unchanged authority can serve the cache without another
management call. Cache identity includes the cryptographic namespace and exact
slot declaration, never the display purpose.

The management interface warns that a `SYS_UNKNOWN` or `CANISTER_ERROR`
signing reject may still have produced a signature. Neutron maps those cases to
`#outcome_unknown`, stores no guessed result, and never retries automatically.
Other management failures collapse to `#management_failure`; raw reject text is
not exposed or persisted. If the slot is revoked during the same await,
`#outcome_unknown` takes precedence over `#revoked_after_dispatch`: both return
no signature bytes, but the ambiguity is the stronger do-not-retry signal.

## Lifecycle, revocation, privacy, and audit

Each slot is a generic runtime resource keyed by exact
`(AppScope, #chain_key_signing, slot_id)`. A signing attempt captures an
irreversible registry epoch before dispatch. After the await, the broker
rechecks the app scope, exact declaration/identity fingerprint, and epoch. If
authority changed, it suppresses returned signature bytes and reports
`#revoked_after_dispatch`; the paid call and signature generation may already
have happened. The simultaneous ambiguous-management case retains
`#outcome_unknown` as described above.

An identical app upgrade retains owner-disabled state and public-key cache.
Narrowed or changed authority is unusable at
commit. A failed install leaves the old scope untouched. Successful uninstall
purges the old scope's slot state, cache, and bounded audit rows; a
reinstall receives a fresh app installation uid and therefore a fresh key.

The broker stores no assertion, digest, signature, management reject, or raw
public-key request. Generic audit retains only bounded resource id, operation,
outcome totals, and timestamps. Slot state contains declaration/identity
fingerprints and the public-key cache. Assertions are not
confidential: they originate in the app backend inside a replicated canister,
so subnet replicas can observe them before hashing. This capability provides
threshold custody and app isolation, not secret canister computation.

## Kitchen Sink and verification gates

Kitchen Sink declares one `ecdsa_secp256k1` slot named
`receipt_assertions`, fetches its real normalized public key, and signs a fixed
zero-value receipt assertion. The page shows bounded hexadecimal signing-domain,
digest, key-fingerprint, public-key, and signature evidence. An unavailable
key, low-cycle state, local-network limitation, management failure, revocation,
or ambiguous outcome remains an error; the page has no fallback or fabricated
success. It also rejects an unexpected authority binding, malformed evidence
length, non-compressed ECDSA key, or signature/public-key domain mismatch.

Required deterministic tests cover:

- exact manifest normalization, slot sorting, closed fields, and aggregate
  limits;
- namespace/domain/digest golden vectors and cross-canister, reinstall,
  cross-app, cross-slot, cross-algorithm, and key-name separation;
- ECDSA/BIP340/Ed25519 public-key normalization and malformed-key rejection;
- one-component derivation paths, fixed key names, and absence of raw signing,
  BIP341 aux, caller-chosen cycles, and management actors in app source;
- absence of temporal request/cycle counters, plus public-key cache,
  concurrency, low-cycle floor, and per-call quote ceiling;
- disable/re-enable, removal, uninstall, failed install rollback, stale-scope
  handles, and post-await revocation;
- definite failure versus unknown outcome, no
  automatic retry, and absence of sensitive payloads in state/audit;
- Kitchen Sink source/package assertions and, before release, real local ECDSA
  plus production public-key/signature verification and observed cycle spend.

## Deferred capabilities

V1 intentionally excludes arbitrary prehash/raw signing, direct transaction or
protocol encoders, child derivation paths, caller-selected master keys, batch
signing, BIP341 auxiliary data, delegated signing sessions, browser-held
signing material, automatic retries, and canister signatures. Typed transaction
adapters and `canister_signatures` are distinct future capabilities with their
own consent and lifecycle models.

See also the IC overview of [chain-key cryptography](https://docs.internetcomputer.org/concepts/chain-key-cryptography/)
and the authoritative [management-canister interface](https://docs.internetcomputer.org/references/ic-interface-spec/management-canister/).
