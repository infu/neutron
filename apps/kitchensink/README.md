# Kitchen Sink capability lab

Kitchen Sink is Neutron's executable app-developer reference. It deliberately
declares the current closed manifest capabilities and gives each one a focused page
with a real operation, exact evidence, failure state, and security-boundary
disclosure. It is a high-authority development app, not a production starter
template.

The primary tile uses grouped, hash-addressable navigation. The companion tile
shares one managed backend counter without polling. A resident background owns
the tray popout demo, persistent-origin demo, provider connection flow, agent
entrypoint, and background-initiated permission example.

## Capability pages

| Capability | Live demonstration | State |
| --- | --- | --- |
| `backend_calls` | Review an exact `icrc1_fee` reservation, attach one million cycles within the installed financial ceilings, and read the ICP ledger fee in one flow. | Implemented; a destination that retains no cycles refunds them, and the durable reservation remains if the probe fails. |
| `https_outcalls` | Run a paid, replicated GET or HEAD against the exact `https://example.com/` prefix and inspect the bounded status/body result. | Development implementation; PocketIC may lack an HTTPS adapter and a live call can fail without fabricating success. |
| `randomness` | Fetch one app-scoped 32-byte consensus seed. | Implemented; concurrency and low-cycle safety remain, with no hourly request limit. |
| `chain_key_signing` | Fetch the app-installation public key and sign one fixed, harmless receipt assertion while showing the domain, digest, fingerprint, key, and signature evidence. | Development implementation; the page reports an unavailable local key or management failure honestly and never fabricates or retries a signature. |
| `vetkeys` | Encrypt a local plaintext with the public IBE key, derive the challenge-bound private key, verify local decrypt, and exercise current/previous-generation lifecycle controls. | Implemented; private key bytes are never rendered or stored, and local use requires the vetKD bootstrap. |
| `scheduled_tasks` | Watch the dedicated run count and last counter value under the run-on-start, daily callback. | Implemented; V1 intentionally has no manual run API. |
| `stable_store` | Create UTF-8 notes only when absent, load revisions, compare-and-swap updates/deletes, scan live two-record prefix pages, inspect logical usage, and clear two matching records at a time. | Development implementation; maximum-state upgrade, heap-reuse, instruction, and cycle benchmarks remain release gates. |
| `preapproved_self_calls` | Compare preapproved counter calls with a normal reviewed `echo`. | Implemented. |
| `agent_entrypoints` | Enable Agent Mode for `capability_agent_demo`, then run one deterministic scoped nested tool call. | Implemented; no model is simulated. |
| `background_ui_requests` | Have the resident request either a foreign app's zero-input read tool or its declared OpenRouter connection through normal kernel UI. | Implemented; the tool path needs a connected peer, while the connection path reuses an active connection or opens trusted setup. |
| `ethereum_provider` | Connect an EIP-1193 provider, read `eth_chainId`, require mainnet, and request accounts once. | Implemented; needs a browser wallet. |
| `connections` | Connect OpenRouter in the resident and prove credential delivery without returning the credential. | Credentials are available only to the exact resident background. |
| `persistent_browser_storage` | Write, read, and clear a bounded resident `localStorage` value. | Origin isolation is implemented; explicit quota and orphan cleanup policy remain open. |
| `public_ingress` | Call the public `demo_v1:status` query through its compiler-generated dispatcher and inspect the stable nested-Candid result. | Implemented; `caller: "any"` is intentional for this harmless status fixture. |
| Certified reads | Inspect the Host-bound publication route and portable blob route synthesized from the declared collection kinds. | Derived from Certified Assets; methods, authority, headers, cache/CORS policy, and certified absence are kernel-owned. |
| `certified_assets` | Stage and commit an opaque publication, stage a content-addressed immutable blob, and create/replace one keyed mutable blob by exact CAS. | API 2 fixture; public bytes and mutation-attributed storage/cycles are disclosed. |
| Derived composition | Call the exact `contacts_neutron_revision_v2` export through the typed `app_calls.contacts` leaf, then inspect ordered `caller`, `canister_principal`, and `memory_kitchensink` function-resource injection. | Implemented; the UI receives values returned by live read-only backend queries, never raw handles or memory references. |

The `certified_assets` API-2 storage fixture intentionally declares all three
closed collection kinds in one installation-scoped engine. `publication_demo` stages
an opaque publication beneath
`/app/kitchensink/_route/publication_demo/<publication-id>/message.txt` on the
exact ordinary Neutron Host. `immutable_blob_demo` stages bytes whose SHA-256
becomes the final segment beneath
`/app/kitchensink/_route/blob_demo/v1/immutable/`. `mutable_blob_demo` writes
one inline Candid value at
`/app/kitchensink/_route/blob_demo/v1/mutable/<key32>` using exact
revision/content-tag CAS. The app receives typed targets and CAS identities,
never raw paths, headers, another app's records, or `setCertifiedData`.

There is no authored certified-read route object. The Kernel groups
collections by mount and synthesizes the publication `GET`/`HEAD` policy and
the portable blob `GET` policy from their kinds. API-1 HTTP routes remain the
independent bounded POST-handler capability.

