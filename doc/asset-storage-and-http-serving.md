# Asset Storage And HTTP Serving

Use this document when changing package asset installation, inspecting an
installed package, or tracing a public HTTP response. The three serving systems
have different authority and persistence contracts:

| System | State owner | HTTP behavior |
| --- | --- | --- |
| Package/static assets | Kernel install journal | Exact-key certified `GET`; stored bodies may stream |
| Certified Assets collections | Installation-scoped backend capability | Fixed certified read policies; no static-asset fallback |
| Authored `http_routes` API 1 | Kernel POST broker and app handler | Preflight upgrades to an update call; no app execution in the query |

Read [Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md)
for collection semantics and browser-origin response policies. Read
[Deprecated Compatibility Paths](./deprecated.md) before adding any dependency
on Kernel-host app URLs or opaque app frames. Those paths still exist, but new
apps must use the replacement model.

## Source Entry Points

| Concern | Source and symbols |
| --- | --- |
| Package paths, upload encoding, journal transaction | `packages/neutron-compiler/src/install.ts`: `preparePackageFiles`, `createStaticFileOperation`, `uploadPreparedFiles`, `deployPreparedPackages` |
| Static store | `apps/kernel/backend/assets.mo`; `apps/kernel/backend/main.mo`: `kernel_static`, `kernel_static_query` |
| HTTP admission and response profiles | `apps/kernel/backend/main.mo`: `validatedHttpAssetPath`, `http_request`, `certifiedResponseHeaders` |
| Static response certification | `apps/kernel/backend/certified_http.mo` |
| Collection reads and mutations | `apps/kernel/backend/certified_assets/`; `apps/kernel/backend/certified_http_v2.mo` |
| POST admission and replay | `apps/kernel/backend/http_post_update_handlers/` |
| Browser registry and frames | `apps/kernel/src/reducer/apps.ts`, `apps/kernel/src/app_frame_security.ts`, `apps/kernel/src/workspace/AppTileFrame.tsx` |
| Fresh-system seeding and verification | `packages/neutron-provision/src/provision.ts`: `seedFreshKernel`, `freshKernelAssetKeys`, `verifyFreshKernel` |

Use these entry points to obtain current limits, full schemas, MIME mappings,
and test locations. Do not copy their changing constants into another document.

## Static File Key Conventions

Package preparation validates archive paths before mapping them to final keys.
Reserved embedded-source material is verified and excluded from installation;
provider-hosted source artifacts are not part of the package archive.

| Package path | Kernel key | Ordinary app key |
| --- | --- | --- |
| `web/index.html` | `/` | `/app/<id>/index.html` |
| `web/<path>` | `/<path>` | `/app/<id>/<path>` |
| `mo/<sha256>.mo` | `/mo/<sha256>.mo` | `/mo/<sha256>.mo` |
| Other installable package files | `/pkg/<path>` | `/app/<id>/pkg/<path>` |
| Reserved embedded legal/source archive paths | Not installed | Not installed |

`preparePackageFiles()` produces relative paths; the upload helpers add the
leading slash and map the special root `index.html` to `/`. The backend stores
the supplied exact key. It does not infer directory indexes or redirect
`/<id>` or `/app/<id>/` to an entrypoint.

The compiler rejects ordinary-app `web/pkg/**` and `web/_route/**` paths and
Kernel `web/app/**` paths. These would collide with Kernel-owned metadata,
routes, or another app's subtree. Use the shared package-path and app-ID
validators rather than reproducing their validation rules in a client.

### `/system/apps.json` Registry

The public certified registry describes installed apps, normalized tiles,
functions, and capability plans. `getApps()` verifies and normalizes it before
replacing frontend app state. A missing or invalid registry is an error, not
an empty installation. Plan fingerprints are recomputed before their authority
fields are used.

Registry `link` values are navigation metadata, not backend redirects. The
launcher opens workspace tile instances from the normalized `tiles` array.
Kernel entries normalize to an empty tile array. Use the shared registry
builders and parsers in `install.ts` rather than constructing a second schema.

### `/system/browser-surface-origins.json` Authority Sidecar

This public certified sidecar contains a format tag and a canonical `app_ids`
array of installed ordinary apps adopted onto installation-owned surface
origins. The required-runtime parser rejects missing, malformed, stale, or
registry-inconsistent content; only the explicit predecessor bridge permits
absence.

Adoption is package-derived. A package qualifies through the canonical
packer-owned `.neutron/browser-surface-origins.v1.json` marker or a
`browser_permissions` declaration. Existing adopted IDs survive unrelated
transactions and compatible upgrades; uninstall removes them. The checked
install journal commits package files, response policies, registry, and
sidecar together. The sidecar does not contain credentials, installation UIDs,
nonces, or authority epochs.

