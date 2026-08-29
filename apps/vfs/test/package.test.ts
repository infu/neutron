import { beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import { generateAppMethodSchemaArtifact } from "neutron-scripts/src/method_schema.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { type NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import {
  NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX,
  NEUTRON_PACKAGE_RECORD_PATH,
  neutronAppSourceArchiveFilename,
  neutronPackageRecordArchiveOnlyPaths,
} from "neutron-tools/package_record.js";
import { verifyFilesRelease } from "../scripts/release.ts";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendUrl = new URL("../backend/main.mo", import.meta.url);
const htmlUrl = new URL("../dist/web/index.html", import.meta.url);
const cssUrl = new URL("../dist/web/main.css", import.meta.url);
const jsUrl = new URL("../dist/web/main.js", import.meta.url);
const serviceHtmlUrl = new URL("../dist/web/service.html", import.meta.url);
const serviceJsUrl = new URL("../dist/web/service.js", import.meta.url);
const packageUrl = new URL("../files.v0.4.8.neutron", import.meta.url);

const VAULT_METHODS = [
  "files_bootstrap_v2",
  "files_list_v2",
  "files_lookup_v2",
  "files_read_chunk_v2",
  "files_operation_status_v2",
  "files_vault_write_v2",
  "files_write_block_v2",
  "files_mutate_v2",
  "files_remove_v2",
  "files_abort_v2",
  "files_cleanup_v2",
] as const;

const PLAIN_METHODS = [
  "files_plain_list_v3",
  "files_plain_stat_v3",
  "files_plain_read_chunk_v3",
  "files_plain_write_block_v3",
  "files_plain_mkdir_v3",
  "files_plain_move_v3",
  "files_plain_remove_v3",
  "files_plain_abort_v3",
  "files_plain_cleanup_v3",
] as const;

const METHODS = [...VAULT_METHODS, ...PLAIN_METHODS] as const;

beforeAll(async () => {
  await verifyFilesRelease();
});

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

test("Files package manifest binds Shared, Vault, and Workspace storage", async () => {
  const manifest = await readManifest();
  expect(validate_neutron_conf(manifest).valid).toBe(true);
  expect(manifest).toMatchObject({
    id: "files",
    name: "Files",
    version: 408,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    background: { path: "service.html" },
    backend: { capabilities: { certified_assets: { api: 2 } } },
    capabilities: {
      background_ui_requests: { api: 1, categories: ["frontend_tool"] },
      vetkeys: { api: 1, slots: [{ id: "files_vault" }] },
      persistent_browser_storage: {
        api: 1,
        surface: "background",
      },
      preapproved_self_calls: { api: 1 },
      certified_assets: { api: 2 },
    },
    tiles: [{ id: "files", path: "index.html", icon: "static/icon.svg" }],
    memory: {
      files: {
        version: 2,
        schemas: {
          "1": { src: "memory/files/v1.mo" },
          "2": { src: "memory/files/v2.mo" },
        },
        migrations: [
          {
            from: 1,
            to: 2,
            src: "memory/files/v1_to_v2.mo",
          },
        ],
      },
    },
  });
  expect(Object.keys(manifest.func ?? {}).sort()).toEqual([...METHODS].sort());
  expect(manifest.capabilities).not.toHaveProperty("dedicated_resident_origin");
  expect(manifest.capabilities).not.toHaveProperty("public_ingress");
  expect(manifest.capabilities).not.toHaveProperty("scheduled_tasks");
  expect(manifest).not.toHaveProperty("init_arg");
});

test("Files emits all Vault and plaintext backend method schemas", async () => {
  const manifest = await readManifest();
  const backend = await readFile(backendUrl, "utf8");
  const artifact = generateAppMethodSchemaArtifact(manifest, backend);
  expect(Object.keys(artifact.methods).sort()).toEqual([...METHODS].sort());
  for (const method of METHODS) {
    expect(artifact.methods[method]).toBeDefined();
  }
  const lookupInput = artifact.methods.files_lookup_v2?.input as {
    maxItems?: number;
  };
  const writeInput = artifact.methods.files_write_block_v2?.input as {
    maxItems?: number;
  };
  expect(lookupInput.maxItems).toBe(1);
  expect(writeInput.maxItems).toBe(1);
  expect(
    JSON.stringify(artifact.methods.files_lookup_v2?.input),
  ).toContain('"body"');
  expect(
    JSON.stringify(artifact.methods.files_write_block_v2?.input),
  ).toContain('"body"');
  expect(
    JSON.stringify(artifact.methods.files_lookup_v2?.output),
  ).toContain('"body"');
  expect(
    JSON.stringify(artifact.methods.files_plain_write_block_v3?.input),
  ).toContain('"body"');
  expect(
    JSON.stringify(artifact.methods.files_plain_read_chunk_v3?.output),
  ).toContain('"body"');
});

test("Files bundles its three roots, upload, links, and tool surface", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const css = await readFile(cssUrl, "utf8");
  const js = await readFile(jsUrl, "utf8");
  const serviceHtml = await readFile(serviceHtmlUrl, "utf8");
  const serviceJs = await readFile(serviceJsUrl, "utf8");

  expect(html).toContain("./main.css");
  expect(css).toContain(".nt-app");
  expect(js).toMatch(/Upload|Choose files/);
  expect(js).toContain("Shared");
  expect(js).toContain("Vault");
  expect(js).toContain("Workspace");
  expect(js).toContain("Get link");
  expect(serviceHtml).toContain("./service.js");
  for (const tool of [
    "list",
    "stat",
    "read",
    "readBinary",
    "write",
    "writeBinary",
    "writeMany",
    "append",
    "patch",
    "mkdir",
    "move",
    "remove",
  ]) {
    expect(serviceJs).toContain(tool);
  }
  expect(serviceJs).toContain("neutron:attachments");
  expect(serviceJs).toContain("files_vault");
  expect(serviceJs.length).toBeGreaterThan(100_000);
});

