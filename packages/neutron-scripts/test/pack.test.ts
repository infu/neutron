import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import msgpack5 from "msgpack5";
import {
  NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH,
  parseBrowserSurfaceOriginsPackageMarker,
} from "neutron-tools/src/package_surface_origins.js";
import { packDirectory } from "../src/pack.ts";

const msgpack = msgpack5();

async function createPackageTree(
  rootDir: string,
  creationOrder: readonly string[],
): Promise<void> {
  await fs.writeFile(
    path.join(rootDir, "neutron.json"),
    JSON.stringify({ id: "reproducible", version: 100 }),
  );
  await fs.mkdir(path.join(rootDir, "dist"));
  for (const relativePath of creationOrder) {
    const absolutePath = path.join(rootDir, "dist", relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `contents:${relativePath}`);
  }
}

test("packer bytes do not depend on directory creation order", async () => {
  const firstRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-pack-order-a-"),
  );
  const secondRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-pack-order-b-"),
  );
  const paths = [
    "z-last.txt",
    "nested/z-child.txt",
    "a-first.txt",
    "nested/a-child.txt",
  ] as const;

  try {
    await createPackageTree(firstRoot, paths);
    await createPackageTree(secondRoot, [...paths].reverse());

    const firstArchive = await fs.readFile(await packDirectory(firstRoot));
    const secondArchive = await fs.readFile(await packDirectory(secondRoot));

    expect(firstArchive).toEqual(secondArchive);
  } finally {
    await Promise.all([
      fs.rm(firstRoot, { recursive: true, force: true }),
      fs.rm(secondRoot, { recursive: true, force: true }),
    ]);
  }
});

test("packer retains predecessor archives after writing a new release", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-pack-retained-predecessor-"),
  );

  try {
    await fs.writeFile(
      path.join(rootDir, "neutron.json"),
      JSON.stringify({ id: "retained", version: 102 }),
    );
    await fs.mkdir(path.join(rootDir, "dist"));
    await fs.writeFile(path.join(rootDir, "dist", "index.html"), "candidate");
    await fs.writeFile(
      path.join(rootDir, "retained.v0.1.1.neutron"),
      "durable predecessor",
    );

    await packDirectory(rootDir);

    expect(await fs.readFile(
      path.join(rootDir, "retained.v0.1.1.neutron"),
      "utf8",
    )).toBe("durable predecessor");
    expect(await fs.readdir(rootDir)).toContain("retained.v0.1.2.neutron");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("packer retains app-local and external durable predecessor fixtures", async () => {
  const repositoryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-pack-durable-predecessor-"),
  );
  const appRoot = path.join(repositoryRoot, "apps", "kernel");
  const fixturePath = path.join(
    repositoryRoot,
    "packages",
    "neutron-compiler",
    "test",
    "fixtures",
    "kernel.v0.3.6.neutron",
  );

  try {
    await fs.mkdir(path.join(appRoot, "dist"), { recursive: true });
    await fs.mkdir(path.dirname(fixturePath), { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(appRoot, "neutron.json"),
        JSON.stringify({ id: "kernel", version: 307 }),
      ),
      fs.writeFile(path.join(appRoot, "dist", "index.html"), "candidate"),
      fs.writeFile(
        path.join(appRoot, "kernel.v0.3.6.neutron"),
        "disposable app-local archive",
      ),
      fs.writeFile(fixturePath, "durable exact predecessor"),
    ]);

    const archivePath = await packDirectory(appRoot);

    expect(await fs.readFile(fixturePath, "utf8")).toBe(
      "durable exact predecessor",
    );
    expect(await fs.readdir(appRoot)).toContain("kernel.v0.3.6.neutron");
    const entries = msgpack.decode(
      await fs.readFile(archivePath),
    ) as Record<string, Uint8Array>;
    expect(entries[NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH]).toBeUndefined();
  } finally {
    await fs.rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("packer emits a deployment-target-neutral archive", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-pack-target-"),
  );

  try {
    await fs.writeFile(
      path.join(rootDir, "neutron.json"),
      JSON.stringify({ id: "target_test", version: 100 }),
    );
    await fs.mkdir(path.join(rootDir, "dist"));
    await fs.writeFile(path.join(rootDir, "dist", "index.html"), "test");

    const archivePath = await packDirectory(rootDir);
    const archive = await fs.readFile(archivePath);
    const entries = msgpack.decode(archive) as Record<string, Uint8Array>;
    expect(Object.keys(entries)).toEqual([
      "index.html",
      NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH,
    ]);
    expect(
      parseBrowserSurfaceOriginsPackageMarker(
        zlib.gunzipSync(
          entries[NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH]!,
        ),
      ),
    ).toBe(true);
    expect(entries[".neutron-build.json"]).toBeUndefined();
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("packer rejects the removed build-target marker", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-pack-reserved-"),
  );

  try {
    await fs.writeFile(
      path.join(rootDir, "neutron.json"),
      JSON.stringify({ id: "reserved_test", version: 100 }),
    );
    await fs.mkdir(path.join(rootDir, "dist"));
    await fs.writeFile(
      path.join(rootDir, "dist", ".neutron-build.json"),
      "forged",
    );

    await expect(packDirectory(rootDir)).rejects.toThrow(
      "package archives are deployment-target neutral",
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("packer reserves the browser-surface origins marker", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-pack-origin-marker-"),
  );

  try {
    await fs.writeFile(
      path.join(rootDir, "neutron.json"),
      JSON.stringify({ id: "reserved_origin", version: 100 }),
    );
    const markerPath = path.join(
      rootDir,
      "dist",
      ...NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH.split("/"),
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, '{"format":1}\n');

    await expect(packDirectory(rootDir)).rejects.toThrow(
      "reserved for package-generation metadata",
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
