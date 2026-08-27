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
  type KernelWorkspaceSourceFile,
} from "../generate_package_metadata.ts";
import { packDirectory } from "neutron-scripts/src/pack.js";
import type { ThirdPartyNoticeBundle } from "neutron-scripts/src/third_party_notices.js";
import { hashContent } from "neutron-tools/src/hash.js";
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

describe("Kernel v317 NPL package metadata", () => {
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
    expect(packagedManifest.version).toBe(317);
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
    ).toThrow("restricted to Kernel version 317");
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
    ).toThrow("preserve the released managed-memory lock");

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

  test("current workspace review includes every required changed source", async () => {
    const sourceFiles = await collectKernelWorkspaceSource(repositoryRoot);
    const sourcePaths = sourceFiles.map(({ path: sourcePath }) => sourcePath);
    expect(sourcePaths).toEqual([...sourcePaths].sort());
    expect(new Set(sourcePaths).size).toBe(sourcePaths.length);
    for (const required of KERNEL_PACKAGE_BUILD_INPUT_PATHS) {
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
  const packagedMemory = packagedManifestValue.memory as Record<string, unknown>;
  const packagedKernel = packagedMemory.kernel as Record<string, unknown>;
  const packagedKernelSchemas = packagedKernel.schemas as Record<string, unknown>;
  Object.assign(packagedKernelSchemas["3"] as Record<string, unknown>, {
    hash: "50d5dcda32504525875af20f38d3fcb46e61f3e1413f8b99fd7ce8163c0f3477",
    entry: "bac62a48a7c70cc09cc6e8200784f306db044f5c055cf2a61b3f16f42babce5b",
  });
  const packagedActivation = packagedMemory.kernel_activation as Record<
    string,
    unknown
  >;
  const packagedActivationSchemas = packagedActivation.schemas as Record<
    string,
    unknown
  >;
  Object.assign(packagedActivationSchemas["1"] as Record<string, unknown>, {
    hash: "f73560cae883ddc894cc4ad8e474aaea0cb4d7f64a017d9fd72e391306e88d9b",
    entry: "f2380721e6147d0f0af208a70183e3d8ce6ac19ad533e1367b3f5780305e7ad3",
  });
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
        "d7ed0a92b6219d784b7143e0851ed64b55dfc25a\n",
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
      inputs: { "/repo/node_modules/icblast/lib/browser.js": {} },
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
        "didc_wasm_pkg\n" +
          "this decision makes no claim about those rights\n" +
          "https://github.com/infu/neutron_motoko/tree/" +
          "d7ed0a92b6219d784b7143e0851ed64b55dfc25a\n" +
          "https://github.com/ocsigen/js_of_ocaml/tree/" +
          "e4d950bc1cbcb0f8fc61cce06b0c6a2c55f94581\n",
      ),
    },
    noticePaths: [noticePath],
    components: [
      {
        ecosystem: "npm",
        name: "icblast",
        version: "4.3.0",
        declaredLicense: "package.json omits a license field",
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
