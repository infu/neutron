# Certified HTTP And Certified Assets

This document defines Neutron's app-scoped certified record store and its fixed
public read behavior.

Three version numbers appear in this area and mean different things:

- `capabilities.certified_assets.api = 2` versions the typed storage
  declaration and backend handle;
- synthesized `certified_read_routes` entries use the current capability-plan
  wire; and
- IC HTTP response certification version 2 is the certificate protocol emitted
  in public responses and advertised in Wasm metadata.

Apps do not author a version-2 HTTP route. Authored `http_routes` is API 1 and
contains only bounded mutating `POST` handlers.

## Security Boundary

An app may choose a closed collection kind, a route mount ID, a
kind-appropriate relative location, and finite quotas. It may not choose:

- raw public paths outside its derived mount;
- Host policy or gateway authority;
- HTTP methods or status behavior;
- content type, cache, CORS, security, digest, range, or download headers;
- a certification expression;
- authenticated-tree keys or witnesses;
- another app's `AppScope`;
- arbitrary staging or mutation semantics; or
- a Kernel cleanup callback.

The compiler creates a backend handle that captures the exact
`(app_id, installation_uid)` and normalized declaration. Runtime state also
binds the collection generation, authority epoch, mount fingerprint, capability
registry lease, and physical admission.

## Architecture

```text
manifest certified_assets declaration
    -> normalized collections
    -> synthesized certified_read_routes
    -> compiler-created scoped backend handle
    -> staged/CAS mutation service
    -> persistent authenticated HTTP forest
    -> direct certified GET/HEAD response
```

Certified Assets is separate from:

- package/static assets managed by the install journal;
- `http_routes` API-1 `POST` handlers;
- public Candid `public_ingress`; and
- an app's private stable memory.

All public certified records share the canister's certified-data root, but each
record, route, collection, and mutation is installation-scoped.

One Kernel-owned parser and canonical constructor defines IC and PocketIC Host
authorities. Certified Assets, authored POST routes, route namespaces, and
connection callbacks reuse that interpretation while retaining their own exact
allow policies; callers that accept raw/custom gateways must deny them
explicitly.

## Manifest Contract

Every declaration also requires the exact backend API-2 handle:

```json
{
  "backend": {
    "capabilities": {
      "certified_assets": { "api": 2 }
    }
  }
}
```

The authority declaration is closed:

```json
{
  "capabilities": {
    "certified_assets": {
      "api": 2,
      "max_entries": 10000,
      "max_committed_bytes": 268435456,
      "max_object_bytes": 67108864,
      "max_pending_stages": 1,
      "max_staged_bytes": 67108864,
      "max_batch_operations": 16,
      "max_batch_bytes": 67108864,
      "max_idempotency_receipts": 4096,
      "collections": [
        {
          "id": "posts",
          "mount": "posts",
          "kind": "publication",
          "max_object_bytes": 67108864
        },
        {
          "id": "objects",
          "mount": "data",
          "kind": "immutable_blob",
          "path_prefix": "/sha256/",
          "max_object_bytes": 1048576
        },
        {
          "id": "profile",
          "mount": "data",
          "kind": "mutable_blob",
          "exact_path": "/profile",
          "max_object_bytes": 1048576
        }
      ]
    }
  }
}
```

All ten top-level fields are required and no others are accepted:

- `api`;
- `max_entries`;
- `max_committed_bytes`;
- `max_object_bytes`;
- `max_pending_stages`;
- `max_staged_bytes`;
- `max_batch_operations`;
- `max_batch_bytes`;
- `max_idempotency_receipts`; and
- `collections`.

Each collection contains:

- `id`;
- `mount`;
- `kind`;
- optional `max_object_bytes`; and
- only the location field allowed by its kind.

Every numeric top-level limit is a positive bounded integer;
`max_idempotency_receipts` is at least 2. The object limit cannot exceed the
committed, staged, or batch-byte limit; the batch-operation limit cannot exceed
the entry limit; the pending-stage limit cannot exceed the receipt limit; and
the nonempty collection array cannot exceed either 16 or `max_entries`.

