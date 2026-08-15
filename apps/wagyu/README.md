# Wagyu

Wagyu is Neutron's certified peer-to-peer social app. Each Neutron canister is
one Wagyu node and one protocol identity. Nodes exchange compact, paid action
references; the browser fetches the referenced immutable object and verifies
its IC certificate, HTTP witness, path, exact Candid bytes, and protocol
bindings before rendering it.

The normative product, protocol, security, storage, economics, and release
contract is [spec.md](spec.md). Code and tests must follow that document rather
than treating this README as a second protocol definition.

> **Release status:** v0.3.2 is the current limited-release candidate. Its
> app-level audit stop-ships are remediated, but it is not eligible for a public
> production launch until the shared Kernel certified-asset implementation has
> measured, release-bound production and browser/gateway evidence. See
> [Production gate](#production-gate).

## Architecture

Wagyu is push-based. It does not periodically ask peers for new content:

```text
sender certifies an immutable object
  -> sender durably queues and pays for a compact push
  -> receiver admits and quarantines the exact candidate
  -> browser Worker fetches and verifies the referenced object
  -> a verified candidate may be promoted and rendered
```

The backend binds the immediate caller, payment, relationship policy, bounds,
deduplication, and durable local state. It deliberately performs no remote IC
certificate or HTTP-witness verification. A paid receiver acknowledgement is
therefore admission evidence, not proof that remote content is valid or was
displayed.

The resident may refresh bounded status from its own Wagyu backend and advance
the durable outbound queue. Those local recovery reads are not peer polling.
For Follow liveness, each first durable promotion of a browser-verified
delivery advances a sparse local counter for that exact subscription. The 28th
promotion directly attempts to queue renewal while a nominal four of the
initial 32 remote delivery credits remain; day 350 is the resident-scan
fallback. Automatic Follow dispatch revalidates the current generation,
subscription, pending link, registering status, and Block state, superseding
stale work before cycles are attached. Each renewal grants only the room
remaining under the combined 128-credit cap.
Peer renewal hints remain diagnostic and cannot authorize the owner's cycles.
Accepted or duplicate renewal anchors use the operation's write-once first
local dispatch-start time, not callback time or the peer-returned receipt
epoch; failures preserve the prior paid anchor.

Owner UI calls use Neutron's single API-1 `querySelf`/`updateSelf` path.
Profile avatar bytes, exact certified references, proof Candid, and returned
page bodies are normal nested `Blob` fields represented as `Uint8Array`; there
is no API-2 self-call, positional attachment argument, or app-local generated
alias repair step.

Fresh installation receives
`AppBackendEnvironment.installation.network_id`, a compiler-owned 32-byte
identity derived from the exact trusted IC/PocketIC root-key SPKI DER and
persisted immutably by the generated actor. Wagyu validates it before any
ordinary app operation. A fresh profile path remains absent; local owner reads
project a revision-zero default, and the owner's first edit creates revision
one. Lazy context binding is allowed only over exact pristine managed memory.
No install-only initializer, provisional zero-network profile, or owner
configuration transaction is used.

### Surfaces

- `main` is the owner-facing feed, composer, profiles, relationships,
  notifications, and likes tile.
- `service` coordinates local revision invalidations, verified-object caches,
  tray state, on-demand verification, bounded outbox progress, and the
  kernel-authorized cross-app tool surface while the resident is present.
- `tray` shows the recent local notification list and unread badge. It has no
  outbox, feed statistics, or delivery controls and never fetches peers.
- `verification-worker` is a standalone same-origin module Worker used by the
  resident for profile, feed, and Like-package verification.

The local backend is the canonical store for authored objects, relationships,
delivery candidates, notification summaries, reaction receipts, deduplication,
and durable outbox state. Browser persistence is only a rebuildable cache.
Remote bytes remain quarantined until frontend verification succeeds.

The resident exposes bounded tools for profiles, Home, authored posts, direct
threads, Likes, relationships, post, reply, Like, Share, Follow, and Unfollow.
They call the same owner adapter and persistent verification Worker as the UI.
Read tools release only verified peer text, label it `external_untrusted`, and
return short-lived opaque post targets; mutation tools never accept
model-assembled proof fields or raw post locators.

## Verification Worker

The Worker receives trusted runtime configuration from the local
kernel-authored runtime file. It derives the network ID from that root, checks
the supplied expected network ID, accepts one initialization only, and refuses
blob, data, or cross-origin Worker URLs. The resident CSP permits only a
same-origin Worker and the configured IC or local-development gateways.

Every peer fetch is an anonymous fixed-route `GET` with credentials omitted and
redirects rejected. Before returning content, the verifier checks:

1. the V2 IC certificate and delegation against the trusted root and expected
   serving canister;
2. the HTTP witness, expression path, method, status, frozen headers, body
   length, and raw SHA-256 digest;
3. the fixed Wagyu path and content-addressed action kind;
4. the exact received Candid bytes and their protocol bindings; and
5. freshness plus generation/revision high-water rules for mutable profiles
   and Like heads.

Only a terminal `verified` result releases decoded remote content to the UI.
Live transport, HTTP, proof, and cryptographic failures remain retryable
`unavailable`; they never authorize deletion. A cryptographically established
semantic `invalid` result is removed atomically from candidate state.

The feed verifier handles originals, shares, direct tombstones, reply parents,
and relayed tombstones. A relayed tombstone requires exact bounded
share-delivery Candid evidence, either provided with the request or loaded from
the resident cache, and cryptographically re-verifies it. Metadata-only hints
and cached booleans are never authority. One claimed `(author, post_id)` slot
admits at most 64 candidates and uses a direct slot index; promotion therefore
never scans the global feed store. Post retries likewise use a durable direct
nonce-to-post index instead of scanning authored history.

Feed and notification queries return at most 25 and 50 items respectively and
examine at most 256 ordered rows. An all-blocked window returns an empty page
with the last examined sequence as its continuation, preserving forward
progress without unbounded query work.

Like verification walks at most two sealed packages per request, checks up to
150 receipts per package with nested liker proofs, rejects duplicate likers,
and caps receipt verification concurrency at 12. A bounded-chain result returns an opaque
Worker-bound continuation when more packages remain; the continuation retains
the exact verified-head anchor plus cross-page cycle and duplicate state.
The drawer exposes that continuation as “Load older Like packages” while
retaining already verified pages and any retryable unavailable boundary.

Successful browser verification of a Like arms one 60-second app-scoped
`like_seal` timer. Additional verified Likes reuse that key without delaying
it. The one-shot callback certifies at most eight due Like packages, with each
bounded search examining at most 200 authored posts. For a selected post, it
gives a ready 150-receipt segment priority; otherwise it can publish the
current 1–149 browser-verified receipts as an immutable partial package while
the post remains open. The frozen V1 field
`final_partial` therefore marks a partial-sized package in V101, not a closed
post. The mutable head advances by CAS in the same `certified_assets` commit.
A daily scheduled pass remains only for bounded recovery and maintenance.

The bounded authored-page projection includes owner-local, post-bound unsealed
counts and liker IDs only after exact browser verification has admitted them
to the sealable set. Pending quarantine appears only as a pending notification.
Neither local state is added to the public sealed total or fabricated as a
sealed receipt row. Remote nodes cannot infer pending or unsealed work from the
certified head.

Persistent background verification uses app-isolated IndexedDB for at most
8,192 mutable high-water records and 4,096 small derived-result records.
High-water compare-and-write is atomic across tabs and fails closed at capacity;
it is not silently evicted. Immutable HTTP responses may use a 256-entry
CacheStorage transport cache, but every cache hit still traverses the complete
verifier and optional persistence never delays an already verified result.
Raw Candid is structurally bounded before decode. HTTP witnesses are traversed
iteratively under encoded-byte, total-node, and embedded-blob budgets; tree
depth is not a content-count quota. Endpoint-bound cancellation frees Worker
slots and cache leases. None of these caches replaces canonical backend state.

## Build and validation

The direct commands below avoid depending on repository-wide npm workspace
discovery. Run the focused checks from `apps/wagyu`:

```sh
cd apps/wagyu
bun run typecheck
bun test test
bun test/motoko/run.ts
```

`bun test test` scopes Bun discovery to the app-local TypeScript tests. The
Motoko runner discovers every app-local `*_test.mo` or `*.test.mo`, compiles
each with the vendored Motoko Wasm compiler, and executes its WASI output.
`main_compile_test.mo` is compile-only because a fresh Wagyu installation reads
the system clock, which the WASI test target does not provide.

Build and package with the shared Neutron scripts, still from `apps/wagyu`:

```sh
bun ../../packages/neutron-scripts/src/validate.ts
bun build.ts
bun ../../packages/neutron-scripts/src/mogen.ts
bun ../../packages/neutron-scripts/src/mopack.ts
bun ../../packages/neutron-scripts/src/method_schema.ts
bun ../../packages/neutron-scripts/src/pack.ts
```

This is the same logical pipeline as:

```text
validate -> frontend build + mogen -> mopack -> schema -> pack
```

The six-method public protocol and normalized 20-method binary owner bridge have
separate checked-in DIDs. The manifest independently freezes all 32 approved
API-1 self calls and their query/update modes. Regenerate the reviewed
JavaScript/TypeScript bindings explicitly with:

```sh
./scripts/generate-candid-bindings.sh
```

That command invokes `didc` directly and is a source-maintenance step. It is
not a package hook, provisioning extension, or runtime installer script.

Once both package artifacts exist, the whole-canister compiler integration can
be checked from the repository root:

```sh
bun packages/neutron-cli/src/index.ts compile \
  --package apps/kernel/kernel.v0.3.7.neutron \
  --package apps/wagyu/wagyu.v0.3.2.neutron \
  --wasm-out /tmp/neutron-wagyu.wasm \
  --candid-out /tmp/neutron-wagyu.did
```

That offline check uses the compiler-pinned production context. A trusted local
actor can be compiled only by the provisioner attached to the exact PocketIC
root.

`bun build.ts watch` rebuilds browser assets only. It does not regenerate
Motoko method metadata, package the app, or provision a Neutron.

The browser build emits self-contained ESM bundles for `main`, `service`,
`tray`, and `verification-worker`, compiles Sass, and copies `public` into
`dist/web`. Local deployment is owned by the repository's whole-canister
provision workflow.

### Canonical three-node local fleet

[`../../wagyu-local.ndeploy.json`](../../wagyu-local.ndeploy.json) is the
tracked `alpha`, `bravo`, `charlie` desired state. For PocketIC developer
iteration it names local kernel and Wagyu archive paths only; the provisioner
derives hashes, sizes, ids, and versions at invocation time. No generated
helper, repair script, package extension, or hand-maintained digest is
required. Production/external artifact sets remain exactly pinned.

```sh
npm run provision -- wagyu-local.ndeploy.json serve
npm run provision -- wagyu-local.ndeploy.json reinstall
npm run provision -- wagyu-local.ndeploy.json status
```

The local fleet is preproduction and uses the destructive `reinstall` path.
The current package keeps memory schema V3 and does not import older
development state whose accepted Like rows lack durable browser-verification
evidence. A fresh install starts the bounded local verified-delivery renewal
counter empty.

`status` prints the three labeled URLs. A temporary browser principal may be
granted fleet-wide with:

```sh
npm run provision -- wagyu-local.ndeploy.json authorize PRINCIPAL
```

## Production gate

The remaining shared launch blocker is measurement, not a Wagyu-specific
storage mode. The Kernel has a neutral synthetic profile/fixture and a
deterministic candidate-binding generator/schema, but a generated binding is
not evidence. The repository has no production runner, evidence schema/file,
or recorded
release-bound results for the maximum-state resource, browser/gateway, and
hostile-gateway envelope.

Local unit tests, package checks, and a three-node PocketIC run are development
evidence only. The exact Kernel release must be measured and recorded before a
public production claim. Wagyu owns no separate app-suite qualification or
waiver. See [wagyu.review.md](wagyu.review.md) and the shared
[qualification status](../../doc/kernel-http-v2-and-certified-assets.md#qualification-status).
