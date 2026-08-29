# Asset Storage And HTTP Serving

Back to the [documentation index](./index.md).

This document covers the current static asset storage, app-scoped certified
route store, bounded POST handler broker, and HTTP serving implementation. It
is limited to install-time path rewriting, the kernel-owned stores and
admission state, certified HTTP serving, provisioning asset writes, and the files
that consume the stored assets.

Primary sources:

- `apps/kernel/backend/main.mo`
- `apps/kernel/backend/assets.mo`
- `apps/kernel/backend/certified_assets/{Service,Types}.mo`
- `apps/kernel/backend/certified_http.mo`
- `apps/kernel/backend/http_post_update_handlers/{Service,Types}.mo`
- `apps/kernel/backend/lib/Painless.mo`
- `packages/neutron-compiler/src/install.ts`
- `apps/kernel/src/tools/install.ts`
- `apps/kernel/src/tools/mime.ts`
- `apps/kernel/src/tools/app.ts`
- `apps/kernel/src/reducer/apps.ts`
- `apps/kernel/src/reducer/auth.ts`
- `apps/kernel/src/index.tsx`
- `apps/kernel/src/workspace/Launcher.tsx`
- `apps/kernel/src/workspace/AppTileFrame.tsx`
- `packages/neutron-tools/src/runtime.ts`
- `packages/neutron-provision/src/provision.ts`
- `packages/neutron-provision/src/local_deploy.ts`
- `packages/neutron-provision/src/runtime_config.ts`
- `doc/kernel-backend-runtime.md`
- `doc/app-package-format.md`

## Implementation Facts

### Static File Key Conventions

The backend stores assets by the exact `Text` key passed to `kernel_static`.
The normal upload client constructs keys from package-relative paths:

- `preparePackageFiles()` rewrites installable package paths without a leading
  slash. Before this step, package preparation verifies and removes any
  reserved archive-only legal/source paths used by an explicit embedded-source
  package. Normal provider-hosted packages contain no such paths.
- `uploadPreparedFiles()` adds the leading slash.
- The kernel-local `prepare_files()` and `upload_files()` functions delegate to
  the shared package compiler helpers.
- The special path `index.html` is stored as `/`.
- Every other path is stored as `/<rewritten-path>`.

For the kernel package, `app_prefix` is empty:

| Package path                   | Rewritten path                      | Stored key                           |
| ------------------------------ | ----------------------------------- | ------------------------------------ |
| `web/index.html`               | `index.html`                        | `/`                                  |
| `web/static/icon.png`          | `static/icon.png`                   | `/static/icon.png`                   |
| `neutron.json`                 | `pkg/neutron.json`                  | `/pkg/neutron.json`                  |
| `legal/package-record.v1.json` | `pkg/legal/package-record.v1.json` | `/pkg/legal/package-record.v1.json`  |
| `legal/APPLICATION-NOTICE.txt` | `pkg/legal/APPLICATION-NOTICE.txt` | `/pkg/legal/APPLICATION-NOTICE.txt`  |
| `legal/LICENSE*.txt`           | `pkg/legal/LICENSE*.txt`           | `/pkg/legal/LICENSE*.txt`            |
| `legal/THIRD_PARTY_NOTICES.md` | `pkg/legal/THIRD_PARTY_NOTICES.md` | `/pkg/legal/THIRD_PARTY_NOTICES.md`  |
| `legal/archive-only/**`        | not staged                          | not stored                           |
| `legal/source/app-source.v1.msgpack` | not staged                    | not stored                           |
| `mo/<hash>.mo`                 | `mo/<hash>.mo`                      | `/mo/<hash>.mo`                      |

For a normal app package, `app_prefix` is `app/<id>/`:

| Package path                   | Rewritten path                               | Stored key                                    |
| ------------------------------ | -------------------------------------------- | --------------------------------------------- |
| `web/index.html`               | `app/<id>/index.html`                        | `/app/<id>/index.html`                        |
| `web/static/icon.png`          | `app/<id>/static/icon.png`                   | `/app/<id>/static/icon.png`                   |
| `neutron.json`                 | `app/<id>/pkg/neutron.json`                  | `/app/<id>/pkg/neutron.json`                  |
| `legal/package-record.v1.json` | `app/<id>/pkg/legal/package-record.v1.json` | `/app/<id>/pkg/legal/package-record.v1.json`  |
| `legal/APPLICATION-NOTICE.txt` | `app/<id>/pkg/legal/APPLICATION-NOTICE.txt` | `/app/<id>/pkg/legal/APPLICATION-NOTICE.txt`  |
| `legal/LICENSE*.txt`           | `app/<id>/pkg/legal/LICENSE*.txt`           | `/app/<id>/pkg/legal/LICENSE*.txt`            |
| `legal/THIRD_PARTY_NOTICES.md` | `app/<id>/pkg/legal/THIRD_PARTY_NOTICES.md` | `/app/<id>/pkg/legal/THIRD_PARTY_NOTICES.md`  |
| `.neutron/browser-surface-origins.v1.json` | `app/<id>/pkg/.neutron/browser-surface-origins.v1.json` | `/app/<id>/pkg/.neutron/browser-surface-origins.v1.json` |
| `legal/archive-only/**`        | not staged                                   | not stored                                    |
| `legal/source/app-source.v1.msgpack` | not staged                              | not stored                                    |
| `mo/<hash>.mo`                 | `mo/<hash>.mo`                               | `/mo/<hash>.mo`                               |

The backend does not infer directory indexes or prepend slashes. `http_request`
separates an admitted query string from the canonical asset path, rejects
fragments, and then looks up that exact asset key. This lets tile iframe URLs
carry app/tile/instance context in query parameters while still serving the
stored `/app/<id>/<path>` asset.

### `/system/apps.json` Registry

`apps/kernel/src/reducer/apps.ts` treats `/system/apps.json` as the frontend app
registry. After authorization, `getApps()` fetches it through certified HTTP
v2, normalizes it through the shared registry helper, and replaces the Zustand
app store with that registry. A missing registry and HTTP/read failures are
explicit registry errors; they are not treated as an empty installation.

During browser install, `install_app()` builds a new registry object from the
current Zustand app list plus the package being installed. The registry value for
the kernel package is:

```json
{
  "kernel": {
    "link": "/",
    "name": "<manifest name>",
    "version": 100,
    "format": 3,
    "icon": "/static/icon.png",
    "tiles": [],
    "capability_plan": {
      "format": 1,
      "app": { "id": "kernel", "version": 100 },
      "entries": ["<closed canonical entries>"]
    },
    "capability_plan_fingerprint": "<64 lowercase hex characters>",
    "functions": ["<normalized function entries>"]
  }
}
```

The registry value for a normal app is:

```json
{
  "<id>": {
    "link": "/<id>",
    "name": "<manifest name>",
    "version": 100,
    "format": 3,
    "icon": "/app/<id>/static/icon.png",
    "tiles": [
      {
        "id": "main",
        "title": "<tile title>",
        "path": "index.html",
        "icon": "/app/<id>/static/icon.png"
      }
    ],
    "capability_plan": {
      "format": 1,
      "app": { "id": "<id>", "version": 100 },
      "entries": ["<closed canonical entries>"]
    },
    "capability_plan_fingerprint": "<64 lowercase hex characters>",
    "functions": ["<normalized function entries>"]
  }
}
```

The examples abbreviate the bounded plan and function rows; the actual registry
is closed and contains no placeholder values. Its fingerprint is recomputed
and verified before any plan field is used.

The `link` field is retained as navigation metadata. The current kernel UI
does not launch apps by hash route. `Launcher.tsx` flattens each non-kernel
registry entry's `tiles[]` into openable tile actions. Selecting a tile creates
a workspace tile instance. On the browser-surface-origin runtime, an app listed in
`/system/browser-surface-origins.json` loads its tile from an
installation-owned, per-tile hostname:

```text
https://i<surface-nonce>--<neutron_id>.icp0.io/app/<id>/<tile.path>?app=<id>&tile=<tile-id>&instance=<instance-id>&workspace=<workspace>
```