Collection `id` and `mount` use `[a-z][a-z0-9_]{0,39}`. A collection ID is
unique. Location segments use lowercase `[a-z0-9._~-]+`, excluding `.` and
`..`, in a path no longer than 256 characters. Prefixes have 1–9 segments and
a trailing slash; exact paths have 1–10 segments and no trailing slash.
Locations on one mount cannot overlap. The effective object maximum of every
portable collection, including an inherited top-level maximum, is at most
1,048,576 bytes.

## Collection Kinds

| Kind | Location | Body and mutation | Public delivery |
| --- | --- | --- | --- |
| `publication` | No authored path. Kernel allocates a 32-byte opaque publication ID and combines it with a caller-supplied, Kernel-validated safe filename. | Staged create-once, conditional delete. Caller selects `inline_text` or `attachment` presentation at allocation. | Exact Neutron Host, `GET`/`HEAD`, bounded ranges, no-store |
| `immutable_blob` | Required trailing-slash `path_prefix`; final locator is exact body SHA-256 | Inline or staged create-if-absent; no replacement while present; exact conditional delete | Portable canister-gateway `GET`, immutable cache, anonymous CORS |
| `mutable_blob` | Exactly one of trailing-slash `path_prefix` or `exact_path`; prefix form uses a 32-byte key | Inline CAS create, replace, and delete | Portable canister-gateway `GET`, revalidation cache, anonymous CORS |

Portable collections have a 1,048,576-byte per-object public response ceiling.
Publication objects may be as large as 67,108,864 bytes and are served as
certified blocks/ranges.

Collections on one mount must have non-overlapping locations. A publication
collection occupies the host-bound class for its mount, so it cannot share that
mount with a portable blob collection.

## Synthesized Read Routes

The compiler groups collections by `mount` and creates a derived
`certified_read_routes` plan entry.

Every mount lives at:

```text
/app/<app-id>/_route/<mount-id>
```

Its authority is fixed:

| Collections on mount | Authority mode | Methods |
| --- | --- | --- |
| Publications | `exact_neutron_host_v1` | `GET`, `HEAD` |
| Immutable or mutable blobs | `canister_gateway_v1` | `GET` |

Authored `http_routes` POST mounts and synthesized read mounts share one
16-mount aggregate limit. Their IDs may not collide. Route normalization also
rejects reserved paths, overlapping authored POST prefixes, invalid path
segments, and a certified path that would exceed the fixed witness-depth
bound.

The derived mount remains an independently enableable capability-registry
resource. Disabling it removes serving authority without granting another app
its location.

## Public Locators And Paths

### Publication

The final suffix is:

```text
/<hex(publication_id)>/<filename>
```

The publication ID binds:

- the persistent random publication salt;
- canister ID;
- app ID and installation UID;
- collection ID and generation;
- never-reused publication generation; and
- the caller's exact 16-byte begin nonce.

The filename is 1–100 ASCII letters, digits, `.`, `_`, or `-`, excluding `.`
and `..`.

### Immutable Blob

The final suffix is:

```text
<declared-path-prefix><hex(sha256(body))>
```

The staged digest is computed incrementally by the Kernel. A caller cannot
claim a different content-addressed path.

### Mutable Blob

The final suffix is either:

```text
<declared-path-prefix><hex(32-byte-key)>
```

or the collection's one declared exact path.

## Backend Handle

The synchronous scoped handle exposes:

- `scope_info`;
- `begin_stage`;
- `put_chunk`;
- `stage_status`;
- `abort_stage`;
- `commit_batch`;
- `record_status`;
- `maintenance_page`; and
- `usage`.

It exposes no raw clear, path, certificate, tree, storage allocator, header, or
cross-scope operation.

Targets are collection-relative:

