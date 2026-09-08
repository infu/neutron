import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeNeutronPackageArchive } from "neutron-compiler/src/package_decoder.js";
import {
  installGeneratedKernelPackageMetadata,
  KERNEL_APPLICATION_NOTICE_PATH,
  KERNEL_NPL_LICENSE_ID,
  KERNEL_NPL_LICENSE_PATH,
  KERNEL_NPL_LICENSE_SHA256,
  KERNEL_PACKAGE_BUILD_INPUT_PATHS,
  KERNEL_RELEASE_MEMORY_LOCK_SHA256,
  auditKernelDistForPackaging,
  buildKernelPackageMetadata,
  collectKernelWorkspaceSource,
  installKernelInstalledArtifactInventory,
  type KernelWorkspaceSourceFile,
} from "../generate_package_metadata.ts";
import { packDirectory } from "neutron-scripts/src/pack.js";
import type { ThirdPartyNoticeBundle } from "neutron-scripts/src/third_party_notices.js";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  KERNEL_INSTALLED_ARTIFACT_INVENTORY_PACKAGE_PATH,
  kernelPackagePathRequiresInlineText,
  parseKernelInstalledArtifactInventory,
} from "neutron-tools/src/installed_artifacts.js";
import {
  NEUTRON_PACKAGE_RECORD_PATH,
  readNeutronPackageRecord,
} from "neutron-tools/package_record.js";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const kernelRoot = path.join(repositoryRoot, "apps/kernel");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Kernel v347 NPL package metadata", () => {
  test("binds exact NPL, 3V Interactive notice, HTTPS source, and build inputs", async () => {
    const fixture = await metadataFixture();
    const generated = buildKernelPackageMetadata(fixture);
    const reversed = buildKernelPackageMetadata({
      ...fixture,
      sourceFiles: [...fixture.sourceFiles].reverse(),
    });

    expect(generated.recordBytes).toEqual(reversed.recordBytes);
    expect(hashContent(generated.license)).toBe(KERNEL_NPL_LICENSE_SHA256);
    expect(hashContent(fixture.memoryLock)).toBe(
      KERNEL_RELEASE_MEMORY_LOCK_SHA256,
    );
    expect(generated.record.license).toMatchObject({
      id: KERNEL_NPL_LICENSE_ID,
      texts: [{ id: KERNEL_NPL_LICENSE_ID, path: KERNEL_NPL_LICENSE_PATH }],
    });
    expect(generated.record.source).toMatchObject({
      kind: "https",
      sha256: generated.sourceArtifact.sha256,
      bytes: generated.sourceArtifact.bytes,
    });
    expect(generated.record.build.inputs.length).toBe(
      KERNEL_PACKAGE_BUILD_INPUT_PATHS.length,
    );
    expect(generated.record.build.inputs.map(({ path: inputPath }) => inputPath)).toEqual(
      [...KERNEL_PACKAGE_BUILD_INPUT_PATHS].sort(),
    );
    expect(
      generated.record.build.inputs.map(({ path: inputPath }) => inputPath),
    ).toContain("packages/neutron-tools/src/installed_artifacts.ts");
    expect(textDecoder.decode(generated.notice)).toContain(
      "Copyright 2026 3V Interactive",
    );
    expect(textDecoder.decode(generated.notice)).toContain(
      "modified browser compiler is maintained in its own source repository",
    );
  });

  test("packs the NPL legal envelope without changing the closed format-3 manifest", async () => {
    const fixture = await metadataFixture();
    const generated = buildKernelPackageMetadata(fixture);
    const root = await temporaryDirectory("neutron-kernel-metadata-pack-");
    const dist = path.join(root, "dist");
    await fs.mkdir(dist, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(root, "neutron.json"), fixture.packagedManifest),
      fs.writeFile(path.join(dist, "neutron.json"), fixture.packagedManifest),
      fs.writeFile(path.join(dist, "neutron.lock.json"), fixture.memoryLock),
    ]);
    await installGeneratedKernelPackageMetadata(dist, generated);

    const archive = new Uint8Array(await fs.readFile(await packDirectory(root)));
    const unpacked = decodeNeutronPackageArchive(archive);
    const packagedManifest = JSON.parse(
      textDecoder.decode(unpacked["neutron.json"]),
    ) as PackagedNeutronManifest;
    expect(validate_neutron_conf(packagedManifest).errors).toEqual([]);
    expect(unpacked["neutron.json"]).toEqual(fixture.packagedManifest);
    expect(packagedManifest.format).toBe(3);
    expect(packagedManifest.version).toBe(347);
    expect(packagedManifest.package_features).toBeUndefined();
    expect(unpacked[KERNEL_NPL_LICENSE_PATH]).toEqual(generated.license);
    expect(textDecoder.decode(unpacked[KERNEL_APPLICATION_NOTICE_PATH])).toContain(
      "Copyright 2026 3V Interactive",
    );
    expect(
      readNeutronPackageRecord({ files: unpacked, manifest: packagedManifest }),
    ).toEqual(generated.record);
  });

  test("fails closed on wrong release identity, license, notice, or memory", async () => {
    const fixture = await metadataFixture();
    const manifest = JSON.parse(
      textDecoder.decode(fixture.packagedManifest),
    ) as Record<string, unknown>;
    expect(() =>
      buildKernelPackageMetadata({
        ...fixture,
        packagedManifest: jsonBytes({ ...manifest, version: 309 }),
      }),
    ).toThrow("restricted to Kernel version 347");
    expect(() =>
      buildKernelPackageMetadata({
        ...fixture,
        packageJson: jsonBytes({ license: KERNEL_NPL_LICENSE_ID }),
      }),
    ).toThrow("must declare SEE LICENSE IN LICENSE");
    expect(() =>
      buildKernelPackageMetadata({
        ...fixture,
        license: textEncoder.encode("not the NPL"),
      }),
    ).toThrow("do not match the canonical repository NPL");
    expect(() =>
      buildKernelPackageMetadata({
        ...fixture,
        notice: textEncoder.encode("Copyright 2026 Wrong Holder\n"),
      }),
    ).toThrow("missing required text");
    expect(() =>
      buildKernelPackageMetadata({
        ...fixture,
        memoryLock: new Uint8Array([...fixture.memoryLock, 0x20]),
      }),
    ).toThrow("match the reviewed managed-memory lock");

    const changedMemoryManifest = structuredClone(manifest);
    const memory = changedMemoryManifest.memory as Record<string, unknown>;
    const kernel = memory.kernel as Record<string, unknown>;
    const schemas = kernel.schemas as Record<string, unknown>;
    (schemas["3"] as Record<string, unknown>).hash = "0".repeat(64);
    expect(() =>
      buildKernelPackageMetadata({
        ...fixture,
        packagedManifest: jsonBytes(changedMemoryManifest),
      }),
    ).toThrow("changed the schema binding");
  });

  test("requires schema 3 history, the custody schema 4, and its exact forward migration", async () => {
    const fixture = await metadataFixture();
    const original = JSON.parse(textDecoder.decode(fixture.packagedManifest));
    expect(original.memory.kernel.version).toBe(4);
    expect(Object.keys(original.memory.kernel.schemas)).toEqual(["3", "4"]);
    expect(original.memory.kernel.migrations).toEqual([{
      from: 3,
      to: 4,
      src: "memory/kernel/v3_to_v4.mo",
      entry: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }]);
    expect(original.memory.kernel_activation.version).toBe(1);
    expect(original.memory.kernel_activation.migrations).toEqual([]);

    const mutations = [
      {
        mutate: (manifest: typeof original) => { delete manifest.memory.kernel.schemas["3"]; },
        message: "schema history for kernel",
      },
      {
        mutate: (manifest: typeof original) => { delete manifest.memory.kernel.schemas["4"]; },
        message: "schema history for kernel",
      },
      {
        mutate: (manifest: typeof original) => { manifest.memory.kernel.schemas["4"].hash = "0".repeat(64); },
        message: "changed the schema binding for kernel v4",
      },
      {
        mutate: (manifest: typeof original) => { manifest.memory.kernel.migrations = []; },
        message: "migration history for kernel",
      },
      {
        mutate: (manifest: typeof original) => { manifest.memory.kernel.migrations.push(manifest.memory.kernel.migrations[0]); },
        message: "migration history for kernel",
      },
      {
        mutate: (manifest: typeof original) => { manifest.memory.kernel.migrations[0].entry = "0".repeat(64); },
        message: "changed the migration binding for kernel 3->4",
      },
      {
        mutate: (manifest: typeof original) => { manifest.memory.kernel.migrations[0].consume = ["kernel_activation"]; },
        message: "changed the migration binding for kernel 3->4",
      },
      {
        mutate: (manifest: typeof original) => { manifest.memory.kernel_activation.version = 2; },
        message: "memory kernel_activation v1",
      },
    ];
    for (const { mutate, message } of mutations) {
      const changed = structuredClone(original);
      mutate(changed);
      expect(() => buildKernelPackageMetadata({
        ...fixture,
        packagedManifest: jsonBytes(changed),
      })).toThrow(message);
    }
  });

  test("retains the exact released schema source bytes in the offered source", async () => {
    const fixture = await metadataFixture();
    for (const schemaPath of [
      "apps/kernel/backend/memory/activation/v1.mo",
      "apps/kernel/backend/memory/kernel/v3.mo",
    ]) {
      expect(() => buildKernelPackageMetadata({
        ...fixture,
        sourceFiles: fixture.sourceFiles.map((file) => file.path === schemaPath
          ? { ...file, content: textEncoder.encode("module {}\n") }
          : file),
      })).toThrow(`preserve immutable released schema source ${schemaPath}`);
    }
  });

  test("rejects symbolic, sensitive, and arbitrary unreviewed source inputs", async () => {
    const symbolicRoot = await gitFixture();
    await fs.mkdir(path.join(symbolicRoot, "apps/kernel/src/settings"), {
      recursive: true,
    });
    await fs.symlink(
      path.join(symbolicRoot, "README.md"),
      path.join(
        symbolicRoot,
        "apps/kernel/src/settings/DeploymentIntegrityDetails.tsx",
      ),
    );
    await expect(collectKernelWorkspaceSource(symbolicRoot)).rejects.toThrow(
      "not a real file",
    );

    const sensitiveRoot = await gitFixture();
    await fs.mkdir(path.join(sensitiveRoot, "apps/kernel/src"), {
      recursive: true,
    });
    await fs.writeFile(path.join(sensitiveRoot, "apps/kernel/src/.env"), "TOKEN=x");
    await expect(collectKernelWorkspaceSource(sensitiveRoot)).rejects.toThrow(
      "Sensitive credential-like path",
    );

    const arbitraryRoot = await gitFixture();
    await fs.mkdir(path.join(arbitraryRoot, "apps/kernel/src"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(arbitraryRoot, "apps/kernel/src/leak.ts"),
      "export const incidentalSecret = true;\n",
    );
    await expect(collectKernelWorkspaceSource(arbitraryRoot)).rejects.toThrow(
      "requires explicit review",
    );
  });

  test("rejects stale files before pack traverses Kernel dist", async () => {
    const root = await temporaryDirectory("neutron-kernel-dist-audit-");
    const requiredFiles = [
      ".neutron-release-evidence.json",
      "connection-providers.json",
      KERNEL_INSTALLED_ARTIFACT_INVENTORY_PACKAGE_PATH,
      KERNEL_NPL_LICENSE_PATH,
      KERNEL_APPLICATION_NOTICE_PATH,
      "legal/THIRD_PARTY_NOTICES.md",
      "legal/third-party/EXACT-MATERIALS.v1.txt",
      NEUTRON_PACKAGE_RECORD_PATH,
      "neutron.did",
      "neutron.json",
      "neutron.lock.json",
      `${"mo"}/${"a".repeat(64)}.mo`,
      "web/index.html",
    ];
    await Promise.all(
      requiredFiles.map(async (relativePath) => {
        const destination = path.join(root, ...relativePath.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, "fixture\n");
      }),
    );
    await expect(auditKernelDistForPackaging(root)).resolves.toBeUndefined();
    await fs.writeFile(path.join(root, "stale-debug.json"), "{}\n");
    await expect(auditKernelDistForPackaging(root)).rejects.toThrow(
      "unexpected file: stale-debug.json",
    );
  });

  test("generates a deterministic inventory of exact installed Kernel artifacts", async () => {
    const root = await temporaryDirectory("neutron-kernel-artifact-inventory-");
    const packagedFiles = new Map<string, Uint8Array>([
      [".neutron-release-evidence.json", textEncoder.encode("evidence\n")],
      ["connection-providers.json", textEncoder.encode("[]\n")],
      [KERNEL_NPL_LICENSE_PATH, textEncoder.encode("license\n")],
      [KERNEL_APPLICATION_NOTICE_PATH, textEncoder.encode("notice\n")],
      ["legal/THIRD_PARTY_NOTICES.md", textEncoder.encode("notices\n")],
      [
        "legal/third-party/EXACT-MATERIALS.v1.txt",
        textEncoder.encode("materials\n"),
      ],
      [NEUTRON_PACKAGE_RECORD_PATH, textEncoder.encode("record\n")],
      ["neutron.did", textEncoder.encode("service : {}\n")],
      ["neutron.json", textEncoder.encode("manifest\n")],
      ["neutron.lock.json", textEncoder.encode("lock\n")],
      [`mo/${"a".repeat(64)}.mo`, textEncoder.encode("actor {}\n")],
      ["web/index.html", textEncoder.encode("<main>Kernel</main>\n")],
      ["web/assets/app.js", new Uint8Array([0x00, 0xff, 0x0a, 0x41])],
      [
        "web/system/browser-origin-cleanup.html",
        textEncoder.encode(
          "<script>parent.postMessage('ready', '*')</script>\n",
        ),
      ],
    ]);
    await Promise.all(
      [...packagedFiles].map(async ([relativePath, content]) => {
        const destination = path.join(root, ...relativePath.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content);
      }),
    );

    await installKernelInstalledArtifactInventory(root, 347);
    const inventoryPath = path.join(
      root,
      KERNEL_INSTALLED_ARTIFACT_INVENTORY_PACKAGE_PATH,
    );
    const firstBytes = new Uint8Array(await fs.readFile(inventoryPath));
    const parsed = parseKernelInstalledArtifactInventory(
      JSON.parse(textDecoder.decode(firstBytes)),
    );
    const byPackagePath = new Map(
      parsed.artifacts.map((file) => [file.package_path, file] as const),
    );

    expect(parsed.package).toEqual({ id: "kernel", version: 347 });
    expect(byPackagePath.has("neutron.did")).toBe(false);
    expect(byPackagePath.has(`mo/${"a".repeat(64)}.mo`)).toBe(false);
    expect(
      byPackagePath.has(KERNEL_INSTALLED_ARTIFACT_INVENTORY_PACKAGE_PATH),
    ).toBe(false);
    expect(
      byPackagePath.get("web/system/browser-origin-cleanup.html"),
    ).toMatchObject({
      inline_text: "<script>parent.postMessage('ready', '*')</script>\n",
    });
    for (const [packagePath, content] of packagedFiles) {
      if (packagePath === "neutron.did" || packagePath.startsWith("mo/")) {
        continue;
      }
      expect(byPackagePath.get(packagePath)).toMatchObject({
        bytes: content.byteLength,
        sha256: hashContent(content),
      });
      expect(byPackagePath.get(packagePath)?.inline_text !== undefined).toBe(
        kernelPackagePathRequiresInlineText(packagePath),
      );
    }

    await expect(auditKernelDistForPackaging(root)).resolves.toBeUndefined();
    await installKernelInstalledArtifactInventory(root, 347);
    expect(new Uint8Array(await fs.readFile(inventoryPath))).toEqual(
      firstBytes,
    );

    await fs.rm(inventoryPath);
    await expect(auditKernelDistForPackaging(root)).rejects.toThrow(
      `missing required file: ${KERNEL_INSTALLED_ARTIFACT_INVENTORY_PACKAGE_PATH}`,
    );
  });

  test("current workspace review includes every required changed source", async () => {
    const sourceFiles = await collectKernelWorkspaceSource(repositoryRoot);
    const sourcePaths = sourceFiles.map(({ path: sourcePath }) => sourcePath);
    expect(sourcePaths).toEqual([...sourcePaths].sort());
    expect(new Set(sourcePaths).size).toBe(sourcePaths.length);
    for (const required of KERNEL_PACKAGE_BUILD_INPUT_PATHS) {
      expect(sourcePaths).toContain(required);
    }
    for (const required of [
      "apps/kernel/backend/main.mo",
      "apps/kernel/backend/memory/kernel/v3.mo",
      "apps/kernel/backend/memory/kernel/v4.mo",
      "apps/kernel/backend/memory/kernel/v3_to_v4.mo",
      "apps/kernel/backend/wallet_custody_signing/Service.mo",
      "apps/kernel/backend/wallet_custody_signing/Types.mo",
      "packages/neutron-tools/src/evm_wallet.ts",
      "packages/neutron-tools/test/evm_wallet.test.ts",
      "packages/neutron-tools/test/wallet_custody_capabilities.test.ts",
      "packages/neutron-compiler/test/evm_wallet_upgrade.pocketic.test.ts",
      "packages/neutron-compiler/test/evm_wallet_upgrade/archives.ts",
      "packages/neutron-compiler/test/evm_wallet_upgrade/existing_apps.ts",
      "packages/neutron-compiler/test/evm_wallet_upgrade/new_apps.ts",
      "packages/neutron-compiler/test/evm_signed_upgrade.pocketic.test.ts",
      "packages/neutron-compiler/test/evm_wallet_upgrade/actor_fixtures.ts",
      "packages/neutron-compiler/test/evm_wallet_upgrade/evm_signed_pending.ts",
      "packages/neutron-compiler/test/evm_wallet_upgrade/evm_signed_rpc_fixture.mo",
      "packages/neutron-compiler/test/evm_wallet_upgrade/wallet_bridge_journals.ts",
      "packages/neutron-compiler/test/evm_wallet_upgrade/wallet_journal_canisters.ts",
      "packages/neutron-compiler/test/evm_wallet_upgrade/wallet_journal_fixture.mo",
      "packages/neutron-compiler/test/evm_wallet_upgrade/wallet_journal_types.ts",
      "packages/neutron-compiler/test/evm_wallet_upgrade/wallet_transfer_journals.ts",
      "packages/neutron-compiler/test/ic_wallet_journals_upgrade.pocketic.test.ts",
      "doc/evm-wallet.md",
      "doc/evm-wallet-research.md",
      "doc/todo.evm-wallet.md",
      "doc/todo.wallet-fresh-start.md",
      "packages/neutron-compiler/test/fresh_custody_cutover.pocketic.test.ts",
    ]) {
      expect(sourcePaths).toContain(required);
    }
    expect(sourcePaths.some((sourcePath) => sourcePath.includes("node_modules"))).toBe(
      false,
    );
    expect(sourcePaths.some((sourcePath) => sourcePath.endsWith(".neutron"))).toBe(
      false,
    );
  });
});