test("Files package contains the backend, memory, schema, and web install paths", async () => {
  const unpacked = unpackNeutronPackage(await readFile(packageUrl));
  const paths = Object.keys(unpacked).sort();
  const packedManifest = JSON.parse(
    new TextDecoder().decode(unpacked["neutron.json"]),
  ) as NeutronManifest & {
    entry: string;
    memory: {
      files: {
        schemas: {
          "1": {
            entry: string;
          };
          "2": {
            entry: string;
          };
        };
        migrations: Array<{ from: number; to: number; entry: string }>;
      };
    };
  };
  expect(packedManifest.entry).toMatch(/^[a-f0-9]{64}$/u);
  expect(packedManifest).not.toHaveProperty("package_features");
  expect(packedManifest.memory.files.schemas["1"].entry).toMatch(
    /^[a-f0-9]{64}$/u,
  );
  expect(packedManifest.memory.files.schemas["2"].entry).toMatch(
    /^[a-f0-9]{64}$/u,
  );
  expect(packedManifest.memory.files.migrations).toEqual([
    expect.objectContaining({
      from: 1,
      to: 2,
      entry: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }),
  ]);
  const migrationEntry = packedManifest.memory.files.migrations[0]?.entry;
  expect(migrationEntry).toBeDefined();
  for (const path of [
    ".neutron-release-evidence.json",
    "legal/LICENSE.APP.txt",
    "legal/THIRD_PARTY_NOTICES.md",
    NEUTRON_PACKAGE_RECORD_PATH,
    "legal/APPLICATION-NOTICE.txt",
    "neutron.json",
    "neutron.lock.json",
    "schema.json",
    `mo/${packedManifest.entry}.mo`,
    `mo/${packedManifest.memory.files.schemas["1"].entry}.mo`,
    `mo/${packedManifest.memory.files.schemas["2"].entry}.mo`,
    `mo/${migrationEntry}.mo`,
    "web/index.html",
    "web/main.css",
    "web/main.js",
    "web/service.html",
    "web/service.js",
    "web/static/icon.svg",
  ]) {
    expect(paths).toContain(path);
  }
  expect(paths).not.toContain(".neutron-worker-browser-evidence.json");
  expect(paths).not.toContain("main.mo");
  expect(paths).not.toContain("memory/files/v1.mo");
  expect(paths).not.toContain("memory/files/v2.mo");
  expect(paths).not.toContain("memory/files/v1_to_v2.mo");
  expect(paths).not.toContain("THIRD_PARTY_NOTICES.md");
  expect(paths).not.toContain(NEUTRON_APP_SOURCE_SNAPSHOT_PATH);
  expect(paths.some((path) =>
    path.startsWith(NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX)
  )).toBe(false);
  expect(paths.some((path) =>
    path.startsWith("legal/third-party/")
  )).toBe(true);
  expect(paths.some((path) => path.endsWith(".source.v1.msgpack.gz"))).toBe(
    false,
  );

  const prepared = preparePackageInstall(unpacked);
  expect(prepared.manifest.version).toBe(408);
  expect(prepared.packageRecord?.license.id).toBe(
    "LicenseRef-Neutron-Sovereign-Application-License-1.0",
  );
  expect(prepared.packageRecord?.features).toBeUndefined();
  const source = prepared.packageRecord?.source;
  expect(source?.kind).toBe("https");
  if (source?.kind !== "https") {
    throw new Error("Files package must carry an HTTPS source offer");
  }
  expect(source.revision).toBe(`source-sha256:${source.sha256}`);
  expect(source.url).toBe(
    `https://233tv-xiaaa-aaaay-aacta-cai.icp0.io/repo/v1/sources/` +
      neutronAppSourceArchiveFilename(source.sha256),
  );
  const sourceArtifact = new Uint8Array(
    await readFile(
      new URL(
        `../.neutron/sources/${neutronAppSourceArchiveFilename(source.sha256)}`,
        import.meta.url,
      ),
    ),
  );
  expect(sourceArtifact.byteLength).toBe(source.bytes);
  expect(hashContent(sourceArtifact)).toBe(source.sha256);
  const sourceSnapshot = new Uint8Array(gunzipSync(sourceArtifact));
  expect(sourceSnapshot.byteLength).toBeGreaterThan(0);
  const installedPaths = prepared.files.map((file) => file.path);
  expect(installedPaths).toContain("app/files/index.html");
  expect(installedPaths).toContain("app/files/service.html");
  expect(installedPaths).toContain("app/files/service.js");
  expect(installedPaths).toContain(
    `app/files/pkg/${NEUTRON_PACKAGE_RECORD_PATH}`,
  );
  expect(installedPaths).toContain(
    "app/files/pkg/legal/APPLICATION-NOTICE.txt",
  );
  expect(installedPaths).toContain("app/files/pkg/legal/LICENSE.APP.txt");
  expect(installedPaths).toContain(
    "app/files/pkg/legal/THIRD_PARTY_NOTICES.md",
  );
  expect(
    neutronPackageRecordArchiveOnlyPaths(prepared.packageRecord!),
  ).toEqual([]);
});
