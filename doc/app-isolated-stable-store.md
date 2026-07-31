# App-Isolated Stable Store V1

Status: **development implementation** (2026-07-18). The closed manifest,
compiler-selected Motoko leaf, kernel-owned store, install/Settings surfaces,
and Kitchen Sink demonstration are implemented in the development baseline.
Maximum-state upgrade, garbage-collection reuse, and sustained instruction and
cycle measurements remain release gates.

## Decision

`stable_store` is a bounded, app-installation-scoped binary key/value store. It
is for dynamic records that do not fit naturally in one compile-time managed
memory schema. It does not expose a Motoko `Region`, a stable-memory address,
an offset, a page allocator, the kernel's map, or another app's storage.

The kernel owns the physical store and derives its namespace from the exact
installed app scope. App code can:

- read one binary key;
- create or replace one bounded binary value, optionally with a revision
  condition;
- revision-check and delete one key;
- walk one binary prefix through bounded live pages;
- inspect bounded logical usage; and
- delete at most one bounded page beneath a prefix.

The value is opaque to the kernel. `schema_version` labels the version that
wrote each entry; the app, not the kernel, interprets and migrates its bytes.
There are no cross-store joins, transactions, indexes, query languages, raw
pointers, or kernel-authored value migrations in V1.

## Manifest contract

An ordinary app declares one through eight stores and explicitly selects the
backend leaf:

```json
{
  "backend": {
    "capabilities": {
      "stable_store": { "api": 1 }
    }
  },
  "capabilities": {
    "stable_store": {
      "api": 1,
      "stores": [
        {
          "id": "notes",
          "purpose": "Keep revision-safe notes",
          "schema_version": 1,
          "max_entries": 16,
          "max_key_bytes": 64,
          "max_value_bytes": 2048,
          "max_bytes": 16384
        }
      ]
    }
  }
}
```

The object is closed. Store ids match `^[a-z][a-z0-9_]{0,39}$`, are unique
inside the app, and are sorted canonically in the normalized plan. The
declaration bounds are:

| Bound | V1 maximum |
| --- | ---: |
| Stores per app | 8 |
| Schema version | 65,535 |
| Entries per store | 4,096 |
| Entries per app | 8,192 |
| Entries across the kernel store | 65,536 |
| Key bytes | 256 |
| Value bytes | 262,144 |
| Bytes per store | 16,777,216 |
| Bytes per app | 33,554,432 |
| Bytes across the kernel store | 268,435,456 |
| Stores across the kernel store | 2,048 |

`max_key_bytes + max_value_bytes` must fit within `max_bytes`. Logical byte
usage counts key bytes plus value bytes. Entry count separately bounds the
map and per-record overhead.

`purpose` is one through 160 Unicode scalar values of **untrusted display
text**. It is escaped and labelled as app-provided in install and Settings UI.
It is excluded from the declaration authority fingerprint, namespace,
retention identity, quotas, and revisions. Editing prose does not move data or
reset the store.

Declaring `stable_store` creates one generic runtime resource per store id.
Declaring it alone does not inject a handle. Selecting
`backend.capabilities.stable_store` injects exactly
`env.capabilities.stable_store : StableStoreV1`; it does not expose a
universal capability object.

## Namespace and physical storage

The effective logical authority is:

```text
(neutron canister,
 app id,
 app installation uid,
 stable_store,
 declared store id,
 kernel-assigned namespace uid,
 binary key)
```

The compiler resolves `AppScope` from the committed or exactly staged app
inventory and passes it only to a private kernel factory. The app-facing handle
captures that scope and accepts no app id, installation uid, or namespace uid
as authority input.

Each active store is one kernel-owned, ordered `mo:core/Map<Blob, Entry>`
beneath a scoped store record. Equal store ids and equal binary keys in two
apps therefore resolve to different maps. A monotonically allocated,
never-reused `namespace_uid` distinguishes removal followed by re-addition even
when an ordinary app upgrade retains its `AppScope`. The uid appears in a
continuation cursor only so the broker can reject a cursor from a retired
namespace; it is not a pointer or bearer capability.

