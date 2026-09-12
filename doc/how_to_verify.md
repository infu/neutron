# Source, Artifact, And Live-Canister Verification

Use this guide when establishing whether source, a prepared deployment, and an
installed canister correspond. It does not authorize deployment. Use
[Package Updates](./package-updates.md) for releases and
[Production Provisioning](./production-provisioning.md) for provisioning.

## Establish The Inputs

- Record the Neutron and compiler source revisions, working-tree changes,
  dependency lockfiles, and build runtime versions with the verification output.
  A clean build of current HEAD does not establish what an older release used.
- Obtain the exact selected package archives and their trusted release or
  deployment records. Check each archive's ID, version, size, and SHA-256 before
  compilation. Do not regenerate missing release archives and treat them as the
  original bytes.
- Put temporary verification output in the ignored repository-root `tmp/`
  directory. Keep release evidence with the relevant release record rather than
  adding current hashes, canister IDs, or package inventories to this guide.

The current Dispenser selection is
[`starter-packages.json`](../support/dispenser/starter-packages.json), interpreted
by [`loadStarterSelection`](../support/dispenser/starter.ts). It names archive
paths, not immutable release pins. The production staging implementation in
[`production_deploy.ts`](../support/dispenser/production_deploy.ts) derives exact
pins and records them in its receipt. For a previous deployment, use that
deployment's recorded package set; today's selection may differ.

## Keep Byte Domains Separate

Record a filename, byte length, and SHA-256 for each artifact being compared.

| Artifact | What it establishes |
| --- | --- |
| Outer `.neutron` archive | Exact package bytes selected for installation |
| Uncompressed compiler Wasm | Raw compiled actor output |
| Submitted `wasm_module` bytes | Exact install transport, including compression |
| Starter file commitment | Static asset paths, HTTP metadata, chunk layout, and bytes |
| Certified live module hash | Whole-canister installed module identity |

Never compare a raw Wasm hash with a compressed transport hash. Recompressing
the same raw Wasm with another encoder can produce a different transport hash.
Use the transport produced and recorded by the installation path being audited:

- Fresh provisioning and Dispenser staging use `prepareDeployment` in
  [`artifact.ts`](../packages/neutron-provision/src/artifact.ts), which returns
  both raw and transport hashes and the exact transport bytes.
- In-product checked installation binds its transport through
  [`deployment_record.ts`](../packages/neutron-compiler/src/deployment_record.ts).
  Read the encoder identity from the build record and implementation; do not
  assume it is the same encoder used by the provisioning path.
- The Dispenser backend is separately compiled and installed. Follow its own
  deployment implementation when identifying the exact installed bytes.

## Verify The Compiler And Package Contents

Set `MOTOKO_REPO` to the compiler checkout for the release under examination.
The compiler repository's `scripts/build-neutron-moc-wasm` builds the browser
compiler through its Nix configuration and writes the loaders, Wasm sidecar,
and `SHA256SUMS`. Give it a new temporary output directory because it replaces
that directory's contents:

```sh
mkdir -p tmp
MOTOKO_OUT=$(mktemp -d "$PWD/tmp/compiler-verification.XXXXXX")
"$MOTOKO_REPO/scripts/build-neutron-moc-wasm" "$MOTOKO_OUT"
diff -u "$MOTOKO_OUT/SHA256SUMS" \
  packages/neutron-motoko-wasm/compiler/SHA256SUMS
(cd "$MOTOKO_OUT" && sha256sum -c SHA256SUMS)
(cd packages/neutron-motoko-wasm/compiler && sha256sum -c SHA256SUMS)
```

For a historical release, compare with that release's vendored compiler rather
than assuming the current checkout is its reference. Compare actual asset
bytes as well as checksum manifests. [`apps/kernel/build.ts`](../apps/kernel/build.ts)
copies the compiler assets into the Kernel's `web/motoko` directory. Unpack the
selected Kernel archive with `unpackNeutronPackage` from
[`install.ts`](../packages/neutron-compiler/src/install.ts) and verify those
packaged assets too; matching files in the workspace do not prove the archive
contains them.

## Reproduce The Deployment

For a fresh production actor, call `prepareDeployment` with the exact ordered
archive paths, `target: "production"`, and `expectedArtifacts` from the reviewed
pins. The implementation validates the archive identities, package roles,
dependencies, and compiler output. Production preparation does not permit the
local compiled-actor cache or caller-supplied local installation context.

Compare the compiled deployment ID, raw Wasm, transport Wasm, Candid, and stable
signature with the recorded evidence in their respective byte domains. Reuse
any recorded deployment nonce or other compilation inputs. An in-product
upgrade also depends on installed source, memory lineage, and transaction
inputs; compiling a fresh starter is not a reproduction of that upgrade.

For Dispenser assets, use `starterFilesSha256` in
[`starter_payload.ts`](../support/dispenser/starter_payload.ts). Its asset
builder includes generated registry and provenance files and excludes paths
populated dynamically for the created canister. Verify runtime configuration
separately; the static file commitment does not cover every eventual served
file. Do not substitute a hash of a directory listing or concatenated archive
contents for this commitment.

To build the Dispenser backend without installing it, use the build-only ICP
command from its workspace:

```sh
cd support/dispenser
icp build -e ic dispenser
```

Hash the artifact produced by that invocation, not an older cache entry. The
build definition is [`icp.yaml`](../support/dispenser/icp.yaml); the production
deployment path uses the same `compileMotokoWithCandid` implementation through
[`production_deploy.ts`](../support/dispenser/production_deploy.ts). Do not run a
deployment or starter-staging command merely to obtain verification evidence.

## Compare Live State

Resolve canister IDs and controller identities from the deployment being
audited. Query `starter()` on the Dispenser and compare its committed revision,
deployment ID, ordered app IDs, Wasm size and digest, file counts and commitment,
and reserved backend-call target principals with the prepared payload and
receipt. [`assertCommittedStarter`](../support/dispenser/starter_payload.ts)
defines the uploader's postflight comparison. A query result is a report from
the backend; its trust depends on separately verifying that backend's installed
module.

For the installed Dispenser or Neutron, an IC controller can read management
`canister_status`. Certified `read_state` provides the
`/canister/<id>/module_hash` path without requiring controller access. Verify
the certificate against the intended network's trusted root. Existing
implementations are in [`ic_client.ts`](../packages/neutron-provision/src/ic_client.ts)
and [`deployed_kernel_observation.ts`](../packages/neutron-provision/src/deployed_kernel_observation.ts).
The latter also reconciles controller, operational, and certified Registry
placement evidence for production qualification.

For a Neutron installed by provisioning, compare the live module hash with
`transportWasmSha256`, not `rawWasmSha256`. For another installation path,
compare with the exact submitted transport recorded by that path. This is one
hash for the combined Kernel-plus-app actor, not a hash per installed app.

Report which comparisons were completed and which evidence was unavailable.
Matching module bytes establishes code identity; it does not establish memory
migration correctness, asset integrity, or controller retirement. Verify those
separately using [Memory Migrations](./memory-migrations-and-uninstall.md),
[Dispenser And Provisioning](./dispenser-and-provisioning.md), and
[Testing And Verification](./testing-and-verification.md).
