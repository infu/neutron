# Repository Setup Manifests

[Back to the documentation index](./index.md).

Neutron Repository Protocol v1 adds an optional way for an independent
provider to offer one or more `.neutron` packages as a setup. It does not add a
Neutron marketplace, default catalog, operated package repository, update feed,
or separate Kernel protocol. With no setup fragment, the dispenser, manual
file installer, Kernel replacement flow, and ordinary Neutron UI behave as
before.

Repository setup remains setup-only. App updates reuse the repository v1
content-addressed package path but add a separate fixed certified HTTP release
asset at `/repo/v1/releases/<app-id>.json`. Settings requests only installed
app IDs that explicitly name a source and never turns a setup manifest into an
update feed. See [App Package Updates](./package-updates.md).

The implementation is split between:

- `packages/neutron-tools/src/repository.ts`, which owns the v1 wire model,
  strict schemas, limits, link parsing, and transient handoff helpers;
- `support/dispenser/`, which transfers a validated setup reference in the
  browser without adding it to a dispenser backend request;
- `apps/kernel/src/repository/`, which obtains contact consent, verifies the
  repository, reconciles installed apps, and drives one batch install;
- `packages/neutron-compiler/`, which performs bounded package decoding and the
  existing compile/journal/deploy transaction; and
- `support/repository/`, a static example provider template, not an official or
  production repository.

## Provider Link

The canonical provider link is:

```text
https://<dispenser-origin>/#repo=<canister-principal>&manifest=<manifest-id>&digest=<64-lowercase-hex>
```

The current SushiOS production dispenser origin is
`https://2h7je-aiaaa-aaaay-aacra-cai.icp0.io/`. A provider may use a different
deployed dispenser by setting its own origin explicitly.

All three fields are required and occur in the URL fragment. Query-string
forms are rejected. The fragment keeps the selection out of the HTTP request
to the dispenser, but it is not a secret: it can briefly be visible to the
address bar, extensions, screenshots, the clipboard, or anyone who receives
the link.

The fields mean:

- `repo`: the canonical principal of the repository canister;
- `manifest`: a bounded identifier matching
  `^[a-z0-9][a-z0-9_-]{0,63}$`; and
- `digest`: SHA-256 of the exact certified manifest bytes.

The digest pins a named manifest. If a provider later changes those bytes, an
old link fails instead of silently selecting the replacement. A provider can
still issue a unique syntactically valid manifest id or digest and correlate a
later request with that link; the first-contact dialog discloses this before
the browser contacts the canister.

## Dispenser And Activation Handoff

The dispenser frontend captures, validates, stores in same-tab session state,
and removes the provider setup fragment before provisioning work. It appends a
canonical internal fragment only to the user's Neutron link. Repository fields
do not enter `provision()`, any query parameter, or the dispenser's persistent
registry. Opening a setup link for an existing completed canister opens that
canister; it does not mutate it until the authenticated owner reviews the
repository setup inside Neutron.

The same internal fragment also carries the dispenser's independent
`activate` bearer. Internet Identity principals are scoped to the frontend
origin, so the dispenser does not attempt to reuse its local Ed25519
provisioning principal as the browser principal for the new Neutron. The kernel
captures both handoffs before Internet Identity, uses the activation code once
to authorize the actual Neutron-origin caller, and then resumes repository
setup only after authorization and registry load.

Both frontend entrypoints run a small bootstrap/capture path before their main
work and handle a later `hashchange`. The kernel requires durable same-tab
storage and successful address-bar removal for its internal setup and
activation values; failure rolls back and stops startup. The provider
dispenser may retain a parsed repository setup in the already-mounted page when
session storage is unavailable, but it does not put that value in a backend
request. Kernel and dispenser HTML also set a `no-referrer` policy.

## Public Repository Query API

Repository resources are public. After the authenticated owner clicks
`Load setup`, the kernel creates a separate anonymous `HttpAgent` and calls a
fixed Candid interface:

