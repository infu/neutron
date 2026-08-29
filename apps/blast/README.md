# Blast

Blast is a headless Neutron app that exposes bounded canister, script, run, and
browser-local collection tools to installed Neutron agents. It uses ICBlast's
JSON API for canister discovery and calls. Discovered Candid is compiled in the
browser with ICBlast's packaged Wasm inside a disposable Worker. Cancellation
or the canister-operation deadline terminates that Worker, including synchronous
Wasm conversion; Blast does not use a conversion canister or an MCP transport.

Saved script source and bounded metadata are the only Blast data retained in
managed backend memory. Local identity keys, fetched pages, derived
collections, runs, and checkpoints remain in IndexedDB at the app's isolated
resident-browser origin. Browser-local data can be evicted or cleared by the
browser or owner. Blast does not synchronize this state across browsers or
devices and has no dedicated full-fidelity backup or archive-export workflow.
Authorized tools can read bounded collection data, but fetched collections
should still be treated as a re-creatable local cache.

The Blast-local identity is durable only within the current Neutron
installation, browser profile, and retained site data. Clearing site data,
uninstalling or reinstalling Blast, or moving to another device can create a
different identity; agents should compare the exposed principal/fingerprint
when continuity matters. Discovery and local calls use this distinct principal,
which target canisters can observe, and do not open a Kernel consent dialog.

Blast has no tile or tray. Its resident registers the complete tool surface
when the owner is logged in and authorized. Agent-written JavaScript runs in a
killable QuickJS Worker with only Blast's bounded JSON host functions. Its guest
heap and containing Wasm linear memory are independently hard-bounded.

## Tool Surface

- Canister tools: `blast.identity`, `blast.scan`, `blast.schema`,
  `blast.validate_input`, `blast.query`, and `blast.update`.
- Script and run tools: `script.list`, `script.get`, `script.save`,
  `script.delete`, `script.evaluate`, `script.run`, `run.list`, `run.get`, and
  `run.delete`. Deleting a terminal run with unresolved update evidence
  requires explicit acknowledgment.
- Collection and storage tools: `collection.list`, `collection.describe`,
  `collection.query`, `collection.delete`, and `storage.status`. Scripts can
  stream nested JSON pages into raw or derived collections; JSONata queries one
  bounded page batch at a time.

Canister discovery and call tools accept ordinary IC canister principals. The
management canister is deliberately excluded from every Blast call route.
Blast's independent local identity may call public methods on the hosting
Neutron canister. Kernel identity may not target that canister through Blast:
same-Neutron owner calls require the Kernel's separate private self-call
transport, so Blast rejects that combination before capability negotiation.

For collection-wide analysis, inspect one stored page with
`collection.describe` before writing code that assumes a row path. A stored
page value may be an array of rows, but it may also contain a more deeply
nested canister response. Inside a script, `collections.pages(id)` is a lazy
async iterable of those stored page values—not individual rows—and follows its
internal continuation while the run remains within its read budget. A finite
`collections.pages(id, { limit })` limit counts total yielded pages and stops
without returning its continuation. For resumable work,
`collections.readPages(id, { cursor, limit })` returns one bounded
`{ values, nextCursor }` batch so a script can return its partial aggregate and
cursor, then a later run can resume. A prior `collection.describe` inspection
does not consume pages or initialize the script cursor.
Only a null cursor from the direct paginated tools proves their traversal has
reached its current end; page length and collection counts are not completion
signals. Collection and run catalogues are weakly consistent: if entries may be
created or deleted during a pass, restart from a null cursor afterward for a
fresh pass.

Process large collections incrementally. Scripts should put large transformed
data into a derived collection, close every collection they create, and return
only a compact collection id and summary counts. `collections.create()` returns
the created collection record; pass its `id` to `collections.putPage()`,
`collections.append()`, `collections.complete()`, or `collections.fail()`.
`putPage(id, key, value)` appends a raw page with a required idempotency key;
the same key and canonical value replay safely while writable, but another
value conflicts. `append(id, value, key?)` writes a derived page. Without a key
it is at-least-once and can duplicate on retry, so pass a key when replay safety
is required. A raw collection may declare external `source`; a derived
collection may declare `sourceCollectionIds`. Those fields are script-declared
provenance, not proof that pages came from the declared source. Blast binds the
producing saved-script revision and local identity separately.
Returning or accumulating the whole collection can exceed the bounded host or
script-result envelope even when every individual stored page is valid. The
live tool descriptions and schemas carry the enforced limits and a copyable
streaming example.

