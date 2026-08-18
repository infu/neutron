import { describe, expect, test } from "bun:test";
import { gzipSync } from "fflate";
import { gzipSync as nodeGzipSync } from "node:zlib";
import msgpack from "tiny-msgpack";
import { hashContent } from "neutron-tools/src/hash.ts";
import { neutronAppSourceRepositoryPath } from "neutron-tools/src/package_record.ts";
import {
  NEUTRON_REPOSITORY_PROTOCOL,
  parseRepositoryReleaseRecord,
  repositoryPackagePath,
  repositoryReleasePath,
  serializeRepositoryReleaseRecord,
} from "neutron-tools/src/repository.ts";
import {
  hostedSourceArtifactPath,
  inspectPackageFiles,
  inspectUpdatePackage,
  MAX_PUBLICATION_BYTES,
  sha256Hex,
  type DeclaredHostedSource,
  type PackageInspector,
} from "../src/model.ts";

const text = (value: string) => new TextEncoder().encode(value);

function examplePackage(id: string, name: string): Uint8Array {
  const module = text(
    'module { public class Init() { public func ping() : Text { "ok" } } }',
  );
  const entry = hashContent(module);
  const files = {
    "neutron.json": text(
      JSON.stringify({
        format: 3,
        id,
        name,
        version: 100,
        entry,
        func: { ping: { type: "update", async: false } },
      }),
    ),
    "web/index.html": text("<main></main>"),
    [`mo/${entry}.mo`]: module,
  };
  return msgpack.encode(
    Object.fromEntries(
      Object.entries(files).map(([path, bytes]) => [path, gzipSync(bytes)]),
    ),
  );
}

const deterministicGzipOptions = { level: 9 as const, mtime: 0 };

function hostedFixture(id = "alpha", version = 100): {
  bytes: Uint8Array;
  declaration: DeclaredHostedSource;
} {
  const snapshot = msgpack.encode({
    format: 1,
    package: { id, version },
    files: [
      {
        path: `apps/${id}/neutron.json`,
        mode: 0o644,
        content: text(JSON.stringify({ id, version })),
      },
    ],
  });
  const bytes = new Uint8Array(
    nodeGzipSync(snapshot, deterministicGzipOptions),
  );
  const sha256 = sha256Hex(bytes);
  const path = neutronAppSourceRepositoryPath(sha256);
  return {
    bytes,
    declaration: {
      url: `https://example.test${path}`,
      path,
      revision: `source-sha256:${sha256}`,
      sha256,
      size: bytes.byteLength,
      package: { id, version },
      buildInputs: [],
    },
  };
}

function metadataInspector(
  hostedSource: DeclaredHostedSource,
): PackageInspector {
  return (_file, bytes) => {
    const digest = sha256Hex(bytes);
    const record = parseRepositoryReleaseRecord({
      protocol: NEUTRON_REPOSITORY_PROTOCOL,
      id: "alpha",
      version: 100,
      sha256: digest,
      size: bytes.byteLength,
    });
    return {
      record,
      releaseBytes: serializeRepositoryReleaseRecord(record),
      packagePath: repositoryPackagePath(digest),
      releasePath: repositoryReleasePath(record.id),
      hostedSource,
    };
  };
}

