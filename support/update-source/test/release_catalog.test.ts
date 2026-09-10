import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "fflate";
import msgpack from "tiny-msgpack";
import { hashContent } from "neutron-tools/src/hash.ts";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.ts";
import {
  loadReleaseCatalog,
  productionReleaseCatalogPath,
  resolveReleaseCatalogPackageFiles,
} from "../src/release_catalog.ts";

const updateSource = "233tv-xiaaa-aaaay-aacta-cai";
const temporaryRoots: string[] = [];
const text = (value: string) => new TextEncoder().encode(value);

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("release catalog", () => {
  test("keeps the checked-in production inventory in declarative data", async () => {
    const catalog = await loadReleaseCatalog(productionReleaseCatalogPath);
    const publisher = await readFile(
      new URL("../scripts/publish-catalog.ts", import.meta.url),
      "utf8",
    );
    expect(catalog.updateSource).toBe(updateSource);
    expect(catalog.packages.length).toBeGreaterThan(0);
    expect(catalog.packages.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "taggr", "openchat", "nuance", "snsgov",
    ]));
    expect(new Set(catalog.packages.map(({ id }) => id)).size).toBe(
      catalog.packages.length,
    );
    expect(
      catalog.packages.every(({ directory }) =>
        directory.startsWith(path.resolve(import.meta.dir, "../../../apps/")),
      ),
    ).toBe(true);
    expect(publisher).not.toContain(updateSource);
    for (const { id } of catalog.packages) {
      expect(publisher).not.toContain(`"${id}"`);
    }
  });

  test("resolves manifest-derived archive names and validates package identity", async () => {
    const fixture = await releaseFixture();
    const catalog = await loadReleaseCatalog(fixture.catalogPath, {
      repositoryRoot: fixture.root,
    });

    await expect(resolveReleaseCatalogPackageFiles(catalog)).resolves.toEqual([
      fixture.archivePath,
    ]);
  });

  test("catalog inventory can exceed one mutation while retaining its byte bound and nonempty shape", async () => {
    const fixture = await emptyFixture();
    const base = {
      format: 1,
      update_source: updateSource,
      packages: Array.from({ length: 21 }, (_, index) => ({ id: `app_${index}`, directory: `../apps/app_${index}` })),
    };
    await writeCatalog(fixture.catalogPath, base);
    expect((await loadReleaseCatalog(fixture.catalogPath, { repositoryRoot: fixture.root })).packages).toHaveLength(21);
    await writeCatalog(fixture.catalogPath, { ...base, packages: [] });
    await expect(loadReleaseCatalog(fixture.catalogPath, { repositoryRoot: fixture.root })).rejects.toThrow("must contain at least one entry");
    await writeFile(fixture.catalogPath, JSON.stringify(base) + " ".repeat(256 * 1024));
    await expect(loadReleaseCatalog(fixture.catalogPath, { repositoryRoot: fixture.root })).rejects.toThrow("Release catalog exceeds 262144 bytes");
  });

  test("rejects unknown fields, duplicate identities, and paths outside the repository", async () => {
    const fixture = await emptyFixture();
    const base = {
      format: 1,
      update_source: updateSource,
      packages: [{ id: "alpha", directory: "../apps/alpha" }],
    };

    await writeCatalog(fixture.catalogPath, { ...base, legacy: true });
    await expect(
      loadReleaseCatalog(fixture.catalogPath, {
        repositoryRoot: fixture.root,
      }),
    ).rejects.toThrow(
      "release catalog must contain exactly format, packages, update_source",
    );

    await writeCatalog(fixture.catalogPath, {
      ...base,
      packages: [...base.packages, ...base.packages],
    });
    await expect(
      loadReleaseCatalog(fixture.catalogPath, {
        repositoryRoot: fixture.root,
      }),
    ).rejects.toThrow("duplicate package ids");

    await writeCatalog(fixture.catalogPath, {
      ...base,
      packages: [{ id: "alpha", directory: "../../outside" }],
    });
    await expect(
      loadReleaseCatalog(fixture.catalogPath, {
        repositoryRoot: fixture.root,
      }),
    ).rejects.toThrow("must remain inside the repository");
  });
});

async function releaseFixture(): Promise<{
  root: string;
  catalogPath: string;
  archivePath: string;
}> {
  const fixture = await emptyFixture();
  const packageDirectory = path.join(fixture.root, "apps/alpha");
  await mkdir(packageDirectory, { recursive: true });

  const module = text(
    'module { public class Init() { public func ping() : Text { "ok" } } }',
  );
  const entry = hashContent(module);
  const manifest = {
    format: 3,
    id: "alpha",
    name: "Alpha",
    version: 100,
    update_source: updateSource,
    entry,
    func: { ping: { type: "update", async: false } },
  };
  const manifestBytes = text(JSON.stringify(manifest));
  const archive = msgpack.encode({
    "neutron.json": gzipSync(manifestBytes),
    "web/index.html": gzipSync(text("<main></main>")),
    [`mo/${entry}.mo`]: gzipSync(module),
  });
  const archivePath = path.join(
    packageDirectory,
    packageArchiveFilename(manifest.id, manifest.version),
  );
  await Promise.all([
    writeFile(path.join(packageDirectory, "neutron.json"), manifestBytes),
    writeFile(archivePath, archive),
    writeCatalog(fixture.catalogPath, {
      format: 1,
      update_source: updateSource,
      packages: [{ id: "alpha", directory: "../apps/alpha" }],
    }),
  ]);
  return { ...fixture, archivePath };
}

async function emptyFixture(): Promise<{
  root: string;
  catalogPath: string;
}> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "neutron-release-catalog-"),
  );
  temporaryRoots.push(root);
  const catalogDirectory = path.join(root, "catalog");
  await mkdir(catalogDirectory, { recursive: true });
  return {
    root,
    catalogPath: path.join(catalogDirectory, "release-catalog.json"),
  };
}

async function writeCatalog(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, JSON.stringify(value));
}
