import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ASSEMBLER_ID } from "neutron-compiler/src/assemble.js";
import {
  compiledActorCacheKey,
  resolveLocalCompiledActor,
  type CacheableCompileResult,
} from "../src/compiled_cache.ts";

const COMPILER_FINGERPRINT = "a".repeat(64);
const PACKAGE_HASHES = ["b".repeat(64), "c".repeat(64)];
const INSTALLATION_NETWORK_ID = "d".repeat(64);

describe("local compiled actor cache", () => {
  test("reuses only hash-verified raw Wasm, Candid, and stable outputs", async () => {
    await withTempDirectory(async (root) => {
      let compiles = 0;
      const cache = cacheOptions(root);
      const first = await resolveLocalCompiledActor({
        cache,
        packageArchiveSha256: PACKAGE_HASHES,
        compile: async () => {
          compiles += 1;
          return compiled;
        },
      });
      const second = await resolveLocalCompiledActor({
        cache,
        packageArchiveSha256: PACKAGE_HASHES,
        compile: async () => {
          throw new Error("a valid warm cache must skip compilation");
        },
      });

      expect(compiles).toBe(1);
      expect(second).toEqual(first);
      const entry = cacheEntry(root);
      expect((await readdir(entry)).sort()).toEqual([
        "metadata.json",
        "neutron.did",
        "neutron.most",
        "neutron.wasm",
      ]);
      expect(await readFile(path.join(entry, "neutron.wasm"))).toEqual(
        Buffer.from(compiled.wasm),
      );
      expect(await readFile(path.join(entry, "neutron.did"), "utf8")).toBe(
        compiled.candid,
      );
      expect(await readFile(path.join(entry, "neutron.most"), "utf8")).toBe(
        compiled.stable,
      );
    });
  });

  test("retains a valid compile when a later deployment phase fails", async () => {
    await withTempDirectory(async (root) => {
      let compiles = 0;
      let failAfterCompile = true;
      const deploy = async () => {
        const result = await resolveLocalCompiledActor({
          cache: cacheOptions(root),
          packageArchiveSha256: PACKAGE_HASHES,
          compile: async () => {
            compiles += 1;
            return compiled;
          },
        });
        if (failAfterCompile) throw new Error("simulated asset seeding failure");
        return result;
      };

      await expect(deploy()).rejects.toThrow("asset seeding failure");
      failAfterCompile = false;
      expect(await deploy()).toEqual(compiled);
      expect(compiles).toBe(1);
    });
  });

  test("discards and rebuilds an entry whose raw output hash changed", async () => {
    await withTempDirectory(async (root) => {
      const cache = cacheOptions(root);
      await resolveLocalCompiledActor({
        cache,
        packageArchiveSha256: PACKAGE_HASHES,
        compile: async () => compiled,
      });
      await writeFile(
        path.join(cacheEntry(root), "neutron.wasm"),
        new Uint8Array([99]),
      );

      let compiles = 0;
      const replacement = {
        ...compiled,
        wasm: new Uint8Array([7, 8, 9, 10]),
      };
      const result = await resolveLocalCompiledActor({
        cache,
        packageArchiveSha256: PACKAGE_HASHES,
        compile: async () => {
          compiles += 1;
          return replacement;
        },
      });

      expect(compiles).toBe(1);
      expect(result.wasm).toEqual(replacement.wasm);
      expect(await readFile(path.join(cacheEntry(root), "neutron.wasm"))).toEqual(
        Buffer.from(replacement.wasm),
      );
    });
  });

  test("rejects extra metadata fields instead of accepting an old schema", async () => {
    await withTempDirectory(async (root) => {
      const cache = cacheOptions(root);
      await resolveLocalCompiledActor({
        cache,
        packageArchiveSha256: PACKAGE_HASHES,
        compile: async () => compiled,
      });
      const metadataPath = path.join(cacheEntry(root), "metadata.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<
        string,
        unknown
      >;
      metadata.legacy = true;
      await writeFile(metadataPath, JSON.stringify(metadata));

      let compiles = 0;
      await resolveLocalCompiledActor({
        cache,
        packageArchiveSha256: PACKAGE_HASHES,
        compile: async () => {
          compiles += 1;
          return compiled;
        },
      });
      expect(compiles).toBe(1);
    });
  });

  test("keys ordered archives, target, and compiler implementation separately", () => {
    const base = compiledActorCacheKey({
      target: "local",
      compilerFingerprint: COMPILER_FINGERPRINT,
      packageArchiveSha256: PACKAGE_HASHES,
      installationNetworkIdHex: INSTALLATION_NETWORK_ID,
    });
    expect(
      compiledActorCacheKey({
        target: "local",
        compilerFingerprint: COMPILER_FINGERPRINT,
        packageArchiveSha256: [...PACKAGE_HASHES].reverse(),
        installationNetworkIdHex: INSTALLATION_NETWORK_ID,
      }),
    ).not.toBe(base);
    expect(
      compiledActorCacheKey({
        target: "production",
        compilerFingerprint: COMPILER_FINGERPRINT,
        packageArchiveSha256: PACKAGE_HASHES,
        installationNetworkIdHex: INSTALLATION_NETWORK_ID,
      }),
    ).not.toBe(base);
    expect(
      compiledActorCacheKey({
        target: "local",
        compilerFingerprint: "d".repeat(64),
        packageArchiveSha256: PACKAGE_HASHES,
        installationNetworkIdHex: INSTALLATION_NETWORK_ID,
      }),
    ).not.toBe(base);
    expect(
      compiledActorCacheKey({
        target: "local",
        compilerFingerprint: COMPILER_FINGERPRINT,
        packageArchiveSha256: PACKAGE_HASHES,
        installationNetworkIdHex: "e".repeat(64),
      }),
    ).not.toBe(base);
  });
});

const compiled: CacheableCompileResult = {
  wasm: new Uint8Array([0, 97, 115, 109, 1, 2, 3]),
  candid: "service : { ping : () -> (); }",
  stable: "type Neutron = { version : Nat };",
  compilerId: "moc_test",
  assemblerId: ASSEMBLER_ID,
  deploymentId: "deployment_test",
  browserSurfaceOriginAppIds: ["files"],
};

function cacheOptions(root: string) {
  return {
    directory: path.join(root, ".neutron", "cache", "compiled"),
    compilerFingerprint: COMPILER_FINGERPRINT,
    installationNetworkIdHex: INSTALLATION_NETWORK_ID,
    logger: { log() {} },
  };
}

function cacheEntry(root: string): string {
  const key = compiledActorCacheKey({
    target: "local",
    compilerFingerprint: COMPILER_FINGERPRINT,
    packageArchiveSha256: PACKAGE_HASHES,
    installationNetworkIdHex: INSTALLATION_NETWORK_ID,
  });
  return path.join(root, ".neutron", "cache", "compiled", "v3", key);
}

async function withTempDirectory(
  callback: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "compiled-actor-cache-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