type MetadataFixture = Parameters<typeof buildKernelPackageMetadata>[0];

async function metadataFixture(): Promise<MetadataFixture> {
  const license = new Uint8Array(await fs.readFile(path.join(kernelRoot, "LICENSE")));
  const notice = new Uint8Array(await fs.readFile(path.join(kernelRoot, "NOTICE")));
  const packageJson = new Uint8Array(
    await fs.readFile(path.join(kernelRoot, "package.json")),
  );
  const memoryLock = new Uint8Array(
    await fs.readFile(path.join(kernelRoot, "neutron.lock.json")),
  );
  const sourceManifestValue = JSON.parse(
    await fs.readFile(path.join(kernelRoot, "neutron.json"), "utf8"),
  ) as Record<string, unknown>;
  const packagedManifestValue = structuredClone(sourceManifestValue);
  packagedManifestValue.entry = "kernelentry";
  const memoryLockValue = JSON.parse(textDecoder.decode(memoryLock)) as {
    memory: Record<string, {
      schemas: Record<string, { hash: string; entry: string }>;
      migrations: Record<string, string>;
    }>;
  };
  const packagedMemory = packagedManifestValue.memory as Record<string, {
    schemas: Record<string, Record<string, unknown>>;
    migrations: Array<{ from: number; to: number; entry?: string }>;
  }>;
  for (const [memoryId, memory] of Object.entries(packagedMemory)) {
    const locked = memoryLockValue.memory[memoryId];
    if (!locked) throw new Error(`Missing memory lock for ${memoryId}`);
    for (const [version, schema] of Object.entries(memory.schemas)) {
      const lockedSchema = locked.schemas[version];
      if (!lockedSchema) {
        throw new Error(`Missing locked schema for ${memoryId} v${version}`);
      }
      Object.assign(schema, lockedSchema);
    }
    for (const migration of memory.migrations) {
      const edge = `${migration.from}->${migration.to}`;
      const lockedMigration = locked.migrations[edge];
      if (!lockedMigration) {
        throw new Error(`Missing locked migration for ${memoryId} ${edge}`);
      }
      migration.entry = lockedMigration;
    }
  }
  const sourceManifest = jsonBytes(sourceManifestValue);
  const packagedManifest = jsonBytes(packagedManifestValue);
  const contentByPath = new Map<string, Uint8Array>();
  for (const sourcePath of KERNEL_PACKAGE_BUILD_INPUT_PATHS) {
    contentByPath.set(sourcePath, textEncoder.encode(`source:${sourcePath}\n`));
  }
  contentByPath.set("LICENSE", license);
  contentByPath.set("apps/kernel/LICENSE", license);
  contentByPath.set("apps/kernel/NOTICE", notice);
  contentByPath.set("apps/kernel/package.json", packageJson);
  contentByPath.set("apps/kernel/neutron.json", sourceManifest);
  contentByPath.set("apps/kernel/neutron.lock.json", memoryLock);
  for (const schemaPath of [
    "apps/kernel/backend/memory/activation/v1.mo",
    "apps/kernel/backend/memory/kernel/v3.mo",
  ]) {
    contentByPath.set(
      schemaPath,
      new Uint8Array(await fs.readFile(path.join(repositoryRoot, schemaPath))),
    );
  }
  contentByPath.set(
    "packages/neutron-motoko-wasm/LICENSES.md",
    textEncoder.encode(
      "https://github.com/infu/neutron_motoko/tree/" +
        "b93f048c8b261e374daab0bb0d4e7f9f2d4b725a\n",
    ),
  );

  return {
    kernelRoot,
    packagedManifest,
    memoryLock,
    packageJson,
    license,
    notice,
    esbuildMetafile: jsonBytes({
      inputs: {
        "node_modules/icblast/lib/browser.js": {},
        "node_modules/icblast/didc_wasm_pkg/didc_rust.js": {},
        "node_modules/icblast/didc_wasm_pkg/didc_rust_bg.bin": {},
      },
    }),
    sourceFiles: [...contentByPath.entries()].map(([sourcePath, content]) => ({
      path: sourcePath,
      content,
      mode: sourcePath.endsWith(".ts") ? 0o755 : 0o644,
    })) satisfies readonly KernelWorkspaceSourceFile[],
    thirdPartyNotices: thirdPartyFixture(),
  };
}

