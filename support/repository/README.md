# Neutron example repository

This directory is a static provider template for `neutron-repo-v1`. It is not a
Neutron marketplace, catalog, default source, recommendation, or production
service. The canister exposes exactly four public query methods:

- `repo_info({ index })`
- `repo_manifests({ index })`
- `repo_manifest({ id, index })`
- `repo_package({ sha256, index })`

Every response contains the selected raw chunk plus an IC certificate and an
exact `http_assets` Merkle witness. The certified keys are:

```text
/repo/v1/info.json
/repo/v1/manifests.json
/repo/v1/manifests/<manifest-id>.json
/repo/v1/packages/<sha256>.neutron
```

The canister has no HTTP asset endpoint, upload method, publisher account, or
application-level administrator. Its controller can still replace the code, so
the repository is static rather than inherently immutable. Setup links pin the
exact setup-manifest SHA-256 and fail if its bytes later change.

## Build the example

The checked-in configuration uses the real Hello and Kitchen Sink package
artifacts. Starting at the repository root, build those packages first, then
generate and compile the repository:

```sh
npm --workspace neutron-hello run package
npm --workspace neutron-kitchensink run package
npm run repository:generate
cd support/repository
mops install
npm run build:wasm
```

`npm run build:all` sequences the repository-wide build, package, and
generation phases in that order and stops if any app package validation fails.
It does not run browser tests, `mops install`, or compile `repository.wasm`.

`build:wasm` uses Neutron's exact vendored Motoko WebAssembly compiler and
emits `repository.wasm` plus its matching `repository.wasm.did` Candid
sidecar. It does not resolve or execute a host `moc`; `mops sources` is used
only to locate the package roots declared in `mops.toml`.

`build.ts` reads `repository.json`, fully validates each `.neutron` package,
derives its app ID and version from the internal `neutron.json`, computes its
raw size and SHA-256, deduplicates content-addressed package bytes, serializes
the info/manifests/index deterministically, and generates
`mo/GeneratedRepository.mo`. A package filename must agree with its actual
`<id>.v<major>.<minor>.<patch>.neutron` identity derived from the package's
packed manifest version. Hand-authored configuration cannot provide
or override an ID, version, digest, or size.

To print directly usable links after a canister ID is known, run the root
command from the repository root:

```sh
REPOSITORY_CANISTER_ID=rrkah-fqaaa-aaaaa-aaaaq-cai \
npm run repository:generate
```

The link builder defaults to the production SushiOS dispenser frontend,
`https://2h7je-aiaaa-aaaay-aacra-cai.icp0.io`. Set
`REPOSITORY_DISPENSER_ORIGIN` only when deliberately targeting another
deployed frontend.

The example defines two setup manifests:

- `demopack`, containing Hello and Kitchen Sink;
- `hello`, containing only Hello.

The same Hello package resource is emitted once and referenced from both
manifests.

## Deployment boundary

This package has no deployment manifest or local deployment command. The
unified PocketIC provisioner does not install the example repository or the
dispenser; normal app development uses exact archives pinned by a separately
named format-3 config and that config's destructive whole-fleet `reinstall`.
The root `local.ndeploy.json` is not consumed by this package. An operator who
deploys the example repository independently can pass its final canister ID to
`build.ts` to print pinned setup links.

The repository queries are intentionally public. The kernel waits for the
owner's explicit `Load setup` decision and then uses a separate anonymous agent,
so the repository canister does not receive the owner's Internet Identity
principal. Certification authenticates the returned bytes independently of the
anonymous caller.

## Tests

```sh
npm --workspace neutron-example-repository test
```

The TypeScript tests cover the closed build model, package-derived identity,
deterministic generation, content deduplication, paths, chunking, missing files,
and pinned links. The Motoko test covers static lookup/chunk behavior; compiling
`mo/main.mo` additionally verifies the four-method Candid surface.
