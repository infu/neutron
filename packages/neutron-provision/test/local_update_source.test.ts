import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { Principal } from "@dfinity/principal";
import {
  UPDATE_SOURCE_WASM_ARTIFACT,
  encodeAssetCanisterInitArgs,
  ensureLocalUpdateSource,
  loadLocalUpdateSourceAssets,
  localUpdateSourceIdentity,
  resolveLocalUpdateSourceWasm,
  synchronizeLocalUpdateSourceAssets,
  type LocalAssetCanisterActor,
  type LocalUpdateSourceAsset,
  type LocalUpdateSourceClient,
  type LocalUpdateSourceWasmArtifact,
  type PreparedLocalUpdateSourceWasm,
} from "../src/local_update_source.ts";

test("local update source pins the SDK 0.32.0 asset canister", () => {
  expect(UPDATE_SOURCE_WASM_ARTIFACT).toEqual({
    release: "dfinity-sdk-0.32.0",
    name: "assetstorage.wasm.gz",
    url: "https://github.com/dfinity/sdk/releases/download/0.32.0/assetstorage.wasm.gz",
    archiveSha256:
      "04e565b3425fe7510ee16b02adcfe3f01abc9a2725c82a21cb08969241debd62",
    moduleSha256:
      "763ae81b8e134067a1d622e1f2c561d60a0a538b5cc95cad804097f8ea6fa8c0",
  });
});

test("pinned update-source Wasm is verified, cached, and reverified", async () => {
  await withTempDirectory(async (root) => {
    const wasm = new TextEncoder().encode("synthetic asset canister");
    const archive = new Uint8Array(gzipSync(wasm));
    const artifact = testArtifact(archive, wasm);
    let downloads = 0;
    const fetcher = (async () => {
      downloads += 1;
      return new Response(archive, {
        headers: { "Content-Length": archive.byteLength.toString() },
      });
    }) as unknown as typeof fetch;
    const first = await resolveLocalUpdateSourceWasm({
      cacheDirectory: root,
      artifact,
      fetcher,
      logger: { log() {} },
    });
    expect(first.wasm).toEqual(wasm);
    expect(first.moduleHashHex).toBe(artifact.moduleSha256);

    const second = await resolveLocalUpdateSourceWasm({
      cacheDirectory: root,
      artifact,
      fetcher,
      logger: { log() {} },
    });
    expect(second).toEqual(first);
    expect(downloads).toBe(1);

    await writeFile(
      path.join(root, artifact.release, artifact.name),
      "corrupt",
    );
    await resolveLocalUpdateSourceWasm({
      cacheDirectory: root,
      artifact,
      fetcher,
      logger: { log() {} },
    });
    expect(downloads).toBe(2);
  });
});

test("pinned update-source Wasm rejects unverified bytes and cache symlinks", async () => {
  await withTempDirectory(async (root) => {
    const wasm = new TextEncoder().encode("expected");
    const archive = new Uint8Array(gzipSync(wasm));
    const artifact = testArtifact(archive, wasm);
    await expect(
      resolveLocalUpdateSourceWasm({
        cacheDirectory: root,
        artifact,
        fetcher: (async () =>
          new Response(gzipSync("attacker"))) as unknown as typeof fetch,
        logger: { log() {} },
      }),
    ).rejects.toThrow("archive checksum mismatch");

    const releaseDirectory = path.join(root, artifact.release);
    await mkdir(releaseDirectory, { recursive: true });
    const target = path.join(root, "outside");
    await writeFile(target, archive);
    await symlink(target, path.join(releaseDirectory, artifact.name));
    await expect(
      resolveLocalUpdateSourceWasm({
        cacheDirectory: root,
        artifact,
        fetcher: (async () =>
          new Response(archive)) as unknown as typeof fetch,
        logger: { log() {} },
      }),
    ).rejects.toThrow();
  });
});

test("asset loader recursively maps regular files and rejects symlinks", async () => {
  await withTempDirectory(async (root) => {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "health.txt"), "Neutron update source\n");
    await writeFile(path.join(root, "nested", "release.json"), "{}\n");
    const assets = await loadLocalUpdateSourceAssets(root);
    expect(
      assets.map(({ key, contentType }) => ({ key, contentType })),
    ).toEqual([
      { key: "/health.txt", contentType: "text/plain" },
      { key: "/nested/release.json", contentType: "application/json" },
    ]);
    expect(assets[0]?.sha256Hex).toBe(
      digest(new TextEncoder().encode("Neutron update source\n")),
    );

    await symlink(
      path.join(root, "health.txt"),
      path.join(root, "nested", "linked.txt"),
    );
    await expect(loadLocalUpdateSourceAssets(root)).rejects.toThrow(
      "Refusing symlink update-source asset",
    );
  });
});