function thirdPartyFixture(): ThirdPartyNoticeBundle {
  const noticePath = "legal/archive-only/THIRD_PARTY_NOTICES.md";
  return {
    files: {
      [noticePath]: textEncoder.encode(
        "didc_wasm_pkg/didc_rust_bg.bin\n" +
          "third_party/licenses/rust/map.json\n" +
          "Rust standard-library dependency inventory\n" +
          "https://github.com/infu/neutron_motoko/tree/" +
          "b93f048c8b261e374daab0bb0d4e7f9f2d4b725a\n" +
          "https://github.com/ocsigen/js_of_ocaml/tree/" +
          "e4d950bc1cbcb0f8fc61cce06b0c6a2c55f94581\n",
      ),
    },
    noticePaths: [noticePath],
    components: [
      {
        ecosystem: "npm",
        name: "icblast",
        version: "4.3.3",
        declaredLicense: "Apache-2.0",
        selectedLicense: "Apache-2.0",
        materials: [],
      },
      {
        ecosystem: "npm",
        name: "neutron-motoko-wasm",
        version: "1.1.0",
        declaredLicense: "SEE LICENSE IN LICENSES.md",
        selectedLicense: "Apache-2.0 WITH LLVM-exception",
        materials: [],
      },
    ],
  };
}

async function gitFixture(): Promise<string> {
  const root = await temporaryDirectory("neutron-kernel-source-git-");
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  git(root, ["init", "--quiet"]);
  git(root, ["add", "README.md"]);
  git(root, [
    "-c",
    "user.name=Neutron Test",
    "-c",
    "user.email=test@neutron.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return root;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function jsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}
