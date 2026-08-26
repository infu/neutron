import { describe, expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import msgpack from "tiny-msgpack";
import {
  ASSEMBLER_ID,
  assemblerForFreshKernelVersion,
  LEGACY_V25_ASSEMBLER_ID,
} from "neutron-compiler/src/assemble.js";
import {
  assertPreparedPackageArchiveIdentity,
  BROWSER_SURFACE_ORIGINS_PATH,
} from "neutron-compiler/src/install.js";
import {
  assertPreparedDeploymentWasmMetadata,
  assertFreshPackageRoles,
  assertWasmDeploymentLimits,
  buildFreshInstallProvenance,
  chunkWasm,
  IC_MAX_CHUNK_STORE_BYTES,
  IC_MAX_WASM_BYTES,
  IC_MAX_WASM_CHUNKS,
  MANAGEMENT_CHUNK_BYTES,
  prepareDeployment,
  sha256Hex,
  type PreparedDeployment,
} from "../src/artifact.ts";
import {
  parseTransactionPayload,
  serializeTransactionPayload,
  TRANSACTION_PAYLOAD_VERSION,
} from "../src/payload.ts";
import { freshKernelAssetKeys } from "../src/provision.ts";
import {
  trustedInstallationContextFromRootKey,
  trustedInstallationNetworkIdHex,
} from "neutron-compiler/src/installation_context.js";
import {
  assertSupportedCertificateVersions,
  withSupportedCertificateVersions,
} from "neutron-tools/src/wasm_metadata.js";
import {
  CREATE_CANISTER_MEMO,
  principalSubaccount,
} from "../src/ic_client.ts";

describe("production deployment artifacts", () => {
  test("selects the exact assembler at the Kernel 316 boundary", () => {
    expect(assemblerForFreshKernelVersion(315)).toBe(
      LEGACY_V25_ASSEMBLER_ID,
    );
    expect(assemblerForFreshKernelVersion(316)).toBe(ASSEMBLER_ID);
  });

  test("writes an old-Kernel fresh deployment as v4-bound v25 without a sidecar", async () => {
    const archivePath = path.resolve(
      import.meta.dir,
      "../../neutron-compiler/test/fixtures/kernel.v0.3.15.neutron",
    );
    const archive = new Uint8Array(await readFile(archivePath));
    const expectedArtifacts = [
      {
        path: archivePath,
        id: "kernel",
        version: 315,
        sha256: sha256Hex(archive),
        bytes: archive.byteLength,
      },
    ];
    const deployment = await prepareDeployment([archivePath], {
      target: "production",
      deploymentNonce: "1".repeat(32),
      expectedArtifacts,
    });

    expect(deployment.compiled.assemblerId).toBe(
      LEGACY_V25_ASSEMBLER_ID,
    );
    expect(deployment.compiled.browserSurfaceOriginAppIds).toEqual([]);
    expect(freshKernelAssetKeys(deployment)).not.toContain(
      BROWSER_SURFACE_ORIGINS_PATH,
    );

    const payload = serializeTransactionPayload(deployment);
    expect(payload.version).toBe(TRANSACTION_PAYLOAD_VERSION);
    const restored = parseTransactionPayload(
      payload.bytes,
      deployment.packageArtifacts,
      TRANSACTION_PAYLOAD_VERSION,
    );
    expect(restored.compiled.assemblerId).toBe(
      LEGACY_V25_ASSEMBLER_ID,
    );
    expect(restored.packages[0]!.archiveIdentity).toEqual({
      sha256: expectedArtifacts[0]!.sha256,
      size: expectedArtifacts[0]!.bytes,
    });
    expect(() =>
      assertPreparedPackageArchiveIdentity(restored.packages[0]!),
    ).not.toThrow();
    const restoredFile = restored.packages[0]!.files.find(
      ({ content }) => content.byteLength > 0,
    );
    if (restoredFile === undefined) {
      throw new Error("Expected restored Kernel package file");
    }
    restoredFile.content[0] = restoredFile.content[0]! ^ 1;
    expect(() =>
      assertPreparedPackageArchiveIdentity(restored.packages[0]!),
    ).toThrow("contents changed after archive review");
  }, 30_000);

  test("rejects browser permissions paired with an old Kernel before compilation", async () => {
    const temporary = await mkdtemp(
      path.join(tmpdir(), "neutron-v25-browser-permissions-"),
    );
    try {
      const kernelPath = path.resolve(
        import.meta.dir,
        "../../neutron-compiler/test/fixtures/kernel.v0.3.15.neutron",
      );
      const kernelArchive = new Uint8Array(await readFile(kernelPath));
      const appPath = path.join(temporary, "media.neutron");
      const appArchive = mediaPackageArchive();
      await writeFile(appPath, appArchive);

      await expect(
        prepareDeployment([kernelPath, appPath], {
          target: "production",
          deploymentNonce: "2".repeat(32),
          expectedArtifacts: [
            packageArtifact(kernelPath, "kernel", 315, kernelArchive),
            packageArtifact(appPath, "media", 100, appArchive),
          ],
        }),
      ).rejects.toThrow(
        "App media declares browser_permissions, which requires Kernel 316 or newer with assembler neutron_actor_v26",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("requires exact final public HTTP certification metadata", () => {
    const emptyWasm = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ]);
    const wasm = withSupportedCertificateVersions(emptyWasm);
    const wasmMetadata = assertSupportedCertificateVersions(wasm);

    expect(() =>
      assertPreparedDeploymentWasmMetadata({
        compiled: {
          wasm,
          candid: "service : {}",
          stable: "stable-types",
          deploymentId: "deployment",
          compilerId: "compiler",
          assemblerId: ASSEMBLER_ID,
          browserSurfaceOriginAppIds: [],
        },
        wasmMetadata,
      }),
    ).not.toThrow();
    expect(() =>
      assertPreparedDeploymentWasmMetadata({
        compiled: {
          wasm: emptyWasm,
          candid: "service : {}",
          stable: "stable-types",
          deploymentId: "deployment",
          compilerId: "compiler",
          assemblerId: ASSEMBLER_ID,
          browserSurfaceOriginAppIds: [],
        },
        wasmMetadata,
      }),
    ).toThrow("Missing Wasm custom section");
    expect(() =>
      assertPreparedDeploymentWasmMetadata({
        compiled: {
          wasm,
          candid: "service : {}",
          stable: "stable-types",
          deploymentId: "deployment",
          compilerId: "compiler",
          assemblerId: ASSEMBLER_ID,
          browserSurfaceOriginAppIds: [],
        },
        wasmMetadata: { ...wasmMetadata, value: "1" as "2" },
      }),
    ).toThrow("must name the exact single public supported-certificate section");
  });

  test("requires the configured kernel build to be first", () => {
    expect(() =>
      assertFreshPackageRoles([{ isKernel: true }, { isKernel: false }]),
    ).not.toThrow();
    expect(() =>
      assertFreshPackageRoles([{ isKernel: false }, { isKernel: true }]),
    ).toThrow("config kernel archive");
    expect(() =>
      assertFreshPackageRoles([{ isKernel: true }, { isKernel: true }]),
    ).toThrow("exactly one kernel");
  });

  test("builds canonical fresh provenance from aligned package artifacts", () => {
    const deployment = provenanceDeployment([
      { id: "kernel", version: 301, sha256: "b".repeat(64) },
      { id: "files", version: 400, sha256: "a".repeat(64) },
    ]);

    const provenance = buildFreshInstallProvenance(deployment);

    expect(Object.keys(provenance.apps)).toEqual(["files", "kernel"]);
    expect(provenance).toEqual({
      format: 1,
      apps: {
        files: {
          kind: "provisioned",
          package_digest: "a".repeat(64),
        },
        kernel: {
          kind: "provisioned",
          package_digest: "b".repeat(64),
        },
      },
    });
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(Object.isFrozen(provenance.apps)).toBe(true);
    expect(Object.isFrozen(provenance.apps.files)).toBe(true);
  });

  test("rejects ambiguous fresh provenance inputs", () => {
    const mismatched = provenanceDeployment([
      { id: "kernel", version: 301, sha256: "a".repeat(64) },
    ]);
    mismatched.packageArtifacts[0] = {
      ...mismatched.packageArtifacts[0]!,
      version: 300,
    };
    expect(() => buildFreshInstallProvenance(mismatched)).toThrow(
      "does not match its package artifact",
    );

    const duplicateDigests = provenanceDeployment([
      { id: "kernel", version: 301, sha256: "a".repeat(64) },
      { id: "files", version: 400, sha256: "a".repeat(64) },
    ]);
    expect(() => buildFreshInstallProvenance(duplicateDigests)).toThrow(
      "duplicate package archive digests",
    );

    const duplicateIds = provenanceDeployment([
      { id: "kernel", version: 301, sha256: "a".repeat(64) },
      { id: "kernel", version: 301, sha256: "b".repeat(64) },
    ]);
    expect(() => buildFreshInstallProvenance(duplicateIds)).toThrow(
      "duplicate package IDs",
    );
  });

  test("accepts exact IC Wasm deployment boundaries", () => {
    expect(() =>
      assertWasmDeploymentLimits({
        rawWasmBytes: IC_MAX_WASM_BYTES,
        transportWasmBytes: IC_MAX_CHUNK_STORE_BYTES,
        chunkCount: IC_MAX_WASM_CHUNKS,
      }),
    ).not.toThrow();
  });

  test("rejects each IC Wasm deployment boundary before spending", () => {
    expect(() =>
      assertWasmDeploymentLimits({
        rawWasmBytes: IC_MAX_WASM_BYTES + 1,
        transportWasmBytes: 1,
        chunkCount: 1,
      }),
    ).toThrow("Compiled Wasm");
    expect(() =>
      assertWasmDeploymentLimits({
        rawWasmBytes: 1,
        transportWasmBytes: IC_MAX_CHUNK_STORE_BYTES + 1,
        chunkCount: 1,
      }),
    ).toThrow("chunk-store limit");
    expect(() =>
      assertWasmDeploymentLimits({
        rawWasmBytes: 1,
        transportWasmBytes: 1,
        chunkCount: IC_MAX_WASM_CHUNKS + 1,
      }),
    ).toThrow("Compressed Wasm needs");
  });

  test("splits management uploads at the one MiB boundary in order", () => {
    const bytes = new Uint8Array(MANAGEMENT_CHUNK_BYTES + 1);
    bytes[0] = 7;
    bytes[MANAGEMENT_CHUNK_BYTES] = 9;
    const chunks = chunkWasm(bytes);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.bytes.byteLength).toBe(MANAGEMENT_CHUNK_BYTES);
    expect(chunks[1]!.bytes.byteLength).toBe(1);
    expect(chunks[0]!.hashHex).toBe(sha256Hex(chunks[0]!.bytes));
    expect(chunks[1]!.hashHex).toBe(sha256Hex(chunks[1]!.bytes));
  });

  test("uses the CMC's eight-byte little-endian CREA memo", () => {
    expect([...CREATE_CANISTER_MEMO]).toEqual([
      0x43, 0x52, 0x45, 0x41, 0, 0, 0, 0,
    ]);
  });

  test("derives the CMC subaccount from the deployer principal", () => {
    const principal = Principal.fromText(
      "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe",
    );
    const bytes = principal.toUint8Array();
    const subaccount = principalSubaccount(principal);
    expect(subaccount).toHaveLength(32);
    expect(subaccount[0]).toBe(bytes.byteLength);
    expect([...subaccount.slice(1, 1 + bytes.byteLength)]).toEqual([...bytes]);
    expect([...subaccount.slice(1 + bytes.byteLength)]).toEqual(
      Array(31 - bytes.byteLength).fill(0),
    );
  });

  test("rejects caller-supplied production context before archive I/O", async () => {
    const context = trustedInstallationContextFromRootKey(
      new Uint8Array(32).fill(7),
    );
    await expect(
      prepareDeployment(["/does/not/exist.neutron"], {
        target: "production",
        freshInstallationContext: context,
      }),
    ).rejects.toThrow(
      "Production deployment cannot accept a caller-supplied installation context",
    );
  });

  test("rejects unpinned production preparation before archive I/O", async () => {
    await expect(
      prepareDeployment(["/does/not/exist.neutron"], {
        target: "production",
      }),
    ).rejects.toThrow(
      "requires exact expectedArtifacts from a format-3 config",
    );
  });

  test("rejects a cache network ID that differs from trusted context", async () => {
    const context = trustedInstallationContextFromRootKey(
      new Uint8Array(32).fill(8),
    );
    const expectedNetworkId = trustedInstallationNetworkIdHex(context);
    await expect(
      prepareDeployment(["/does/not/exist.neutron"], {
        target: "local",
        freshInstallationContext: context,
        localCompileCache: {
          directory: "/tmp/not-used",
          compilerFingerprint: "a".repeat(64),
          installationNetworkIdHex:
            expectedNetworkId === "f".repeat(64)
              ? "e".repeat(64)
              : "f".repeat(64),
          logger: { log() {} },
        },
      }),
    ).rejects.toThrow(
      "cache network ID does not match trusted installation context",
    );
  });

  test("requires trusted context for every fresh local compile", async () => {
    await expect(
      prepareDeployment(["/does/not/exist.neutron"], {
        target: "local",
      }),
    ).rejects.toThrow(
      "fresh local deployment requires trusted installation context",
    );
  });
});

function provenanceDeployment(
  entries: readonly {
    id: string;
    version: number;
    sha256: string;
  }[],
): Pick<PreparedDeployment, "packages" | "packageArtifacts"> {
  return {
    packages: entries.map(({ id, version }) => ({
      manifest: { id, version },
    })) as PreparedDeployment["packages"],
    packageArtifacts: entries.map(({ id, version, sha256 }, index) => ({
      path: `/packages/${index}.neutron`,
      id,
      version,
      sha256,
      bytes: 1,
    })),
  };
}

function packageArtifact(
  packagePath: string,
  id: string,
  version: number,
  archive: Uint8Array,
) {
  return {
    path: packagePath,
    id,
    version,
    sha256: sha256Hex(archive),
    bytes: archive.byteLength,
  };
}

function mediaPackageArchive(): Uint8Array {
  const encoder = new TextEncoder();
  const module = encoder.encode(
    'module { public class Init() { public func call() : Text { "ok" } } }',
  );
  const entry = sha256Hex(module);
  const files: Record<string, Uint8Array> = {
    "neutron.json": encoder.encode(
      JSON.stringify({
        format: 3,
        id: "media",
        name: "Media",
        version: 100,
        entry,
        func: { call: { type: "update", async: false } },
        tiles: [
          {
            id: "main",
            title: "Media",
            path: "index.html",
            icon: "static/icon.png",
          },
        ],
        capabilities: {
          browser_permissions: {
            api: 1,
            tiles: [{ id: "main", features: ["camera"] }],
          },
        },
      }),
    ),
    "web/index.html": encoder.encode("<main>Media</main>"),
    "web/static/icon.png": Uint8Array.of(0),
    [`mo/${entry}.mo`]: module,
  };
  return msgpack.encode(
    Object.fromEntries(
      Object.entries(files).map(([name, content]) => [
        name,
        gzipSync(content),
      ]),
    ),
  );
}