Secondary pages cover managed memory, live method schemas, message-bus
endpoints, tray state, dense data, and the shared design system. Roadmap-only
capabilities are not represented as working buttons.

The Composition page demonstrates three compiler-derived capabilities rather
than a second permission object. Contacts publishes one exact internal method
through its `app_exports` projection; Kitchen Sink names only that method in its
dependency, so its `app_calls.contacts` handle has no other Contacts authority.
The snapshot query separately proves the exact ordered `function_resources`
projection by returning the injected wrapper caller, Neutron canister principal,
and counter read through Kitchen Sink's own stable-memory namespace.

The managed-memory page links the compiler lifecycle invariant suite instead
of pretending that a sandboxed tile can upgrade or uninstall its containing
actor. Local apps enter a running Neutron only through the provisioner's full
config and whole-canister reinstall; checked in-product update behavior remains
covered by the compiler and Kernel suites.

The public-ingress query uses
`app_kitchensink__demo_v1_query`. Its outer request is
`{ method = "status"; payload = to_candid (ExactInput) }`; the `#ok` blob is
the exact `public_status` output Candid. The ordinary `public_status` method
remains owner-authorized—only the declared route is public.

`npm run test:e2e:kitchensink` executes the actual external transports: the
anonymous physical public-ingress dispatcher (including an unknown-route
failure), a staged publication plus certified GET/HEAD, a staged immutable
blob, two inline mutable-blob writes that exercise create and CAS, and the
daily task's committed run-on-start marker. These checks do not replace the
kernel's maximum-state and hostile-gateway release gates.

The HTTPS-outcall fixture deliberately targets the reserved Example Domain,
uses no credentials or private data, and exposes both GET and HEAD. Its backend
receives only the scoped `HttpsOutcallsV1` leaf: it cannot choose another host,
attach cycles, retain response headers, select a transform, or reach the
management actor. The page reports real local/mainnet adapter, per-call cost,
consensus, concurrency, and revocation failures. HTTPS outcalls provide integrity through
replicated execution but no confidentiality from subnet replicas.

The chain-key fixture uses only the `receipt_assertions` ECDSA slot. Its backend
can ask for that slot's public key or submit an assertion blob; it cannot choose
a master key, derivation path, raw digest, transaction, attached cycle amount,
or retry policy. Neutron constructs the installation-bound namespace and
domain-separated SHA-256 digest. The fixed zero-value receipt is intentionally
harmless. Local ECDSA expects `dfx_test_key`; local Schnorr is deliberately
reported as unavailable, with no production-key fallback.
An external verifier can still assign authority to a signed assertion; this
fixture does not turn install approval into one-shot transaction consent.
The page rejects unexpected slot/algorithm/format/version bindings, wrong
key/digest/signature lengths, and a signature domain that differs from the
fetched public-key domain.

The Stable Store fixture declares one 24-entry, 32 KiB `notes` namespace and
wraps its binary key/value API in UTF-8 text methods. A read at revision 7 can
be replaced only by a compare-and-swap expecting revision 7; if another writer
has already produced revision 8, the stale write reports the current revision
instead of losing it. Prefix pages are live rather than snapshots and carry a
logical continuation, never a stable-memory pointer. `usage()` is the only live
entries/bytes/over-quota view; Settings shows the declaration, toggle, and
generic outcome counters. The store is plaintext to canister subnet replicas,
not encrypted or certified, and uninstall/reinstall creates a fresh namespace.
Stable Store has no write-frequency window; quotas, CAS, operation bounds, and
the low-cycle reserve remain. Chain-key signing and vetKeys likewise have no
hourly request limits. Kernel Settings measures Kitchen Sink update, scheduled,
and public-handler instruction use independently of these capability controls.

## Resident tools

The resident service exposes strict, bounded tools:

- `capability_agent_demo`
- `capability_background_ui`
- `capability_storage_status`, `capability_storage_write`, `capability_storage_clear`
- `capability_connection_status`, `capability_connection_connect`, `capability_connection_disconnect`
- `tray_demo_snapshot`, `tray_demo_add`, `tray_demo_mark_read`, `tray_demo_mark_all_read`

Capability controls require a kernel-attested Kitchen Sink tile caller. The
OpenRouter credential is acquired only in the resident, reduced to a delivery
boolean, cleared immediately, and never returned or logged. Nested agent and
background calls use the handler's scoped `context.kernel`; they cannot bypass
the kernel permission model through an unscoped global client.

Tray mutations capture their committed revision before publishing an
invalidation. Tile consumers accept every non-regressing revision while request
sequence numbers suppress only stale errors, so an older in-flight snapshot
cannot replace newer state. The companion refreshes
on app-state invalidation, window focus, and explicit owner action—never on a
timer.

## Build and test

From the repository root:

```sh
npm install
npm --workspace neutron-kitchensink test
npm run test:e2e:kitchensink
```

The package build emits self-contained `main`, `service`, and `tray` web
assets, generated Motoko modules, the method-schema artifact, and
`kitchensink.v0.3.4.neutron`. The backend selects only the exact capability leaf
interfaces from `mo:neutron-capabilities`: backend calls, HTTPS outcalls,
randomness, chain-key assertion signing, `CertifiedAssetsV2`, and Stable Store.
It never receives a universal kernel capability object.