Core Map is an ordered stable B-tree under Motoko's enhanced orthogonal
persistence. Lookup, conditional mutation, and the start of a page use bounded
tree operations. Prefix listing uses `Map.entriesFrom` and stops as soon as the
next ordered key leaves the requested prefix. It never scans another store or
starts from the global beginning.

## App-facing Motoko leaf

The reviewed type-only `mo:neutron-capabilities` package exposes these public
V1 leaves:

```motoko
public type StableStoreConditionV1 = {
  #unconditional;
  #if_absent;
  #if_revision : Nat64;
};

public type StableStoreCursorV1 = {
  namespace_uid : Nat64;
  prefix : Blob;
  after : Blob;
};

public type StableStoreEntryV1 = {
  key : Blob;
  value : Blob;
  revision : Nat64;
  schema_version : Nat;
};

public type StableStoreUsageV1 = {
  store : Text;
  schema_version : Nat;
  entries : Nat;
  bytes : Nat;
  max_entries : Nat;
  max_bytes : Nat;
  over_quota : Bool;
};

public type StableStoreErrorV1 = {
  #source_gone;
  #not_declared;
  #disabled;
  #invalid_request;
  #too_large;
  #quota_exceeded;
  #not_found;
  #conflict : { current_revision : ?Nat64 };
  #low_cycles;
  #not_replicated;
  #revision_exhausted;
  #cursor_stale;
};
```

`StableStoreV1` contains only synchronous `get`, `put`, `delete`, `list`,
`usage`, and `clear_page` functions with closed request/result aliases.

- `put({ store; key; value; condition })` returns only the new revision, the
  kernel-stamped schema version, and usage. It does not echo the key or value.
- `get({ store; key })` returns `#ok(null)` for an absent key or the complete
  bounded entry.
- `delete({ store; key; expected_revision })` permits an unconditional delete
  with `null`, or rejects a changed record with `#conflict`.
- `list({ store; prefix; cursor; limit })` returns bounded entries, an optional
  logical continuation, and the store revision observed by that page.
- `usage(store)` returns logical entries/bytes and current limits.
- `clear_page({ store; prefix; limit })` deletes only a bounded page and
  returns removed entry/byte counts, `more`, and current usage.

Mutation methods reject non-replicated query execution with
`#not_replicated`; they never claim that a query-only state change persisted.
Every operation rechecks the exact store declaration, current app scope, and
generic runtime toggle. The handle contains no map, `AppScope`, namespace
allocator, registry object, stable-memory primitive, or cycle primitive.

## Revisions, conditions, and live pagination

Every successful put receives a monotonically increasing kernel revision.
Revisions are not app timestamps and are never reused. `#if_absent` implements
create-if-absent. **Compare-and-swap (CAS)** means “apply this mutation only if
the record still has the revision I read.” If one editor reads revision 7 and
another editor writes revision 8 first, the first editor's
`#if_revision(7)` update conflicts instead of silently overwriting revision 8.
`expected_revision = ?n` gives delete the same protection. A mismatch reports
only the current optional revision, never another record's bytes. Exhausting
the revision allocator fails closed.

Pagination is deliberately **live**, not snapshot-isolated:

1. each call traverses one invocation-local coherent store state; an ordinary
   query read may be stale or non-consensus and is not certified;
2. entries are ordered lexicographically by their binary keys;
3. `after` is exclusive, so a key already returned is not returned again;
4. changes at or below `after` are not revisited;
5. changes above `after` may appear in a later page; and
6. the broker rejects a continuation whose namespace uid or prefix does not
   match the current store/request.