```candid
type read_request = record { index : nat };
type manifest_read_request = record { id : text; index : nat };
type package_read_request = record { sha256 : text; index : nat };

type certified_value = record {
  content : blob;
  chunks : nat;
};

type certified_read = record {
  certificate : blob;
  witness : blob;
  asset : opt certified_value;
};

service : {
  repo_info : (read_request) -> (certified_read) query;
  repo_manifests : (read_request) -> (certified_read) query;
  repo_manifest : (manifest_read_request) -> (certified_read) query;
  repo_package : (package_read_request) -> (certified_read) query;
}
```

The kernel uses `repo_info`, `repo_manifest`, and `repo_package` for a setup.
`repo_manifests` exists for provider tooling; Neutron does not call it to build
a catalog.

Anonymous calls prevent the repository method from receiving the owner's
Internet Identity principal. They do not provide network anonymity: an IC
gateway and network infrastructure can still observe request metadata. The
transport forces `credentials: "omit"`, `referrerPolicy: "no-referrer"`, and
`cache: "no-store"`.

Anonymous transport is independent of integrity. Every accepted response must
carry an IC certificate and an exact Merkle witness bound to the selected
canister and certified resource path. The shared certified-asset reader checks
the root of trust, canister id, certificate freshness, witness, chunk count and
size, complete byte count, and whole-resource hash. In local development the
anonymous agent first fetches the local replica root key.

## Certified Resources

The v1 certified tree uses the existing `http_assets` label. The setup flow
consumes exactly these keys:

```text
/repo/v1/info.json
/repo/v1/manifests.json
/repo/v1/manifests/<manifest-id>.json
/repo/v1/packages/<sha256>.neutron
```

The same v1 namespace also defines `/repo/v1/releases/<app-id>.json`, used by
the separate owner-triggered update-check flow rather than by setup. The static
example provider under `support/repository/` generates only the four setup keys
above.

These are certified-tree keys read through Candid queries, not public `GET`
routes. Each leaf contains SHA-256 of the complete raw resource. Package chunks
are exact `.neutron` bytes; there is no extra transport gzip layer.

`info.json` is a closed object containing protocol, repository name, and
provider name, with optional bounded descriptions and HTTPS-only website,
terms, privacy, and support links. All provider names, descriptions, links,
publisher claims, and source claims are rendered as repository-provided and
unverified plain text. They cannot supply HTML, executable UI, Candid, method
names, install scripts, or fetch URLs.

A setup manifest is also a closed object:

```json
{
  "protocol": "neutron-repo-v1",
  "id": "demopack",
  "revision": 1,
  "name": "Demo Pack",
  "description": "Hello and Kitchen Sink examples",
  "packages": [
    {
      "id": "hello",
      "version": 100,
      "sha256": "<sha256-of-exact-neutron-package>",
      "size": 165459,
      "publisher": {
        "name": "Example publisher",
        "website": "https://example.invalid/"
      },
      "source": "https://example.invalid/source/hello"
    }
  ]
}
```

The outer entry supplies exact download expectations. After download, the
package's own `neutron.json` remains authoritative for app identity, name,
permissions, dependencies, files, memory, and runtime behavior. The importer
rejects an outer id or version that does not match the prepared package. It
also rejects duplicate ids or digests and any repository package whose id is
`kernel`. Deliberate local-file kernel replacement remains supported.

`manifests.json` is a bounded, sorted index of provider-generated manifest
summaries and exact manifest digests. It is useful for the provider's tooling
but is not fetched by the setup dialog.

## Owner Workflow

The root-level repository controller becomes active only after login,
authorization, and a verified app registry load.

1. **Contact decision.** The dialog shows the repository principal, manifest
   id, pinned digest, anonymous-query behavior, remaining network visibility,
   and identifier-correlation warning. No repository request occurs before
   `Load setup`.
