import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import msgpack from "tiny-msgpack";
import {
  NEUTRON_REPOSITORY_PROTOCOL,
  parseRepositoryReleaseRecord,
  repositoryPackagePath,
  repositoryReleasePath,
  serializeRepositoryReleaseRecord,
  type RepositoryReleaseRecord,
} from "neutron-tools/src/repository.ts";
import { neutronAppSourceRepositoryPath } from "neutron-tools/src/package_record.ts";
import { publishPackageFiles } from "../src/publish.ts";
import {
  PACKAGE_CONTENT_TYPE,
  PACKAGE_MAX_AGE_SECONDS,
  RELEASE_CONTENT_TYPE,
  RELEASE_MAX_AGE_SECONDS,
  SOURCE_CONTENT_TYPE,
  SOURCE_MAX_AGE_SECONDS,
  UPLOAD_CHUNK_BYTES,
  packageHeaders,
  releaseHeaders,
  sha256Hex,
  sourceHeaders,
  type DeclaredHostedSource,
  type PackageInspector,
} from "../src/model.ts";
import { MemoryAssetState, storedAsset } from "./memory_asset.ts";

const canisterId = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const origin = `http://${canisterId}.localhost:8003`;
const publisher =
  "l7put-ak4xb-iq2fx-7zgzw-n57my-5meck-krbld-etgzd-5lnha-zkuff-3ae";
const deterministicGzipOptions = { level: 9 as const, mtime: 0 };

function publishingState(): MemoryAssetState {
  const state = new MemoryAssetState();
  state.permissions.get("Commit")!.add(publisher);
  return state;
}

function inspector(versions: Record<string, number>): PackageInspector {
  return (file, bytes) => {
    const id = file.replace(/\.neutron$/, "");
    const digest = sha256Hex(bytes);
    const record = parseRepositoryReleaseRecord({
      protocol: NEUTRON_REPOSITORY_PROTOCOL,
      id,
      version: versions[id],
      sha256: digest,
      size: bytes.byteLength,
    });
    return {
      record,
      releaseBytes: serializeRepositoryReleaseRecord(record),
      packagePath: repositoryPackagePath(digest),
      releasePath: repositoryReleasePath(id),
    };
  };
}

type HostedSourceFixture = Readonly<{
  bytes: Uint8Array;
  digest: string;
  path: string;
}>;

function hostedSourceFixture(
  id: string,
  version: number,
): HostedSourceFixture {
  const snapshot = msgpack.encode({
    format: 1,
    package: { id, version },
    files: [
      {
        path: `apps/${id}/neutron.json`,
        mode: 0o644,
        content: new TextEncoder().encode(JSON.stringify({ id, version })),
      },
    ],
  });
  const bytes = new Uint8Array(
    gzipSync(snapshot, deterministicGzipOptions),
  );
  const digest = sha256Hex(bytes);
  return { bytes, digest, path: neutronAppSourceRepositoryPath(digest) };
}

function hostedInspector(
  versions: Record<string, number>,
  sources: Record<string, HostedSourceFixture>,
  sourceOrigin = origin,
): PackageInspector {
  const base = inspector(versions);
  return (file, bytes) => {
    const inspected = base(file, bytes);
    const id = inspected.record.id;
    const source = sources[id];
    if (!source) return inspected;
    const hostedSource: DeclaredHostedSource = {
      url: `${new URL(sourceOrigin).origin}${source.path}`,
      path: source.path,
      revision: `source-sha256:${source.digest}`,
      sha256: source.digest,
      size: source.bytes.byteLength,
      package: { id, version: versions[id]! },
      buildInputs: [],
    };
    return { ...inspected, hostedSource };
  };
}

function readHostedSources(
  sources: Record<string, HostedSourceFixture>,
): (file: string) => Promise<Uint8Array> {
  const byDigest = new Map(
    Object.values(sources).map((source) => [source.digest, source.bytes]),
  );
  return async (file) => {
    const digest = /([a-f0-9]{64})\.source\.v1\.msgpack\.gz$/u.exec(file)?.[1];
    const bytes = digest ? byDigest.get(digest) : undefined;
    if (!bytes) throw new Error(`missing test source ${file}`);
    return bytes.slice();
  };
}

