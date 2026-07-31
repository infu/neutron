import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  POCKET_IC_ARTIFACTS,
  POCKET_IC_IDLE_TTL_SECONDS,
  POCKET_IC_SERVER_VERSION,
  assertPocketIcVersionOutput,
  pocketIcArtifactForHost,
  pocketIcServerArguments,
  resolvePocketIcBinary,
  verifyPocketIcBinary,
  type PocketIcArtifact,
} from "../src/pocketic_binary.ts";

describe("PocketIC pinned binary resolution", () => {
  test("downloads, verifies, atomically caches, and re-verifies the executable", async () => {
    await withTempDirectory(async (root) => {
      const executable = Buffer.from("synthetic pocket-ic 14 executable\n");
      const archive = gzipSync(executable);
      const artifact = testArtifact(archive, executable);
      let downloads = 0;
      const fetcher = async (): Promise<Response> => {
        downloads += 1;
        return new Response(archive, {
          status: 200,
          headers: { "Content-Length": archive.byteLength.toString() },
        });
      };

      const first = await resolvePocketIcBinary({
        cacheDirectory: path.join(root, "cache"),
        artifact,
        fetcher,
      });
      expect(first.version).toBe(POCKET_IC_SERVER_VERSION);
      expect(first.sha256).toBe(artifact.binarySha256);
      expect(await readFile(first.path)).toEqual(executable);
      expect((await stat(first.path)).mode & 0o777).toBe(0o700);
      await verifyPocketIcBinary(first.path, artifact.binarySha256);

      const second = await resolvePocketIcBinary({
        cacheDirectory: path.join(root, "cache"),
        artifact,
        fetcher,
      });
      expect(second).toEqual(first);
      expect(downloads).toBe(1);

      await writeFile(first.path, "corrupt", { mode: 0o700 });
      await chmod(first.path, 0o700);
      await resolvePocketIcBinary({
        cacheDirectory: path.join(root, "cache"),
        artifact,
        fetcher,
      });
      expect(downloads).toBe(2);
      expect(await readFile(first.path)).toEqual(executable);
    });
  });

  test("rejects an unverified archive and never installs it", async () => {
    await withTempDirectory(async (root) => {
      const executable = Buffer.from("expected executable");
      const expectedArchive = gzipSync(executable);
      const artifact = testArtifact(expectedArchive, executable);
      const cacheDirectory = path.join(root, "cache");
      await expect(
        resolvePocketIcBinary({
          cacheDirectory,
          artifact,
          fetcher: async () => new Response(gzipSync(Buffer.from("attacker"))),
        }),
      ).rejects.toThrow("release archive checksum mismatch");
    });
  });

  test("never follows a cached executable symlink", async () => {
    if (process.platform === "win32") return;
    await withTempDirectory(async (root) => {
      const executable = Buffer.from("expected executable");
      const archive = gzipSync(executable);
      const artifact = testArtifact(archive, executable);
      const artifactDirectory = path.join(
        root,
        "cache",
        `pocket-ic-${artifact.version}-${artifact.platform}-${artifact.architecture}`,
      );
      await writeFile(path.join(root, "target"), executable);
      await mkdir(artifactDirectory, { recursive: true });
      await symlink(path.join(root, "target"), path.join(artifactDirectory, "pocket-ic"));

      await expect(
        resolvePocketIcBinary({
          cacheDirectory: path.join(root, "cache"),
          artifact,
          fetcher: async () => new Response(archive),
        }),
      ).rejects.toThrow("Refusing symlink PocketIC executable");
    });
  });

  test("pins supported upstream artifacts and exact long-lived launch arguments", () => {
    expect(POCKET_IC_ARTIFACTS).toHaveLength(4);
    for (const artifact of POCKET_IC_ARTIFACTS) {
      expect(artifact.version).toBe("14.0.0");
      expect(artifact.url).toStartWith(
        "https://github.com/dfinity/pocketic/releases/download/14.0.0/",
      );
      expect(artifact.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.binarySha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(pocketIcArtifactForHost("linux", "x64").archiveSha256).toBe(
      "292c0b7fb7066c19de57bb731281f664f6af1ece0ef1462274000075b0ae8a2b",
    );
    expect(pocketIcServerArguments("/private/run/pocketic.port")).toEqual([
      "--ttl",
      POCKET_IC_IDLE_TTL_SECONDS.toString(),
      "--port-file",
      "/private/run/pocketic.port",
      "--log-levels",
      "error",
    ]);
    expect(() => assertPocketIcVersionOutput("pocket-ic-server 14.0.0\n")).not.toThrow();
    expect(() => assertPocketIcVersionOutput("pocket-ic-server 13.0.0")).toThrow(
      "Expected pocket-ic-server 14.0.0",
    );
  });
});

function testArtifact(archive: Buffer, executable: Buffer): PocketIcArtifact {
  return {
    version: POCKET_IC_SERVER_VERSION,
    platform: "linux",
    architecture: "x64",
    url: "https://example.invalid/pocket-ic.gz",
    archiveSha256: digest(archive),
    binarySha256: digest(executable),
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withTempDirectory(
  operation: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-pocketic-binary-"));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
