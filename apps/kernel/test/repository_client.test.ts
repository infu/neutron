import { describe, expect, test } from "bun:test";
import {
  serializeRepositoryInfo,
  serializeRepositoryManifest,
  type RepositoryManifest,
  type RepositorySetupReference,
} from "neutron-tools/repository";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  createRepositoryFetch,
  verifyRepositorySetupBytes,
  type RepositoryByteSource,
} from "../src/repository/client.ts";

const encoder = new TextEncoder();

function fixture() {
  const packageBytes = [encoder.encode("hello-package"), encoder.encode("other-package")];
  const manifest: RepositoryManifest = {
    protocol: "neutron-repo-v1",
    id: "demo",
    revision: 1,
    name: "Demo",
    packages: packageBytes.map((bytes, index) => ({
      id: index === 0 ? "hello" : "other_app",
      version: 100,
      sha256: hashContent(bytes),
      size: bytes.byteLength,
    })),
  };
  const manifestBytes = serializeRepositoryManifest(manifest);
  const reference: RepositorySetupReference = {
    repo: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    manifest: "demo",
    digest: hashContent(manifestBytes),
  };
  const infoBytes = serializeRepositoryInfo({
    protocol: "neutron-repo-v1",
    name: "Example",
    provider: { name: "Example provider" },
  });
  return { infoBytes, manifest, manifestBytes, packageBytes, reference };
}

describe("repository byte verification", () => {
  test("fetches and verifies every pinned package through one uniform path", async () => {
    const value = fixture();
    const reads: string[] = [];
    const packages = new Map(
      value.manifest.packages.map((metadata, index) => [
        metadata.sha256,
        value.packageBytes[index]!,
      ]),
    );
    const source: RepositoryByteSource = {
      async readInfo() {
        reads.push("info");
        return value.infoBytes;
      },
      async readManifest(id) {
        reads.push(`manifest:${id}`);
        return value.manifestBytes;
      },
      async readPackage(digest) {
        reads.push(`package:${digest}`);
        return packages.get(digest);
      },
    };
    const loaded = await verifyRepositorySetupBytes(value.reference, source);
    expect(loaded.packages.map(({ metadata }) => metadata.id)).toEqual([
      "hello",
      "other_app",
    ]);
    expect(reads.filter((read) => read.startsWith("package:"))).toHaveLength(2);
  });

  test("keeps a 50-package manifest within the four-read concurrency bound", async () => {
    const packageBytes = Array.from({ length: 50 }, (_, index) =>
      encoder.encode(`small-package-${index}`),
    );
    const manifest: RepositoryManifest = {
      protocol: "neutron-repo-v1",
      id: "fifty_apps",
      revision: 1,
      name: "Fifty apps",
      packages: packageBytes.map((bytes, index) => ({
        id: `app_${index}`,
        version: 100,
        sha256: hashContent(bytes),
        size: bytes.byteLength,
      })),
    };
    const manifestBytes = serializeRepositoryManifest(manifest);
    const reference: RepositorySetupReference = {
      repo: "ryjl3-tyaaa-aaaaa-aaaba-cai",
      manifest: manifest.id,
      digest: hashContent(manifestBytes),
    };
    const infoBytes = serializeRepositoryInfo({
      protocol: "neutron-repo-v1",
      name: "Example",
      provider: { name: "Example provider" },
    });
    const packages = new Map(
      manifest.packages.map(({ sha256 }, index) => [
        sha256,
        packageBytes[index]!,
      ]),
    );
    let active = 0;
    let maximumActive = 0;
    let packageReads = 0;
    const loaded = await verifyRepositorySetupBytes(reference, {
      async readInfo() {
        return infoBytes;
      },
      async readManifest() {
        return manifestBytes;
      },
      async readPackage(digest) {
        packageReads += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return packages.get(digest);
      },
    });

    expect(loaded.packages).toHaveLength(50);
    expect(packageReads).toBe(50);
    expect(maximumActive).toBe(4);
    expect(active).toBe(0);
  });

  test("rejects the manifest before any package read when its pin differs", async () => {
    const value = fixture();
    let packageReads = 0;
    const source: RepositoryByteSource = {
      async readInfo() {
        return value.infoBytes;
      },
      async readManifest() {
        return value.manifestBytes;
      },
      async readPackage() {
        packageReads += 1;
        return new Uint8Array();
      },
    };
    await expect(
      verifyRepositorySetupBytes(
        { ...value.reference, digest: "f".repeat(64) },
        source,
      ),
    ).rejects.toThrow(/Pinned manifest digest mismatch/);
    expect(packageReads).toBe(0);
  });

  test("settles and cancels sibling package reads before exposing failure", async () => {
    const packageBytes = Array.from({ length: 6 }, (_, index) =>
      encoder.encode(`package-${index}`),
    );
    const manifest: RepositoryManifest = {
      protocol: "neutron-repo-v1",
      id: "failure_demo",
      revision: 1,
      name: "Failure demo",
      packages: packageBytes.map((bytes, index) => ({
        id: `app_${index}`,
        version: 100,
        sha256: hashContent(bytes),
        size: bytes.byteLength,
      })),
    };
    const manifestBytes = serializeRepositoryManifest(manifest);
    const reference: RepositorySetupReference = {
      repo: "ryjl3-tyaaa-aaaaa-aaaba-cai",
      manifest: manifest.id,
      digest: hashContent(manifestBytes),
    };
    const infoBytes = serializeRepositoryInfo({
      protocol: "neutron-repo-v1",
      name: "Example",
      provider: { name: "Example provider" },
    });
    const indexByDigest = new Map(
      manifest.packages.map(({ sha256 }, index) => [sha256, index]),
    );
    let releaseSiblings!: () => void;
    const siblingAbort = new Promise<void>((resolve) => {
      releaseSiblings = resolve;
    });
    let activeReads = 0;
    let abortCalls = 0;
    const reads: number[] = [];
    const source: RepositoryByteSource = {
      async readInfo() {
        return infoBytes;
      },
      async readManifest() {
        return manifestBytes;
      },
      async readPackage(digest) {
        const index = indexByDigest.get(digest)!;
        reads.push(index);
        activeReads += 1;
        try {
          if (index === 0) {
            await Promise.resolve();
            throw new Error("first package failed");
          }
          await siblingAbort;
          await Promise.resolve();
          throw new DOMException("cancelled sibling", "AbortError");
        } finally {
          activeReads -= 1;
        }
      },
    };

    await expect(
      verifyRepositorySetupBytes(reference, source, undefined, () => {
        abortCalls += 1;
        releaseSiblings();
      }),
    ).rejects.toThrow("first package failed");

    expect(abortCalls).toBe(1);
    expect(activeReads).toBe(0);
    // Only the initial bounded worker set started; no worker consumed the two
    // remaining entries after the first failure.
    expect(reads.sort((left, right) => left - right)).toEqual([0, 1, 2, 3]);
    const readsAtRejection = reads.length;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toHaveLength(readsAtRejection);
  });
});

test("repository transport strips credentials, referrer, and cache", async () => {
  let observed: RequestInit | undefined;
  const base = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    observed = init;
    return new Response("ok");
  }) as unknown as typeof fetch;
  await createRepositoryFetch(base)("https://example.invalid/", {
    credentials: "include",
    referrerPolicy: "unsafe-url",
    cache: "default",
  });
  expect(observed?.credentials).toBe("omit");
  expect(observed?.referrerPolicy).toBe("no-referrer");
  expect(observed?.cache).toBe("no-store");
});
