# App Package Format

A Neutron app package is one `.neutron` archive containing a format-3 manifest,
content-addressed Motoko modules, optional managed-memory lock, and optional
frontend assets.

The package is deployment-target neutral. Canister IDs, root keys, local
fixtures, installation UIDs, origins, grants, and deployment IDs are supplied
by the compiler and installer, not embedded by the packer.

## Archive Shape

The current archive is exactly:

```text
MessagePack map<
  safe relative UTF-8 string path,
  MessagePack bin containing one gzip member
>
```

Each source file is gzip-compressed independently. The top-level archive is not
itself gzip.

The decoder accepts no numeric keys, integer byte arrays, nested maps, symlinks,
absolute paths, `.`/`..` segments, duplicate paths, dangerous JavaScript keys,
trailing bytes, or multiple gzip members.

Default deliberate local-file limits are:

| Resource | Limit |
| --- | ---: |
| Raw archive | 128 MiB |
| Entries | 16,384 |
| Path bytes | 4,096 |
| Compressed entry | 128 MiB |
| Decoded entry | 64 MiB |
| Decoded total | 256 MiB |

Packages fetched through a repository use the smaller remote trust-bound
limits:

| Resource | Limit |
| --- | ---: |
| Raw archive | 32 MiB |
| Entries | 4,096 |
| Path bytes | 512 |
| Compressed entry | 32 MiB |
| Decoded entry | 16 MiB |
| Decoded total | 64 MiB |

Expected outer archive SHA-256 and byte size are checked before decompression
when the acquisition path provides them.

## Package Layout

A typical built tree is:

```text
dist/
  neutron.json
  neutron.lock.json             # only when managed memory is declared
  mo/
    <sha256>.mo
  web/
    index.html
    main.js
    main.css
    static/icon.png
```

The archive paths are relative to `dist/`, so package entries are
`neutron.json`, `mo/<sha256>.mo`, `web/...`, and optionally
`neutron.lock.json`.

Frontend files are optional. A backend-only or otherwise headless package does
not need `web/index.html`.