This contract permits a bounded lazy migration to list a page, revision-check
and rewrite those same keys, then continue after the page. A mandatory
whole-store snapshot revision would invalidate that workflow after every
rewrite. CAS makes a revision obtained from a stale query safe to use: a later
replicated update conflicts if that record has changed. Callers that need to
detect an intervening revisioned mutation can compare the returned
`observed_revision` themselves and restart. Puts always
advance it, and deletes/clear pages advance it while revision ids remain
available. At the terminal `#revision_exhausted` state, destructive recovery
deliberately remains available without allocating another revision, so
`observed_revision` is no longer a complete change detector.

Cursors are data, not authority. They contain no physical address, Region id,
node handle, app scope, or cross-store lookup key.

## Quotas, allocation safety, and narrowing

The broker validates key, value, prefix, cursor, and page bounds before doing
storage work. It enforces declared store quotas, app aggregate ceilings, hard
global actual-usage ceilings, and bounded one-operation key/value/page sizes.
There is no fixed-hour put or rewritten-byte counter. Storage growth is refused
below the 250 billion-cycle reserve; reads, deletes, target-valid non-growing
replacements, and bounded cleanup remain available so low cycles do not make
data impossible to remove. Repeated writes contribute to the exact
installation's telemetry and Installed Apps cycles-used summary but are not
throttled by this capability.

A quota reduction never silently evicts opaque app records. On a compatible
upgrade the store retains its data and reports `over_quota = true` if current
usage exceeds a new entry or byte ceiling. While over quota:

- `get`, `list`, `usage`, revision-checked `delete`, and bounded
  `clear_page` continue to work;
- a target-valid replacement that does not increase the store's accounted
  bytes is allowed; and
- inserting a key, increasing a value, or otherwise increasing entries or
  bytes returns `#quota_exceeded` until the store fits again.

This makes narrowing recoverable without pretending the new ceiling has
already erased user data. Install and Settings UI show the declared ceilings;
the scoped `usage()` result, demonstrated by Kitchen Sink, is the V1 source of
live entry/byte usage and the over-quota flag.

## Schema migration

The kernel stamps every successful put with the store's currently declared
`schema_version`. An upgrade may retain a same-id store and raise its schema
version. Existing entries keep their write-time versions, so app code can:

1. list a bounded live page;
2. decode only versions it understands;
3. compute the next opaque representation;
4. use `#if_revision` to replace the record safely; and
5. continue with the page cursor.

The kernel does not decode values, run app migration callbacks, or claim an
all-record transaction. Apps should keep readers compatible during a lazy
migration and make conversion idempotent. Store schema versions cannot move
backward while the same namespace is retained. Cross-store rename,
consolidation, and atomic bulk migration are deferred.

Managed backend memory remains the right facility for typed Motoko state whose
layout and migration DAG belong to actor assembly. `stable_store` is the right
facility for larger, bounded, opaque records and incremental app-level
migration. It does not replace managed memory.

## Install, disable, removal, and garbage collection

Store lifecycle joins the checked deployment journal:

- target declarations are validated during actor construction without making
  pending app scopes usable;
- before commit, pending code cannot read or mutate retained stores and no old
  store is cleaned early;
- successful commit retains the exact same scoped store while applying its
  new schema and quota declaration;
- a failed activation, abort, or commit trap leaves the predecessor's store
  unchanged;
- disabling a store blocks subsequent reads and writes but does **not** erase
  it;
- capability/store removal and app uninstall drop the old scoped store only in
  successful commit; and
- reinstall, or later re-adding a removed id, receives a fresh namespace uid
  and cannot inherit or page through the retired store.

`clear_page` is intentionally bounded; an app cannot demand an unbounded
prefix scan or deletion inside one broker call. Removal/uninstall drops the
single outer reference to the nested ordered map rather than visiting every
entry in the install-commit message.