The Kernel derives `surface-nonce` from the app installation's existing
`browser_origin_nonce` and the exact surface key, and uses its first 96 bits as
the 24 lowercase hexadecimal characters after `i`. Each tile ID, the tray, and
the ordinary background have different origins; instances of one tile ID share
that tile origin. An in-place upgrade that retains the installation nonce keeps
these origins stable, while uninstall/reinstall and an authority transition
that rotates the nonce replace them. The same scheme is used by the standard
local gateway on `localhost:8000`.

These frames remain credentialless. A supported browser receives
`sandbox="allow-scripts allow-same-origin"`; any exact tile browser-permission
declaration is delegated separately by the iframe policy. If the required
credentialless behavior cannot be proved before navigation, the Kernel keeps
the surface URL but removes `allow-same-origin` and browser-feature delegation,
so the document remains opaque.

An unmarked historical package that does not declare `browser_permissions`
does not appear in the sidecar. It retains its released legacy URL selection
(an unprefixed or `a<dns-app-id>a` hostname, as applicable),
`sandbox="allow-scripts"`, opaque `origin: "null"`, and no browser-feature
delegation. The explicit predecessor assembly bridge uses that same legacy
policy. The
Kernel does not infer adoption from an app ID, version, route, or unrelated
capability.

An `i<surface-nonce>` Host selects one compiled app installation and surface
and may execute or load subresources only from that app's `/app/<id>/`
subtree. Other-app and Kernel paths, stale nonces, wrong destinations, raw or
custom gateways, and alternate ports fail closed. The one cross-subtree rule
is a passive, programmatic fetch of the exact no-query
`/system/runtime-config.json` URL with exactly one `Sec-Fetch-Dest: empty`; it
does not grant document or worker authority. Unprefixed Kernel origins
continue to serve public app HTML, scripts, icons, and committed package
metadata under `/app/<id>/pkg/**`, but those public app documents are never
installation origin authority. Kernel registry entries always normalize to
`tiles: []`, so the default Kernel does not appear as a normal app tile in the
launcher.

