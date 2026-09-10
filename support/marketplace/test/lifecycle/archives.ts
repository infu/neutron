import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageMotoko } from "../../../../packages/neutron-scripts/src/mopack.ts";
import { packDirectory } from "../../../../packages/neutron-scripts/src/pack.ts";
import { generateAppMethodSchemaArtifact } from "../../../../packages/neutron-scripts/src/method_schema.ts";
import {
  generateOrdinaryAppPackageMetadata,
  NSAL_USE_LICENSE_ID,
} from "../../../../packages/neutron-scripts/src/package_metadata.ts";
import { THIRD_PARTY_NOTICE_INDEX_PATH } from "../../../../packages/neutron-scripts/src/third_party_notices.ts";
import { preparePackageInstall } from "../../../../packages/neutron-compiler/src/install.ts";
import type { PreparedArchive } from "../../../../packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts";

export const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export type ArchiveEvidence = Readonly<{
  id: string;
  version: number;
  path: string;
  bytes: number;
  sha256: string;
}>;
export type EvidencedArchive = PreparedArchive & Readonly<{ evidence: ArchiveEvidence }>;

const counterSchema = `module {
  public type Mem = { var counter : Nat };
  public func init() : Mem { { var counter = 0 } };
};
`;

function backend(version: number): string {
  return `import Memory "./memory/counter/v1";
module {
  public type AppBackendEnvironment = { stable_memory : { counter : Memory.Mem } };
  public class Init(env : AppBackendEnvironment) {
    let mem = env.stable_memory.counter;
    public func read_counter() : Nat { mem.counter };
    public func set_counter(value : Nat) : Nat { mem.counter := value; mem.counter };
    public func release_version() : Nat { ${version} };
  };
  public type read_counter_Input = ();
  public type read_counter_Output = Nat;
  public type set_counter_Input = (value : Nat);
  public type set_counter_Output = Nat;
  public type release_version_Input = ();
  public type release_version_Output = Nat;
};
`;
}

const fixtureCache = new Map<string, Promise<PreparedArchive>>();

/** Build real source/lock/legal envelopes without changing any production package. */
export function fixtureArchive(appId: string, version: number, updateSource: string): Promise<PreparedArchive> {
  if (!/^[a-z][a-z0-9_]*$/.test(appId)) throw new Error("Invalid fixture app id");
  if (!Number.isSafeInteger(version) || version < 100) throw new Error("Invalid fixture version");
  const key = JSON.stringify([appId, version, updateSource]);
  let result = fixtureCache.get(key);
  if (result === undefined) {
    result = buildFixtureArchive(appId, version, updateSource);
    fixtureCache.set(key, result);
  }
  return result;
}