test("ensure records a dynamic ID before installation and reuses a persisted ID", async () => {
  const canisterId = Principal.selfAuthenticating(
    new Uint8Array(32).fill(91),
  ).toText();
  const artifact: PreparedLocalUpdateSourceWasm = {
    wasm: new Uint8Array([0, 97, 115, 109]),
    moduleHashHex: "a".repeat(64),
  };
  const health = testAsset("/health.txt", "Neutron update source\n");
  const calls: string[] = [];
  const client: LocalUpdateSourceClient = {
    async createCanister() {
      calls.push("create");
      return canisterId;
    },
    async ensureInstalled(id, selected) {
      calls.push(`install:${id}`);
      expect(selected).toBe(artifact);
    },
    async synchronizeAssets(id, assets) {
      calls.push(`sync:${id}:${assets.length}`);
      return true;
    },
    async verifyHealth(id, asset) {
      calls.push(`health:${id}:${asset.key}`);
    },
  };
  const dependencies = {
    resolveWasm: async () => artifact,
    loadAssets: async () => [health],
    createClient: async () => client,
  };
  const common = {
    gatewayUrl: "http://localhost:8000/",
    expectedRootKeyBase64: "AQ==",
    defaultEffectiveCanisterIdBase64: "KgEB",
    cacheDirectory: "/unused",
    logger: { log() {} },
  };
  expect(
    await ensureLocalUpdateSource(
      {
        ...common,
        recordCanisterId: async (id) => {
          calls.push(`record:${id}`);
        },
      },
      dependencies,
    ),
  ).toBe(canisterId);
  expect(calls).toEqual([
    "create",
    `record:${canisterId}`,
    `install:${canisterId}`,
    `sync:${canisterId}:1`,
    `health:${canisterId}:/health.txt`,
  ]);

  calls.length = 0;
  expect(
    await ensureLocalUpdateSource(
      { ...common, existingCanisterId: canisterId },
      {
        ...dependencies,
        createClient: async () => ({
          ...client,
          async createCanister() {
            throw new Error("must reuse persisted ID");
          },
        }),
      },
    ),
  ).toBe(canisterId);
  expect(calls).toEqual([
    `install:${canisterId}`,
    `sync:${canisterId}:1`,
    `health:${canisterId}:/health.txt`,
  ]);
});

test("asset synchronization is exact and skips an unchanged fixture", async () => {
  const health = testAsset("/health.txt", "Neutron update source\n");
  const calls: Array<{ method: string; value: unknown }> = [];
  let listed = [metadata(testAsset("/old.txt", "old")), metadata(testAsset("/health.txt", "stale"))];
  const actor = {
    async list(value: unknown) {
      calls.push({ method: "list", value });
      return listed;
    },
    async create_batch(value: unknown) {
      calls.push({ method: "create_batch", value });
      return { batch_id: 7n };
    },
    async create_chunk(value: unknown) {
      calls.push({ method: "create_chunk", value });
      return { chunk_id: 9n };
    },
    async commit_batch(value: unknown) {
      calls.push({ method: "commit_batch", value });
    },
    async delete_batch(value: unknown) {
      calls.push({ method: "delete_batch", value });
    },
  } as unknown as LocalAssetCanisterActor;
  expect(await synchronizeLocalUpdateSourceAssets(actor, [health])).toBe(true);
  const commit = calls.find(({ method }) => method === "commit_batch")!;
  expect(commit.value).toEqual({
    batch_id: 7n,
    operations: [
      { DeleteAsset: { key: "/old.txt" } },
      { DeleteAsset: { key: "/health.txt" } },
      {
        CreateAsset: {
          key: "/health.txt",
          content_type: "text/plain",
          headers: [],
          allow_raw_access: [false],
          max_age: [],
          enable_aliasing: [false],
        },
      },
      {
        SetAssetContent: {
          key: "/health.txt",
          sha256: [health.sha256],
          chunk_ids: [9n],
          content_encoding: "identity",
          last_chunk: [],
        },
      },
    ],
  });
  expect(calls.some(({ method }) => method === "delete_batch")).toBe(false);

  calls.length = 0;
  listed = [metadata(health)];
  expect(await synchronizeLocalUpdateSourceAssets(actor, [health])).toBe(false);
  expect(calls.map(({ method }) => method)).toEqual(["list"]);
});

test("failed asset synchronization abandons its batch", async () => {
  const health = testAsset("/health.txt", "Neutron update source\n");
  let deleted: bigint | undefined;
  const actor = {
    async list() {
      return [];
    },
    async create_batch() {
      return { batch_id: 11n };
    },
    async create_chunk() {
      throw new Error("upload failed");
    },
    async commit_batch() {},
    async delete_batch({ batch_id }: { batch_id: bigint }) {
      deleted = batch_id;
    },
  } as unknown as LocalAssetCanisterActor;
  await expect(
    synchronizeLocalUpdateSourceAssets(actor, [health]),
  ).rejects.toThrow("upload failed");
  expect(deleted).toBe(11n);
});

test("update-source identity and init permissions are deterministic", () => {
  const first = localUpdateSourceIdentity().getPrincipal().toText();
  const second = localUpdateSourceIdentity().getPrincipal().toText();
  expect(first).toBe(second);
  expect(first).not.toBe(Principal.anonymous().toText());
  expect(encodeAssetCanisterInitArgs(Principal.fromText(first)).byteLength).toBeGreaterThan(20);
});

function testAsset(key: string, value: string): LocalUpdateSourceAsset {
  const bytes = new TextEncoder().encode(value);
  const sha256Hex = digest(bytes);
  return {
    key,
    contentType: key.endsWith(".txt") ? "text/plain" : "application/octet-stream",
    bytes,
    sha256: new Uint8Array(Buffer.from(sha256Hex, "hex")),
    sha256Hex,
  };
}

function metadata(asset: LocalUpdateSourceAsset) {
  return {
    key: asset.key,
    content_type: asset.contentType,
    encodings: [
      {
        content_encoding: "identity",
        sha256: [asset.sha256] as [Uint8Array],
        length: BigInt(asset.bytes.byteLength),
      },
    ],
  };
}

function testArtifact(
  archive: Uint8Array,
  wasm: Uint8Array,
): LocalUpdateSourceWasmArtifact {
  return {
    release: "dfinity-sdk-0.32.0",
    name: "synthetic-assetstorage.wasm.gz",
    url: "https://example.invalid/assetstorage.wasm.gz",
    archiveSha256: digest(archive),
    moduleSha256: digest(wasm),
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withTempDirectory(
  operation: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-update-source-"));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