Authoritative public registries are seeded once on a fresh system. Direct
static-store retries must match the existing record; later changes use the
checked install journal. Direct deletion or a broad clear cannot bypass this
ownership rule. Consult `isSeedOncePublicRegistryStaticTarget` in the backend
for the current protected set.

### `/pkg` Metadata

Installed manifests, licenses, notices, and package records use `/pkg/**` for
the Kernel and `/app/<id>/pkg/**` for other apps. Settings and the compiler
read these through certified HTTP. Package legal/source ownership is defined
in [App Package Format](./app-package-format.md) and
[License And Deployment Records](./license-and-deployment-records.md).

Runtime-generated metadata is distinct from packed files. The installer
stages generated Candid at `/pkg/neutron.did`; the authenticated self-actor
loader consumes that certified Candid. The provisioner also records the
canister ID and stable signature. Use the install-asset builders and fresh
seeder's key inventory to discover the complete generated set.

Installed-artifact inspection must use an authenticated inventory:

- The Kernel package generates an installed-artifact inventory binding its
  inspectable frontend and metadata paths to hashes and lengths. A Kernel
  upgrade does not clear the entire root, so an unrestricted root listing may
  contain superseded chunks.
- Ordinary app replacement clears and replaces its complete static subtree.
  Exclude Kernel-owned route records when enumerating that app's static files.
- Backend inspection follows content-addressed imports from the selected
  manifest. Required current roots must exist and hash correctly. Historical
  or migration roots may have been garbage-collected when no longer reachable;
  retain their declarations without inventing available source files.

### Installed App Assets Under `/app/<id>/`

Adopted apps use installation-owned origins derived from the exact installation
nonce and surface key. Tile IDs, the tray, and the ordinary background get
separate origins; instances of the same tile ID share an origin. Compatible
upgrades preserve that identity unless an authority transition rotates it.
Uninstall and reinstall create a new identity. Construct URLs through runtime
helpers, not by copying a production hostname or port.

Supported browsers use credentialless frames with
`sandbox="allow-scripts allow-same-origin"` and exact-origin message checks.
Historical unadopted packages retain their legacy URL policy and opaque
sandbox. Browsers without the required credentialless support also fall back
to opaque execution, even for an adopted package. Package migration alone
does not remove this browser fallback.

Installation-origin HTTP admission binds the Host to the current app and
surface. Initial HTML requires an iframe destination; executable subresources
must match the response's MIME/destination policy. Other app/Kernel executable
assets, top-level documents, stale authorities, and unsupported gateways fail
closed. Same-app package metadata is passive data. The exact no-query
`/system/runtime-config.json` programmatic fetch is the cross-subtree exception;
it does not grant document or worker authority.

Kernel-host `/app/<id>/...` serving remains available for compatibility and
uses the HTTP `Content-Security-Policy: sandbox allow-scripts` response policy.
That protects Kernel-origin storage when app HTML is opened directly. It does
not make those URLs installation-origin authority or resolve opaque-frame
message-port reassignment after navigation. See the
[deprecation plan](./deprecated.md) for both planned removals.

Kernel-controlled responses use `frame-ancestors 'none'`, preventing an app
frame from navigating to active Kernel content and gaining its origin storage.

