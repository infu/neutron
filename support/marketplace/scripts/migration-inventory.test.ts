// All rights reserved. See ../LICENSE.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "fflate";
import msgpack from "tiny-msgpack";
import { Principal } from "@dfinity/principal";
import { hashContent } from "neutron-tools/src/hash.ts";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.ts";
import { neutronAppSourceRepositoryPath } from "neutron-tools/src/package_record.ts";
import { loadReleaseCatalog } from "../../update-source/src/release_catalog.ts";
import { hostedSourceArtifactPath, sha256Hex } from "../../update-source/src/model.ts";
import { inspectMigrationArchive, migrationInventory, prepareMigration, publisherMap, readPublishedSnapshot, type PublishedSnapshot } from "./migration-inventory.ts";
import { TRUSTED_PUBLISHER_CALLER } from "./first-party-publish.ts";

const oldSource = "233tv-xiaaa-aaaay-aacta-cai";
const marketplace = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const publisher = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const text = (value: string) => new TextEncoder().encode(value);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function archive(directory: string, id = "alpha", version = 101, source = marketplace, offeredSource = false) {
  await mkdir(directory, { recursive: true });
  const module = text('module { public class Init() { public func ping() : Text { "ok" } } }');
  const entry = hashContent(module);
  const manifest = { format: 3, id, name: `${id} app`, version, update_source: source, entry, func: { ping: { type: "update", async: false } } };
  const manifestBytes = text(JSON.stringify(manifest));
  const files: Record<string, Uint8Array> = { "neutron.json": manifestBytes, "web/index.html": text("<main></main>"), [`mo/${entry}.mo`]: module };
  let sourceFile: string | null = null;
  if (offeredSource) {
    const sourceBytes = gzipSync(msgpack.encode({ format: 1, package: { id, version }, files: [{ path: "neutron.json", mode: 0o644, content: manifestBytes }] }), { mtime: 0 });
    const digest = sha256Hex(sourceBytes);
    const sourcePath = neutronAppSourceRepositoryPath(digest);
    const license = text("Example fixture license\n"), notice = text("Example fixture notice\n");
    files["legal/LICENSE.txt"] = license;
    files["legal/APPLICATION-NOTICE.txt"] = notice;
    files["legal/package-record.v1.json"] = text(JSON.stringify({
      format: 1,
      package: { id, version, manifest: { path: "neutron.json", sha256: hashContent(manifestBytes), bytes: manifestBytes.length } },
      license: { id: "LicenseRef-Example-1.0", texts: [{ id: "LicenseRef-Example-1.0", path: "legal/LICENSE.txt", sha256: hashContent(license), bytes: license.length }] },
      source: { kind: "https", url: `https://${source}.icp0.io${sourcePath}`, revision: `source-sha256:${digest}`, sha256: digest, bytes: sourceBytes.length },
      dependencies: [], notices: [{ path: "legal/APPLICATION-NOTICE.txt", sha256: hashContent(notice), bytes: notice.length }], memory: null,
      build: { inputs: [{ path: "neutron.json", sha256: hashContent(manifestBytes), bytes: manifestBytes.length }], commands: [{ purpose: "package", cwd: ".", argv: ["npm", "run", "package"] }] },
    }));
    sourceFile = hostedSourceArtifactPath(path.join(directory, packageArchiveFilename(id, version)), digest);
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, sourceBytes);
  }
  const file = path.join(directory, packageArchiveFilename(id, version));
  const bytes = msgpack.encode(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, gzipSync(data, { mtime: 0 })])));
  await writeFile(file, bytes);
  await writeFile(path.join(directory, "neutron.json"), manifestBytes);
  return { file, bytes, sourceFile };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-migration-")); temporary.push(root);
  const local = await archive(path.join(root, "apps/alpha"), "alpha", 100, oldSource);
  const transition = await archive(path.join(root, "transitions"), "alpha", 101);
  const catalogPath = path.join(root, "release-catalog.json");
  await writeFile(catalogPath, JSON.stringify({ format: 1, update_source: oldSource, packages: [{ id: "alpha", directory: "apps/alpha" }] }));
  const catalog = await loadReleaseCatalog(catalogPath, { repositoryRoot: root });
  const release = (await inspectMigrationArchive(local.file)).release;
  const published: PublishedSnapshot = { updateSource: oldSource, evidence: "supplied_snapshot", releases: [release] };
  const input = { catalog, marketplace, feeVersion: "1", publishers: [{ appId: "alpha", publisher }], transitions: [{ appId: "alpha", file: transition.file }], published };
  return { root, local, transition, catalog, release, published, input };
}