async function buildFixtureArchive(appId: string, version: number, updateSource: string): Promise<PreparedArchive> {
  const root = await mkdtemp(path.join(tmpdir(), "marketplace-lifecycle-package-"));
  const appRoot = path.join(root, "apps", appId);
  try {
    await mkdir(path.join(appRoot, "backend/memory/counter"), { recursive: true });
    await mkdir(path.join(appRoot, "dist/web/static"), { recursive: true });
    await mkdir(path.join(root, "packages/neutron-design-system"), { recursive: true });
    const manifest = {
      format: 3,
      id: appId,
      name: appId === "paid_alpha" ? "Paid Alpha" : "Paid Beta",
      version,
      src: "main.mo",
      update_source: updateSource,
      tiles: [{ id: "main", title: appId, path: "index.html", icon: "static/icon.svg" }],
      func: {
        read_counter: { type: "query", async: false },
        set_counter: { type: "update", async: false },
        release_version: { type: "query", async: false },
      },
      memory: {
        counter: { version: 1, schemas: { "1": { src: "memory/counter/v1.mo" } }, migrations: [] },
      },
    };
    const appPackage = { name: `neutron-${appId}`, version: "1.0.0", license: NSAL_USE_LICENSE_ID, dependencies: {} };
    const source = backend(version);
    const html = `<!doctype html><meta charset="utf-8"><title>${appId}</title><p>${appId} release ${version}</p>`;
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    await Promise.all([
      writeFile(path.join(root, "package.json"), json({ name: "marketplace-lifecycle-fixtures", private: true, workspaces: ["apps/*"] })),
      writeFile(path.join(root, "package-lock.json"), json({ name: "marketplace-lifecycle-fixtures", lockfileVersion: 3, packages: {} })),
      copyFile(path.join(repositoryRoot, "LICENSE.APP.USE"), path.join(root, "LICENSE.APP.USE")),
      copyFile(path.join(repositoryRoot, "LICENSE.APP"), path.join(root, "LICENSE.APP")),
      copyFile(path.join(repositoryRoot, "LICENSE.APP.1.0"), path.join(root, "LICENSE.APP.1.0")),
      copyFile(path.join(repositoryRoot, "packages/neutron-design-system/LICENSE"), path.join(root, "packages/neutron-design-system/LICENSE")),
      writeFile(path.join(appRoot, "package.json"), json(appPackage)),
      writeFile(path.join(appRoot, "neutron.json"), json(manifest)),
      writeFile(path.join(appRoot, "NOTICE"), `${appId}\n\nCopyright 2026 3V Interactive\nLicensed under the Neutron Sovereign Application Use License, Version 1.0.\nSPDX-License-Identifier: ${NSAL_USE_LICENSE_ID}\nProduction Use by any person is permitted only in a Qualifying Sovereign System.\nSource is provided for inspection; modification and redistribution are not licensed.\nAll rights not expressly granted are reserved. See LICENSE.APP.USE.\n`),
      writeFile(path.join(appRoot, "backend/main.mo"), source),
      writeFile(path.join(appRoot, "backend/memory/counter/v1.mo"), counterSchema),
      writeFile(path.join(appRoot, "index.html"), html),
      writeFile(path.join(appRoot, "dist/web/index.html"), html),
      writeFile(path.join(appRoot, "dist/web/static/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="6" fill="#4263eb"/></svg>'),
    ]);
    const packaged = await packageMotoko({ cwd: appRoot, packages: {}, sourceDelivery: "embedded" });
    await writeFile(path.join(appRoot, "dist/schema.json"), json(generateAppMethodSchemaArtifact(packaged, source)));
    await generateOrdinaryAppPackageMetadata({
      appRoot,
      repositoryRoot: root,
      // These dependency-free test modules contain only their own two sources.
      buildNotices: async () => ({
        files: { [THIRD_PARTY_NOTICE_INDEX_PATH]: new TextEncoder().encode("# Third-party notices\n\nThis fixture has no third-party runtime dependencies.\n") },
        noticePaths: [THIRD_PARTY_NOTICE_INDEX_PATH],
        components: [],
      }),
    });
    const archive = new Uint8Array(await readFile(await packDirectory(appRoot)));
    const prepared = preparePackageInstall(archive, {
      expectedIdentity: { id: appId, version, sha256: sha256(archive) },
    });
    if (prepared.packageRecord?.source.kind !== "embedded" || prepared.packageRecord.memory === null) {
      throw new Error("Fixture packaging omitted its source or managed memory lock");
    }
    return { archive, prepared };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Read the exact source-selected candidates; never build or edit them here. */
export async function currentArchive(id: "kernel" | "marketplace"): Promise<EvidencedArchive> {
  const manifestPath = path.join(repositoryRoot, "apps", id, "neutron.json");
  const source = JSON.parse(await readFile(manifestPath, "utf8")) as { id: string; version: number };
  if (source.id !== id || !Number.isSafeInteger(source.version)) throw new Error(`Invalid ${id} source manifest`);
  const version = source.version;
  const semver = `${Math.floor(version / 10_000)}.${Math.floor(version / 100) % 100}.${version % 100}`;
  const archivePath = path.join(repositoryRoot, "apps", id, `${id}.v${semver}.neutron`);
  const archive = new Uint8Array(await readFile(archivePath));
  const digest = sha256(archive);
  const prepared = preparePackageInstall(archive, { expectedIdentity: { id, version, sha256: digest } });
  return {
    archive,
    prepared,
    evidence: { id, version, path: archivePath, bytes: archive.byteLength, sha256: digest },
  };
}

export async function currentArchives(): Promise<{ kernel: EvidencedArchive; marketplace: EvidencedArchive }> {
  const [kernel, marketplace] = await Promise.all([currentArchive("kernel"), currentArchive("marketplace")]);
  return { kernel, marketplace };
}