- publication `{ publication_id, filename }`;
- immutable `{ digest }`;
- mutable `{ key }`; or
- mutable `exact_path`.

Every target includes the collection generation. Stale generations fail
closed.

## Staging

There is one ordered staging engine.

- block size: 1,889,984 bytes;
- at most 36 blocks;
- exact expected byte length fixed at `begin_stage`;
- exact 16-byte idempotency nonce;
- one next block index;
- exact replay of an already accepted chunk is idempotent;
- SHA-256 is continued incrementally; and
- an idle stage expires after one hour.

Publication uses `allocate_publication` and is always staged. Immutable blobs
may use `derive_body_sha256`; completion exposes the computed target. Mutable
blobs are inline-only.

The final block must match the remaining expected length. A stage cannot be
committed before every block is present. Terminal stage reconciliation remains
available for 24 hours so a caller can recover the outcome after a lost reply.

## Atomic Batches And CAS

`commit_batch` takes:

- an exact 16-byte nonce;
- at most 16 ordered operations;
- puts with `#absent` or exact revision/content-tag match;
- deletes with exact revision/content-tag match; and
- optional `requires_present_after` requirements.

A valid batch is either one or more puts, optionally with requirements, or
exactly one delete with no requirements. Mixed put/delete batches and
multi-delete batches are invalid. Bodies are inline or reference a completed
stage where the collection kind permits it. The Kernel preflights the complete
batch, quotas, authenticated forest, allocator, receipts, and registry lease
before mutation. Record state, body ownership, public leaves, usage, and
receipts commit together.

All three collection kinds permit the exact conditional delete form. For an
immutable blob, deletion revokes the current record rather than replacing its
bytes. A later create at the same body digest can only publish the same bytes.
Privileged scope retirement separately retains Kernel-owned cleanup authority.

Idempotency storage makes an exact retained retry return the same outcome.
Terminal stage receipts gain a finite expiry and are then reclaimed. A
per-record delete lane moves from reserved empty state to a filled result and
is likewise reclaimed after its reconciliation window. These lanes preserve
enough cleanup authority for one required conditional delete without claiming
permanent receipts.

`record_status` distinguishes present, absent, recently deleted, and deleted
high-water state. A high-water result is Kernel storage evidence; any
app-protocol meaning remains the app's responsibility.

## Fixed Response Policies

### Publication Inline Text

- `Content-Type: text/plain; charset=utf-8`
- `Cache-Control: no-store`
- sandboxing/security headers
- `Accept-Ranges: bytes`
- content-tag `ETag`
- exact `Content-Length`
- optional `Content-Range`
- host-bound certification expression

### Publication Attachment

The policy is the same except:

- `Content-Type: application/octet-stream`
- forced `Content-Disposition: attachment` with the caller-supplied,
  Kernel-validated safe filename

### Immutable Blob

- `Content-Type: application/octet-stream`
- exact `Content-Length`
- SHA-256 `Content-Digest`
- SHA-256 `ETag`
- `Cache-Control: public, max-age=31536000, immutable`
- anonymous CORS and exposed certification/digest headers
- cross-origin resource policy and sandboxing/security headers
- portable certification expression

### Mutable Blob

The immutable policy changes only its cache rule:

```text
Cache-Control: no-cache, must-revalidate
```

### Certified Absence

Host-bound absence supports `GET` and `HEAD`; portable absence supports `GET`.
Both are certified `404` responses with an empty body, `no-store`, and their
respective Host/CORS policy.

Header order and values, status alternatives, method sets, expression bytes,
and dynamic scalar positions form a Kernel-owned response-policy table whose
fingerprint is committed into the persistent authenticated forest.

## Range And HEAD Behavior

Publications accept at most one
`Range: bytes=<start>-<optional-end>` field. The start must locate a stored
block; a present end must be numeric and no smaller than the start. Selection
returns the complete certified block containing the start. An absent `Range`
selects block zero.