2. **Uniform verification.** After that click, the kernel acquires the same
   app-operation mutex used by manual installation, snapshots authenticated
   package/runtime state, verifies repository information and the pinned
   manifest, then fetches, verifies, and prepares every package in the
   manifest. It does this even for an app that is already installed, so omitted
   package requests do not reveal the installed subset.
3. **Reconciliation and selection.** Installed presence is the union of the
   local registry, compiled package configurations, and running actor state.
   Any present or inconsistent id is conservatively shown as
   `Installed — skipped`; repository setup never updates, downgrades, replaces,
   or uninstalls it. Missing apps start unchecked. Selecting a dependent
   automatically selects and locks its missing dependency closure. A too-old
   installed dependency blocks the selection rather than being updated.
4. **Review and compile.** Selection is local and causes no further repository
   request. `Review N applications` freezes the selected closure, shows
   verified package facts and kernel-derived permission disclosures, preflights
   the selected mutable-file count against the kernel's 4,000-copy journal
   limit, and calls `compilePackages()` once for the batch.
5. **Final install.** `Install N applications` rechecks registry, compiled
   configuration, runtime deployment identity, stable signature, and private
   provenance. It then calls `deployPreparedPackages()` once. One journal
   stages the selected web/package metadata and provenance, activates one
   combined actor, verifies it, and commits active assets atomically. The same
   commit removes only content-addressed modules from the authenticated
   pre-install baseline that the compiled actor no longer reaches; it never
   scans or deletes unknown concurrent uploads.

The repository session holds the compiler/deployment mutex from `Load setup`
through cancellation, failure, or completion. An additive
`kernel_install_begin_checked` compares the caller's expected running
deployment id before accepting the journal, closing the last cross-tab race.
It is the only supported journal-begin API in the development V1 baseline.
The journal also commits the current and target capability-plan fingerprint
inventories so activation cannot mix registry and actor projections.

Before and after every package-state baseline, the kernel frontend reconciles
an existing journal: it commits when the journal's runtime is active and waits
or refuses while another activation remains possible. A pre-activation journal
left by a crashed tab does not hide the current app registry. The owner sees an
persistent, nonmodal recovery panel in Settings and may discard that exact
staged deployment after the kernel's dispatch marker and ordered management
fence prove that no queued activation can still apply it. The journal continues
to fence app authority and further app mutations, but it does not block
unrelated Settings work. Neutron never aborts another tab's journal merely
because a timer elapsed.

No package is installed when the owner merely opens the link, logs in, loads
the manifest, changes selection, or compiles the review. If every id is already
present, the dialog reports `Nothing to install` and performs no compile or
update. A failed repository or validation request does not prevent ordinary
Neutron use. The same-tab setup reference expires after one hour; its timer
continues through loading, selection, and compilation. Once the owner approves
the exact compiled transaction, an in-flight deployment may finish. If that
deployment fails, the original deadline is restored and rechecked.

## Certified Provenance

A successful repository batch commits one minimal certified record at
`/system/install-provenance.json` in the same journal as the registry. The
record is served over the canister's certified HTTP surface and is not private:

```json
{
  "format": 1,
  "apps": {
    "hello": {
      "kind": "repository",
      "repository": "<repository-canister-principal>",
      "manifest_id": "demopack",
      "manifest_digest": "<manifest-sha256>",
      "package_digest": "<package-sha256>"
    }
  }
}
```

Only successfully selected apps are recorded. Neutron does not retain the raw
link, provider prose, informational links, unselected package ids,
fetch history, or timestamps. Settings shows this source and integrity record.
Uninstall removes the app entry, and a later manual file replacement clears a
stale repository entry. There is no subscription or callback to the provider.

## Bounds And Package Hardening

Important v1 remote-import limits include:

