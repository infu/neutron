# vetKeys Isolation Fixture

This directory produces two deliberately narrow Neutron apps used to prove
installed-app vetKeys isolation. `vetkeys_fixture` and
`vetkeys_fixture_peer` both declare the slot id `mailbox`, but neither has
backend methods, stable memory, resident, tray, or a normal private-key export
path. The redaction gate described below adds one test-only loopback export
whose exact bytes cross only the Playwright evaluation boundary.

The focused tile can request the kernel-consented lifecycle reservation. Any
currently authorized Neutron principal can then list the slot, fetch public key
information, and run one encrypted derivation. The exact originating tile
automatically confirms its own source-bound challenge without another click,
focus check, transient activation, or consent dialog. The fixture verifies the
encrypted response and immediately discards its volatile private handle. It
displays only public fingerprint and binding evidence. Browser SDK requests
never contain an app id; the kernel derives `vetkeys_fixture` from the live
registered tile. The slot's `key_holder` is its lifecycle manager, not its only
reader, and tray endpoints cannot derive. A loopback-only proof surface also
lets the installed verifier submit malformed cross-app payloads and exchange a
challenge between the two real app frames without exposing private key bytes.

## Build and test

From the repository root in the pinned `nix develop` shell:

```sh
npm --workspace neutron-vetkeys-fixture test
```

The freshness assertion compares exact compressed archive bytes, so release
artifacts must be produced with that pinned Bun/zlib toolchain rather than an
arbitrary host Bun version.

The deterministic installable artifacts are:

```text
apps/vetkeys_fixture_test/vetkeys_fixture.v0.1.2.neutron
apps/vetkeys_fixture_test/vetkeys_fixture_peer.v0.1.2.neutron
```

They share compiled Motoko and web assets, but contain exact, distinct packaged
manifests, memory locks, method schemas, archive names, and app ids. The peer is
constructed in memory from `peer/neutron.json`; packaging never swaps or
rewrites the primary source manifest.

## Pinned browser-library vectors

The fixture also owns the offline compatibility gate for the official
`@dfinity/vetkeys` browser package. The package is pinned exactly to `0.4.0` and
the workspace lock must retain npm integrity
`sha512-MLa5UvseEOVB6HgcKYtIDOZc6De0tdRm61dZlmAVKKqjnZuXoUJqypDbMe30EnofH0JMjvGQP2jGvxGRKC6nGQ==`.
The canonical vector at
`test/vectors/vetkeys-browser-current-previous-v1.json` has SHA-256
`4a238085dd0fcf6d8222fbee00e5b69709aeec631480772d48d28869b18595ad`.

The two responses were captured from generations 2 (current) and 1 (previous) of
one disposable local Neutron's real Mail `mailbox` slot after one rotation. The
fixed transport secret in the file is public test material and must never be
used outside this known-answer test. The fixture replays no actor or network
call: it deserializes the exact real 192-byte encrypted responses and uses
`TransportSecretKey`, `DerivedPublicKey`, and
`EncryptedVetKey.decryptAndVerify` from the pinned package. It checks the exact
48-byte decrypted VetKey for both generations. Mutating either generation's
ciphertext, derived public key, derivation input, expected plaintext key, the
transport, or substituting one generation's ciphertext for the other must fail
closed.

Run the reproducible offline evidence gate from the repository root:

```sh
npm --workspace neutron-vetkeys-fixture run test:browser-vectors
sha256sum apps/vetkeys_fixture_test/test/vectors/vetkeys-browser-current-previous-v1.json
```

The capture provenance remains reproducible on a clean disposable local
Neutron with Mail installed. Use Mail's fail-closed UI preparation and capture
harness; both commands derive the loopback gateway and authorized developer
identity, while the mutating prepare step requires an exact canister
acknowledgement and capture requires the exact slot UID. The target comes only
from the selected PocketIC config's matching provision session. The repository
default is the current root `local.ndeploy.json` and can only reuse its
already-provisioned runtime; a fresh disposable capture must select a
separately named format-3 config and its schema-3 session:

```sh
npm --workspace neutron-mail run vetkeys:kat:prepare -- \
  --confirm-disposable <disposable-neutron-canister-id>

npm --workspace neutron-mail run vetkeys:kat:capture -- \
  --slot-uid <mail-slot-uid>
```

Pass `--config <CONFIG.ndeploy.json>` to both commands when using another
provisioned local config. Manual `--host` and `--canister-id` routing is not
supported. The selected config's developer identity must match the frozen Mail
KAT identity profile.

Any intentional replacement is a new reviewed golden vector: update the
canonical fixture document and its SHA-256 pin together, then rerun the focused
gate and the full fixture suite. A fresh capture is not silently accepted.

## Prove on PocketIC

The former fixture-owned networks and incremental bootstrap/install commands
are not a supported deployment path. Package the fixtures with the trusted
workflow and prepare a format-3 `CONFIG.ndeploy.json` containing their exact
archive pins. Run its supervised PocketIC server and whole-canister
`reinstall`, then use the primary canister and gateway printed by
`neutron-provision CONFIG.ndeploy.json status` for the proof commands below.
The config-derived `CONFIG.ndeploy.session.json` remains the sole source of
local runtime state.