The archive may also contain safe auxiliary metadata files. With the reserved
archive-only exceptions described below, the installer places every
non-`web/`, non-`mo/` package file below the package's `pkg/` namespace. The
implemented package-information sidecar uses the fixed archive
path `legal/package-record.v1.json` instead of adding an unknown field to the
closed format-3 manifest. It is closed, bounded format-1 JSON that binds the
package manifest, license texts, source offer or status, dependencies, notices,
managed-memory lock, and build inputs. Existing packages without the sidecar
remain valid and are reported as legacy/undeclared; a malformed present record
fails package preparation. See
[License And Deployment Records](./license-and-deployment-records.md#package-information-record-v1).

The sidecar is optional product metadata, not a user-maintained legal registry.
The NPL/NSAL drafts do not require an app author or private installer to
hand-write hashes or identify the browser-generated package combination or
combined Wasm. Ordinary first-party app packaging generates the sidecar,
governing license, concise application notice, complete derived third-party
notice set, and a closed Complete App Source snapshot automatically.

For an app with `update_source`, the default production form keeps the license
and notices at ordinary installable `legal/**` paths and writes the exact
generator-produced Complete App Source gzip bytes outside `dist`, at
`<app>/.neutron/sources/<sha256>.source.v1.msgpack.gz`. The package record binds
that artifact and identifies its certified HTTPS URL. The gzip member expands
to the closed v1 MessagePack source snapshot; its recorded size and SHA-256 bind
the compressed bytes, not a later recompression. The update-source
publisher, not the installer or Sovereign User, uploads and retains it. Source
bytes are therefore not placed in the `.neutron` package or an installed
Neutron. Private browser assembly does not publish a user's package selection,
modifications, combined Wasm, hashes, or compliance records.

An app without `update_source` instead uses the explicit embedded form described
below. That form retains its source and bulk legal material only in the supplied
archive and requires an archive-only-aware Kernel.

## Manifest Format

`neutron.json` uses:

```json
{
  "format": 3,
  "id": "hello",
  "name": "Hello",
  "version": 101,
  "src": "main.mo"
}
```

Source manifests use `src`. The Motoko packaging step resolves imports,
content-addresses reachable modules, and writes the packaged `entry` hash into
`dist/neutron.json`. In automatic mode, an ordinary app with `update_source`
uses a provider-hosted HTTPS source offer and receives no package feature marker.
An ordinary app without `update_source` uses embedded delivery and receives the
generated `package_features: ["archive-only-legal-v1"]` compatibility marker.
The packager also supports an explicit embedded override. App authors must not
maintain the generated field in source `neutron.json`; source validation rejects
it. Every installable package must contain `entry`.

The closed top-level fields are:

| Field | Meaning |
| --- | --- |
| `format` | Exactly `3` |
| `id` | Stable app ID |
| `name` | Owner-visible app name |
| `version` | Packed release version |
| `package_features` | Packaged-only closed installer feature markers |
| `update_source` | Optional canonical update-source canister principal |
| `description` | Optional owner-visible description |
| `src` | Source entry path used by the packager |
| `entry` | Packaged content-addressed Motoko entry |
| `init_arg` | Kernel-only constructor resource names |
| `func` | Backend function declarations |
| `memory` | Managed-memory schemas, migrations, and retirement |
| `dependencies` | Typed dependencies on other installed apps |
| `tiles` | Zero or more disposable frontend endpoints |
| `background` | Optional resident frontend endpoint |
| `tray` | Optional tray endpoint |
| `backend` | Exact backend capability interfaces to inject |
| `capabilities` | Closed authority declarations |

Unknown fields are rejected. In particular, immutable production v0.3.5 and
v0.3.6 and the compatible private v0.3.7 candidate reject the archive-only
marker before staging any files. A later archive-only-aware Kernel accepts it
and cross-checks the same feature in the package record against the actual
reserved archive paths. Production packages that use the HTTPS source offer
omit both the reserved paths and marker, so those older Kernels can prepare
them in the same **Upgrade all** batch as a newer Kernel. Keeping any marker out
of source manifests makes this an automatic packaging safety boundary rather
than an app-author duty.

## IDs, Names, And Versions

App IDs use the shared app-ID grammar and are not display names. The literal
`kernel` ID is reserved for the operating-system package.

Names are 3–20 ASCII letters, digits, and spaces. Descriptions and endpoint
text are NFC-normalized and reject control, bidi, default-ignorable, and
line-separator characters before trusted UI display.

Release versions are a naturally ordered SemVer subset:

```text
packed = major * 10_000 + minor * 100 + patch
```

`minor` and `patch` are 0–99. The first supported release is `0.1.0`, packed as
`100`. Memory schema versions and protocol API numbers use their own numbering.

## Functions

`func` maps logical method names to:

```json
{
  "type": "query | update | internal",
  "async": false,
  "arg": ["resource_name"],
  "expose": "apps"
}
```

Rules include:

- at most 256 functions;
- at most 16 unique injected resources per function;
- internal functions may be exposed to typed app dependencies;
- only Kernel may use its direct unauthorized-function declaration; and
- ordinary public access must use `capabilities.public_ingress`.

The compiler validates the source signature and maps logical methods to
physical actor methods or dispatchers. App code cannot select its physical
name.

## Backend Environment

`backend.capabilities` selects versioned interfaces:

```json
{
  "backend": {
    "capabilities": {
      "deferred_timers": { "api": 1 },
      "stable_store": { "api": 1 }
    }
  }
}
```

The current interface catalog includes deferred timers, backend calls,
randomness, chain-key signing, stable store, HTTPS outcalls, attenuated vetKey
public access, and Certified Assets.

Selecting an interface does not create undeclared authority. For example, the
`stable_store` interface also requires a matching closed
`capabilities.stable_store` declaration. The compiler builds the exact
environment for the exact installation.

## Capabilities

`capabilities` is closed and normalized by the shared catalog. It may declare:

- backend calls and install-reviewed reservations;
- randomness;
- chain-key signing;
- stable stores;
- HTTPS outcalls;
- vetKeys;
- scheduled tasks;
- preapproved self calls;
- agent entrypoints;
- background UI request categories;
- browser-wallet methods and chains;
- provider connections;
- persistent or ephemeral resident origins;
- public Candid ingress;
- bounded HTTP POST mounts; and
- Certified Assets collections.

The compiler derives stable-memory, migration, app-call, backend-environment,
certified-read-route, function-resource, app-export, tile, background, and tray
entries.

See [Kernel Capability Inventory](./kernel-capability-inventory.md).

## Frontend Surfaces

### Tiles

`tiles` is optional and may contain at most 32 entries:

```json
{
  "id": "main",
  "title": "Hello",
  "path": "index.html",
  "icon": "static/icon.png",
  "description": "Optional trusted-shell text"
}
```

Paths are safe relative asset paths. When omitted within a declared tile,
`path` defaults to `index.html` and `icon` to `static/icon.png`.

Missing or empty `tiles` stays empty. No tile or asset is synthesized.

### Background

```json
{
  "background": {
    "path": "service.html",
    "description": "Refreshes app data while Neutron is open"
  }
}
```

There is at most one resident background. Its security mode is derived from
the persistent/dedicated-origin capability declarations, or uses the default
opaque credentialless mode.

### Tray

```json
{
  "tray": {
    "title": "Notifications",
    "path": "tray.html",
    "icon": "static/icon.png"
  }
}
```

There is at most one tray. Paths are always explicit; the runtime does not
invent `service.html` or `tray.html`. A tray declaration is valid only when the
same manifest also declares a resident background.

## Typed App Dependencies

Dependencies are keyed by local aliases:

```json
{
  "dependencies": {
    "directory": {
      "app": "contacts",
      "min_version": 100,
      "functions": ["contact_lookup"]
    }
  }
}
```

An app may declare at most 32 dependencies and at most 64 exact functions per
dependency. The provider must be installed at the minimum version and must
expose those methods as internal app exports. The compiler injects only the
typed dependency handle.

Kernel cannot declare app dependencies, and an app cannot depend on itself or
on Kernel.

## Managed Memory

A memory declaration has:

```json
{
  "memory": {
    "main": {
      "version": 2,
      "schemas": {
        "1": { "src": "memory/main/v1.mo" },
        "2": { "src": "memory/main/v2.mo" }
      },
      "migrations": [
        {
          "from": 1,
          "to": 2,
          "src": "memory/main/migrate_1_2.mo"
        }
      ]
    }
  }
}
```

Limits are 64 roots, 256 migration edges across the manifest, and 16 consumed
roots per consolidation edge.

The packager:

1. strips comments/empty lines for schema hashing;
2. restricts schema imports to declared Motoko packages;
3. writes content-addressed `entry` values;
4. writes schema `hash` values;
5. compares and merges the source `neutron.lock.json`; and
6. copies the exact lock into `dist/`.

`neutron.lock.json` currently has its own format 2. That is the active
managed-memory lock format, not a deployment-config or provision-journal
compatibility path.

A removed memory root must be declared `retired` and participate in the
compiler's explicit retirement plan. Apps cannot share raw memory roots.

See [Managed Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md).

## Certified Assets Example

Certified Assets uses three closed kinds and compiler-derived read routes:

```json
{
  "backend": {
    "capabilities": {
      "certified_assets": { "api": 2 }
    }
  },
  "capabilities": {
    "certified_assets": {
      "api": 2,
      "max_entries": 1000,
      "max_committed_bytes": 67108864,
      "max_object_bytes": 1048576,
      "max_pending_stages": 1,
      "max_staged_bytes": 1048576,
      "max_batch_operations": 16,
      "max_batch_bytes": 16777216,
      "max_idempotency_receipts": 1024,
      "collections": [
        {
          "id": "objects",
          "mount": "data",
          "kind": "immutable_blob",
          "path_prefix": "/sha256/"
        }
      ]
    }
  }
}
```

The package does not declare a certified `http_routes` object, headers,
certification expression, or response profile.

See [Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md).

## Build And Pack Flow

A conventional app build:

1. bundles frontend assets into `dist/web` when present;
2. validates the source manifest;
3. walks Motoko imports from app, memory-schema, and migration roots;
4. rewrites imports to content-addressed `dist/mo/<sha256>.mo`;
5. writes packaged `entry` and memory hashes;
6. writes `dist/neutron.json` and optional lock;
7. derives and verifies the legal files and package record in a replaceable
   `dist/legal` tree and, for HTTPS delivery, writes the exact generated source
   artifact below the app-local `.neutron/sources/` directory;
8. walks `dist` in sorted order without following symlinks;
9. gzip-compresses every file independently;
10. encodes the flat MessagePack map; and
11. writes `<app-id>.v<major.minor.patch>.neutron`.

Older archives for the same app are retained as immutable history. Never reuse
an earlier release version for different bytes.

## Installation Rewriting

The installer stores ordinary package state under Kernel-owned paths:

- package manifest under `/app/<id>/pkg/neutron.json`;
- governing license, application and third-party notices, and package record
  under `/app/<id>/pkg/legal/`;
- web assets under `/app/<id>/...`;
- content-addressed Motoko modules under `/mo/<sha256>.mo`;
- app registry under `/system/apps.json`;
- generated Candid under `/pkg/neutron.did`;
- stable signature under `/pkg/neutron.most`; and
- install provenance under its Kernel-owned system path.

The Kernel package is the only path exception: its manifest is stored at
`/pkg/neutron.json`.

Normal provider-hosted packages have no reserved bulk source paths. Their
governing license, notices, and package record use ordinary `legal/**` paths and
are installed under `/pkg` or `/app/<id>/pkg`; their Complete App Source exists
only at the digest-bound HTTPS URL and the publisher's app-local source
artifact. Installing or privately assembling the package does not copy that
source into the Neutron.

For the explicit embedded form, `legal/archive-only/**` and
`legal/source/app-source.v1.msgpack` remain archive exceptions rather than
installed path rewrites. Package preparation verifies them and retains them in
the supplied `.neutron` archive without staging them under `/pkg` or
`/app/<id>/pkg`.

These are install-journal targets, not app-authored arbitrary static paths.
Uninstall clears the app prefix and module GC removes unreferenced hashed
modules within the same bounded transaction.

## Minimal Headless Example

```json
{
  "format": 3,
  "id": "counter_backend",
  "name": "Counter Backend",
  "version": 100,
  "src": "main.mo",
  "func": {
    "read": { "type": "query", "async": false },
    "increment": { "type": "update", "async": false }
  }
}
```

After Motoko packaging, `dist/neutron.json` also contains the content-addressed
`entry`. No `tiles`, `background`, `tray`, or `web/` directory is required.

## Relevant Sources

- `packages/neutron-tools/src/schema.ts`
- `packages/neutron-tools/src/memory.ts`
- `packages/neutron-tools/src/capabilities/`
- `packages/neutron-compiler/src/package_decoder.ts`
- `packages/neutron-compiler/src/install.ts`
- `packages/neutron-scripts/src/mopack.ts`
- `packages/neutron-scripts/src/pack.ts`