Neutron uses Motoko's enhanced orthogonal persistence and its incremental
garbage collector. Once no kernel object or capability closure references a
retired nested map, its nodes and blobs are garbage and their heap space can be
reused. Physical Wasm pages need not shrink. Kernel Settings reports
whole-canister memory, which is distinct from the app-facing store's logical
`usage()` result. A Region-per-installation
design is rejected: [stable Regions can grow but never shrink](https://docs.internetcomputer.org/languages/motoko/icp-features/stable-memory/),
and dropping a Region handle does not make its grown pages a reusable
app-scoped allocation. The [enhanced persistence design](https://docs.internetcomputer.org/languages/motoko/fundamentals/actors/orthogonal-persistence/enhanced/)
already provides a retained heap with incremental garbage collection.

## Privacy, certification, and audit

`stable_store` is an isolation and resource-accounting boundary, not an
encryption boundary. Keys and values are ordinary replicated canister state.
Subnet replicas and node providers can process them, controllers may obtain
canister-level snapshots, and a kernel bug can inspect the shared actor heap.
Do not store plaintext secrets on the assumption that the broker hides them
from infrastructure.

An app that needs end-to-end private values must encrypt them before storage
using an appropriate app-isolated key flow. The store then sees ciphertext.
`stable_store` neither derives a vetKey nor changes who may decrypt it.

Stored records are also **not certified HTTP assets**. The broker does not add
them to the shared certificate tree or make them public. An app that needs a
bounded certified public body must deliberately copy an appropriate value into
its separately declared `certified_assets` mount.

Settings shows the declared ceilings, runtime toggle, and bounded generic
operation/outcome totals. It has no public V1 storage-admin or live-usage
endpoint. Live logical usage remains available only through the app-scoped
handle. Neither Settings nor audit retains keys, prefixes, values, value
hashes, decoded schema data, or cursor contents. Errors are closed and do not
echo arbitrary storage bytes.

## Kitchen Sink and verification gates

Kitchen Sink declares one small `notes` store. Its capability page uses a
binary-safe text wrapper to demonstrate:

- `#if_absent` creation;
- exact load with schema and revision evidence;
- revision-checked replacement;
- a two-record live prefix page and continuation;
- revision-checked deletion;
- usage and over-quota state; and
- bounded `clear_page` cleanup.

The demo never fabricates success or treats a missing record, conflict,
disabled capability, stale cursor, low-cycle condition, or
non-replicated write as success.

Required deterministic tests cover:

- closed manifest/API validation, canonical store sorting, purpose exclusion,
  backend selection, per-store/app/global bounds, and fingerprints;
- exact compiler delivery and absence of AppScope, Map, Region, pointer,
  stable-memory, and universal-capability fields from the SDK leaf;
- two apps using the same store id/key, forged ids/cursors, stale namespace
  generations, removal/re-addition, and reinstall isolation;
- binary key ordering and prefix boundaries, cursor mismatch, page count/byte
  ceilings, live mutation semantics, and `Map.entriesFrom` range behavior;
- create-if-absent, CAS update/delete, missing records, revisions, schema
  stamps, quota accounting, over-quota shrink/cleanup, absence of temporal
  write admission, low
  cycles, and non-replicated mutation denial;
- pending deployment, failed activation, abort, commit rollback, unchanged
  retention, owner disable/re-enable, removal, uninstall, and fresh reinstall;
- stable-memory invariant validation and bounded/redacted Settings and audit;
  and
- Kitchen Sink source/package assertions.

Before release, stress a maximum-state store through actor reconstruction,
bounded pages, quota narrowing, removal, and reinstall. Repeatedly fill,
clear/uninstall, allow incremental GC work, and refill while measuring Wasm
memory, instructions, latency, and cycles. The release evidence must show heap
reuse without runaway growth and keep large upgrades safely below platform
limits; development unit tests alone are not that evidence.

## Deferred capabilities

V1 intentionally excludes snapshots, snapshot-isolated cursors, multi-key or
cross-store transactions, indexes, range deletes, compare-and-swap batches,
server-side decoding/querying, cross-app sharing, store export/import, raw
Region access, app-controlled compaction, certified reads, automatic
encryption, backups, TTL eviction, and globally reservable store names.