Dedicated backgrounds use separate resident-origin policies and a certified
cleanup preflight. See [Dedicated Resident Origins](./kernel-http-v2-and-certified-assets.md#dedicated-resident-origins).

### Motoko Module Files Under `/mo`

Modules are shared by content hash, not by app directory. Preparation verifies
that every `mo/<sha256>.mo` filename matches the decompressed bytes.
`readKernelPackageState()` obtains a bounded authenticated key list and reads
the modules through certified HTTP for compilation.

Commit removes only valid content-addressed modules in the authenticated
pre-install baseline that the new actor no longer reaches. It does not scan
or delete unknown concurrent uploads. Do not infer per-app ownership from the
global `/mo/` listing.

## Static Upload And Mutation

`createStaticFileOperation()` chooses MIME and encoding and chunks the stored
bytes. Unknown extensions default to `application/octet-stream`; image MIME
types use identity encoding and other types normally use gzip.
`uploadPreparedFiles()` additionally forces content-addressed Motoko modules
to identity encoding. Reuse these helpers instead of assuming every non-image
file is gzipped.

File tasks may run concurrently, but the initial `store` and subsequent
`store_chunk` operations for one file are sequential. Completion publishes the
assembled asset and its hash. Upload chunk size and concurrency are transport
settings, not part of the package format.

The static store retains content chunks, content type, and encoding. It does
not sniff the body or negotiate `Accept-Encoding`; public response policy may
override the supplied type for passive package metadata and owns security and
cache headers.

`kernel_static` and `kernel_static_query` require Kernel authorization in the
assembled actor. Direct mutation is fenced while a checked journal exists,
and reserved route, registry, dispatch, and deployment-record paths have
additional ownership checks. The list query returns exact keys only and traps
on overflow rather than returning an incomplete baseline. Its lexical prefix
lookup is not a path-segment-aware directory API.

## HTTP Admission And Certification

`http_request` requires HTTP response-certification v2 negotiation. Missing or
older direct-call negotiation receives an uncertified `426`; ordinary gateways
negotiate on behalf of browsers. Public reads require an empty request body
and a bounded canonical envelope. Path validation rejects ambiguous encodings,
dot segments, repeated slashes, backslashes, fragments, and controls. An
admitted query alias does not change the static lookup key.

Declared routes resolve before static lookup. A shared-route path never falls
through to a package asset, even when its mount is disabled or absent. Static
lookup supports exact `GET`, without directory-index, Range, or HEAD behavior.
Response profiles bind the applicable request authority, destination, headers,
and body. See `publicCertificationVariants` and `residentCertificationVariants`
for the canonical static alternatives; do not infer certification policy from
the presence of a certificate header alone.

Most `/system/**` paths are HTTP-internal. `isInternalHttpStatePath` owns the
explicit public metadata allowlist; the certified resident cleanup document
has its own narrow exception. Denied internal paths and missing static keys
use the fixed miss response. Registry, installed metadata, compiler modules,
and guessed public app assets are publicly readable. Certification proves
integrity, not inventory confidentiality. Public deployment evidence must not
contain credentials or owner authorization material.

Certification state is persistent. Normal activation does not scan or
republish every existing body. Journal promotion certifies selected package
files against the capability state published by that same commit. Retained
response-policy migrations have explicit backend paths: the structural
quarantine/rebuild preserves installed app, module, and package subtrees and
rebuilds only the affected Kernel responses. Preserve these migration paths
and their atomic rollback behavior when changing certification internals;
inspect `reconcileRetainedKernelStaticAssets` and its callers rather than
treating a previous release's migration as disposable initialization code.

Public repository `repo_*` Candid proofs are a separate transport, verified by
`packages/neutron-tools/src/certified_asset.ts`. They are not a static-read API
for the Kernel asset database.

## App-Scoped POST Update Routes (API 1)

The compiler binds each declared mount to one internal synchronous handler.
The declaration selects an allowed Host/path mode, finite body/reply limits,
forwarded header names, and external admission. It does not supply arbitrary
HTTP response headers, redirects, cookies, CORS, encoding, or streaming.
Schemas and broker constants own the accepted values and ceilings.

The query preflight selects a live mount and returns `upgrade = true`; it
never invokes app code. Once a mount owns the path, mount-specific malformed
input upgrades so the update handler can return a stable validation error.
`http_request_update` repeats authority, envelope, scope, toggle, admission,
capacity, concurrency, and idempotency checks before the compiler-owned
self-call. The wrapper rechecks dispatch and calls the exact handler.

Every POST needs a valid `Idempotency-Key`. Completed exact retries replay the
stored response; changed input conflicts and pending/unknown work never
redispatches. Reservations commit before the self-call, so a trap does not
refund external admission or permit an unbounded retry. Runtime disable also
denies replays. Re-enabling compatible authority can replay completed work,
but cannot resume an old pending dispatch.

Anonymous gateway traffic consumes the declared external windows. A
Kernel-authorized principal calling the Candid update directly is exempt from
those windows, while retaining the other checks. The handler receives only a
relative path, explicitly forwarded headers, bounded body, and idempotency-key
digest. It has no raw actor, scope selector, or injected capability. Handler
execution is limited by the platform update-message budget, not a separate
per-handler instruction allowance.

The update reply is authenticated by update consensus when the gateway follows
the upgrade. The query certificate tree does not certify app handler output.
Qualification must therefore cover gateway upgrade behavior as well as backend
and compiler validation.

## Provisioner Asset Writes

`seedFreshKernel()` is a fresh-system path. It validates the package-derived
registry/origin target, initializes publication entropy, deduplicates prepared
files, uploads them, and writes runtime-generated metadata. It does **not**
clear the static namespace. Runtime configuration is bound to the final
deployment before seeding; `verifyFreshKernel()` checks the resulting assets
and runtime through the shared certified readers.

The Dispenser has its own starter assembly and handoff implementation; do not
assume all new-system creation executes the CLI seeder. Neither flow is an app
upgrade mechanism. Existing production canisters use the checked,
state-preserving install transaction described in
[Package Updates](./package-updates.md) and
[Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md).