| Resource | Limit |
| --- | ---: |
| Packages in one manifest | 64 |
| One query chunk | 1 MiB |
| One raw package | 32 MiB / 32 chunks |
| Raw packages in one manifest | 64 MiB |
| Concurrent repository reads | 4 |
| Entries in one package | 4,096 |
| Entries across a manifest | 16,384 |
| One decoded entry | 16 MiB |
| Decoded files in one package | 64 MiB |
| Decoded files across a manifest | 128 MiB |
| Repository metadata or manifest JSON | 256 KiB each |
| Mutable asset copies in one install journal | 4,000, including four compiler/provenance assets |
| Complete authenticated static-key listing | 20,000; overflow traps instead of returning a partial baseline |
| Obsolete baseline module paths in one commit | 20,000 exact lowercase SHA-256 `.mo` names |

The package decoder preflights the flat MessagePack map instead of asking a
general-purpose decoder to allocate it first. It rejects excessive raw input,
entries, path bytes, compressed values, duplicate or dangerous keys, unsafe
paths, trailing data, multiple gzip members, invalid gzip footer/checksum, and
per-entry or aggregate decompression overflow. Multi-package preparation also
rejects duplicate app ids, duplicate mutable targets, and same-path Motoko
module conflicts while deduplicating byte-identical shared modules.

The repository limits are scoped to remote setup imports. The manual file
installer uses larger finite safety ceilings and retains its current package
and Kernel-replacement behavior. Repository setup consumes the current
`.neutron`, install-journal, and managed-memory contracts; it does not define
alternate versions of them.

## Static Example Provider

`support/repository/` is an independent static provider template. Its build
reads `repository.json`, inspects the actual `.neutron` files, derives their ids,
versions, sizes, digests, and chunks, serializes deterministic JSON, and writes
`mo/GeneratedRepository.mo`. Hand-authored configuration cannot override the
derived package identity or digest. Generation applies the same remote package
decoder, manifest-wide archive-entry and decoded-byte ceilings, and 4,000-copy
install-journal preflight that the browser enforces, so an example manifest that
cannot fit the kernel transaction is rejected before publication.

The example contains:

- `demopack`, referencing the local Hello and Kitchen Sink packages; and
- `hello`, referencing only Hello.

From the repository root, build the application packages before generating the
repository:

```sh
npm --workspace neutron-hello run package
npm --workspace neutron-kitchensink run package
npm run repository:generate
```

`npm run build:all` runs the repository-wide source build, app packaging, and
this generation step in dependency order. Repository Wasm compilation remains
a separate workspace command.

Supplying `REPOSITORY_CANISTER_ID` and `REPOSITORY_DISPENSER_ORIGIN` makes the
generator print pinned provider links after a repository has been deployed by
an operator. The generator does not deploy a canister, there are no root
commands to deploy either support canister locally, and the unified PocketIC
provisioner does not install either of them. The dispenser's checked-in IC
project contains only the production backend and frontend. The updater is a
separate certified asset canister and is not a setup repository.

The example canister exposes only the four query methods. It has no HTTP asset
endpoint, upload API, publisher accounts, or application-level admin method. It
is static, not inherently immutable: an IC controller can still replace its
code. Neutron does not publish, recommend, select, or operate it as a production
package source.

## Verification Surface

The fast tests cover strict fragment/schema parsing, capture and expiry,
certificate-path adapters, repository byte and digest verification, uniform
package reads, privacy fetch options, installed-state reconciliation,
dependency closure, private provenance, bounded package decoding, batch
collisions, checked journal activation, manual-authorization separation,
dispenser backend separation, and deterministic example generation and Motoko
lookup behavior.

There is no combined dispenser/repository Playwright fixture. The repository
provider is not part of the provisioner's PocketIC topology. The dispenser can
be deployed separately into the same running PocketIC for focused frontend,
starter, handoff, and CMC creation testing; its constructor-bound target is the
Application subnet attested by that supervised PocketIC runtime. The provisioner
independently owns a minimal update-source fixture; neither support component
is a repository alias. The provider template and protocol have focused
TypeScript and Motoko coverage, but Neutron configures no production repository
or setup link.