function inputs(values: Record<string, Uint8Array>): {
  files: string[];
  read: (file: string) => Promise<Uint8Array>;
} {
  return {
    files: Object.keys(values).map((id) => `${id}.neutron`),
    read: async (file) => values[file.replace(/\.neutron$/, "")]!.slice(),
  };
}

function seedRelease(
  state: MemoryAssetState,
  record: RepositoryReleaseRecord,
): void {
  const bytes = serializeRepositoryReleaseRecord(record);
  state.seed(
    repositoryReleasePath(record.id),
    storedAsset({
      bytes,
      contentType: RELEASE_CONTENT_TYPE,
      headers: releaseHeaders(sha256Hex(bytes)),
      maxAge: RELEASE_MAX_AGE_SECONDS,
    }),
  );
}

describe("atomic update-source publication", () => {
  test("first publication lists metadata and only fetches after its atomic commit", async () => {
    const state = publishingState();
    const source = inputs({ alpha: new Uint8Array([1, 2, 3]) });
    const certifiedFetch = state.fetch(origin);
    const commitCountsAtFetch: number[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      commitCountsAtFetch.push(state.commits);
      return certifiedFetch(input, init);
    }) as typeof globalThis.fetch;

    const receipt = await publishPackageFiles(source.files, {
      canisterId,
      origin,
      port: state.actor(publisher),
      fetch,
      read: source.read,
      inspect: inspector({ alpha: 100 }),
    });

    expect(state.calls[0]).toBe(`list_assets:${publisher}`);
    expect(commitCountsAtFetch).toEqual([1, 1]);
    expect(state.fetchedPaths).toEqual([
      repositoryReleasePath("alpha"),
      receipt.packages[0]!.package_path,
    ]);
  });

  test("publishes two package blobs and pointers in one batch", async () => {
    const state = publishingState();
    const source = inputs({
      alpha: new Uint8Array([1, 2, 3]),
      bravo: new Uint8Array([4, 5, 6, 7]),
    });
    const receipt = await publishPackageFiles(source.files, {
      canisterId,
      origin,
      port: state.actor(publisher),
      fetch: state.fetch(origin),
      read: source.read,
      inspect: inspector({ alpha: 100, bravo: 101 }),
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    });

    expect(state.commits).toBe(1);
    expect(state.assets.size).toBe(4);
    expect(receipt).toMatchObject({
      protocol: "neutron-update-source-publish-v2",
      canister_id: canisterId,
      batch_id: "1",
      atomic: true,
      published_at: "2026-07-19T00:00:00.000Z",
      packages: [
        { id: "alpha", version: 100, status: "published" },
        { id: "bravo", version: 101, status: "published" },
      ],
    });
    for (const outcome of receipt.packages) {
      expect(state.assets.get(outcome.package_path)?.contentType).toBe(
        PACKAGE_CONTENT_TYPE,
      );
      expect(state.assets.get(outcome.package_path)?.maxAge).toBe(
        PACKAGE_MAX_AGE_SECONDS,
      );
      expect(state.assets.get(outcome.release_path)?.contentType).toBe(
        RELEASE_CONTENT_TYPE,
      );
      expect(state.assets.get(outcome.release_path)?.maxAge).toBe(
        RELEASE_MAX_AGE_SECONDS,
      );
    }
  });

  test("atomically publishes and certifies hosted source, package, and release", async () => {
    const state = publishingState();
    const packages = inputs({ alpha: new Uint8Array([1, 2, 3]) });
    const sources = { alpha: hostedSourceFixture("alpha", 100) };
    const receipt = await publishPackageFiles(packages.files, {
      canisterId,
      origin,
      port: state.actor(publisher),
      fetch: state.fetch(origin),
      read: packages.read,
      readSource: readHostedSources(sources),
      inspect: hostedInspector({ alpha: 100 }, sources),
    });

    expect(state.commits).toBe(1);
    expect(state.assets.size).toBe(3);
    expect(state.assets.get(sources.alpha.path)).toMatchObject({
      contentType: SOURCE_CONTENT_TYPE,
      maxAge: SOURCE_MAX_AGE_SECONDS,
      bytes: sources.alpha.bytes,
    });
    expect(receipt.packages[0]?.source).toEqual({
      url: `${origin}${sources.alpha.path}`,
      path: sources.alpha.path,
      sha256: sources.alpha.digest,
      size: sources.alpha.bytes.byteLength,
      status: "published",
    });
    expect(state.fetchedPaths).toEqual([
      repositoryReleasePath("alpha"),
      receipt.packages[0]!.package_path,
      sources.alpha.path,
    ]);
  });

  test("hosted source repeat publication is a fully verified no-op", async () => {
    const state = publishingState();
    const packages = inputs({ alpha: new Uint8Array([3, 2, 1]) });
    const sources = { alpha: hostedSourceFixture("alpha", 100) };
    const options = {
      canisterId,
      origin,
      port: state.actor(publisher),
      fetch: state.fetch(origin),
      read: packages.read,
      readSource: readHostedSources(sources),
      inspect: hostedInspector({ alpha: 100 }, sources),
    };
    await publishPackageFiles(packages.files, options);
    const commits = state.commits;
    state.fetchedPaths.length = 0;
    const receipt = await publishPackageFiles(packages.files, options);

    expect(state.commits).toBe(commits);
    expect(receipt.batch_id).toBeNull();
    expect(receipt.packages[0]).toMatchObject({
      status: "unchanged",
      source: { status: "unchanged", sha256: sources.alpha.digest },
    });
    expect(state.fetchedPaths).toContain(sources.alpha.path);
  });

  test("an unchanged release fails closed if its immutable source is missing", async () => {
    const state = publishingState();
    const packages = inputs({ alpha: new Uint8Array([4, 4, 4]) });
    const sources = { alpha: hostedSourceFixture("alpha", 100) };
    const options = {
      canisterId,
      origin,
      port: state.actor(publisher),
      fetch: state.fetch(origin),
      read: packages.read,
      readSource: readHostedSources(sources),
      inspect: hostedInspector({ alpha: 100 }, sources),
    };
    await publishPackageFiles(packages.files, options);
    state.assets.delete(sources.alpha.path);
    const commits = state.commits;

    await expect(publishPackageFiles(packages.files, options)).rejects.toThrow(
      "points to a missing immutable Complete App Source",
    );
    expect(state.commits).toBe(commits);
  });

  test("rejects a hosted source URL outside the configured certified origin", async () => {
    const state = publishingState();
    const packages = inputs({ alpha: new Uint8Array([5, 5, 5]) });
    const sources = { alpha: hostedSourceFixture("alpha", 100) };

    await expect(
      publishPackageFiles(packages.files, {
        canisterId,
        origin,
        port: state.actor(publisher),
        fetch: state.fetch(origin),
        read: packages.read,
        readSource: readHostedSources(sources),
        inspect: hostedInspector(
          { alpha: 100 },
          sources,
          "https://wrong.example",
        ),
      }),
    ).rejects.toThrow("Complete App Source URL must be");
    expect(state.calls).toEqual([]);
  });

  test("a hosted-source commit failure exposes none of the three assets", async () => {
    const state = publishingState();
    state.failCommit = true;
    const packages = inputs({ alpha: new Uint8Array([6, 6, 6]) });
    const sources = { alpha: hostedSourceFixture("alpha", 100) };

    await expect(
      publishPackageFiles(packages.files, {
        canisterId,
        origin,
        port: state.actor(publisher),
        fetch: state.fetch(origin),
        read: packages.read,
        readSource: readHostedSources(sources),
        inspect: hostedInspector({ alpha: 100 }, sources),
      }),
    ).rejects.toThrow("injected commit failure");
    expect(state.assets.size).toBe(0);
    expect(state.batches.size).toBe(0);
  });

  test("post-commit verification detects corrupt hosted source bytes", async () => {
    const state = publishingState();
    const packages = inputs({ alpha: new Uint8Array([7, 7, 7]) });
    const sources = { alpha: hostedSourceFixture("alpha", 100) };
    const certifiedFetch = state.fetch(origin);
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await certifiedFetch(input, init);
      if (
        state.commits > 0 &&
        new URL(response.url).pathname === sources.alpha.path &&
        response.status === 200
      ) {
        const corrupted = new Uint8Array(await response.arrayBuffer());
        corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
        const replacement = new Response(corrupted, {
          status: response.status,
          headers: response.headers,
        });
        Object.defineProperty(replacement, "url", { value: response.url });
        return replacement;
      }
      return response;
    }) as typeof globalThis.fetch;

    await expect(
      publishPackageFiles(packages.files, {
        canisterId,
        origin,
        port: state.actor(publisher),
        fetch,
        read: packages.read,
        readSource: readHostedSources(sources),
        inspect: hostedInspector({ alpha: 100 }, sources),
      }),
    ).rejects.toThrow(`expected ${sources.alpha.digest}`);
    expect(state.commits).toBe(1);
    expect(state.assets.size).toBe(3);

    const reconciled = await publishPackageFiles(packages.files, {
      canisterId,
      origin,
      port: state.actor(publisher),
      fetch: state.fetch(origin),
      read: packages.read,
      readSource: readHostedSources(sources),
      inspect: hostedInspector({ alpha: 100 }, sources),
    });
    expect(reconciled.batch_id).toBeNull();
    expect(reconciled.packages[0]).toMatchObject({
      status: "unchanged",
      source: { status: "unchanged" },
    });
  });

  test("reuses a preexisting verified source in a new release batch", async () => {
    const state = publishingState();
    const packages = inputs({ alpha: new Uint8Array([8, 8, 8]) });
    const sources = { alpha: hostedSourceFixture("alpha", 100) };
    state.seed(
      sources.alpha.path,
      storedAsset({
        bytes: sources.alpha.bytes,
        contentType: SOURCE_CONTENT_TYPE,
        headers: sourceHeaders(sources.alpha.digest),
        maxAge: SOURCE_MAX_AGE_SECONDS,
      }),
    );

    const receipt = await publishPackageFiles(packages.files, {
      canisterId,
      origin,
      port: state.actor(publisher),
      fetch: state.fetch(origin),
      read: packages.read,
      readSource: readHostedSources(sources),
      inspect: hostedInspector({ alpha: 100 }, sources),
    });
    expect(state.commits).toBe(1);
    expect(state.assets.size).toBe(3);
    expect(receipt.packages[0]?.source?.status).toBe("unchanged");
    expect(
      state.calls.filter((call) => call.startsWith("create_chunk:")).length,
    ).toBe(2);
  });

  test("rejects a corrupt preexisting source before creating a batch", async () => {
    const state = publishingState();
    const packages = inputs({ alpha: new Uint8Array([9, 9, 9]) });
    const sources = { alpha: hostedSourceFixture("alpha", 100) };
    const corrupt = new Uint8Array([1]);
    state.seed(
      sources.alpha.path,
      storedAsset({
        bytes: corrupt,
        contentType: SOURCE_CONTENT_TYPE,
        headers: sourceHeaders(sha256Hex(corrupt)),
        maxAge: SOURCE_MAX_AGE_SECONDS,
      }),
    );

    await expect(
      publishPackageFiles(packages.files, {
        canisterId,
        origin,
        port: state.actor(publisher),
        fetch: state.fetch(origin),
        read: packages.read,
        readSource: readHostedSources(sources),
        inspect: hostedInspector({ alpha: 100 }, sources),
      }),
    ).rejects.toThrow("bytes; expected");
    expect(state.commits).toBe(0);
    expect(
      state.calls.some((call) => call.startsWith("create_batch:")),
    ).toBe(false);
  });

  test("same version and digest is an idempotent verified no-op", async () => {
    const state = publishingState();
    const source = inputs({ alpha: new Uint8Array([8, 9, 10]) });
    const options = {
      canisterId,
      origin,
      port: state.actor(publisher),
      fetch: state.fetch(origin),
      read: source.read,
      inspect: inspector({ alpha: 100 }),
    };
    await publishPackageFiles(source.files, options);
    const commits = state.commits;
    const receipt = await publishPackageFiles(source.files, options);
    expect(state.commits).toBe(commits);
    expect(receipt.batch_id).toBeNull();
    expect(receipt.packages[0]?.status).toBe("unchanged");
  });

  test("refuses downgrade and same-version digest equivocation", async () => {
    const state = publishingState();
    seedRelease(state, {
      protocol: NEUTRON_REPOSITORY_PROTOCOL,
      id: "alpha",
      version: 102,
      sha256: "a".repeat(64),
      size: 3,
    });
    const source = inputs({ alpha: new Uint8Array([1, 2, 3]) });
    await expect(
      publishPackageFiles(source.files, {
        canisterId,
        origin,
        port: state.actor(publisher),
        fetch: state.fetch(origin),
        read: source.read,
        inspect: inspector({ alpha: 101 }),
      }),
    ).rejects.toThrow("Refusing to downgrade");

    state.assets.clear();
    seedRelease(state, {
      protocol: NEUTRON_REPOSITORY_PROTOCOL,
      id: "alpha",
      version: 101,
      sha256: "a".repeat(64),
      size: 3,
    });
    await expect(
      publishPackageFiles(source.files, {
        canisterId,
        origin,
        port: state.actor(publisher),
        fetch: state.fetch(origin),
        read: source.read,
        inspect: inspector({ alpha: 101 }),
      }),
    ).rejects.toThrow("already has a different digest");
    expect(state.commits).toBe(0);
  });

  test("a failed commit exposes neither package nor pointer", async () => {
    const state = publishingState();
    state.failCommit = true;
    const bytes = new Uint8Array([1, 2, 3]);
    const source = inputs({ alpha: bytes });
    await expect(
      publishPackageFiles(source.files, {
        canisterId,
        origin,
        port: state.actor(publisher),
        fetch: state.fetch(origin),
        read: source.read,
        inspect: inspector({ alpha: 100 }),
      }),
    ).rejects.toThrow("injected commit failure");
    expect(state.assets.size).toBe(0);
    expect(state.assets.has(repositoryReleasePath("alpha"))).toBe(false);
    expect(state.assets.has(repositoryPackagePath(sha256Hex(bytes)))).toBe(false);
    expect(state.batches.size).toBe(0);
    expect(state.calls.some((call) => call.startsWith("delete_batch:"))).toBe(
      true,
    );
  });

  test("a failed upload after staging package bytes exposes neither package nor pointer", async () => {
    const state = publishingState();
    // One package chunk is staged first; injecting the release-record upload
    // failure proves that staging never makes either asset externally visible.
    state.failCreateChunkAt = 2;
    const bytes = new Uint8Array([1, 2, 3]);
    const source = inputs({ alpha: bytes });

    await expect(
      publishPackageFiles(source.files, {
        canisterId,
        origin,
        port: state.actor(publisher),
        fetch: state.fetch(origin),
        read: source.read,
        inspect: inspector({ alpha: 100 }),
      }),
    ).rejects.toThrow("injected chunk upload failure");

    expect(state.createChunkCalls).toBe(2);
    expect(state.commits).toBe(0);
    expect(state.assets.has(repositoryReleasePath("alpha"))).toBe(false);
    expect(state.assets.has(repositoryPackagePath(sha256Hex(bytes)))).toBe(false);
    expect(state.batches.size).toBe(0);
    expect(state.calls.some((call) => call.startsWith("delete_batch:"))).toBe(
      true,
    );
  });

  test("post-commit verification rejects wrong certified response headers", async () => {
    const state = publishingState();
    const bytes = new Uint8Array([1, 2, 3]);
    const source = inputs({ alpha: bytes });
    const certifiedFetch = state.fetch(origin);
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await certifiedFetch(input, init);
      if (
        state.commits > 0 &&
        new URL(response.url).pathname === repositoryReleasePath("alpha") &&
        response.status === 200
      ) {
        response.headers.set("Content-Type", "text/plain");
      }
      return response;
    }) as typeof globalThis.fetch;

    await expect(
      publishPackageFiles(source.files, {
        canisterId,
        origin,
        port: state.actor(publisher),
        fetch,
        read: source.read,
        inspect: inspector({ alpha: 100 }),
      }),
    ).rejects.toThrow("wrong content-type header");

    expect(state.commits).toBe(1);
    expect(state.assets.has(repositoryReleasePath("alpha"))).toBe(true);
    expect(state.assets.has(repositoryPackagePath(sha256Hex(bytes)))).toBe(true);
  });

  test("post-commit verification rejects wrong certified response bytes", async () => {
    const state = publishingState();
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = sha256Hex(bytes);
    const packagePath = repositoryPackagePath(digest);
    const source = inputs({ alpha: bytes });
    const certifiedFetch = state.fetch(origin);
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await certifiedFetch(input, init);
      if (
        state.commits > 0 &&
        new URL(response.url).pathname === packagePath &&
        response.status === 200
      ) {
        const corrupted = new Uint8Array(await response.arrayBuffer());
        corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
        const replacement = new Response(corrupted, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        Object.defineProperty(replacement, "url", { value: response.url });
        return replacement;
      }
      return response;
    }) as typeof globalThis.fetch;

    await expect(
      publishPackageFiles(source.files, {
        canisterId,
        origin,
        port: state.actor(publisher),
        fetch,
        read: source.read,
        inspect: inspector({ alpha: 100 }),
      }),
    ).rejects.toThrow(`expected ${digest}`);

    expect(state.commits).toBe(1);
    expect(state.assets.has(repositoryReleasePath("alpha"))).toBe(true);
    expect(state.assets.has(packagePath)).toBe(true);
  });

  test("large packages are chunked while preserving byte order", async () => {
    const state = publishingState();
    const bytes = new Uint8Array(UPLOAD_CHUNK_BYTES + 123);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 239;
    const source = inputs({ alpha: bytes });
    const receipt = await publishPackageFiles(source.files, {
      canisterId,
      origin,
      port: state.actor(publisher),
      fetch: state.fetch(origin, 64 * 1024),
      read: source.read,
      inspect: inspector({ alpha: 100 }),
    });
    const stored = state.assets.get(receipt.packages[0]!.package_path)!;
    expect(stored.bytes).toEqual(bytes);
    expect(
      state.calls.filter((call) =>
        call.startsWith(`create_chunk:${publisher}:1:`),
      ).length,
    ).toBe(3); // two package chunks and one release-record chunk
  });

  test("does not enumerate a source containing unrelated records", async () => {
    const state = publishingState();
    for (let index = 0; index < 100; index += 1) {
      seedRelease(state, {
        protocol: NEUTRON_REPOSITORY_PROTOCOL,
        id: `app_${String(index).padStart(3, "0")}`,
        version: 100,
        sha256: index.toString(16).padStart(64, "0"),
        size: 1,
      });
    }
    const source = inputs({ alpha: new Uint8Array([1]) });
    await publishPackageFiles(source.files, {
      canisterId,
      origin,
      port: state.actor(publisher),
      fetch: state.fetch(origin),
      read: source.read,
      inspect: inspector({ alpha: 100 }),
    });
    expect(
      state.fetchedPaths.every(
        (path) => path.includes("/alpha.") || path.includes("/alpha.json") || path.includes("/packages/"),
      ),
    ).toBe(true);
    expect(
      state.fetchedPaths.some((path) => path.includes("app_")),
    ).toBe(false);
  });
});
