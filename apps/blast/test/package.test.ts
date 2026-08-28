import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import {
  assertNeutronAppSourceBuildInputs,
  decodeNeutronAppSourceSnapshot,
} from "neutron-compiler/src/source_snapshot.ts";
import { hashContent } from "neutron-tools/src/hash.ts";
import {
  NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS,
  NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX,
  NEUTRON_PACKAGE_RECORD_PATH,
  neutronAppSourceArchiveFilename,
  neutronPackageRecordArchiveOnlyPaths,
} from "neutron-tools/src/package_record.ts";
import {
  NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH,
  browserSurfaceOriginsPackageMarkerBytes,
} from "neutron-tools/src/package_surface_origins.ts";
import type {
  NeutronManifest,
  PackagedNeutronManifest,
} from "neutron-tools/src/schema.ts";
import { formatAppVersion } from "neutron-tools/src/version.ts";

const appRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(appRoot, "../..");
const sourceManifestBytes = await readBytes(resolve(appRoot, "neutron.json"));
const manifest = JSON.parse(
  new TextDecoder().decode(sourceManifestBytes),
) as NeutronManifest;
const archivePath = resolve(
  appRoot,
  `blast.v${formatAppVersion(manifest.version)}.neutron`,
);

const LICENSE_ID = "LicenseRef-Neutron-Sovereign-Application-Use-License-1.0";
const LICENSE_PATH = "legal/LICENSE.APP.USE.txt";
const APPLICATION_NOTICE_PATH = "legal/APPLICATION-NOTICE.txt";
const THIRD_PARTY_NOTICE_PATH = "legal/THIRD_PARTY_NOTICES.md";
const THIRD_PARTY_MATERIAL_PATH = "legal/third-party/EXACT-MATERIALS.v1.txt";
const NODE_MODULE_SPECIFIER =
  /(?:\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*|\b(?:import|export)\b[^;"']{0,512}\bfrom\s*)["']node:[^"']+["']/u;

const SCRIPT_METHODS = [
  "blast_scripts_list_v1",
  "blast_script_get_v1",
  "blast_script_save_v1",
  "blast_script_delete_v1",
];

const EXPECTED_BUILD_INPUTS = [
  "apps/blast/NOTICE",
  "apps/blast/build.ts",
  "apps/blast/mops.toml",
  "apps/blast/neutron.json",
  "apps/blast/neutron.lock.json",
  "apps/blast/package.json",
  "package-lock.json",
  "package.json",
].sort();

const ROOT_SOURCE_PATHS = new Set([
  "flake.lock",
  "flake.nix",
  "package-lock.json",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.browser.json",
  "tsconfig.bun.json",
  "tsconfig.json",
]);

describe("Blast first-release package shape", () => {
  test("package transport audit distinguishes object keys from Node module specifiers", () => {
    expect(() =>
      assertNoRemoteCodeOrNodeTransport(
        "web/browser.js",
        "const tree = { node: { value: 1 } };",
      )
    ).not.toThrow();

    for (const source of [
      'import "node:fs";',
      'import fs from "node:fs";',
      'export { readFile } from "node:fs";',
      'const net = await import("node:net");',
      'const http = require("node:http");',
    ]) {
      expect(() =>
        assertNoRemoteCodeOrNodeTransport("web/browser.js", source)
      ).toThrow();
    }
  });

  test("is a single headless resident with no owner launch surface", async () => {
    expect(manifest).toMatchObject({
      format: 3,
      id: "blast",
      version: 102,
      update_source: "233tv-xiaaa-aaaay-aacta-cai",
      background: {
        path: "service.html",
      },
    });
    expect(manifest).not.toHaveProperty("tiles");
    expect(manifest).not.toHaveProperty("tray");
    expect(manifest).not.toHaveProperty("menu_items");
    expect(await readdir(resolve(appRoot, "public"))).toEqual(["service.html"]);
  });

  test("declares only the exact resident capabilities and v1 self-call surface", () => {
    expect(manifest.capabilities).toEqual({
      preapproved_self_calls: { api: 1, methods: SCRIPT_METHODS },
      background_ui_requests: {
        api: 1,
        categories: ["signed_canister_call"],
      },
      persistent_browser_storage: { api: 1, surface: "background" },
    });
    expect(manifest.capabilities).not.toHaveProperty("agent_entrypoints");
    expect(Object.keys(manifest.func as Record<string, unknown>)).toEqual(
      SCRIPT_METHODS,
    );
    expect(manifest.func).toEqual({
      blast_scripts_list_v1: { type: "query", async: false },
      blast_script_get_v1: { type: "query", async: false },
      blast_script_save_v1: { type: "update", async: false },
      blast_script_delete_v1: { type: "update", async: false },
    });
  });

  test("starts at memory v1 with no fabricated migration", () => {
    expect(manifest.memory).toEqual({
      blast: {
        version: 1,
        schemas: { "1": { src: "memory/blast/v1.mo" } },
        migrations: [],
      },
    });
  });

  test("binds the exact install archive, legal record, and offered source", async () => {
    const archiveBytes = await readBytes(archivePath);
    const unpacked = unpackNeutronPackage(archiveBytes);
    const paths = Object.keys(unpacked).sort();
    for (const packagePath of paths) assertAllowedPackagePath(packagePath);

    expect(unpacked[NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH]).toEqual(
      browserSurfaceOriginsPackageMarkerBytes(),
    );
    expect(paths).not.toContain(NEUTRON_APP_SOURCE_SNAPSHOT_PATH);
    expect(
      paths.some((packagePath) =>
        packagePath.startsWith(NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX),
      ),
    ).toBe(false);

    for (const packagePath of paths) {
      if (packagePath === NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH) continue;
      expect(
        unpacked[packagePath],
        `${packagePath} differs from the authoritative dist file`,
      ).toEqual(await readBytes(resolve(appRoot, "dist", packagePath)));
    }

    const packedManifestBytes = unpacked["neutron.json"]!;
    const packedManifest = JSON.parse(
      new TextDecoder().decode(packedManifestBytes),
    ) as PackagedNeutronManifest;
    expect(packedManifest).toMatchObject(manifest);

    const memoryLock = await readBytes(resolve(appRoot, "neutron.lock.json"));
    expect(unpacked["neutron.lock.json"]).toEqual(memoryLock);

    const prepared = preparePackageInstall(archiveBytes, {
      expectedIdentity: { id: "blast", version: manifest.version },
    });
    expect(prepared.browserSurfaceOriginsReady).toBe(true);
    expect(prepared.archiveIdentity).toEqual({
      sha256: hashContent(archiveBytes),
      size: archiveBytes.byteLength,
    });
    expect(prepared.manifest).toEqual(packedManifest);

    const record = prepared.packageRecord;
    if (record === undefined)
      throw new Error("Blast package record is missing");
    expect(record.features).toBeUndefined();
    expect(record.package).toEqual({
      id: "blast",
      version: manifest.version,
      manifest: embeddedFile("neutron.json", packedManifestBytes),
    });

    const license = await readBytes(resolve(repositoryRoot, "LICENSE.APP.USE"));
    const applicationNotice = await readBytes(resolve(appRoot, "NOTICE"));
    expect(unpacked[LICENSE_PATH]).toEqual(license);
    expect(unpacked[APPLICATION_NOTICE_PATH]).toEqual(applicationNotice);
    expect(record.license).toEqual({
      id: LICENSE_ID,
      texts: [{ id: LICENSE_ID, ...embeddedFile(LICENSE_PATH, license) }],
    });
    expect(record.notices).toEqual([
      embeddedFile(APPLICATION_NOTICE_PATH, applicationNotice),
      embeddedFile(THIRD_PARTY_NOTICE_PATH, unpacked[THIRD_PARTY_NOTICE_PATH]!),
      embeddedFile(
        THIRD_PARTY_MATERIAL_PATH,
        unpacked[THIRD_PARTY_MATERIAL_PATH]!,
      ),
    ]);
    expect(record.memory).toEqual({
      lock: embeddedFile("neutron.lock.json", memoryLock),
    });
    expect(record.build.inputs.map(({ path }) => path).sort()).toEqual(
      EXPECTED_BUILD_INPUTS,
    );
    expect(record.build.commands).toEqual([
      {
        purpose: "package",
        cwd: ".",
        argv: ["npm", "--workspace", "neutron-blast", "run", "package"],
      },
    ]);

    const source = record.source;
    if (source.kind !== "https") {
      throw new Error("Blast must carry a provider-hosted HTTPS source offer");
    }
    expect(source.revision).toBe(`source-sha256:${source.sha256}`);
    expect(source.url).toBe(
      "https://233tv-xiaaa-aaaay-aacta-cai.icp0.io/repo/v1/sources/" +
        neutronAppSourceArchiveFilename(source.sha256),
    );
    const sourceArtifact = await readBytes(
      resolve(
        appRoot,
        ".neutron/sources",
        neutronAppSourceArchiveFilename(source.sha256),
      ),
    );
    expect(sourceArtifact.byteLength).toBe(source.bytes);
    expect(hashContent(sourceArtifact)).toBe(source.sha256);
    const sourceSnapshot = decodeNeutronAppSourceSnapshot(
      new Uint8Array(
        gunzipSync(sourceArtifact, {
          maxOutputLength: NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.encodedBytes,
        }),
      ),
      { id: "blast", version: manifest.version },
    );
    assertNeutronAppSourceBuildInputs(sourceSnapshot, record.build.inputs);
    for (const sourceFile of sourceSnapshot.files) {
      assertAllowedSourcePath(sourceFile.path);
      expect(
        sourceFile.content,
        `${sourceFile.path} differs from the offered source`,
      ).toEqual(await readBytes(resolve(repositoryRoot, sourceFile.path)));
    }

    expect(neutronPackageRecordArchiveOnlyPaths(record)).toEqual([]);
    expect(prepared.files.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "app/blast/service.html",
        "app/blast/service.js",
        "app/blast/icblast_worker.js",
        "app/blast/script_worker.js",
        "app/blast/query_worker.js",
        `app/blast/pkg/${LICENSE_PATH}`,
        `app/blast/pkg/${APPLICATION_NOTICE_PATH}`,
        `app/blast/pkg/${NEUTRON_PACKAGE_RECORD_PATH}`,
      ]),
    );
  });

  test("ships only reviewed local Worker and Wasm runtime assets", async () => {
    const unpacked = unpackNeutronPackage(await readBytes(archivePath));
    const paths = Object.keys(unpacked);
    const didcPaths = paths.filter((packagePath) =>
      /^web\/static\/didc_rust_bg-[A-Z0-9]{8}\.bin$/u.test(packagePath),
    );
    const quickJsPaths = paths.filter((packagePath) =>
      /^web\/static\/emscripten-module-[A-Z0-9]{8}\.wasm$/u.test(packagePath),
    );
    expect(didcPaths).toHaveLength(1);
    expect(quickJsPaths).toHaveLength(1);

    const didcPath = didcPaths[0]!;
    const quickJsPath = quickJsPaths[0]!;
    expect(unpacked[didcPath]).toEqual(
      await readBytes(
        resolve(
          repositoryRoot,
          "node_modules/icblast/didc_wasm_pkg/didc_rust_bg.bin",
        ),
      ),
    );
    expect(unpacked[quickJsPath]).toEqual(
      await readBytes(
        resolve(
          repositoryRoot,
          "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
        ),
      ),
    );

    const service = decodeText(unpacked["web/service.js"]!);
    const icblastWorker = decodeText(unpacked["web/icblast_worker.js"]!);
    const scriptWorker = decodeText(unpacked["web/script_worker.js"]!);
    const queryWorker = decodeText(unpacked["web/query_worker.js"]!);
    expect(service).not.toContain(basename(didcPath));
    expect(service).toContain("icblast_worker.js");
    expect(service).toContain("script_worker.js");
    expect(service).toContain("query_worker.js");
    expect(icblastWorker).toContain(basename(didcPath));
    expect(scriptWorker).toContain(basename(quickJsPath));
    expect(queryWorker).toContain(basename(quickJsPath));

    for (const packagePath of [
      "web/service.js",
      "web/icblast_worker.js",
      "web/script_worker.js",
      "web/query_worker.js",
    ]) {
      assertNoRemoteCodeOrNodeTransport(
        packagePath,
        decodeText(unpacked[packagePath]!),
      );
    }
    const serviceHtml = decodeText(unpacked["web/service.html"]!);
    expect(serviceHtml).toContain('<script type="module" src="./service.js">');
    expect(serviceHtml).not.toMatch(/https?:\/\/|(?:src|href)=["']\/\//iu);
  });
});

function assertAllowedPackagePath(packagePath: string): void {
  const allowed =
    packagePath === NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH ||
    packagePath === "neutron.json" ||
    packagePath === "neutron.lock.json" ||
    packagePath === "schema.json" ||
    packagePath === "web/service.html" ||
    packagePath === "web/service.js" ||
    packagePath === "web/icblast_worker.js" ||
    packagePath === "web/script_worker.js" ||
    packagePath === "web/query_worker.js" ||
    packagePath === LICENSE_PATH ||
    packagePath === APPLICATION_NOTICE_PATH ||
    packagePath === THIRD_PARTY_NOTICE_PATH ||
    packagePath === THIRD_PARTY_MATERIAL_PATH ||
    packagePath === NEUTRON_PACKAGE_RECORD_PATH ||
    /^legal\/third-party\/[a-f0-9]{64}\.txt$/u.test(packagePath) ||
    /^mo\/[a-f0-9]{64}\.mo$/u.test(packagePath) ||
    /^web\/static\/didc_rust_bg-[A-Z0-9]{8}\.bin$/u.test(packagePath) ||
    /^web\/static\/emscripten-module-[A-Z0-9]{8}\.wasm$/u.test(packagePath);
  expect(allowed, `unexpected Blast package path ${packagePath}`).toBe(true);
  expect(packagePath).not.toMatch(
    /(?:^|\/)(?:node_modules|dist|\.git|\.mops)(?:\/|$)/u,
  );
  expect(packagePath).not.toMatch(/\.(?:map|neutron|tsbuildinfo)$/u);
}

function assertAllowedSourcePath(sourcePath: string): void {
  const allowed =
    ROOT_SOURCE_PATHS.has(sourcePath) ||
    sourcePath.startsWith("apps/blast/") ||
    sourcePath.startsWith("packages/neutron-tools/");
  expect(allowed, `unexpected Complete App Source path ${sourcePath}`).toBe(
    true,
  );
  expect(sourcePath).not.toMatch(
    /(?:^|\/)(?:node_modules|dist|\.git|\.mops|\.neutron)(?:\/|$)/u,
  );
  expect(sourcePath).not.toMatch(
    /(?:\.neutron|\.source\.v1\.msgpack\.gz|\.tsbuildinfo)$/u,
  );
}

function assertNoRemoteCodeOrNodeTransport(
  packagePath: string,
  content: string,
): void {
  expect(content, `${packagePath} contains a source map`).not.toContain(
    "sourceMappingURL",
  );
  expect(content, `${packagePath} contains MCP runtime code`).not.toMatch(
    /@modelcontextprotocol|mcp_/u,
  );
  expect(content, `${packagePath} contains a Node transport`).not.toMatch(
    NODE_MODULE_SPECIFIER,
  );
  expect(
    content,
    `${packagePath} contains the retired converter`,
  ).not.toContain("a4gq6-oaaaa-aaaab-qaa4q-cai");
  expect(content, `${packagePath} contains importScripts`).not.toMatch(
    /importScripts\s*\(/u,
  );
  expect(content, `${packagePath} imports remote code`).not.toMatch(
    /import\s*\(\s*["'](?:https?:|\/\/)/iu,
  );
  expect(content, `${packagePath} creates a remote Worker`).not.toMatch(
    /new\s+Worker\s*\(\s*["'](?:https?:|\/\/)/iu,
  );
}

function embeddedFile(path: string, content: Uint8Array) {
  return { path, sha256: hashContent(content), bytes: content.byteLength };
}

async function readBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

function decodeText(content: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}