A one-block object returns `200`. Every selected block of a multi-block object,
including block zero when `Range` is absent, returns `206` with exact
`Content-Range`; clients reassemble by requesting successive starts. Duplicate,
malformed, suffix, multi-range, or out-of-range inputs fail closed with an
empty `400` response instead of falling back to block zero.

`HEAD` uses the certified metadata alternative and no body. Portable blobs do
not expose ranges or `HEAD`.

The public renderer and storage staging engine share one exact per-block
admission limit of 1,889,984 bytes. The allocator's larger physical-extent
ceiling is an internal bound, not a client chunk size.

## HTTP Response Certification

The generated final Wasm advertises:

```text
icp:public supported_certificate_versions = "2"
```

Direct `http_request` callers must provide `certificate_version` with a maximum
supported value of at least 2. A missing or lower value returns a plain,
uncertified `426` before route selection. Conforming gateways perform this
negotiation for ordinary HTTP clients.

The Kernel emits direct certified responses; Certified Assets does not use the
static asset streaming callback.

Two exact certification expressions are used:

- host-bound responses certify the `Host` header and no query parameters;
- portable responses exclude Host and query parameters.

Those expression rules are distinct from request admission. A nonempty query is
accepted as an alias on a host-bound route and is excluded from its proof. A
portable route rejects any nonempty query with an empty `400` response, so a
portable object's identity must be carried entirely by its path.

The persistent authenticated forest stores compact request/expression/response
leaf keys and fixed wildcard-absence owners. Query proof construction returns
the IC certificate, witness, and expression header for the exact selected
response. Callers must verify the certificate, witness, certified request, and
response hashes before trusting the body.

`Range` is not part of the certified request expression. Certification proves
the exact returned block and its response metadata, not that the response
honored the caller's requested range syntax.

Certified absence says only that this route/object is absent at the certified
state. It is not a semantic tombstone authorizing destructive cleanup in
another app or canister.

## Publication Entropy

Persistent Kernel state contains either uninitialized publication entropy or a
ready 32-byte salt plus fingerprint, and a monotonic next-publication
generation.

`kernel_publication_entropy_initialize`:

1. returns the stored fingerprint if already ready;
2. otherwise awaits management `raw_rand`;
3. stores the 32-byte salt only if the slot is still empty; and
4. after success or failure rechecks whether a concurrent caller stored the
   winner.

The salt is canister-bound under
`neutron.certified-publication.salt.v1`. A publication stage returns
`#not_ready` until initialization succeeds.

`seedFreshKernel` performs initialization before asset seeding for provision,
local deployment, and destructive reinstall. The Dispenser's independent
handoff calls the same initializer after static asset seeding and before
activation.

## Limits And Physical Admission

Selected declaration and engine limits are:

| Limit | Value |
| --- | ---: |
| Collections per scope | 16 |
| Occupied entry slots per scope | 100,000 |
| Committed logical bytes per scope | 1,073,741,824 |
| Object, staged, or batch bytes | 67,108,864 |
| Active stages per scope | 1 |
| Active stages actor-wide | 4 |
| Batch operations | 16 |
| General receipts per scope | 4,096 |
| Cleanup jobs per scope | 16 |
| Cleanup jobs plus active stages actor-wide | 4,096 |
| Global charged admission, including allocator metadata reserve | 2,890,572,816 |
| Additional global body-plus-metadata charged headroom | 939,524,096 |
| Physical arena-byte admission | 1,879,048,192 |
| Physical extent-policy ceiling | `2 × reserved_extents + 1 ≤ 250,000` |
| Portable blob response | 1,048,576 |
| Publication blocks | 36 |
| Stage idle lifetime | 1 hour |
| Terminal reconciliation lifetime | 24 hours |

