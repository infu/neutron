# App-isolated stable store

`stable_store` is a bounded binary key/value capability scoped to an app
installation. Use it for opaque records with incremental, app-owned schema
migration. Use [managed memory](memory-migrations-and-uninstall.md) for typed
Motoko roots whose layouts and migration paths participate in actor assembly.

## Source map

Read these sources before changing a declaration or the broker:

- [Capability catalog](../packages/neutron-tools/src/capabilities/catalog.ts):
  `NeutronStableStoreV1`, manifest validation, and `STABLE_STORE_*` limits.
- [Runtime projection](../packages/neutron-tools/src/capabilities/runtime.ts):
  per-store authority and toggles; presentation text is excluded.
- [Compiler assembly](../packages/neutron-compiler/src/assemble.ts) and
  [upgrade validation](../packages/neutron-compiler/src/compile.ts): handle
  delivery, aggregate declaration bounds, and
  `assertStableStoreSchemaTransitions`.
- [SDK leaf](../packages/neutron-motoko-capabilities/src/lib.mo):
  `StableStoreV1` and its closed request, result, cursor, and error types.
- [Broker](../apps/kernel/backend/stable_store/Service.mo) and
  [state types](../apps/kernel/backend/stable_store/Types.mo): storage,
  runtime bounds, revision allocation, and lifecycle reconciliation.
- [Kernel integration](../apps/kernel/backend/main.mo):
  `stable_store_capability`, configuration, and install commit hooks.

Keep exact ceilings and API field inventories in those sources rather than
duplicating them here. Existing limits are implementation constraints, not
authorization to add or tighten policy; follow `AGENTS.md` before changing them.

## Declaration and authority

Declare `capabilities.stable_store` with `api: 1` and a nonempty `stores` array.
Each store supplies `id`, `purpose`, `schema_version`, `max_entries`,
`max_key_bytes`, `max_value_bytes`, and `max_bytes`. The manifest is closed;
store ids must be valid, unique within the app, and canonically sorted by
normalization. Key and value bounds must fit together within the byte quota.
Consult catalog validation for exact accepted values.

Also select `backend.capabilities.stable_store` with `api: 1` to receive
`env.capabilities.stable_store : StableStoreV1`. A declaration creates runtime
resources but does not by itself inject a backend handle. The compiler delivers
only the selected leaf, not a universal capability object. Kitchen Sink's
[manifest](../apps/kitchensink/neutron.json) and
[backend](../apps/kitchensink/backend/main.mo) provide a complete usage example.

`purpose` is bounded, untrusted app-authored display text. It does not determine
storage identity, retention, accounting, revisions, or runtime authority.
Changing prose does not reset a store.

The Kernel derives the installation scope from its committed or exactly staged
inventory. The logical namespace combines that scope, the declared store id,
and a never-reused Kernel namespace uid. The app-facing handle captures scope
and accepts no app id, installation uid, or namespace uid as authority input.
Every operation rechecks committed deployment state, active installation,
declaration, and runtime toggle. Retaining a handle does not bypass removal or
disablement.

Each store owns a nested ordered `Map<Blob, Entry>` in Kernel-managed memory.
The API exposes no map, raw stable-memory address, Region, allocator, or
cross-app storage access. Cursor namespace ids identify a generation for
validation; they are not bearer capabilities.

## Operations and concurrency

The leaf provides synchronous `get`, `put`, `delete`, `list`, `usage`, and
`clear_page` functions. Mutation methods reject non-replicated execution with
`#not_replicated`; a query cannot report a durable write.

- `get` returns `#ok(null)` for an absent key, or an entry with bytes, revision,
  and the schema version that wrote it.
- `put` supports unconditional replacement, create-if-absent, and
  compare-and-swap with `#if_revision`. It returns revision/schema evidence and
  usage rather than echoing the value.
- `delete` accepts an optional expected revision. A missing key returns
  `#not_found`; a changed existing record returns `#conflict`.
- `list` traverses a binary prefix in key order, bounded by both entry count
  and response bytes. Use the returned continuation rather than assuming the
  requested number of entries was returned.
- `usage` reports logical key-plus-value bytes, entries, declared store entry/byte
  limits, and `over_quota`; it does not measure physical heap consumption.
- `clear_page` removes a bounded prefix page and reports removed counts,
  remaining work, and usage. Repeat while `more` is true when cleanup is needed.