describe("read-only marketplace migration inventory", () => {
  test("keeps packed local bytes distinct from published evidence", async () => {
    const f = await fixture();
    const result = await migrationInventory(f.input);
    expect(result.publishedEvidence).toBe("supplied_snapshot");
    expect(result.packages[0]?.localMatchesPublished).toBe(true);
    await archive(path.join(f.root, "apps/alpha"), "alpha", 101, marketplace);
    const changed = await migrationInventory(f.input);
    expect(changed.packages[0]?.packedLocal?.release.version).toBe(101);
    expect(changed.packages[0]?.published?.version).toBe(100);
    expect(changed.packages[0]?.localMatchesPublished).toBe(false);
    const offline = await migrationInventory({ catalog: f.catalog, publishers: f.input.publishers });
    expect(offline.publishedEvidence).toBe("not_read");
    expect(offline.packages[0]?.published).toBeNull();
  });

  test("reports an unpacked local app without fabricating a published release", async () => {
    const f = await fixture();
    await rm(f.local.file);
    const result = await migrationInventory({ catalog: f.catalog, publishers: f.input.publishers });
    expect(result.packages[0]?.packedLocal).toBeNull();
    expect(result.packages[0]?.published).toBeNull();
  });

  test("requires explicit complete and unique ownership mappings", async () => {
    const f = await fixture();
    expect(() => publisherMap(f.catalog, [])).toThrow("Missing publisher mapping");
    expect(() => publisherMap(f.catalog, [...f.input.publishers, ...f.input.publishers])).toThrow("Duplicate publisher mapping");
    expect(() => publisherMap(f.catalog, [{ appId: "bravo", publisher }])).toThrow("unknown app");
    for (const owner of ["2vxsx-fae", "aaaaa-aa", Principal.selfAuthenticating(new Uint8Array(32).fill(8)).toText()]) {
      expect(() => publisherMap(f.catalog, [{ appId: "alpha", publisher: owner }])).toThrow("canonical canister principal");
    }
  });

  test("accepts only the approved trusted identity exception without weakening source principals", async () => {
    const f = await fixture();
    expect(TRUSTED_PUBLISHER_CALLER).toBe("y7t6r-gtsqz-45ogs-2k3gk-l6hic-2h7wm-zosg6-uldzf-l4ams-2jaky-wqe");
    const publishers = [{ appId: "alpha", publisher: TRUSTED_PUBLISHER_CALLER }];
    expect(publisherMap(f.catalog, publishers).get("alpha")).toBe(TRUSTED_PUBLISHER_CALLER);
    const plan = await prepareMigration({ ...f.input, publishers });
    expect(plan.initReservations[0]?.publisher).toBe(TRUSTED_PUBLISHER_CALLER);
    expect(plan.nextSteps.join("\n")).toContain("approved direct first-party upload");
    expect(plan.nextSteps.join("\n")).not.toContain("through each publisher Neutron");
    expect((await prepareMigration(f.input)).nextSteps.join("\n")).toContain("through each publisher Neutron with attached cycles");
    const ordinaryIdentity = Principal.selfAuthenticating(new Uint8Array(32).fill(9)).toText();
    expect(() => publisherMap(f.catalog, [{ appId: "alpha", publisher: ordinaryIdentity }])).toThrow("canonical canister principal");
    await expect(prepareMigration({ ...f.input, marketplace: TRUSTED_PUBLISHER_CALLER, publishers })).rejects.toThrow("canonical canister principal");
    await expect(prepareMigration({ ...f.input, published: { ...f.published, updateSource: TRUSTED_PUBLISHER_CALLER }, publishers })).rejects.toThrow("canonical canister principal");
  });

  test("produces deterministic reservations and exact immutable transition evidence without editing files", async () => {
    const f = await fixture();
    const before = await readFile(f.local.file);
    const plan = await prepareMigration(f.input);
    expect(plan).toEqual(await prepareMigration(f.input));
    expect(plan.reservations).toEqual([{ method: "admin_reserve_app", args: { appId: "alpha", publisher, title: "alpha app", feeVersion: "1" } }]);
    expect(plan.initReservations).toEqual([{ appId: "alpha", publisher, title: "alpha app" }]);
    expect(plan.packages[0]?.oldRelease.sha256).toBe(sha256Hex(f.local.bytes));
    expect(plan.packages[0]?.transition.release.sha256).toBe(sha256Hex(f.transition.bytes));
    expect(plan.packages[0]?.transition.updateSource).toBe(marketplace);
    expect(await readFile(f.local.file)).toEqual(before);
  });

  test("refuses stale versions, wrong source, missing published evidence and missing transitions", async () => {
    const f = await fixture();
    const stale = await archive(path.join(f.root, "stale"), "alpha", 100);
    await expect(prepareMigration({ ...f.input, transitions: [{ appId: "alpha", file: stale.file }] })).rejects.toThrow("higher version");
    const wrong = await archive(path.join(f.root, "wrong"), "alpha", 101, oldSource);
    await expect(prepareMigration({ ...f.input, transitions: [{ appId: "alpha", file: wrong.file }] })).rejects.toThrow("must use marketplace update_source");
    await expect(prepareMigration({ ...f.input, published: { ...f.published, releases: [] } })).rejects.toThrow("packed local bytes are not publication evidence");
    await expect(prepareMigration({ ...f.input, transitions: [] })).rejects.toThrow("Missing exact transition");
    await expect(prepareMigration({ ...f.input, publishers: [] })).rejects.toThrow("Missing publisher mapping");
    await expect(prepareMigration({ ...f.input, marketplace: oldSource })).rejects.toThrow("must differ");
  });

  test("checks complete offered source through the production inspector and rejects corruption", async () => {
    const f = await fixture();
    const hosted = await archive(path.join(f.root, "hosted"), "alpha", 101, marketplace, true);
    const input = { ...f.input, transitions: [{ appId: "alpha", file: hosted.file }] };
    const plan = await prepareMigration(input);
    expect(plan.packages[0]?.transition.offeredSource?.file).toBe(hosted.sourceFile!);
    const bytes = await readFile(hosted.sourceFile!);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(hosted.sourceFile!, bytes);
    await expect(prepareMigration(input)).rejects.toThrow("expected");
  });

  test("rejects snapshot identity drift and repeated transition identities", async () => {
    const f = await fixture();
    await expect(prepareMigration({ ...f.input, published: { ...f.published, updateSource: marketplace } })).rejects.toThrow("different old update source");
    await expect(prepareMigration({ ...f.input, published: { ...f.published, releases: [f.release, f.release] } })).rejects.toThrow("repeats");
    await expect(prepareMigration({ ...f.input, transitions: [...f.input.transitions, ...f.input.transitions] })).rejects.toThrow("Duplicate transition");
  });

  test("opt-in gateway reads validate the certified envelope and bind returned app identity", async () => {
    const f = await fixture();
    let calls = 0;
    const body = JSON.stringify(f.release);
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls++;
      expect(String(input)).toBe(`https://${oldSource}.icp0.io/repo/v1/releases/alpha.json`);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      return new Response(body, { headers: {
        "content-type": "application/json", "cache-control": "public, max-age=0, must-revalidate",
        "access-control-allow-origin": "*", "x-content-type-options": "nosniff", "etag": `"${sha256Hex(text(body))}"`,
        "ic-certificate": "certificate=:AQ==:, tree=:AQ==:, expr_path=:AQ==:, version=2", "ic-certificateexpression": "default_certification(ValidationArgs{})",
      } });
    }) as typeof fetch;
    expect((await readPublishedSnapshot(f.catalog, fetcher)).releases).toEqual([f.release]);
    expect(calls).toBe(1);
    const unverified = (async () => new Response(body)) as unknown as typeof fetch;
    await expect(readPublishedSnapshot(f.catalog, unverified)).rejects.toThrow("certified HTTP v2 proof");
  });
});