Installation computes conservative per-scope physical headroom for occupied
rows, replacement, staging, receipts, cleanup, authenticated nodes, body arena,
and arena descriptors. The compiler sums those reservations for the complete
target and rejects a target above the charged, arena-byte, or extent policy
before emitting the actor. The backend repeats its own charged and allocator
admission checks, and runtime semaphores bound actual work. This table is
selected public and declaration policy, not an exhaustive list of every
internal physical bound.

Settings may narrow only occupied entries, committed bytes, staged bytes, and
general receipts; it may also freeze writes. Narrowing never grants more
authority than the manifest.

## Lifecycle And Cleanup

Install commit stages collection and route configuration with the target
`AppScope`. Commit rotates changed authority, publishes the new registry and
authenticated state atomically, and queues bounded cleanup for retired storage.
Abort publishes none of it.

An update that retains an `AppScope` must retain exact collection topology,
location, kind, and mount semantics. It may only widen numeric declaration and
per-collection object limits. Adding, removing, narrowing, or semantically
changing a collection is rejected by the checked in-place upgrade contract.
Removing and later re-adding a production app scope retires its stored records
and is not a migration mechanism. A production release must preserve the
existing topology until a state-preserving forward migration path exists and
has migrated every supported installed state before any old storage is retired.

Settings can:

- inspect scope/usage/diagnostics;
- narrow admission ceilings;
- freeze writes;
- enable or disable exact routes/resources;
- run bounded maintenance pages; and
- retire an exact scope.

Semantic record cleanup belongs to the app protocol. Kernel maintenance only
reclaims storage already made safe by generic record and scope lifecycle.
There is no automatic cleanup timer; complete reclamation advances through
repeated bounded foreground, app, or Settings maintenance pages.

## Installation-Owned Ordinary App Origins

The certified static-asset service also owns the response contract for ordinary
tile, tray, and non-dedicated background origins. These are package assets, not
Certified Assets collection records.

The checked installer writes the canonical
`/system/browser-surface-origins.json` sidecar from package readiness evidence.
An ordinary package is ready when it carries the canonical generated readiness
marker or declares `browser_permissions`; either condition opts the package into
installation-owned browser-surface origins. A markerless package that declares
no browser permissions and has not already been adopted retains the opaque
compatibility path.

For each adopted app, the assembler derives one hostname per tile ID plus the
optional tray and ordinary background from the installation's browser nonce and
surface key. The literal Kernel app is excluded. An in-place update retains the
origin; uninstall and later reinstall receives a new installation identity.

Every derived Host is bound to the corresponding app's `/app/<id>/` subtree.
The initial HTML response requires iframe navigation and limits
`frame-ancestors` to the exact Kernel origin. Subresources require a MIME- and
`Sec-Fetch-Dest`-compatible certified response. Top-level documents, service
workers, shared workers, other app or Kernel assets, package metadata, stale
nonces, and raw or custom gateway authorities fail closed as executable
content. Same-app package metadata may remain passively fetchable as
`application/octet-stream`. The only
cross-subtree exception is a passive, no-query programmatic fetch of the exact
runtime configuration; it cannot be replayed as executable content.

The Kernel document supplies the browser-wide camera/microphone ceiling. An app
document narrows that policy to its own origin, and the trusted frontend adds an
exact-origin iframe `allow` value only for features declared by that tile's
`browser_permissions` entry. The browser still owns prompts, device indicators,
and site-level denial. No media stream or permission session reaches the
backend.

Supported frames are credentialless with
`sandbox="allow-scripts allow-same-origin"`. If the frontend cannot prove the
required credentialless behavior before navigation, it removes same-origin and
feature delegation and uses the opaque `allow-scripts` compatibility sandbox.

## Dedicated Resident Origins

The certified HTTP implementation also serves Kernel-controlled resident
origins. These are not Certified Assets collections.

The resident initial document binds exact app, role, installation UID, frame
security mode, browser-origin nonce, and authority epoch. Its certification
includes Host, destination, and the exact accepted query fields. Subresources
use a separate destination-aware expression and MIME policy.

