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
`dist/neutron.json`. An installable package must contain `entry`.

The closed top-level fields are:

| Field | Meaning |
| --- | --- |
| `format` | Exactly `3` |
| `id` | Stable app ID |
| `name` | Owner-visible app name |
| `version` | Packed release version |
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

Unknown fields are rejected.

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
7. walks `dist` in sorted order without following symlinks;
8. gzip-compresses every file independently;
9. encodes the flat MessagePack map; and
10. writes `<app-id>.v<major.minor.patch>.neutron`.

Older archives for the same app are removed after the new archive is written.

## Installation Rewriting

The installer stores ordinary package state under Kernel-owned paths:

- package manifest under `/app/<id>/pkg/neutron.json`;
- web assets under `/app/<id>/...`;
- content-addressed Motoko modules under `/mo/<sha256>.mo`;
- app registry under `/system/apps.json`;
- generated Candid under `/pkg/neutron.did`;
- stable signature under `/pkg/neutron.most`; and
- install provenance under its Kernel-owned system path.

The Kernel package is the only path exception: its manifest is stored at
`/pkg/neutron.json`.

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