Successful puts receive monotonically allocated Kernel revisions. A stale read
followed by a replicated compare-and-swap therefore conflicts instead of
overwriting a newer value. Revision conflicts expose only the current optional
revision, not record bytes. Exhausted revision allocation refuses new puts;
deletes and bounded cleanup remain available.

Pagination is live, not a snapshot. A page observes one invocation's coherent
state; ordinary query results may be stale and are not certified. The cursor's
`after` key is exclusive. Changes at or below it are not revisited, while later
keys may appear in subsequent pages. The broker rejects a cursor with a stale
namespace, mismatched prefix, or invalid continuation key.

`observed_revision` lets callers detect intervening revisioned mutations. Puts
always advance it; effective deletes and clears advance it while revisions
remain available. Destructive cleanup at revision exhaustion does not advance
it, so it is not a complete change detector in that state.

## Quotas and recovery

Assembly and broker configuration validate aggregate declared capacity as well
as individual store limits. Runtime writes also enforce actual store, app, and
global usage ceilings. Request sizes and page work have independent bounds.
Read their current values from the catalog and broker constants.

Growth below the broker's cycle reserve returns `#low_cycles`. Reads, deletes,
bounded cleanup, and replacements that meet current key/value limits without
growing storage remain available. The capability has no temporal write counter
or throttle.

Compatible quota narrowing retains records. `over_quota` becomes true if
entries or total bytes exceed the new quota, **or if a retained key/value
exceeds its newly narrowed individual size limit**. Reads and cleanup still
work. Replacements must meet current individual limits and must not increase
accounted bytes while over quota; inserts and growth are refused. A key that
exceeds a narrowed key limit remains readable and deletable but cannot be
rewritten under that key until its declaration permits it.

Runtime telemetry records bounded mutation operation/outcome data, not keys,
prefixes, values, hashes, or cursors. Settings exposes declarations and generic
runtime controls; app-scoped `usage` is the source of live logical store usage.

## Schema and installation lifecycle

The Kernel stamps new writes with the current declared `schema_version` and
never interprets existing bytes. A retained store cannot lower that version.
An upgrade can raise it while older entries keep their write-time versions.
For incremental migration, list a page, decode supported versions, transform
records idempotently, replace with revision conditions, and continue after the
page. Readers must remain compatible throughout migration. There is no
all-record transaction or Kernel-run value migration callback.

Store reconciliation participates in checked installation:

- Target declarations are validated during actor construction. Pending code
  cannot use retained stores before successful commit.
- Commit retains same-scope, same-id stores and applies new declarations.
  Abort, failed activation, or a commit trap preserves predecessor state.
- Runtime disablement blocks access without erasing data.
- Removing a store/capability or uninstalling an app drops its scoped store
  during successful commit. Reinstall or later re-addition receives a fresh
  namespace and cannot inherit the retired data or cursor generation.

Removal drops the outer reference to a nested map rather than deleting each
record in that store individually. Once unreachable, map nodes and blobs are
reclaimable by Motoko's incremental garbage collector; physical Wasm memory
need not shrink. Configuration and memory validation do traverse retained
state, so cheap store removal does not imply constant-time actor reconstruction
or installation.

## Privacy and verification

Isolation is not encryption. Store bytes are replicated canister state. Encrypt
private values before storage using an appropriate app-isolated key flow;
`stable_store` does not derive keys or decide who can decrypt. Records are not
public HTTP assets and are not added to a certificate tree. Publishing a value
requires a separately declared certified-assets surface.

The API does not provide snapshot isolation, multi-key transactions, indexes,
automatic encryption, certified reads, or automatic application-level backups.
Do not infer these guarantees from stable persistence or scoped access.

For changes to this capability, start with
[broker tests](../apps/kernel/test/motoko/stable_store_service_test.mo), then
follow the `stable_store` cases in tools schema/runtime tests, compiler
assembly/upgrade tests, SDK public-surface tests, and Kitchen Sink tests.
Preserve evidence for isolation, stale handles/cursors, live paging, revision
conditions, narrowed limits, low-cycle recovery, and failed/committed installs.

Storage or lifecycle changes also require representative persisted-state
reconstruction and fill/clear-or-uninstall/refill measurements. Check logical
accounting, heap reuse, instructions, latency, and cycles; unit tests and a
successful compile do not establish maximum-state upgrade safety.