Persistent and credentialless-ephemeral dedicated modes are mutually exclusive
manifest choices. A credentialless-ephemeral resident may still see browser
storage APIs, but only inside its ephemeral credential partition; it never
falls back to the persistent mode. Rotation invalidates the old authority.
Tiles and trays do not receive resident persistence.

The persistent-origin policy transition retains the installation hostname and
therefore retains IndexedDB. Before each persistent resident launch, the trusted
frontend first navigates the frame to a certified cleanup document on that same
hostname at a Kernel-reserved path outside every app asset subtree. The document
unregisters every Service Worker registration on the retained origin and reports
success only after no registrations remain. It does not clear IndexedDB.

The cleanup request binds the exact current app, installation UID, resident
mode, nonce, authority epoch, `Host`, and iframe request destination. Its
response CSP admits only its inline cleanup script, denies workers and all other
resource types, and limits ancestors to the Kernel origin. The Kernel never
emits a wider Service Worker scope header, so an app Service Worker registered
from its subtree cannot cover the cleanup document.

The frontend launches the resident app only after the expected current-authority
success message. A denied or missing document, cleanup failure, stale authority,
unexpected message, or 15-second timeout leaves that launch blocked. After the
serving or authority problem is repaired, reload or otherwise remount the Kernel
frontend to retry the idempotent preflight; do not bypass it or use reinstall as
recovery.

HTTP denies executable app assets requested as `serviceworker` or
`sharedworker`, so an app cannot use an HTTP-served package asset as a Service
Worker or SharedWorker entrypoint. Ordinary dedicated Workers remain allowed.
A blob-backed SharedWorker does not make an HTTP `sharedworker` entrypoint
request and is therefore outside that destination policy; it remains confined
to the app's nonce-derived origin and loses cross-install reach when the nonce
rotates. These denials do not claim to synchronously terminate an already
running worker context held by another live document.

## Qualification Status

The repository contains a source-owned release runner, an exact pass-only
receipt schema and validator, and five generated neutral scopes. The 12
operational cases run once on fresh canisters and cover
publication, immutable and mutable collections, certified reads, CAS,
idempotency, logical quotas, allocator churn, actor-wide stage admission, and
cross-scope isolation. Separate fixed gates cover the implementation-level
forest, allocator and service invariants, manifest one-over rejection,
same-Wasm upgrade persistence, hostile Range fail-closure, and browser CORS.

The runner starts a private PocketIC instance at a bootstrap time, with
automatic progress off, then explicitly sets and ticks it to the fixed
historical start `1735689600000000000` ns. The physical phase runs first:
256 one-byte records are committed in 16 batches, the eight-receipt boundary
is expired by 24 hours plus 1 ns and reclaimed in one bounded page, and the
257th write is rejected without state drift. The runner then moves forward to
host wall time, enables automatic progress, and records exact raw-query and
gateway pairs for physical candidates and gateway-enabled operational reads
before the Chromium gate.

A generated candidate binding identifies inputs; it is not evidence. The
runner emits a receipt only after pass, and the validator binds that receipt to
the current runner, contract, candidate, compiler, assembler, generated
manifests, implementation sources, and qualified raw and transport Wasm.
Absent or stale is not qualified; a checked binding alone does not establish a
production-safe maximum.

From the repository root, write and review the candidate binding, check it
against current source, and then run the public qualification command:

```sh
npm --workspace neutron-kernel run certified-assets:candidate-binding:write
npm --workspace neutron-kernel run certified-assets:candidate-binding
npm --workspace neutron-kernel run certified-assets:qualify
```

The
[source-owned qualification README](../apps/kernel/evidence/qualification/README.md)
owns the runner's current internal source layout and detailed evidence
procedure. The commands above are the stable release interface.

The receipt is bounded release-regression evidence. It does not establish
cycle cost, proof size, allocator behavior, or upgrade safety at the
100,000-entry production ceiling. The separate manifest gate's 100,001
declaration rejection proves only the schema/admission ceiling.
