import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { preparePackageInstall } from "neutron-compiler/src/install.js";
import { loadStarterSelection } from "../starter.ts";
import { buildStarterInstallProvenanceAsset } from "../starter_payload.ts";

const expectedStarterIds = [
  "kernel",
  "files",
  "contacts",
  "kitchensink",
  "wagyu",
  "agent",
  "jetcreeper",
  "mail",
  "mysubnet",
  "wallet",
  "spreadsheet",
  "chess",
];
const productionUpdateSource = "233tv-xiaaa-aaaay-aacta-cai";

test("SushiOS starter list contains the selected distribution apps", async () => {
  const selection = await loadStarterSelection();
  expect(selection.packageIds).toEqual(expectedStarterIds);

  const archives = await Promise.all(
    selection.packagePaths.map(async (archivePath) =>
      new Uint8Array(await readFile(archivePath)),
    ),
  );
  const packages = archives.map((archive) => preparePackageInstall(archive));
  expect(packages.map(({ manifest }) => manifest.id)).toEqual(
    expectedStarterIds,
  );
  expect(
    packages.map(({ manifest }) => manifest.update_source),
  ).toEqual(expectedStarterIds.map(() => productionUpdateSource));

  const packageArtifacts = packages.map(({ manifest }, index) => ({
    path: selection.packagePaths[index]!,
    id: manifest.id,
    version: manifest.version,
    sha256: createHash("sha256").update(archives[index]!).digest("hex"),
    bytes: archives[index]!.byteLength,
  }));
  const provenanceAsset = buildStarterInstallProvenanceAsset({
    packages,
    packageArtifacts,
  });
  expect(provenanceAsset.key).toBe("/system/install-provenance.json");
  expect(provenanceAsset.val.content_type).toBe("application/json");
  expect(provenanceAsset.val.content_encoding).toBe("identity");
  expect(provenanceAsset.chunks).toEqual([]);

  const provenance = JSON.parse(
    new TextDecoder().decode(provenanceAsset.val.content),
  ) as {
    format: number;
    apps: Record<
      string,
      { kind: string; package_digest: string }
    >;
  };
  expect(provenance.format).toBe(1);
  expect(Object.keys(provenance.apps).sort()).toEqual(
    [...expectedStarterIds].sort(),
  );
  packageArtifacts.forEach(({ id, sha256 }) => {
    expect(provenance.apps[id]).toEqual({
      kind: "provisioned",
      package_digest: sha256,
    });
  });
});

test("starter payload is uploaded in chunks and committed atomically", async () => {
  const [backend, uploader, packageText] = await Promise.all([
    readFile(new URL("../mo/main.mo", import.meta.url), "utf8"),
    readFile(new URL("../starter_payload.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  expect(packageText).toContain(
    '"starter:set": "bun local_deploy.ts --starter-only"',
  );
  expect(uploader).toContain("begin_starter_upload");
  expect(uploader).toContain("add_starter_wasm_chunk");
  expect(uploader).toContain("commit_starter_upload");
  expect(uploader).toContain(
    "const uploadEpoch = await actor.begin_starter_upload(spec)",
  );
  expect(uploader).toContain(
    "actor.commit_starter_upload(uploadEpoch)",
  );
  expect(uploader).toContain("assertCommittedStarter");
  expect(uploader).toContain(
    "fixedBackendCallInstallReservationTargetPrincipals",
  );
  expect(uploader).toContain("backend_call_target_principals");
  expect(uploader).toContain("revision: candid.Nat");
  expect(uploader).toContain("info.revision < 1n");
  expect(backend).toContain("Sha256.fromBlob(#sha256, committedWasm)");
  expect(backend).toContain(
    "MAX_STARTER_BACKEND_CALL_TARGETS : Nat = 2_048",
  );
  expect(backend).toContain(
    "spec.backend_call_target_principals.size() >",
  );
  expect(backend).toContain("next_starter_upload_epoch : Nat = 0");
  expect(
    backend.match(
      /Starter upload epoch does not match the active upload/g,
    ),
  ).toHaveLength(4);

  const commit = backend.slice(
    backend.indexOf("func commit_starter_upload"),
    backend.indexOf("public shared ({ caller }) func provision"),
  );
  expect(commit).toContain("Starter Wasm upload is incomplete");
  expect(commit).toContain("Starter file upload is incomplete");
  expect(commit).toContain("Starter Wasm SHA-256 does not match");
  expect(commit.indexOf("wasm = committedWasm")).toBeGreaterThan(
    commit.indexOf("Starter Wasm SHA-256 does not match"),
  );
  expect(commit.indexOf("files = List.toArray(staged_files)")).toBeGreaterThan(
    commit.indexOf("Starter Wasm SHA-256 does not match"),
  );
  expect(commit.indexOf("backend_call_target_principals =")).toBeGreaterThan(
    commit.indexOf("Starter Wasm SHA-256 does not match"),
  );

  expect(commit).toContain("let revision = next_starter_revision + 1");
  expect(commit).toContain("current_starter := ?committed");
  expect(commit.indexOf("current_starter := ?committed")).toBeGreaterThan(
    commit.indexOf("file_chunks = List.toArray(staged_file_chunks)"),
  );

  for (const retired of [
    "set_wasm",
    "set_runtime_config_template",
    "clear_files",
    "add_file",
    "add_file_chunk",
  ]) {
    expect(backend).not.toMatch(
      new RegExp(`public\\s+shared[^\\n]*func\\s+${retired}\\b`, "u"),
    );
  }
});