describe("update package inspection", () => {
  test("uses Neutron's real package preparation for self-contained examples", () => {
    const examples = [
      ["alpha.neutron", "alpha", "Alpha"],
      ["bravo.neutron", "bravo", "Bravo"],
    ] as const;

    for (const [file, id, name] of examples) {
      const bytes = examplePackage(id, name);
      const inspected = inspectUpdatePackage(file, bytes);
      expect(inspected.record).toEqual({
        protocol: "neutron-repo-v1",
        id,
        version: 100,
        sha256: sha256Hex(bytes),
        size: bytes.byteLength,
      });
      expect(inspected.packagePath).toBe(
        `/repo/v1/packages/${sha256Hex(bytes)}.neutron`,
      );
      expect(inspected.releasePath).toBe(`/repo/v1/releases/${id}.json`);
    }
  });

  test("rejects invalid package bytes through the shared installer", () => {
    expect(() =>
      inspectUpdatePackage("broken.neutron", new Uint8Array([1, 2, 3])),
    ).toThrow("not a valid .neutron package");
  });

  test("rejects duplicate app ids before any publication", async () => {
    const inspect = () => ({
      record: {
        protocol: "neutron-repo-v1" as const,
        id: "alpha",
        version: 100,
        sha256: "a".repeat(64),
        size: 1,
      },
      releaseBytes: new TextEncoder().encode("{}"),
      packagePath: `/repo/v1/packages/${"a".repeat(64)}.neutron`,
      releasePath: "/repo/v1/releases/alpha.json",
    });
    await expect(
      inspectPackageFiles(["alpha.neutron", "copy.neutron"], {
        read: async () => new Uint8Array([1]),
        inspect,
      }),
    ).rejects.toThrow("repeats app id 'alpha'");
  });

  test("loads, gunzips, and package-binds the canonical source sidecar", async () => {
    const fixture = hostedFixture();
    const inspected = await inspectPackageFiles(["alpha.neutron"], {
      read: async () => new Uint8Array([1]),
      readSource: async (file) => {
        expect(file).toBe(
          hostedSourceArtifactPath("alpha.neutron", fixture.declaration.sha256),
        );
        return fixture.bytes.slice();
      },
      inspect: metadataInspector(fixture.declaration),
    });
    expect(inspected[0]?.hostedSource).toMatchObject({
      sha256: fixture.declaration.sha256,
      size: fixture.bytes.byteLength,
      bytes: fixture.bytes,
    });
  });

  test("rejects source sidecars with wrong size, digest, or package binding", async () => {
    const fixture = hostedFixture();
    const run = (
      declaration: DeclaredHostedSource,
      sourceBytes = fixture.bytes,
    ) =>
      inspectPackageFiles(["alpha.neutron"], {
        read: async () => new Uint8Array([1]),
        readSource: async () => sourceBytes.slice(),
        inspect: metadataInspector(declaration),
      });

    await expect(
      run({ ...fixture.declaration, size: fixture.bytes.byteLength + 1 }),
    ).rejects.toThrow("bytes; expected");
    const wrongDigest = "a".repeat(64);
    const wrongDigestPath = neutronAppSourceRepositoryPath(wrongDigest);
    await expect(
      run({
        ...fixture.declaration,
        url: `https://example.test${wrongDigestPath}`,
        path: wrongDigestPath,
        revision: `source-sha256:${wrongDigest}`,
        sha256: wrongDigest,
      }),
    ).rejects.toThrow("has digest");

    const wrongPackage = hostedFixture("bravo", 100);
    await expect(
      run({
        ...wrongPackage.declaration,
        package: { id: "alpha", version: 100 },
      }, wrongPackage.bytes),
    ).rejects.toThrow("is invalid for 'alpha'");
  });

  test("accepts digest-bound valid gzip bytes without runtime-specific recompression", async () => {
    const fixture = hostedFixture();
    const noncanonical = fixture.bytes.slice();
    noncanonical[4] = 1; // gzip MTIME, ignored by decompression but not canonical.
    const digest = sha256Hex(noncanonical);
    const declaration: DeclaredHostedSource = {
      ...fixture.declaration,
      url: `https://example.test${neutronAppSourceRepositoryPath(digest)}`,
      path: neutronAppSourceRepositoryPath(digest),
      revision: `source-sha256:${digest}`,
      sha256: digest,
      size: noncanonical.byteLength,
    };
    const inspected = await inspectPackageFiles(["alpha.neutron"], {
      read: async () => new Uint8Array([1]),
      readSource: async () => noncanonical,
      inspect: metadataInspector(declaration),
    });
    expect(inspected).toHaveLength(1);
    expect(inspected[0]?.hostedSource?.sha256).toBe(digest);
    expect(inspected[0]?.hostedSource?.size).toBe(noncanonical.byteLength);
  });

  test("counts hosted source bytes in the aggregate publication limit", async () => {
    const fixture = hostedFixture();
    const packageBytes = new Uint8Array([1]);
    Object.defineProperty(packageBytes, "byteLength", {
      value: MAX_PUBLICATION_BYTES,
    });
    const record = parseRepositoryReleaseRecord({
      protocol: NEUTRON_REPOSITORY_PROTOCOL,
      id: "alpha",
      version: 100,
      sha256: "a".repeat(64),
      size: 1,
    });

    await expect(
      inspectPackageFiles(["alpha.neutron"], {
        read: async () => packageBytes,
        readSource: async () => fixture.bytes,
        inspect: () => ({
          record,
          releaseBytes: serializeRepositoryReleaseRecord(record),
          packagePath: repositoryPackagePath(record.sha256),
          releasePath: repositoryReleasePath(record.id),
          hostedSource: fixture.declaration,
        }),
      }),
    ).rejects.toThrow(
      `Publication exceeds the ${MAX_PUBLICATION_BYTES}-byte upload limit`,
    );
  });
});
