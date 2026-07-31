import { describe, expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
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