Dedicated resident backgrounds continue to use their separate
credentialless-ephemeral or persistent policies, with an exact nonce-prefixed
Host and certified initial-document request. Their CSP, Host, query,
destination, and origin rules are specified in
[Dedicated Resident Origins](./kernel-http-v2-and-certified-assets.md#dedicated-resident-origins).

### `/system/browser-surface-origins.json` Authority Sidecar

The browser-surface-origin frontend treats
`/system/browser-surface-origins.json` as the public, certified list of ordinary
apps that may use installation-owned surface
origins. Its closed canonical shape is:

```json
{
  "format": 1,
  "app_ids": ["<sorted installed non-kernel app ids>"]
}
```

The list must contain only unique, currently installed non-Kernel app IDs in
canonical order. The browser-surface-origin runtime requires the sidecar even
when the list is empty; absence is valid only for the explicit predecessor
bridge. A malformed, missing, stale, or registry-inconsistent required sidecar
fails closed instead of making any app originful.

Origin adoption is package-derived and app-agnostic. A selected ordinary app
package is eligible when it contains the exact packer-owned
`.neutron/browser-surface-origins.v1.json` marker or declares the inherently
new `browser_permissions` capability. The current packer adds the marker to
future ordinary app archives; immutable historical archives remain unmarked
and opaque. A checked browser-surface-origin install commits the selected
package files, surface response policies, `/system/apps.json`, and this sidecar
atomically. It keeps
already-adopted IDs through unrelated transactions and approved upgrades, and
removes an ID on uninstall.

The sidecar contains no installation UID, browser-origin nonce, authority
epoch, credential, or secret. It is served as ordinary certified HTTP v2
metadata on public non-installation authorities, while installation-surface
Hosts cannot fetch it. After fresh provisioning seeds it once, direct static
store retries must match the existing bytes and direct delete or broad-clear
operations cannot change it; subsequent changes belong to the checked install
journal.

### `/pkg` Metadata

Installable non-`web/` and non-`mo/` package files are stored under a package
metadata prefix:

- Kernel package metadata uses `/pkg/<path>`.
- Normal app package metadata uses `/app/<id>/pkg/<path>`.

The packaged `neutron.json` therefore becomes `/pkg/neutron.json` for the
kernel and `/app/<id>/pkg/neutron.json` for a normal app. The fixed
`legal/package-record.v1.json` sidecar follows the same mapping to
`/pkg/legal/package-record.v1.json` or
`/app/<id>/pkg/legal/package-record.v1.json`.

Provider-hosted production packages install their governing license and notices
from ordinary `legal/**` package paths. Their package record identifies a
generator-produced Complete App Source gzip artifact at the update source's
certified `/repo/v1/sources/<sha256>.source.v1.msgpack.gz` path. That source
object is not inside the `.neutron` archive and is never staged in the user's
canister.

The two reserved groups apply only to the explicit embedded-source form:
`legal/archive-only/**` holds its bulk legal corpus, and
`legal/source/app-source.v1.msgpack` holds its bounded Complete App Source
snapshot. Package preparation verifies their record-bound bytes and source
semantics before excluding them from the staged file list.

Current browser and CLI consumers read committed metadata through IC HTTP
response certification version 2:

- `compile_app()` reads `/pkg/neutron.json` for the kernel manifest.
- `compile_app()` reads `/app/<id>/pkg/neutron.json` for each installed app
  manifest listed in `/system/apps.json`.
- Settings structurally reads each installed package-information record and
  its manifest. It verifies installed license and notice files for a
  provider-hosted package without fetching its HTTPS source offer. For the
  explicit embedded form, it labels absent archive-only material as retained in
  the original package.
- `install_app()` stores the latest generated Candid text at `/pkg/neutron.did`
  and stages the reviewed deployment record before calling the inline or
  chunked install-code path.
- The first dynamic self-actor request reads `/pkg/neutron.did` and passes it to
  `icblast`; concurrent requests share that load and later requests reuse the
  identity-generation-scoped actor.
- `neutron-provision` writes `/pkg/id.json` with the provisioned Neutron
  canister id during both IC and PocketIC installation.

`/pkg/neutron.did` and `/pkg/id.json` are runtime/deployment metadata files, not
files produced by `preparePackageFiles()` from the package layout.

The Kernel package also generates a closed installed-artifact inventory during
packaging. It binds the closed inspectable frontend and package file set to
final installed paths, byte lengths, and SHA-256 digests. Motoko modules are
omitted because their filenames already bind their content; the inventory
itself and selected runtime-generated artifacts included in the catalog are
anchored separately. Bounded package-owned text files installed beneath the
HTTP-internal system subtree are carried inline with the same digests and
lengths, so the frontend can inspect them without changing public HTTP
admission. General mutable system records remain outside the inventory. The
inventory is needed because a Kernel upgrade does not clear the whole root
namespace, so a broad
root listing could include superseded frontend chunks. Ordinary app replacement
instead clears and promotes that app's complete `/app/<id>/` subtree. After
excluding Kernel-owned route records, its remaining keys are the exact static
inventory for that app. The Kernel inventory is ordinary package metadata
handled by the unchanged static asset store; it introduces no backend method or
managed-memory root.

### Installed App Assets Under `/app/<id>/`

Normal app frontend files are served under `/app/<id>/`. The install-time app id
comes from `neutron.json` and is validated in `get_app_details()` after schema
validation:

- It must be a string.
- Its length must be between 4 and 30 characters.
- It may contain only lowercase letters, digits, and `_`.
- The special id `kernel` uses the kernel root prefixes instead of
  `/app/kernel/`.

The code does not add a backend redirect from `/<id>` to `/app/<id>/index.html`.
The kernel frontend owns app navigation and explicitly constructs the iframe URL
under `/app/<id>/index.html`.

### Motoko Module Files Under `/mo`

Motoko files are stored in one shared content-addressed namespace:

```text
/mo/<sha256>.mo
```

During install preparation, each package path under `mo/` must be exactly
`mo/<sha256>.mo`. `preparePackageFiles()` hashes the decompressed file bytes with
`hashContent()` and rejects the package if the filename does not match the
content.

The compiler path uses this same namespace:

- `readKernelPackageState()` calls
  `kernel_static_query({ list: { prefix: "/mo/" } })` through an injected
  `listStatic` callback.
- It fetches every returned path as text through an injected `fetchText`
  callback.
- The shared state reader strips the `/mo/` prefix before passing module
  content to the compiler.
- New package modules are also added from prepared install files whose rewritten
  path starts with `mo/`.

There is no per-app Motoko module directory. Different apps can share identical
modules by hash. A successful install commit removes only content-addressed
modules that were in that install's authenticated baseline and are absent from
the newly compiled reachable-module set. Unknown concurrent uploads are not
globally scanned or deleted.

Installed-artifact inspection therefore derives a per-app backend view from
the selected installed manifest rather than assigning the global module store
to every app. It verifies the main manifest entry, every current non-retired
memory-schema entry, and module filename digests, then follows content-addressed
imports. Those required roots and their reachable dependencies must be present.
Available installed modules reachable from historical, migration, and retired-
memory declarations are included. An absent optional root or dependency is not
catalogued because module garbage collection may legitimately have removed it;
its declaration or import remains visible in retained text.

### Upload Chunking, MIME, And Content Encoding

`uploadPreparedFiles(neutron, files)` defaults to at most 10 file tasks
concurrently and accepts an explicit caller limit. Each file task uploads chunks
sequentially:

1. Determine `content_type` with `mime(path)`.
2. Use `application/octet-stream` for unknown extensions.
3. Set `content_encoding` to `identity` for MIME types beginning with `image/`.
4. Set `content_encoding` to `gzip` for all other MIME types.
5. Gzip the file only when `content_encoding` is `gzip`.
6. Split the processed bytes into 1 MiB chunks.
7. Send chunk 0 with `kernel_static({ store: ... })`.
8. Send chunks 1..N with `kernel_static({ store_chunk: ... })`.

The MIME table includes common image, text, JSON, XML, Markdown, video, and audio
extensions. Only `image/*` changes the encoding decision; video, audio, JSON,
JavaScript, CSS, HTML, and unknown binary files are stored with `gzip`.

The backend stores the supplied `content_type` and `content_encoding` and later
returns them directly as HTTP response headers. It does not inspect content,
negotiate `Accept-Encoding`, or recompress files.

### Backend Asset DB, Index, And Certified HTTP

`apps/kernel/backend/assets.mo` defines the stable asset store:

```motoko
public type Doc = {
    id: Text;
    chunks: Nat;
    content: [Blob];
    content_encoding: Text;
    content_type: Text;
};
```

`Assets.Init` is `Map.Map<Text, Doc>`. `Assets.use()` wraps that Core map with
asset-specific `put`, `get`, `delete`, prefix iteration, and bounded key-listing
operations using `Text.compare`.

`apps/kernel/backend/main.mo` keeps asset storage and certified HTTP memory in
the kernel persistent memory record:

- `assets : Map.Map<Text, Asset>`
- `cert : CertTree.Store`

`kernel_static(cmd)` supports four mutations:

| Command        | Behavior                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#store`       | Asserts `chunks > 0`, calls `cert.chunkedStart`, and inserts the `Assets.Doc` only when the certified HTTP helper's chunk callback receives all chunks. |
| `#store_chunk` | Sends a later chunk through `cert.chunkedSend`.                                                                                                         |
| `#delete`      | Deletes the primary-key entry and certification state for one key.                                                                                      |
| `#clear`       | Scans the primary-key range from `prefix` to `prefix # "~"` and deletes each matching DB row and certification entry.                                   |

`kernel_static_query({ #list = { prefix } })` uses the same lexical prefix range
and returns up to 20,000 matching keys. The backend detects a 20,001st match and
traps rather than returning an incomplete result.

The generated actor protects `kernel_static` and `kernel_static_query` with the
normal authorization check. `kernel_static_query` remains only a bounded key
list: compiler clients use it to discover `/mo/` module names, and the trusted
Kernel frontend also uses it to enumerate one ordinary app's exact
`/app/<id>/` subtree for installed-artifact inspection. Asset contents are not
returned through an actor query. Browser and CLI clients fetch listed modules
and committed package metadata over HTTP. `http_request` is explicitly allowed
for unauthorized callers.

### `http_request` Static Lookup And IC Response Certification

`http_request` requires certificate version 2+ for both reads and POST
preflight. Certified reads additionally require an empty body and bounded
headers/URL/path depth. Its shared boundary also admits POST
only to preflight a declared update mount and return `upgrade = true`; it never
executes app code in the query. Declared routes resolve first and the static
fallback remains exact GET only. It rejects
percent escapes, repeated slashes, backslashes, fragments, controls, and dot
segments before performing one primary-key lookup of the query-free path:

```motoko
assets.pk.get(assetUrl(request.url))
```

Before lookup, the backend keeps `/system/**` HTTP-internal except for exact
`/system/apps.json`, `/system/browser-surface-origins.json`,
`/system/install-provenance.json`, `/system/runtime-config.json`, and
`/system/deployment-build-record.json`. A denied internal path and a missing
key both return the same fixed `404` body. Committed `/system/apps.json`,
`/system/browser-surface-origins.json`, `/system/install-provenance.json`,
`/system/runtime-config.json`, `/system/deployment-build-record.json`, `/mo/**`,
`/pkg/**`, and
`/app/<id>/pkg/**` keys are ordinary certified HTTP assets. Present static
assets return their stored encoding and may use the kernel-owned chunk
streaming callback. Their exact response profiles, cache rules, request
expressions, Host policy, certified miss behavior, and qualification status are
specified in
[Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md).

The `http_assets/<key>` tree retains the complete stored-body hash used when
publishing the public certified response. It is not exposed through a separate
static-read Candid method. Certification state survives actor upgrades, so
ordinary initialization and install commit do not scan or republish existing
package assets. Each staged package file is certified once when it is promoted,
using the exact capability state that the same atomic commit will publish. An
explicit resident-origin policy toggle may reconcile that one app's package
prefix; it does not touch app-scoped certified asset records.

Kernel 316 has one structural exception because its child-response security
headers change. During the exact pre-316-to-316 activation boundary, the
backend grafts each installed app subtree plus the complete `/mo` and `/pkg`
subtrees back unchanged. It moves every remaining predecessor expression below
the fixed `neutron_retired_http_expr_v316` top-level label, which the HTTP v2
protocol cannot select because a response expression path must begin with
`http_expr`. A non-URL sentinel records completion even when no retired branch
remains. Initialization first reclaims every known Kernel expression from that
quarantine, then rebuilds those responses from their existing body hashes and
installs the current 404. Unknown predecessor branches remain authenticated but
HTTP-inaccessible. The whole cutover occurs in the activation publication
batch; a bound or capacity trap rolls the actor upgrade back to the predecessor
without publishing a partial root. It adds no managed-memory root or response
body copy.
Consequently, a kernel upgrade with 100 installed apps has no work proportional
to those apps' certified record counts or body bytes; only bounded app/mount
metadata and the package files of the app being changed enter its install path.

Certified HTTP is an integrity mechanism, not an inventory-confidentiality
boundary. Committed registry/package/compiler assets and a guessed public app
path such as `/app/hello/index.html` are anonymously requestable. Bootstrap
claim records, in-flight staging data, and any future non-allowlisted
`/system/**` records remain HTTP-internal. The deployment build record is
public integrity evidence and must not contain owner authorization,
controllers, credentials, installation UIDs, or browser-origin nonces.

Under the NPL/NSAL private-assembly rules, this automatic runtime availability
does not by itself make the Sovereign User a distributor or source host. The
user assumes distribution duties only by affirmatively acting to distribute the
software itself; ordinary app communication and exchange of User Data do not.

This change does not alter package-repository transport. The separate
`repo_*` actor API still returns certified query resources and chunks, and its
clients still use `packages/neutron-tools/src/certified_asset.ts` to verify
those proofs. Repository responses are not kernel static HTTP assets.

### App-Scoped Certified Asset Reads

The complete, current contract is
[Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md).
The authored `certified_assets` declaration retains `api: 2` as the current
declaration and backend-handle version. It is not an authored HTTP-route
version. The declaration contains only generic app-scoped collections:

- `publication` allocates opaque host-bound objects and supports certified
  `GET`, `HEAD`, and bounded ranges;
- `immutable_blob` uses the exact body SHA-256 under a declared prefix and
  supports portable certified `GET`; and
- `mutable_blob` uses a declared prefix or exact path, mutates through CAS, and
  supports portable certified `GET`.

The compiler groups collections by mount and synthesizes
`certified_read_routes` under `/app/<app-id>/_route/<mount-id>`. Those reads do
not stream or fall through to static assets. Authored `http_routes` remains the
separate API-1 POST-update contract below.

### App-Scoped POST Update Routes (API 1)

An `http_post_update_handler` mount uses either the exact app Host plus authored
prefix or the exact ordinary Neutron Host plus derived shared base, but exactly
POST and an internal synchronous compiler-bound handler. Request
and reply ceilings are each 1–65,536 bytes. The declared external-traffic rate
is 1–240 calls/hour, and at
most eight declared safe lowercase headers are forwarded. App-wide update
mounts total at most 240 calls/hour and 8 MiB of possible one-hour replay
replies.

`http_request` only validates enough to bind an exact live mount and return
`upgrade = true`. Once a mount owns the path, malformed route headers or a
mount-oversized body still upgrade; `http_request_update` returns their stable
400/413 response. This avoids sending an uncertified query error that a
response-verifying gateway would replace with a verification failure.
`http_request_update` independently repeats canonical Host/path/body/header,
scope, mount fingerprint, runtime toggle, external-caller rate, concurrency, and idempotency
checks before persisting admission. It then awaits a compiler-owned self-only
wrapper that rechecks the dispatch and calls exactly one synchronous handler.
The handler receives canonical relative path, explicitly forwarded headers,
bounded body, and a digest of the raw `Idempotency-Key`; it receives no scope,
actor, raw HTTP response, or injected capability.

Each forwarded value is at most 4,096 bytes and a declared header may occur
only once. Cookie/Set-Cookie, duplicate declared headers, and duplicate or
non-`identity` Content-Encoding reject the request; the broker does not silently
strip and continue.

Every POST requires a 16–64-character ASCII alphanumeric/underscore/hyphen
idempotency key. HTTP gateways call anonymously and consume the mount/app/global
request windows. A kernel-authorized principal calling the Candid update method
directly is neither limited nor counted, while still passing every mount,
capacity, concurrency, lifecycle, cycle, and idempotency check. During the
one-hour window, an exact completed duplicate replays its stored status,
content type, and body without app execution; changed input is `409`; and
pending/unknown state never redispatches. For external traffic the stable rate
charge, and for all callers the replay reservation, are committed before the
handler self-call, so a trap does not refund external admission
or permit a cycle-draining retry. Runtime disable denies every POST, including
replays. Exact re-enable can replay a compatible completed result, but cannot
resume an old pending dispatch. V1 has no separate per-handler instruction
allowance below the IC update-message limit; one admitted call may consume up
to that platform limit. Compiler-generated wrappers measure the outer broker
message and inner handler message independently for the owning app's
exact-installation telemetry, which contributes to the Installed Apps
cycles-used summary.

The response status is restricted to 200, 201, 202, 400, 401, 403, 404, 409,
or 422. The app additionally supplies one validated content type and bounded
body; the kernel owns all headers and forbids CORS, cookies, redirects,
app-controlled cache/security policy, encoding, and streaming. If the gateway
follows the honest upgrade, the reply is authenticated by update-call consensus
rather than the certified query tree. Query preflight only selects the upgrade
path; it does not execute app code or return app output. Production qualification
must cover the deployed gateway's upgrade behavior in addition to the
canister-side unit, compiler, lifecycle, and install-disclosure coverage.

### Provisioner Asset Writes

`packages/neutron-provision` is the only whole-canister seeder for production
or local development. After installing the complete actor it:

1. binds `/system/runtime-config.json` after the final canister id is known,
   including the exact isolated-frame origin template and explicit
   update-source origin;
2. clears the static namespace with
   `kernel_static({ clear: { prefix: "" } })`;
3. walks every prepared Kernel and app file, deduplicating identical bytes that
   resolve to the same final content-addressed path and rejecting conflicting
   bytes for one path;
4. uploads each unique file through `uploadPreparedFiles()`;
5. writes `/pkg/neutron.did`, `/system/apps.json`,
   `/system/browser-surface-origins.json`,
   `/system/install-provenance.json`, `/pkg/neutron.most`, and `/pkg/id.json`
   as separate file operations; and
6. verifies those files and the browser entrypoint through certified HTTP.

Concurrency changes scheduling only. Local reinstall currently schedules up to
512 file tasks concurrently, while each `kernel_static` update contains exactly
one file operation or one subsequent chunk of that same file. It never combines
multiple files into one update call. The initial `#store` and any required
`#store_chunk` calls for a large file remain sequential within that file task.

The same seeder is used after a paid IC creation, an IC destructive reinstall,
and a PocketIC install/reinstall. Local developer authorization and ledger
funding occur in the provisioner around that same fresh-system flow; there is no
separate local boot asset loader.

## Inferred Design Intent

The asset store appears to be both a static web server and the package database
for the user's Neutron canister. Frontend assets are served to browsers,
package manifests are fetched by the installer/compiler, Motoko modules are
reused as compiler inputs, and Candid metadata is fetched by the frontend before
creating an authenticated actor.

The path layout appears intended to separate concerns:

- `/` and `/static/...` are the kernel UI.
- `/system/apps.json` is the small kernel-owned app registry.
- `/system/browser-surface-origins.json` is the public browser-surface authority sidecar
  listing installed ordinary apps adopted onto installation-owned surface
  origins.
- `/system/deployment-build-record.json` is the canonical whole-deployment
  build and install record when one has been committed.
- `/pkg/...` is kernel package/runtime metadata.
- `/app/<id>/...` is each installed app's frontend and package metadata.
- `/mo/<hash>.mo` is a global content-addressed Motoko module store.

Install uploads immutable content-addressed modules early. Mutable files and a
bounded obsolete-baseline-module list are written only under
`/system/staging/<deployment-id>/` until the expected actor responds; journal
commit then promotes/certifies mutable files, including a prepared deployment
record when present, and removes the validated obsolete modules atomically.

## Open Questions And Gaps

- Static public assets support bounded exact GET and do not negotiate Range or
  `Accept-Encoding`. Host-bound `publication` collections support certified
  `GET`/`HEAD` and a bounded single range; portable `immutable_blob` and
  `mutable_blob` collections are certified GET-only. See
  [Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md).
  Authored API-1 update mounts separately support bounded POST.
- `http_request` serves only exact keys. There is no backend fallback from
  `/app/<id>/` or `/app/<id>` to `/app/<id>/index.html`.
- Journal commit clears a replaced or removed `/app/<id>/` prefix before
  promoting its complete staged file set. Obsolete `/mo` hashes from the
  checked pre-install baseline are garbage-collected inside that commit.
- The backend accepts and stores whatever `content_type` and `content_encoding`
  the caller supplies. It does not validate MIME values, encoding values, or
  whether the body bytes actually match the headers.
- `kernel_static_query` uses a lexical range from `prefix` to `prefix # "~"` and
  caps complete results at 20,000 keys, trapping on overflow. It is a
  convention-based prefix lookup, not a path-segment-aware directory listing.
- `/pkg/neutron.did` is written by the frontend and read by the frontend. The
  backend accepts `candid` in `kernel_install_code` but does not verify it or
  store it itself.