Local identity is the default. Its calls rediscover the interface and enforce
the live method mode. Kernel identity is available only on the direct
`blast.update` tool through the generic signed-call route. That route does not
accept or enforce an expected method mode and does not return a mode
attestation, so an earlier scan or schema response can race with the call.
Blast therefore treats it conservatively as an update and rejects Kernel
identity on `blast.query`.

Blast inspects the live Kernel tool descriptors before any Kernel-identity
dispatch. It prefers the v2 signed-call route. Outside Agent Mode only, an older
Kernel without that route may use the unversioned compatibility route; owner
consent and the Kernel identity remain in force, but its dialog reviews
pre-conversion JSON and it lacks v2's canonical prepared-argument review and
phase-aware cancellation. Agent Mode always requires v2 and fails before the
signed call when it is unavailable.

Outside a validated Agent Mode invocation, a Kernel-identity update opens the
owner dialog; inside one it follows the current nested-agent policy. Blast never
receives the Kernel key. The v2 route can cancel pending and pre-dispatch work,
but no route can roll back an update after dispatch. Cancellation on the legacy
ordinary fallback cannot prove that a pending call stopped, so treat it as an
unknown non-retry-safe outcome. Scripts use only Blast's local identity, so they
never own interactive Kernel consent. Local script updates can still have an
unknown post-dispatch outcome, which remains non-retry-safe.

Local direct and script update routes accept live Candid update and oneway
methods. A confirmed oneway call means only that dispatch was accepted: it has
no execution result and is never safe to retry automatically. Active runs and
their latest checkpoints are retained locally. Terminal history without
unresolved update evidence is pruned within a fixed bound; evidence-bearing
runs remain until an agent inspects and explicitly deletes them with
`run.delete`, and Blast reports capacity instead of silently discarding that
evidence.

After consuming a confirmed `blast.update` response inside a script, issue a
`run.checkpoint` before another update or normal return. The checkpoint records
which confirmed responses the guest observed and lets Blast settle their
durable evidence. An update whose dispatch remains unknown cannot be settled by
a later checkpoint; it remains visible and non-retry-safe. The live source
schema includes a copyable update-then-checkpoint sequence, and
`pendingUpdateCount` reports unresolved attempts.

`result_too_large` means a complete canister value fit Blast's processing limit
but not a direct tool reply. A local query may be repeated inside a script to
process or store that value. Plan a large local update to run inside a script
from the outset; never repeat an already dispatched direct update merely to
recover its omitted result. Kernel-identity updates have no script recovery
route.
`result_exceeds_processing_limit` means the value exceeded Blast's absolute
limit and was discarded, including inside scripts. Recover that case with the
canister's own pagination or narrower call arguments, not by repeating the
same unbounded call.

Saved-script mutations never turn a cancelled, timed-out, disconnected, or
malformed update reply into a retryable operation. When the transport can
still return it, Blast supplies a bounded `outcome_unknown` result with
`retrySafe: false`; caller cancellation can withhold that result and must be
treated the same way. Replacements and deletes are reconciled by re-reading the
exact script id, while creates are reconciled by paging the catalogue and
comparing every field in the returned `reconciliation.match` object. An
identical older script can also match that create evidence, so a lost create
reply must never be retried blindly.

Page through `script.list` by passing each `nextCursor` unchanged until null.
Any save or delete makes an older cursor stale; discard that partial pass and
restart with a null cursor. Saving source does not execute it, but running a
saved script can perform its declared network and write effects.

After a cancelled or timed-out script, or a lost terminal reply, inspect
`run.list` and `run.get` before deciding what happened; never rerun arbitrary
source automatically. Cleanup is deliberately non-cascading: `script.delete`
does not delete prior runs or collections, `run.delete` does not delete output
collections or saved source, and `collection.delete` does not delete run
records. Inspect running runs before deleting their input or output collections.

Run the source, package, Worker, backend, and memory checks from the repository
root:

```sh
npm --workspace neutron-blast test
```

The release gate also installs the packaged Kernel, Agent, Blast, and a
disposable qualification-only Agent Mode driver into a fresh private PocketIC,
then drives the real installed resident MessagePorts in isolated browser
profiles. It never attaches to the normal development gateway or publishes the
temporary driver:

```sh
npm --workspace neutron-blast run verify:release
```
