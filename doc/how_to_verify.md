# Verify Source, Build Artifacts, and Live Canisters

Use clean checkouts of [Neutron](https://github.com/infu/neutron) and
[neutron_motoko](https://github.com/infu/neutron_motoko). This guide assumes
Neutron is `.` and the compiler is `../neutron_motoko`; in the shared local
workspace the compiler may instead be `../mot_comp`.

```sh
MOTOKO_REPO=${MOTOKO_REPO:-../neutron_motoko} # use ../mot_comp in the shared workspace
git status --short
git -C "$MOTOKO_REPO" status --short
git rev-parse HEAD
git -C "$MOTOKO_REPO" rev-parse HEAD
```

Do not compare a raw `.wasm` hash with a gzip transport hash. Neutron creates
its install transport with the fixed encoder identity
`fflate@0.8.3:default-level:mtime=0`. Record the byte domain, filename, byte
length, and SHA-256 for every comparison.

## 1. Verify the browser compiler

Build the compiler from source into a new temporary directory:

```sh
MOTOKO_OUT=$(mktemp -d)
"$MOTOKO_REPO/scripts/build-neutron-moc-wasm" "$MOTOKO_OUT"
cat "$MOTOKO_OUT/SHA256SUMS"
```

Compare the fresh output with the compiler vendored by Neutron:

```sh
diff -u "$MOTOKO_OUT/SHA256SUMS" \
  packages/neutron-motoko-wasm/compiler/SHA256SUMS
```

Also confirm that the Kernel archive selected for the starter contains those
same compiler hashes:

```sh
KERNEL_ARCHIVE=$(jq -r '.kernel.path' production-starter.artifacts.json)
KERNEL_ARCHIVE="$KERNEL_ARCHIVE" bun -e '
  import { readFileSync } from "node:fs";
  import { unpackNeutronPackage } from "./packages/neutron-compiler/src/install.ts";
  const files = unpackNeutronPackage(readFileSync(process.env.KERNEL_ARCHIVE));
  process.stdout.write(new TextDecoder().decode(files["web/motoko/SHA256SUMS"]));
'
```

## 2. Verify the live Dispenser

Build with the ICP CLI; do not use an older file from `.icp/cache` as evidence:

```sh
cd support/dispenser
icp build -e ic dispenser
sha256sum .icp/cache/artifacts/dispenser
stat -c '%s bytes' .icp/cache/artifacts/dispenser
```

Set the live canister ID and operator identity, then read its installed raw
module hash. The `Module hash` must equal the fresh build hash above.

```sh
export DISPENSER_ID='<dispenser-canister-id>'
export ICP_IDENTITY='<controller-identity>'
icp canister status -e ic --identity "$ICP_IDENTITY" "$DISPENSER_ID"
cd ../..
```

## 3. Verify the starter pack

First verify every selected archive against the tracked pins:

```sh
jq -r '[.kernel, .packages[]] | .[] | [.path,.sha256,(.bytes|tostring)] | @tsv' \
  production-starter.artifacts.json |
while IFS=$'\t' read -r file expected_hash expected_bytes; do
  test "$(sha256sum "$file" | cut -d' ' -f1)" = "$expected_hash"
  test "$(stat -c %s "$file")" = "$expected_bytes"
  echo "OK $file"
done
```

Compile those exact archives without the local compiled-actor cache:

```sh
bun -e '
  import fs from "node:fs/promises";
  import path from "node:path";
  import { prepareDeployment } from "./packages/neutron-provision/src/artifact.ts";
  import { starterFilesSha256 } from "./support/dispenser/starter_payload.ts";
  const pins = JSON.parse(await fs.readFile("production-starter.artifacts.json", "utf8"));
  const artifacts = [pins.kernel, ...pins.packages].map(x => ({ ...x, path: path.resolve(x.path) }));
  const result = await prepareDeployment(artifacts.map(x => x.path), {
    target: "production",
    expectedArtifacts: artifacts,
  });
  console.log(JSON.stringify({
    deploymentId: result.compiled.deploymentId,
    rawWasmBytes: result.compiled.wasm.byteLength,
    rawWasmSha256: result.rawWasmSha256,
    transportWasmBytes: result.transportWasm.byteLength,
    transportWasmSha256: result.transportWasmSha256,
    filesSha256: starterFilesSha256(result),
  }, null, 2));
'
```

Read the live committed starter. Compare its deployment ID, app order, byte
length, and `wasm_sha256` only with the fresh gzip transport values. Compare
`files_sha256` with the fresh `filesSha256`; it covers every static file path,
HTTP metadata field, chunk count, and byte in the starter payload. It is
calculated once when the upload is committed and only read by this query:

```sh
icp canister call -e ic "$DISPENSER_ID" starter '()' --query
```

## 4. Verify a newly created Neutron

After provisioning, set its canister ID and read the live installed module
hash. Use a controller identity when calling `canister status`:

```sh
export NEUTRON_ID='<new-neutron-canister-id>'
icp canister status -e ic --identity "$ICP_IDENTITY" "$NEUTRON_ID"
```

Compare the live module hash with SHA-256 of the exact deterministic gzip
`wasm_module` transport bytes submitted by the provisioning record. Do not
compare it with `rawWasmSha256`. Keep the raw compiler output and transport
hashes separately, and verify the certified `/canister/<id>/module_hash` path
when the caller is not an IC controller. This is one canister-level value for
the complete Kernel-plus-app actor, not one hash per installed app.

The check is complete only when the compiler assets, Dispenser raw Wasm,
starter archives and transport Wasm, and the newly installed live module all
match their corresponding source-built artifacts.

For the state-preserving candidate transition from the released `0.3.6` Kernel to
the GPL-only `0.3.7` bridge, including memory and no-publication constraints,
use [License And Deployment Records](./license-and-deployment-records.md#historical-v035-and-v036-to-v037-gpl-bridge-candidate-checklist).