## Install on a local Neutron

Package this app, publish its exact path/digest/length/id/version pin into the
selected deployment artifact set, and run the provisioner's whole-canister
reinstall:

```sh
npm --workspace neutron-vetkeys-fixture run package
npm run provision -- CONFIG.ndeploy.json reinstall
npm run provision -- CONFIG.ndeploy.json status
```

Open both fixture tiles and reserve each `mailbox` slot through Neutron's
trusted lifecycle dialog. Then compare the actual installed slot bindings and
full public roots:

```sh
npm --workspace neutron-vetkeys-fixture run compare:installed
```

The verifier uses the developer identity from the selected format-3 deployment
config and its matching schema-3 session; it has no identity-seed override.

The verifier rejects non-loopback hosts and any kernel not explicitly configured
for local vetKeys. It requires both slots to be enabled on `test_key_1`, verifies
that each public fingerprint is SHA-256 of its full public key, and proves that
the two real fixture apps have distinct never-reused slot UIDs, public keys,
fingerprints, and public derivation inputs. The derivation input is not the
kernel's persisted namespace nonce.

For the installed browser-origin adversarial proof, run:

```sh
npm --workspace neutron-vetkeys-fixture run prove:installed
```

On a fresh dual install, this opens both actual app frames and reserves each
missing slot through its real tile button and the exact kernel-owned lifecycle
dialog. It then proves that injected `appId` fields cannot
list, fetch, derive, enable, disable, rotate, retire a generation, transfer the
lifecycle manager, or retire the peer slot in either direction. After each
direction it verifies that no trusted lifecycle dialog opened and that neither
installed binding nor public root changed. It also confirms that one app cannot
consume the other's challenge, and then completes an encrypted derivation from
each exact originating frame. It fails rather than skips when an archive, slot,
environment, key name, local login hook, launcher tile, or browser prerequisite
is absent. It returns only public evidence and immediately discards each
verified volatile key handle.

Do not use this verifier against production: its deterministic identity and
root-key fetch are specifically for a local replica.

## Prove installed redaction

The redaction runner stops the canister briefly and takes a
management-canister snapshot, so it still refuses to run unless
`--confirm-disposable` exactly matches the session canister ID. Its old private
network/bootstrap recipe has been removed; only run it against a
disposable target created by the provisioner workflow above.

The redaction-only probe runs through the real installed, source-bound browser
broker. Its success path uses recognizable caller transport secret/public
key/hash, request nonce, challenge id, 192-byte encrypted response, 48-byte
derived private key, and app plaintext. Its failure path submits a recognizable
invalid 48-byte transport point and verifies that the installed browser sees
only canonical `management_failure`. Those exact values are scanned in raw,
hex, base64/base64url, JSON-array, decimal-CSV, and applicable UTF-16 forms
across:

- trusted Settings HTML and exact controller admin/audit projections;
- every accessible frame document, local/session storage, IndexedDB,
  CacheStorage, and Playwright context storage state;
- captured console, page, request-failure, and canonical error text;
- complete raw and decoded Wasm module, live Wasm memory, stable memory, Wasm
  chunk store, snapshot metadata, and canister logs.

The report prints lengths and SHA-256 hashes, never the captured private bytes.
The intentionally public derivation input, public key, and fingerprint are
allowlisted and reported separately. The internal random namespace nonce is
intentionally durable slot metadata, but the runner confirms that neither the
admin nor Settings projection exposes it.

There are two important proof boundaries. Values that necessarily transit the
Motoko backend can remain in the live Wasm heap until garbage collection; the
runner reports any exact transport public key, encrypted response, invalid
public point, or raw reject found there instead of falsely calling that heap
redacted. It still requires browser-only secrets, transport-key hash, request
nonces, challenge ids, derived private key, and app plaintext to be absent from
that live heap, and requires every sentinel to be absent from stable memory,
Settings, audit, logs, errors, and browser persistence. Also, PocketIC does not
expose the adapter's exact internal reject text to the installed browser. The
gate triggers the real reject, pins the known diagnostic text as a sentinel,
and proves canonicalization, but cannot claim observation of an otherwise
unobservable internal string without adding a production backdoor.

## Lifecycle coverage

Local app deployment is intentionally not a fixture operation. The only local
deployment path is the provisioner's whole-canister `reinstall`, so this
workspace has no helper that incrementally installs or uninstalls a package on
the running development Neutron.

The focused unit suite still builds compatible, declaration-removed, and
declaration-restored package variants entirely in memory. It checks their
identity/version invariants and the fresh-context rules for active and restored
lineages. Kernel Motoko and compiler tests cover checked install-journal commit,
abort, manifest suspension, uninstall, and stable-state behavior. Installed
origin/isolation behavior remains browser-tested against fixture packages that
were emitted by the trusted package workflow, exactly pinned in a format-3
artifact set, and installed by the provisioner workflow above.
